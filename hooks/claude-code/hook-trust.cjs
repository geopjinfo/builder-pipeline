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
const LOCAL = /\brequire\(\s*['"](\.{1,2}(?:\/[^'"]*)?)['"]\s*\)|\bfrom\s+['"](\.{1,2}(?:\/[^'"]*)?)['"]|\bimport\(\s*['"](\.{1,2}(?:\/[^'"]*)?)['"]\s*\)/g;

/** The file Node would load for this specifier (`./b` → `b.js`, `./pkg` → `pkg/index.js`). Resolving executes nothing. */
function resolveLocal(specifier, dir) {
  try {
    return require.resolve(specifier, { paths: [dir] });
  } catch {
    return path.resolve(dir, specifier);
  }
}

/**
 * The entry file and every local file it reaches, as REAL paths. Node resolves a module, and the requires inside it,
 * from its realpath; so does this, or a symlinked file holding an exact copy of a committed one would pass while its
 * own requires load from beside the copy. A specifier is resolved the way Node resolves it, or `./b` would look like
 * a missing path while Node loads `b.js`. What resolves to nothing is left out: nothing can load it, and once someone
 * creates it, it is untracked and refused.
 */
function closure(entry, fsLike = fs) {
  const seen = new Set();
  const walk = (start) => {
    let file;
    let text;
    try {
      file = fsLike.realpathSync(start);
      if (seen.has(file)) return;
      text = fsLike.readFileSync(file, 'utf8');
    } catch {
      return;
    }
    seen.add(file);
    for (const m of text.matchAll(LOCAL)) walk(resolveLocal(m[1] ?? m[2] ?? m[3], path.dirname(file)));
  };
  walk(path.resolve(entry));
  return [...seen];
}

/**
 * Git with nothing from the repository's config that can run a program, and nothing inherited from the caller's
 * environment that could point it at another repository. `rev-parse` reads objects and refs only; it never consults
 * the index or runs fsmonitor, and replace refs are ignored. Windows would otherwise look for a bare `git` in the
 * current folder before PATH, and that folder is agent-writable; it reads this variable from this process's own
 * environment, so it is set here, not only for the child.
 */
