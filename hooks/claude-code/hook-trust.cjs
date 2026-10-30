'use strict';
/**
 * What a hook may load from the project — only code that matches HEAD. CLAUDE CODE ONLY (shared by every hook here).
 *
 * WHY. A hook runs outside the permission prompt: the harness starts it on its own, on every matching tool call.
 * The hooks get their logic from `scripts/lib/*.cjs` and `scripts/*.mjs`, which live in the agent-writable tree. An
 * agent (or an injected instruction it follows) that rewrites one of those files would have its code run by the next
 * hook call — code that, typed as a shell command, would have needed approval. So a hook loads a project file only
 * when that file and every local file it requires are byte-for-byte the blob at HEAD of the project's repository. A
 * change has to be committed first, and a commit is a reviewed act.
 *
 * WHAT IT DOES NOT COVER. An agent allowed to commit, or to rewrite `.git` itself (refs, objects, a worktree's
 * `.git` pointer), can still put code at HEAD. This closes the cheap route — editing a file under `scripts/` — not
 * that one; keep commits and `.git` behind the permission prompt.
 *
 * FAILS CLOSED FOR THE CODE, OPEN FOR THE SESSION. No git, a file not at HEAD, any byte changed, a file in a nested
 * repository → the code is not loaded and the caller gets a reason. The caller then does its safe fallback
 * (a guard keeps its defaults, an advisory hook says it did not run); no tool call ever fails here.
 *
 * Reading a file to find its requires executes nothing. Only `git rev-parse` is spawned, with config that can run a
 * program switched off (fsmonitor, hooks) — it never reads the index, which an agent can flag to hide a change.
 *
 * Arming: this file is copied to `.claude/hooks/` with the hooks; a hook that cannot find it loads nothing.
 */
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
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

/**
 * Git with nothing from the repository's config that can run a program, and nothing inherited from the caller's
 * environment that could point it at another repository. `rev-parse` reads objects and refs only; it never consults
 * the index or runs fsmonitor, and replace refs are ignored.
 */
function defaultGit(cwd, args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k)));
  env.GIT_NO_REPLACE_OBJECTS = '1';
  return spawnSync('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=', '-C', cwd, ...args], {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
    env,
  });
}

/** The id git gives these bytes as a blob, in the repository's hash (sha1 ids are 40 hex, sha256 ids 64). */
function blobId(bytes, hexLength) {
  const h = crypto.createHash(hexLength === 64 ? 'sha256' : 'sha1');
  h.update(`blob ${bytes.length}\0`);
  h.update(bytes);
  return h.digest('hex');
}

/**
 * Do these bytes match the blob at HEAD? Compared by hash, never by `git status` — status reads the index, which an
 * agent can flag (assume-unchanged, skip-worktree) to hide a change. A checkout with CRLF line endings
 * (core.autocrlf) matches its LF blob: a CR before a newline changes no JavaScript, since template literals normalise
 * CRLF and no other literal can span a line.
 */
function matchesHead(bytes, head) {
  if (blobId(bytes, head.length) === head) return true;
  const lf = Buffer.from(bytes.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
  return lf.length !== bytes.length && blobId(lf, head.length) === head;
}

/**
 * @param {string[]} files  absolute paths
 * @param {{ base?: string, git?: typeof defaultGit }} [opts]  base: a directory of the repository the files must
 *   belong to — the project root for project files. Defaults to the first file's directory.
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
function verify(files, { base = files.length ? path.dirname(files[0]) : '.', git = defaultGit } = {}) {
  if (files.length === 0) return { ok: false, reason: 'nothing to verify' };
  const top = git(base, ['rev-parse', '--show-toplevel']);
  if (top.status !== 0 || !top.stdout.trim()) return { ok: false, reason: 'cannot verify against HEAD (no git repository)' };
  const repo = path.resolve(top.stdout.trim());
  const rels = [];
  for (const file of files) {
    const native = path.relative(repo, file);
    if (!native || native.startsWith('..') || path.isAbsolute(native)) return { ok: false, reason: `${path.basename(file)} is outside the repository` };
    const rel = native.split(path.sep).join('/');
    for (let dir = path.dirname(file); path.relative(repo, dir); dir = path.dirname(dir)) {
      if (fs.existsSync(path.join(dir, '.git'))) return { ok: false, reason: `${rel} is inside a nested repository` };
    }
    rels.push(rel);
  }
  const heads = git(repo, ['rev-parse', ...rels.map((r) => `HEAD:${r}`)]);
  const ids = heads.stdout.split(/\r?\n/).filter((l) => /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(l));
  if (heads.status !== 0 || ids.length !== rels.length) return { ok: false, reason: 'not all committed at HEAD' };
  const dirty = rels.filter((rel, i) => !matchesHead(fs.readFileSync(files[i]), ids[i]));
  if (dirty.length) return { ok: false, reason: `${dirty.join(', ')} ${dirty.length === 1 ? 'differs' : 'differ'} from HEAD` };
  return { ok: true };
}

/** `entry` (absolute) is safe to run when it and its closure match HEAD. */
function trusted(entry, opts = {}) {
  if (!fs.existsSync(entry)) return { ok: false, reason: `${path.basename(entry)} not found` };
  const v = verify(closure(entry), opts);
  return v.ok ? { ok: true } : { ok: false, reason: `${path.basename(entry)}: ${v.reason}` };
}

/**
 * Require `scripts/lib/<name>` — the project's copy, else the kit's next to this hook — only when trusted. The
 * project's copy is checked against the project root's repository, so a `.git` planted under `scripts/` changes nothing.
 * @returns {{ ok: true, module: any } | { ok: false, reason: string }}
 */
function load(root, hookDir, name, opts = {}) {
  const kit = path.join(hookDir, '..', '..');
  for (const [dir, base] of [[path.join(root, 'scripts', 'lib'), root], [path.join(kit, 'scripts', 'lib'), kit]]) {
    const file = path.resolve(dir, name);
    if (!fs.existsSync(file)) continue;
    const t = trusted(file, { base, ...opts });
    return t.ok ? { ok: true, module: require(file) } : t;
  }
  return { ok: false, reason: `${name} not found` };
}

module.exports = { closure, verify, trusted, load };
