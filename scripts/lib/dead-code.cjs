'use strict';
/**
 * dead-code — orphan source files on a ratchet bank, and TODO markers older than their welcome (specs/repo-hygiene.spec.md
 * REQ-1823, REQ-1824, D91; EXPERIMENTS §23). Experimental: off, nothing of it runs.
 *
 * WHY. A file nobody imports keeps being read by every agent that walks the tree, and a TODO from last year is a
 * decision nobody made. Both are cheap to find and expensive to judge, so this check reports and never deletes.
 *
 *   ORPHAN      a file under `roots` with an extension in `extensions` that no other file imports (require, import … from,
 *               import(), export … from, a bare import; a relative specifier with or without its extension, or a folder
 *               with an index file) and that is not an entry: package.json `main`, `module`, `browser`, `types`, `bin`,
 *               `exports`, a file matching the test pattern, or an `entries` glob
 *   the bank    `baseline` is a ratchet bank (scripts/lib/ratchet.cjs): a new ORPHAN is REFUSED (exit 1), one that is no
 *               longer measured is DRAINED and the bank shrinks; a hand edit that grows the bank fails its own count
 *   STALE-TODO  a TODO, FIXME, HACK or XXX marker whose line is older than `todoDays` by `git blame`, with the age in
 *               days; the author is never printed (the finding is about the line, not the person); reported, never failed
 *
 * The rate of false ORPHANs is the experiment: a dynamic import by a built path, a framework convention or a generated
 * file is an import this reader cannot see. EXPERIMENTS §23 measures it before the feature can gate. Pure over file
 * lists and texts; `blame` is the one impure seam.
 */
const path = require('path');
const { spawnSync } = require('child_process');
const { specifiers } = require('./deps-check.cjs');

const DEFAULT_TEST_PATTERN = '\\.(test|spec)\\.[cm]?[jt]sx?$';
const MARKER = /\b(TODO|FIXME|HACK|XXX)\b/;

/** A glob (`**`, `*`, `?`) as a regular expression over a posix path. */
function globToRegex(glob) {
  const g = glob.replace(/\\/g, '/').replace(/^\.\//, '');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') { re += g[i + 2] === '/' ? '(?:.*/)?' : '.*'; i += g[i + 2] === '/' ? 2 : 1; }
      else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

const norm = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '').split('/').reduce((acc, s) => (s === '..' ? acc.slice(0, -1) : s === '.' || s === '' ? acc : [...acc, s]), []).join('/');

/** The files a manifest names as entries: main, module, browser, types, bin (string or map) and every string in exports. */
function manifestEntries(manifest) {
  const out = new Set();
  if (!manifest || typeof manifest !== 'object') return out;
  for (const k of ['main', 'module', 'browser', 'types', 'typings']) if (typeof manifest[k] === 'string') out.add(norm(manifest[k]));
  if (typeof manifest.bin === 'string') out.add(norm(manifest.bin));
  else if (manifest.bin && typeof manifest.bin === 'object') for (const v of Object.values(manifest.bin)) if (typeof v === 'string') out.add(norm(v));
  const walk = (v) => {
    if (typeof v === 'string') out.add(norm(v));
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  if (manifest.exports !== undefined) walk(manifest.exports);
  return out;
}

/** The file a relative specifier names, as one of `fileSet`, or null (a package or an unresolved path). */
function resolveImport(fromFile, spec, fileSet, extensions) {
  if (!/^\.\.?\//.test(spec)) return null;
  const base = norm(path.posix.join(path.posix.dirname(fromFile), spec));
  const tries = [base, ...extensions.map((e) => base + e), ...extensions.map((e) => `${base}/index${e}`)];
  // a TypeScript source imported by its emitted `.js` name
  if (/\.js$/.test(base)) tries.push(base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'));
  return tries.find((t) => fileSet.has(t)) ?? null;
}

/**
 * The ORPHAN files, sorted.
 * @param {{ files: string[], read: (f: string) => string, manifest?: object, entries?: string[], testPattern?: string, extensions: string[] }} o
 */
function orphans({ files, read, manifest = null, entries = [], testPattern = DEFAULT_TEST_PATTERN, extensions }) {
  const fileSet = new Set(files.map(norm));
  const imported = new Set();
  for (const f of fileSet) {
    let text = '';
    try { text = read(f) ?? ''; } catch { continue; }
    for (const s of specifiers(text)) {
      const hit = resolveImport(f, s, fileSet, extensions);
      if (hit && hit !== f) imported.add(hit);
    }
  }
  const named = manifestEntries(manifest);
  const test = new RegExp(testPattern);
  const globs = entries.map(globToRegex);
  return [...fileSet].filter((f) => !imported.has(f) && !named.has(f) && !test.test(f) && !globs.some((g) => g.test(f))).sort();
}

/** The marker lines of a text: { line, kind, text }. */
function markers(text) {
  const out = [];
  text.split(/\r?\n/).forEach((l, i) => {
    const m = MARKER.exec(l);
    if (m) out.push({ line: i + 1, kind: m[1], text: l.trim() });
  });
  return out;
}

/**
 * `git blame --porcelain` of one file: Map<line, committerTimeSeconds>, or null when blame failed (not a repository, the
 * file is untracked). An uncommitted line carries the time of the blame run, so it is never stale. The author lines are
 * read past and never returned.
 */
function blame(root, file, env = process.env) {
  const r = spawnSync('git', ['blame', '--porcelain', '--', file], { cwd: root, encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) return null;
  const times = new Map();
  const bySha = new Map();
  let current = null;
  for (const line of r.stdout.split('\n')) {
    const head = /^([0-9a-f]{40}) (\d+) (\d+)(?: (\d+))?$/.exec(line);
    if (head) { current = { sha: head[1], final: Number(head[3]) }; if (bySha.has(current.sha)) times.set(current.final, bySha.get(current.sha)); continue; }
    if (current && line.startsWith('committer-time ')) { const t = Number(line.slice('committer-time '.length)); bySha.set(current.sha, t); times.set(current.final, t); }
  }
  return times;
}

/** The STALE-TODO findings of one file given its blame times: { file, line, kind, days }. */
function staleMarkers(file, text, times, todoDays, nowSeconds = Math.floor(Date.now() / 1000)) {
  const out = [];
  for (const m of markers(text)) {
    const t = times.get(m.line);
    if (t === undefined) continue;
    const days = Math.floor((nowSeconds - t) / 86400);
    if (days > todoDays) out.push({ file, line: m.line, kind: m.kind, days });
  }
  return out;
}

module.exports = { DEFAULT_TEST_PATTERN, MARKER, globToRegex, manifestEntries, resolveImport, orphans, markers, blame, staleMarkers, norm };
