/**
 * Every board row's `Cites` id must resolve to its source. Rule: scripts/lib/citations.cjs.
 *
 *   npx builder run citations-check                  every board in paths.boards (files named _*.md and README.md skipped)
 *   npx builder run citations-check <board.md> …    exactly these boards
 *   --list                                           every token with its verdict, scheme and path:line
 *   --json                                           machine-readable results
 * (folder layout: node scripts/citations-check.mjs in place of npx builder run citations-check)
 *
 * Settings: paths.boards · features.citations.schemes — each { name, pattern, skip?, ignoreCase?, source } where
 * source is one of { csv, column } · { dir, filePattern } · { files: [paths], idPattern } (a directory entry in
 * `files` is walked recursively). `dir` is one path or a list of paths — every directory is read and the ids are
 * merged into one set, so records kept in two folders resolve from either; each must exist. Paths resolve against the project root. Off → "citations: not configured", exit 0.
 *
 * No board files → "citations-check: no boards to check", exit 0 (said, never PASS).
 *
 * Exit 0 PASS · 1 any UNRESOLVED id, a scheme whose source yields zero ids, or boards with no Cites column ·
 *      2 an invalid profile, a missing boards directory, or a missing / unreadable source.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { runHint } = require('./lib/run-hint.cjs');
const lib = require('./lib/citations.cjs');
const profile = require('./lib/profile.cjs');

const NAME = 'citations-check';
const loaded = profile.load(process.cwd());
if (loaded.errors.length > 0) {
  console.error(`${NAME}: PIPELINE_PROFILE.md is invalid — run ${runHint('features')}`);
  for (const e of loaded.errors) console.error(`  ${e}`);
  process.exit(2);
}
const feature = profile.feature(loaded.settings, 'citations');
if (!feature.enabled) {
  console.log(feature.line);
  process.exit(0);
}

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const list = args.includes('--list');
const slash = (p) => p.replace(/\\/g, '/');

const die = (message) => {
  console.error(`${NAME}: ${message}`);
  process.exit(2);
};

/* ── sources: every scheme's id set, loaded before a single token is judged ─────────────────────────────────── */
const walkFiles = (p, out = []) => {
  if (statSync(p).isDirectory()) for (const entry of readdirSync(p).sort()) walkFiles(join(p, entry), out);
  else out.push(p);
  return out;
};

const schemes = lib.compileSchemes(feature.config.schemes);
for (const scheme of schemes) {
  const src = scheme.source;
  const flags = scheme.ignoreCase ? 'i' : '';
  const dirs = src.dir === undefined ? [] : [].concat(src.dir);
  const paths = src.csv !== undefined ? [src.csv] : src.dir !== undefined ? dirs : src.files;
  for (const p of paths) if (!existsSync(p)) die(`source missing — ${slash(p)} (scheme "${scheme.name}"). A source that is not there resolves nothing; fix the path, never read it as a pass.`);
  let ids;
  try {
    if (src.csv !== undefined) ids = lib.idsFromCsv(readFileSync(src.csv, 'utf8'), src.column);
    else if (src.dir !== undefined) ids = lib.idsFromNames(dirs.flatMap((d) => readdirSync(d).filter((f) => statSync(join(d, f)).isFile())), src.filePattern, flags);
    else ids = lib.idsFromTexts(src.files.flatMap((p) => walkFiles(p)).map((f) => readFileSync(f, 'utf8')), src.idPattern, flags);
  } catch (e) {
    die(`source unreadable — ${slash(paths[0])} (scheme "${scheme.name}"): ${e.message}`);
  }
  scheme.ids = lib.idSet(scheme, ids);
  scheme.from = slash(paths.join(', '));
}

/* ── boards ─────────────────────────────────────────────────────────────────────────────────────────────────── */
const named = args.filter((a) => !a.startsWith('--'));
const dir = loaded.settings.paths.boards;
if (named.length === 0 && !existsSync(dir)) die(`no boards directory ${slash(dir)} (paths.boards)`);
for (const f of named) if (!existsSync(f)) die(`board missing — ${slash(f)}`);
const boards = (
  named.length
    ? named
    : readdirSync(dir)
        .filter((f) => f.endsWith('.md') && !f.startsWith('_') && f !== 'README.md')
        .sort()
        .map((f) => join(dir, f))
).map(slash);

const problems = [];
for (const s of schemes) {
  if (s.ids.size === 0) {
    problems.push(
      `scheme "${s.name}" resolves against zero ids from ${s.from} — a set of nothing resolves nothing and rejects nothing, so every token it owns was judged against a blank`,
    );
  }
}

let results = [];
let withCites = 0;
for (const board of boards) {
  const scan = lib.scanBoard(readFileSync(board, 'utf8'), board);
  if (scan.hasCites) withCites += 1;
  results = results.concat(lib.judge(scan.sites, schemes));
}
if (boards.length > 0 && withCites === 0) {
  problems.push(`${boards.length} board(s) read and none has a Cites column — the board format requires it, and a check that saw no column checked nothing`);
}
const unresolved = results.filter((r) => r.verdict === 'UNRESOLVED');
if (unresolved.length > 0) problems.push(`${unresolved.length} citation(s) do not resolve`);
const c = lib.counts(results);

if (asJson) {
  console.log(
    JSON.stringify(
      {
        feature: feature.line,
        boards,
        boardsWithCites: withCites,
        schemes: schemes.map((s) => ({ name: s.name, source: s.from, ids: s.ids.size })),
        counts: c,
        results,
        problems,
        verdict: boards.length === 0 && problems.length === 0 ? 'NO-BOARDS' : problems.length ? 'FAIL' : 'PASS',
      },
      null,
      2,
    ),
  );
  process.exit(problems.length ? 1 : 0);
}

if (list) for (const r of results) console.log(`${r.verdict.padEnd(14)} ${r.scheme.padEnd(12)} ${r.token.padEnd(28)} ${r.path}:${r.line}`);

if (problems.length === 0 && boards.length === 0) {
  console.log(`${NAME}: no boards to check`);
  process.exit(0);
}
if (problems.length > 0) {
  for (const r of unresolved) console.error(`  UNRESOLVED ${r.token}  (${r.scheme})  at ${r.path}:${r.line}`);
  if (unresolved.length > 0) {
    console.error('  An id in a known scheme that resolves to nothing is the invented-fact shape: correct it against its source, or move it to prose if it was never an id.');
  }
  console.error(`${NAME}: FAIL — ${problems.join(' · ')}`);
  process.exit(1);
}
console.log(`${NAME}: PASS — ${c.resolved} resolved, ${c.prose} prose (not-evaluable), 0 unresolved, across ${boards.length} board(s)`);