function defaultGit(cwd, args) {
  process.env.NoDefaultCurrentDirectoryInExePath = '1';
  const env =Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k)));
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
  // Real paths on both sides: a file whose realpath leaves the repository — through a symlinked file or folder — is
  // outside it, whatever path it was reached by.
  let repo;
  try {
    repo = fs.realpathSync(top.stdout.trim());
  } catch {
    return { ok: false, reason: 'cannot verify against HEAD (repository path does not resolve)' };
  }
  const rels = [];
  const reals = [];
  for (const given of files) {
    let file;
    try {
      file = fs.realpathSync(given);
    } catch {
      return { ok: false, reason: `${path.basename(given)} does not resolve` };
    }
    reals.push(file);
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
  const dirty = rels.filter((rel, i) => !matchesHead(fs.readFileSync(reals[i]), ids[i]));
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
 * THE KIT AS AN INSTALLED PACKAGE. Installed with npm, the kit's scripts live under
 * `node_modules/@geopjinfo/builder-pipeline/` — not in the project's repository, so "matches HEAD" cannot vouch for
 * them. The project's COMMITTED `builder.lock.json` does instead: unpack/upgrade record a hash of every package
 * script under `package.files`, and a package file runs only when the lock matches HEAD (a change to it is a
 * reviewed commit) and the file and every local file it requires hash to what the lock records. An agent that
 * edits a file in node_modules changes its hash; one that edits the lock to match leaves it differing from HEAD.
 */
const PACKAGE = '@geopjinfo/builder-pipeline';
const LOCK = 'builder.lock.json';

/** The installed package's folder as seen from the project, or null (folder layout, or not installed). */
function packageDir(root) {
  try {
    return path.dirname(require.resolve(`${PACKAGE}/package.json`, { paths: [root] }));
  } catch {
    return null;
  }
}

/** sha256 of the text with CRLF read as LF — the hash the installer writes into the lock. */
const textSha = (bytes) => crypto.createHash('sha256').update(Buffer.from(bytes).toString('utf8').replace(/\r\n/g, '\n')).digest('hex');

/** `entry` (inside the package at `pkg`) is safe to run when the committed lock records it and its closure. */
function trustedByLock(entry, { root, pkg, git = defaultGit } = {}) {
  if (!fs.existsSync(entry)) return { ok: false, reason: `${path.basename(entry)} not found` };
  const lockAbs = path.join(root, LOCK);
  if (!fs.existsSync(lockAbs)) return { ok: false, reason: `${path.basename(entry)}: no ${LOCK} records the package (run the kit's unpack or upgrade, then commit the lock)` };
  const v = verify([lockAbs], { base: root, git });
  if (!v.ok) return { ok: false, reason: `${path.basename(entry)}: ${LOCK} cannot vouch for the package — ${v.reason}` };
  let recorded;
  try {
    recorded = JSON.parse(fs.readFileSync(lockAbs, 'utf8')).package?.files || {};
  } catch {
    return { ok: false, reason: `${path.basename(entry)}: ${LOCK} is not valid JSON` };
  }
  let base;
  try {
    base = fs.realpathSync(pkg);
  } catch {
    return { ok: false, reason: `${path.basename(entry)}: the package folder does not resolve` };
  }
  for (const file of closure(entry)) {
    const rel = path.relative(base, file);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return { ok: false, reason: `${path.basename(entry)}: ${path.basename(file)} is outside the package` };
    const key = rel.split(path.sep).join('/');
    if (!recorded[key]) return { ok: false, reason: `${path.basename(entry)}: ${key} is not recorded in ${LOCK} (run the kit's upgrade, then commit the lock)` };
    if (recorded[key] !== textSha(fs.readFileSync(file))) return { ok: false, reason: `${path.basename(entry)}: ${key} differs from ${LOCK}` };
  }
  return { ok: true };
}

/**
 * Find kit file `scripts/<rel>` for this project and check it: the project's copy (folder layout, checked against
 * HEAD), else the installed package's (checked against the committed lock), else the kit beside this hook (the kit's
 * own repository, checked against HEAD). The first that exists decides — a later one is never a fallback for an
 * untrusted earlier one.
 * @returns {{ ok: true, file: string } | { ok: false, reason: string }}
 */
function locate(root, hookDir, rel, opts = {}) {
  const pkg = packageDir(root);
  const kit = path.join(hookDir, '..', '..');
  const candidates = [
    [path.join(root, 'scripts', rel), (f) => trusted(f, { base: root, ...opts })],
    ...(pkg ? [[path.join(pkg, 'scripts', rel), (f) => trustedByLock(f, { root, pkg, ...opts })]] : []),
    [path.join(kit, 'scripts', rel), (f) => trusted(f, { base: kit, ...opts })],
  ];
  for (const [candidate, check] of candidates) {
    const file = path.resolve(candidate);
    if (!fs.existsSync(file)) continue;
    const t = check(file);
    return t.ok ? { ok: true, file } : t;
  }
  return { ok: false, reason: `${path.basename(rel)} not found` };
}

/**
 * Require `scripts/lib/<name>` — the project's copy, else the installed package's, else the kit's next to this hook —
 * only when trusted (locate() above). The project's copy is checked against the project root's repository, so a
 * `.git` planted under `scripts/` changes nothing.
 * @returns {{ ok: true, module: any } | { ok: false, reason: string }}
 */
function load(root, hookDir, name, opts = {}) {
  const r = locate(root, hookDir, path.join('lib', name), opts);
  return r.ok ? { ok: true, module: require(r.file) } : r;
}

module.exports = { closure, verify, trusted, trustedByLock, packageDir, textSha, locate, load, PACKAGE, LOCK };
