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
/**
 * The path the OS itself reports. git prints the repository's final path; Node's JS realpath keeps a subst drive or a
 * Windows short (8.3) name such as RUNNER~1 as given, so the two spellings of one folder would compare as different
 * folders and every file would look outside the repository. Both sides go through the native call.
 */
function realOf(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return fs.realpathSync(p);
  }
}

function verify(files, { base = files.length ? path.dirname(files[0]) : '.', git = defaultGit } = {}) {
  if (files.length === 0) return { ok: false, reason: 'nothing to verify' };
  const top = git(base, ['rev-parse', '--show-toplevel']);
  if (top.status !== 0 || !top.stdout.trim()) return { ok: false, reason: 'cannot verify against HEAD (no git repository)' };
  // Real paths on both sides: a file whose realpath leaves the repository — through a symlinked file or folder — is
  // outside it, whatever path it was reached by.
  let repo;
  try {
    repo = realOf(top.stdout.trim());
  } catch {
    return { ok: false, reason: 'cannot verify against HEAD (repository path does not resolve)' };
  }
  const rels = [];
  const reals = [];
  for (const given of files) {
    let file;
    try {
      file = realOf(given);
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
 * THE KIT AS AN INSTALLED PACKAGE. Installed with npm, the kit's scripts live in node_modules — not in the project's
 * repository and writable by any agent — so a hook NEVER loads anything from there (no hash taken in that tree can
 * vouch for it). unpack/upgrade instead copy the few scripts the hooks use next to them, into a `kit/` folder beside
 * this file (mirroring scripts/): kit-owned, locked, committed with the project, and checked against HEAD like any
 * project file.
 */
const VENDORED = 'kit';
const UNDER_NODE_MODULES = /(^|[\\/])node_modules([\\/]|$)/;

/**
 * Find kit file `scripts/<rel>` for this project and check it against HEAD: the copy vendored beside the hooks
 * (package layout), else the project's scripts/ copy (folder layout), else the kit beside this hook (the kit's own
 * repository). The first that exists decides — a later one is never a fallback for an untrusted earlier one — and a
 * file under node_modules, or one that requires a file there, is refused outright.
 *
 * The vendored copy comes first because only a package install writes it: a project that moved from the folder layout
 * to the package keeps its old scripts/ copies until `upgrade --prune` removes them, and a hook must run the release the
 * package vendored, not the one the folder copy froze.
 * @returns {{ ok: true, file: string } | { ok: false, reason: string }}
 */
function locate(root, hookDir, rel, opts = {}) {
  const kit = path.join(hookDir, '..', '..');
  const candidates = [
    [path.join(hookDir, VENDORED, rel), root],
    [path.join(root, 'scripts', rel), root],
    [path.join(kit, 'scripts', rel), kit],
  ];
  for (const [candidate, base] of candidates) {
    const file = path.resolve(candidate);
    if (!fs.existsSync(file)) continue;
    const inModules = [file, ...closure(file)].find((f) => UNDER_NODE_MODULES.test(f));
    if (inModules) return { ok: false, reason: `${path.basename(rel)}: ${inModules} is under node_modules — a hook never runs code from there` };
    const t = trusted(file, { base, ...opts });
    return t.ok ? { ok: true, file } : t;
  }
  return { ok: false, reason: `${path.basename(rel)} not found` };
}

/**
 * Require `scripts/lib/<name>` — the copy vendored beside the hooks, else the project's copy, else the kit's next to
 * this hook — only when trusted (locate() above). A project copy is checked against the project root's repository,
 * so a `.git` planted under `scripts/` changes nothing.
 * @returns {{ ok: true, module: any } | { ok: false, reason: string }}
 */
function load(root, hookDir, name, opts = {}) {
  const r = locate(root, hookDir, path.join('lib', name), opts);
  return r.ok ? { ok: true, module: require(r.file) } : r;
}

module.exports = { closure, verify, trusted, locate, load, VENDORED };
