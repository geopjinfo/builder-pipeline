'use strict';
/**
 * docs-check — what a project's general documents point at must exist (specs/repo-hygiene.spec.md REQ-1822, D92).
 *
 * WHY. The instruction lint keeps the agent-instruction files true of the repo. README and docs/ drift the same way:
 * a renamed file, a heading that was reworded, a script that was dropped. Nobody re-reads them, and a reader who
 * follows a dead link stops trusting the rest. This check reads every Markdown file under the configured roots and
 * asks four questions, each answered from the file system and the kit's own script list, never from the network:
 *
 *   BROKEN-PATH     an inline-code repo path (`src/x.js`) does not resolve — the lint's resolver, imported, decides
 *   BROKEN-LINK     a relative link target ([text](docs/x.md), ![img](a.png), [id]: x.md) is no file or folder
 *   BROKEN-ANCHOR   a `#anchor` on a Markdown target (or on the file itself) is no heading there (the GitHub slug rule)
 *   UNKNOWN-SCRIPT  `npx builder-pipeline run <name>` names no shipped script (inline code or a fenced block)
 *
 * An external URL (a scheme, or `//host`) is skipped, never fetched: a document check that depends on a remote host
 * is flaky and leaks the project's paths. `ignorePaths` (regular expressions) suppresses by the document path and by
 * the target. Pure over (path, text) pairs plus an `exists` oracle; the script reads files.
 */
const fs = require('fs');
const path = require('path');
const { makeResolver, pathCandidates, proseLines } = require('./instruction-lint.cjs');

const KINDS = ['BROKEN-PATH', 'BROKEN-LINK', 'BROKEN-ANCHOR', 'UNKNOWN-SCRIPT'];
const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;
const RUN_CMD = /\bnpx\s+(?:--no(?:-install)?\s+)?builder-pipeline\s+run\s+([a-z][a-z0-9-]*)/g;
const SKIP_DIRS = new Set(['.git', 'node_modules']);

/** GitHub's heading slug: lowercase, punctuation removed, spaces to hyphens, repeats suffixed -1, -2, … */
function slug(heading) {
  const text = heading.replace(/`([^`]*)`/g, '$1').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim().toLowerCase();
  return text.replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-');
}
function headingSlugs(md) {
  const seen = new Map();
  const out = [];
  for (const { line } of proseLines(md)) {
    const m = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const base = slug(m[1]);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.push(n === 0 ? base : `${base}-${n}`);
  }
  return out;
}

/** Link targets outside fenced code and inline code: { n, target } for [t](x), ![t](x) and [id]: x. */
function linkTargets(md) {
  const out = [];
  for (const { n, line } of proseLines(md)) {
    const bare = line.replace(/`[^`]*`/g, (m) => ' '.repeat(m.length));
    for (const m of bare.matchAll(/!?\[[^\]]*\]\(\s*(<[^>]*>|[^\s)]+)(?:\s+"[^"]*")?\s*\)/g)) out.push({ n, target: m[1].replace(/^<|>$/g, '') });
    const def = /^\s*\[[^\]]+\]:\s*(<[^>]*>|\S+)/.exec(bare);
    if (def) out.push({ n, target: def[1].replace(/^<|>$/g, '') });
  }
  return out;
}

/** `run <name>` commands anywhere in the text (prose, inline code and fenced blocks): { n, name }. */
function runCommands(md) {
  const out = [];
  md.split(/\r?\n/).forEach((line, i) => {
    for (const m of line.matchAll(RUN_CMD)) out.push({ n: i + 1, name: m[1] });
  });
  return out;
}

const posix = (p) => p.split(path.sep).join('/');
/** Every file under `root` as a root-relative posix path, skipping .git and node_modules. */
function index(root) {
  const out = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) out.push(posix(path.relative(root, full)));
    }
  };
  walk(root);
  return out;
}
/** The Markdown files under `roots` (files or folders, root-relative), sorted, as root-relative posix paths. */
function markdownFiles(root, roots) {
  const out = new Set();
  for (const r of roots) {
    const full = path.join(root, r);
    if (!fs.existsSync(full)) continue;
    if (fs.statSync(full).isFile()) { if (/\.md$/i.test(r)) out.add(posix(path.normalize(r))); continue; }
    for (const p of index(full)) if (/\.md$/i.test(p)) out.add(posix(path.join(r, p)));
  }
  return [...out].sort();
}
const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');

