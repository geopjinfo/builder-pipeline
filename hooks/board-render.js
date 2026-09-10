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
 */
const { execFileSync } = require('node:child_process');
const { existsSync, readdirSync } = require('node:fs');
const { join } = require('node:path');

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();

try {
  const freshness = require(join(root, 'scripts', 'lib', 'board-freshness.cjs'));
  const tasksDir = join(root, 'tasks');

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
        execFileSync(process.execPath, [join(root, 'scripts', 'board-render.mjs'), board], {
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
