#!/usr/bin/env node
/**
 * PostToolUse hook — keep the rendered run boards current on every tool write.
 *
 * WHY A HOOK AS WELL AS A WATCHER. `scripts/board-watch.mjs` is the mechanism; this is the belt to
 * its braces. A watcher can be absent (nobody started it), dead (a killed terminal), or blind (a
 * host without recursive `fs.watch`) — and each of those failures looks exactly like a run where
 * nothing happened, because a board that stopped updating and a run that stopped progressing render
 * identically. The hook fires wherever a tool wrote something, which is most of what a run does.
 *
 * IT NEVER BLOCKS. Exit 0 always: on any input, on no input, on malformed input, on a render that
 * throws. A hook that can fail a tool call would trade a slightly stale page for a broken session,
 * which is not a trade worth making. Errors go to stderr and are swallowed there.
 *
 * IT RENDERS ONLY WHAT IS STALE. The freshness verdict is two `stat` calls per board, so the common
 * case — nothing changed — costs nothing and writes nothing.
 *
 * IT RUNS ONLY COMMITTED CODE. The libraries and `scripts/board-render.mjs` are loaded or spawned only when they match
 * HEAD (`claude-code/hook-trust.cjs`, installed next to this file) — a hook must not run code an agent just wrote.
 * Untrusted → a stderr line and no render.
 */
const { execFileSync } = require('node:child_process');
const { existsSync, readdirSync } = require('node:fs');
const { join } = require('node:path');

function trustLib() {
  for (const p of [join(__dirname, 'hook-trust.cjs'), join(__dirname, 'claude-code', 'hook-trust.cjs')]) if (existsSync(p)) return require(p);
  throw new Error('hook-trust.cjs not found');
}

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();

try {
  const trust = trustLib();
  // The project's scripts/ copies (folder layout), else the installed package's (npm layout) — hook-trust locate().
  const found = {};
  for (const rel of [join('lib', 'board-freshness.cjs'), join('lib', 'profile.cjs'), 'board-render.mjs']) {
    const t = trust.locate(root, __dirname, rel);
    if (!t.ok) throw new Error(`not run — ${t.reason}`);
    found[rel] = t.file;
  }
  const render = found['board-render.mjs'];
  const freshness = require(found[join('lib', 'board-freshness.cjs')]);
  const profile = require(found[join('lib', 'profile.cjs')]);
  const tasksDir = join(root, profile.load(root).settings.paths?.boards || 'tasks');

  if (existsSync(tasksDir)) {
    const stale = readdirSync(tasksDir)
      .filter((f) => f.endsWith('.md') && !f.startsWith('_') && f !== 'README.md')
      .map((f) => join(tasksDir, f))
      .filter((board) => {
        try {
          const verdict = freshness.verdict(board);
          return verdict.applicable && verdict.stale;
        } catch {
          return false;
        }
      });

    for (const board of stale) {
      try {
        execFileSync(process.execPath, [render, board], {
          cwd: root,
          env: { ...process.env, BUILDER_PROJECT_ROOT: root },
          stdio: 'ignore',
          timeout: 10_000,
        });
      } catch (error) {
        process.stderr.write(`board-render hook: ${board} — ${error.message}\n`);
      }
    }
  }
} catch (error) {
  process.stderr.write(`board-render hook: ${error.message}\n`);
}

process.exit(0);