/** The shipped script names of the kit this lib belongs to: scripts/<name>.mjs|.cjs beside this lib's folder. */
function shippedScripts(kitRoot = path.join(__dirname, '..', '..')) {
  const dir = path.join(kitRoot, 'scripts');
  if (!fs.existsSync(dir)) return new Set();
  return new Set(fs.readdirSync(dir).filter((f) => /\.(mjs|cjs)$/.test(f)).map((f) => f.replace(/\.(mjs|cjs)$/, '')));
}

/**
 * @param {{ path: string, text: string }[]} files   root-relative posix paths and their text
 * @param {{ root: string, scripts: Set<string>, ignorePaths?: string[], index?: string[], exists?: (rel: string) => boolean, fetch?: Function }} opts
 *   `fetch` is accepted and never called: the contract that no document check reaches the network (REQ-1822).
 * @returns {{ ok: boolean, findings: { kind: string, file: string, line: number, target: string, detail: string }[], files: number }}
 */
function check(files, opts) {
  const { root, scripts, ignorePaths = [] } = opts;
  const all = opts.index ?? index(root);
  const exists = opts.exists ?? ((rel) => fs.existsSync(path.join(root, rel)));
  const resolver = makeResolver({ exists, index: all });
  const ignore = ignorePaths.map((p) => new RegExp(p));
  const skip = (...texts) => texts.some((t) => ignore.some((re) => re.test(t)));
  const findings = [];
  const add = (kind, file, line, target, detail) => { if (!skip(file, target)) findings.push({ kind, file, line, target, detail }); };
  const slugCache = new Map();
  const slugsOf = (rel) => {
    if (!slugCache.has(rel)) {
      const own = files.find((f) => f.path === rel);
      const text = own ? own.text : exists(rel) ? read(root, rel) : null;
      slugCache.set(rel, text === null ? null : new Set(headingSlugs(text)));
    }
    return slugCache.get(rel);
  };
  const dirExists = (seg) => exists(seg);

  for (const { path: file, text } of files) {
    const here = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';
    const fromHere = (t) => (here ? resolver.fromFile(t, file) : t);
    for (const { n, token } of pathCandidates(text, { dirExists })) {
      if (!resolver.resolves(token, file)) add('BROKEN-PATH', file, n, token, 'does not exist');
    }
    for (const { n, target } of linkTargets(text)) {
      if (EXTERNAL.test(target)) continue; // never fetched
      const [rawPath, ...rest] = target.split('#');
      const anchor = rest.join('#');
      let rel = decodeURIComponent(rawPath).replace(/^\.\//, '');
      if (rel && /[<>{}*?…|$]/.test(rel)) continue; // a placeholder, not a link to check
      if (rel) {
        rel = rel.startsWith('/') ? rel.slice(1) : fromHere(rel);
        if (!exists(rel)) { add('BROKEN-LINK', file, n, target, `${rel} does not exist`); continue; }
      } else rel = file;
      if (!anchor || !/\.md$/i.test(rel)) continue;
      const slugs = slugsOf(rel);
      if (slugs && !slugs.has(anchor.toLowerCase())) add('BROKEN-ANCHOR', file, n, target, `no heading "${anchor}" in ${rel}`);
    }
    for (const { n, name } of runCommands(text)) {
      if (!scripts.has(name)) add('UNKNOWN-SCRIPT', file, n, name, 'no shipped script of that name');
    }
  }
  return { ok: findings.length === 0, findings, files: files.length };
}

module.exports = { KINDS, check, headingSlugs, linkTargets, runCommands, markdownFiles, index, read, shippedScripts, slug };
