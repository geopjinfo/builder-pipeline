#!/usr/bin/env node
/**
 * PostToolUse hook (matcher `Edit|Write|MultiEdit`) — lint an instruction file the moment it is edited. CLAUDE CODE ONLY.
 *
 * When the edited file is one of `features.instructionLint.files`, this runs `scripts/instruction-lint.mjs --files <it>`.
 * A FAIL is returned to the agent as a blocking PostToolUse decision carrying the lint's lines, so the author fixes a
 * dead path or a bare line reference in the same turn instead of leaving it for the gate. Any other file, a PASS,
 * the feature off, or the script missing → exit 0 with no output.
 *
 * FILTER FIRST, THEN TRUST, THEN SPAWN. The file is matched against `files` before anything is started, and the lint
 * script runs only when it and every local file it requires match HEAD (`hook-trust.cjs`) — a hook must not run code
 * an agent just wrote. An untrusted script on an instruction-file edit → a "not run" note to the agent, no block.
 *
 * NEVER FAILS THE TOOL CALL. The edit has already happened; this only reports. Any error here exits 0 silently.
 *
 * Arming: copy this and `hook-trust.cjs` to `.claude/hooks/`, then add a `PostToolUse` entry with matcher
 * `Edit|Write|MultiEdit` running `node .claude/hooks/instruction-lint-on-edit.cjs`. Arming is a person's deliberate act.
 */
'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ACTIVE = ['on', 'unmeasured', 'experimental-on'];
/** The pack defaults: what counts as an instruction file when the profile itself cannot be loaded. */
const DEFAULT_FILES = ['CLAUDE.md', 'AGENTS.md', '.claude/**/*.md'];

// Same glob dialect as scripts/instruction-lint.mjs; tokens first, so the `*` of one expansion is never rewritten.
const globRe = (g) =>
  new RegExp(
    `^${g
      .replace(/\*\*\//g, '\u0001')
      .replace(/\*\*/g, '\u0002')
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]')
      .replace(/\u0001/g, '(?:.*/)?')
      .replace(/\u0002/g, '.*')}$`,
  );
const matches = (rel, globs) => globs.some((g) => globRe(g).test(rel));

/**
 * @param {object} input  the hook input (`tool_input.file_path`)
 * @param {{ root: string, settings?: object | null, untrusted?: string | null, trust?: (file: string) => { ok: boolean, reason?: string },
 *   run?: (root: string, rel: string) => { status: number | null, stdout: string } }} context
 *   `settings` null with `untrusted` set means the profile could not be loaded safely.
 * @returns {{ action: 'pass', reason: string } | { action: 'block', reason: string } | { action: 'note', reason: string }}
 */
function decide(input, { root, settings = null, untrusted = null, trust, run = defaultRun, find = defaultFind }) {
  const file = input?.tool_input?.file_path;
  if (!file) return { action: 'pass', reason: 'no file path' };
  const rel = path.relative(root, path.resolve(root, file)).replace(/\\/g, '/');
  if (rel.startsWith('..')) return { action: 'pass', reason: 'outside the project' };
  if (!settings) {
    if (untrusted && matches(rel, DEFAULT_FILES)) return { action: 'note', reason: `instruction-lint hook: not run for ${rel} — ${untrusted}` };
    return { action: 'pass', reason: 'no settings' };
  }
  const feature = settings.features?.instructionLint ?? {};
  if (!ACTIVE.includes(feature.state ?? 'off')) return { action: 'pass', reason: 'instructionLint: not configured' };
  if (!matches(rel, feature.files ?? DEFAULT_FILES)) return { action: 'pass', reason: 'not an instruction file' };
  // The project's scripts/ copy (folder layout), else the installed package's (npm layout).
  const script = find(root);
  if (!script) return { action: 'pass', reason: 'no lint script' };
  const t = (trust || ((file) => defaultTrust(file, root)))(script);
  if (!t.ok) return { action: 'note', reason: `instruction-lint hook: not run for ${rel} — ${t.reason}` };
  const r = run(root, rel, script);
  if (r.status !== 1) return { action: 'pass', reason: `lint exit ${r.status}` };
  return { action: 'block', reason: `instruction-lint failed for ${rel} — fix it in this turn:\n${r.stdout.trim()}` };
}

function trustLib() {
  for (const p of [path.join(__dirname, 'hook-trust.cjs'), path.join(__dirname, 'claude-code', 'hook-trust.cjs')]) if (fs.existsSync(p)) return require(p);
  throw new Error('hook-trust.cjs not found');
}

/** The lint script for this project: `<root>/scripts/instruction-lint.mjs`, else the installed package's; or null. */
function defaultFind(root) {
  const own = path.join(root, 'scripts', 'instruction-lint.mjs');
  if (fs.existsSync(own)) return own;
  const pkg = trustLib().packageDir(root);
  const packaged = pkg && path.join(pkg, 'scripts', 'instruction-lint.mjs');
  return packaged && fs.existsSync(packaged) ? packaged : null;
}

/** A project copy is checked against HEAD; a package file against the committed lock (hook-trust.cjs). */
function defaultTrust(file, root) {
  const lib = trustLib();
  const pkg = root && lib.packageDir(root);
  if (pkg && !path.relative(pkg, file).startsWith('..')) return lib.trustedByLock(file, { root, pkg });
  return lib.trusted(file, { base: path.resolve(path.dirname(file), '..') });
}

function defaultRun(root, rel, script = path.join(root, 'scripts', 'instruction-lint.mjs')) {
  return spawnSync(process.execPath, [script, '--files', rel], { cwd: root, encoding: 'utf8', timeout: 20000, env: { ...process.env, BUILDER_PROJECT_ROOT: root } });
}

if (require.main === module) {
  try {
    const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
    const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
    const profile = trustLib().load(root, __dirname, 'profile.cjs');
    const d = profile.ok ? decide(input, { root, settings: profile.module.load(root).settings }) : decide(input, { root, untrusted: profile.reason });
    if (d.action === 'block') process.stdout.write(JSON.stringify({ decision: 'block', reason: d.reason }));
    if (d.action === 'note') process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: d.reason } }));
  } catch {
    /* never fail the tool call */
  }
  process.exit(0);
}

module.exports = { decide };
