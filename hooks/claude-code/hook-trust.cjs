'use strict';
/**
 * What a hook may load from the project — only code that matches HEAD. CLAUDE CODE ONLY (shared by every hook here).
 *
 * WHY. A hook runs outside the permission prompt: the harness starts it on its own, on every matching tool call.
 * The hooks get their logic from `scripts/lib/*.cjs` and `scripts/*.mjs`, which live in the agent-writable tree. An
 * agent (or an injected instruction it follows) that rewrites one of those files would have its code run by the next
 * hook call — code that, typed as a shell command, would have needed approval. So a hook loads a project file only
 * when that file and every local file it requires are committed and unchanged: tracked by git, and clean against
 * HEAD in the index and the working tree. A change has to be committed first, and a commit is a reviewed act.
 *
 * FAILS CLOSED FOR THE CODE, OPEN FOR THE SESSION. No git, an untracked or ignored file, a missing require, a staged
 * or unstaged change → the code is not loaded and the caller gets a reason. The caller then does its safe fallback
 * (a guard keeps its defaults, an advisory hook says it did not run); no tool call ever fails here.
 *
 * Reading a file to find its requires executes nothing. Only `git` is spawned.
 *
 * Arming: this file is copied to `.claude/hooks/` with the hooks; a hook that cannot find it loads nothing.
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/** Relative requires and imports. A match inside a comment only widens the check, never narrows it. */
const LOCAL = /\brequire\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)|\bfrom\s+['"](\.{1,2}\/[^'"]+)['"]|\bimport\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;

/**
 * The entry file and every local file it reaches, absolute. A path that does not exist is left out: nothing can load
 * it, and once someone creates it, it is untracked and refused.
 */
function closure(entry, fsLike = fs) {
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    let text;
    try {
      text = fsLike.readFileSync(file, 'utf8');
    } catch {
      return;
    }
    seen.add(file);
    for (const m of text.matchAll(LOCAL)) walk(path.resolve(path.dirname(file), m[1] ?? m[2] ?? m[3]));
  };
  walk(path.resolve(entry));
  return [...seen];
}

function defaultGit(cwd, args) {
  return spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 5000, windowsHide: true });
}

/**
 * @param {string[]} files  absolute paths, all in one repository
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
function verify(files, { git = defaultGit } = {}) {
  if (files.length === 0) return { ok: false, reason: 'nothing to verify' };
  const cwd = path.dirname(files[0]);
  const rels = files.map((f) => f.replace(/\\/g, '/'));
  const listed = git(cwd, ['ls-files', '--', ...rels]);
  if (listed.status !== 0) return { ok: false, reason: 'cannot verify against HEAD (no git repository, or a file outside it)' };
  const tracked = listed.stdout.split(/\r?\n/).filter(Boolean).length;
  if (tracked !== files.length) return { ok: false, reason: `${files.length - tracked} file(s) not committed` };
  const status = git(cwd, ['status', '--porcelain', '--untracked-files=no', '--', ...rels]);
  if (status.status !== 0) return { ok: false, reason: 'cannot verify against HEAD (git status failed)' };
  const dirty = status.stdout.split(/\r?\n/).filter(Boolean).map((l) => l.slice(3));
  if (dirty.length) return { ok: false, reason: `${dirty.join(', ')} ${dirty.length === 1 ? 'differs' : 'differ'} from HEAD` };
  return { ok: true };
}

/** `entry` (absolute) is safe to run when it and its closure are committed and clean. */
function trusted(entry, opts = {}) {
  if (!fs.existsSync(entry)) return { ok: false, reason: `${path.basename(entry)} not found` };
  const v = verify(closure(entry), opts);
  return v.ok ? { ok: true } : { ok: false, reason: `${path.basename(entry)}: ${v.reason}` };
}

/**
 * Require `scripts/lib/<name>` — the project's copy, else the kit's next to this hook — only when trusted.
 * @returns {{ ok: true, module: any } | { ok: false, reason: string }}
 */
function load(root, hookDir, name, opts = {}) {
  for (const dir of [path.join(root, 'scripts', 'lib'), path.join(hookDir, '..', '..', 'scripts', 'lib')]) {
    const file = path.resolve(dir, name);
    if (!fs.existsSync(file)) continue;
    const t = trusted(file, opts);
    return t.ok ? { ok: true, module: require(file) } : t;
  }
  return { ok: false, reason: `${name} not found` };
}

module.exports = { closure, verify, trusted, load };
