/**
 * A catalogue row is cited by KEY, never by LINE. Rule: scripts/lib/line-citations.cjs.
 *
 *   npx builder run line-citations-check             the gate — every catalogue line citation outside the roster fails
 *   npx builder run line-citations-check --list     also print every offending site
 *   npx builder run line-citations-check --stale    the MEASUREMENT, not the gate: each offender paired with the
 *                                                    catalogue key before it on its line, cited line vs actual line
 * (folder layout: node scripts/line-citations-check.mjs in place of npx builder run line-citations-check)
 *
 * Settings: paths.logs · features.lineCitations — catalogues (paths; their basenames are what a citation names),
 * roots (walked recursively), extensions, roster (null, or a JSON file { "files": [...], "total": N }), control
 * (null, or a regex that must match somewhere in the walk), minFiles, keyColumn (the key cell of a catalogue row, for
 * --stale). Skipped directories: node_modules, .git, dist, coverage and paths.logs. This script, its lib and the
 * roster file are excluded by their exact paths. Off → "lineCitations: not configured", exit 0.
 *
 * The positive control runs FIRST and is fatal: at least minFiles files walked, and a control match (or, with no
 * control, at least one other line citation) seen — otherwise zero offenders proves nothing.
 *
 * Exit 0 PASS (or --stale: nothing stale / not evaluable) · 1 an offender outside the roster, a dead roster entry,
 *      a rostered offender count that differs from the roster total (above it is a new offender; below it is slack
 *      a new offender could hide in — lower "total" to the number the message names), a failed positive control,
 *      or (--stale) any stale pairing ·
 *      2 an invalid profile, a missing root / catalogue / roster, a malformed roster, or (--stale) a catalogue with
 *      no keys at keyColumn.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { runHint } = require('./lib/run-hint.cjs');
const lib = require('./lib/line-citations.cjs');
const profile = require('./lib/profile.cjs');

const NAME = 'line-citations-check';
const loaded = profile.load(process.cwd());
if (loaded.errors.length > 0) {
  console.error(`${NAME}: PIPELINE_PROFILE.md is invalid — run ${runHint('features')}`);
  for (const e of loaded.errors) console.error(`  ${e}`);
  process.exit(2);
}
const feature = profile.feature(loaded.settings, 'lineCitations');
if (!feature.enabled) {
  console.log(feature.line);
  process.exit(0);
}

const cfg = feature.config;
const cwd = process.cwd();
const args = process.argv.slice(2);
const list = args.includes('--list');
const staleMode = args.includes('--stale');
const slash = (p) => p.replace(/\\/g, '/');
const die = (message) => {
  console.error(`${NAME}: ${message}`);
  process.exit(2);
};

for (const c of cfg.catalogues) if (!existsSync(c)) die(`catalogue missing — ${slash(c)}. A citation names a basename; a catalogue that is not there makes that name a guess.`);
for (const r of cfg.roots) if (!existsSync(r)) die(`root missing — ${slash(r)}`);

let roster = null;
if (cfg.roster) {
  if (!existsSync(cfg.roster)) die(`roster missing — ${slash(cfg.roster)}`);
  try {
    roster = JSON.parse(readFileSync(cfg.roster, 'utf8'));
  } catch (e) {
    die(`roster ${slash(cfg.roster)} is not valid JSON — ${e.message}`);
  }
  const errors = lib.rosterErrors(roster);
  if (errors.length) die(`roster ${slash(cfg.roster)} is malformed — ${errors.join('; ')}`);
}

/*
 * Excluded by identity, never by pattern: the two files running now, and the roster. On Windows the same path can
 * differ in drive-letter case, so paths compare case-folded there.
 */
const key = (p) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));
const SELF = new Set([fileURLToPath(import.meta.url), require.resolve('./lib/line-citations.cjs'), ...(cfg.roster ? [resolve(cwd, cfg.roster)] : [])].map(key));

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage']);
const logs = slash(loaded.settings.paths.logs ?? '').replace(/^\.\//, '').replace(/\/$/, '');
const extensions = new Set(cfg.extensions.map((e) => (e.startsWith('.') ? e : `.${e}`).toLowerCase()));

const walk = (dir, out) => {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const rel = slash(relative(cwd, p));
    if (statSync(p).isDirectory()) {
      if (SKIP_DIRS.has(entry) || (logs && (rel === logs || (!logs.includes('/') && entry === logs)))) continue;
      walk(p, out);
    } else if (extensions.has(extname(entry).toLowerCase()) && !SELF.has(key(p))) out.set(key(p), p);
  }
  return out;
};
/* A root may name a single file; the exclusion holds there too, or naming the roster as a root would walk it. */
const files = [
  ...cfg.roots
    .reduce((acc, r) => {
      if (statSync(r).isDirectory()) return walk(r, acc);
      return SELF.has(key(r)) || !extensions.has(extname(r).toLowerCase()) ? acc : acc.set(key(r), r);
    }, new Map())
    .values(),
].sort();

const index = lib.catalogueIndex(cfg.catalogues);
const control = cfg.control ? new RegExp(cfg.control) : null;
let keysByCatalogue = null;
if (staleMode) {
  keysByCatalogue = new Map();
  for (const c of cfg.catalogues) {
    const keys = lib.loadKeyLines(readFileSync(c, 'utf8'), lib.baseName(c), cfg.keyColumn);
    if (keys.size === 0) die(`catalogue ${slash(c)} yields no keys at keyColumn ${cfg.keyColumn} — the stale measurement has nothing to compare against`);
    keysByCatalogue.set(lib.baseName(c).toLowerCase(), keys);
  }
}

let offenders = [];
let other = 0;
let controlHits = 0;
const pairs = [];
for (const file of files) {
  const rel = slash(relative(cwd, file));
  const text = readFileSync(file, 'utf8');
  const scan = lib.scanText(text, rel, index, control);
  offenders = offenders.concat(scan.offenders);
  other += scan.other;
  controlHits += scan.controlHits;
  if (staleMode && scan.offenders.length) {
    const lines = text.split(/\r?\n/);
    for (const n of new Set(scan.offenders.map((o) => o.line))) {
      for (const p of lib.pairOn(lines[n - 1], index, keysByCatalogue)) pairs.push({ file: rel, line: n, ...p });
    }
  }
}

const failedControl = lib.positiveControl({ files: files.length, minFiles: cfg.minFiles, control: cfg.control, controlHits, other });
if (failedControl) {
  console.error(`${NAME}: FAIL — ${failedControl}`);
  process.exit(1);
}
const seen = cfg.control ? `${controlHits} control match(es)` : `${other} other line citation(s)`;
const judged = lib.judgeRoster(offenders, roster);
const rosteredFiles = new Set(judged.rostered.map((o) => o.file));

if (staleMode) {
  const paired = pairs.filter((p) => p.key !== null);
  const stale = paired.filter((p) => p.actual !== p.cited);
  const unpaired = pairs.length - paired.length;
  if (offenders.length === 0) {
    console.log(`${NAME} --stale: no catalogue line citations to measure (${files.length} file(s) walked, ${seen})`);
    process.exit(0);
  }
  if (paired.length === 0) {
    console.log(`${NAME} --stale: NOT-EVALUABLE — ${offenders.length} catalogue line citation(s), none beside a key of its catalogue, so zero stale proves nothing`);
    process.exit(0);
  }
  for (const s of stale) {
    console.log(`  ${s.file}:${s.line} — ${s.key} cited ${s.cite}, actually :${s.actual}${rosteredFiles.has(s.file) ? ' (rostered)' : ''}`);
  }
  console.log(`${NAME} --stale: ${stale.length} STALE of ${paired.length} paired catalogue line citation(s), ${unpaired} unpaired`);
  process.exit(stale.length ? 1 : 0);
}

if (list) for (const o of offenders) console.log(`  ${o.file}:${o.line} — cites \`${o.cite}\`${rosteredFiles.has(o.file) ? ' (rostered)' : ''}`);

const problems = [];
for (const o of judged.unrostered) console.error(`  ${o.file}:${o.line} — cites the catalogue as \`${o.cite}\`; cite the row's KEY by name`);
if (judged.unrostered.length) {
  problems.push(`${judged.unrostered.length} catalogue line citation(s) outside the roster — a line number rots the moment a row is inserted above it, and reads as verification while naming a different row`);
}
for (const f of judged.dead) console.error(`  dead roster entry: ${f} no longer cites a catalogue by line — delete it from ${slash(cfg.roster)}`);
if (judged.dead.length) problems.push(`${judged.dead.length} dead roster entr${judged.dead.length === 1 ? 'y' : 'ies'} — the roster is shrink-only; delete the entry`);
if (judged.over) problems.push(`${judged.rostered.length} rostered offender(s) exceed the roster total ${judged.total} — the roster may only shrink`);
if (judged.under) {
  problems.push(
    `the roster total ${judged.total} is above the ${judged.rostered.length} rostered offender(s) — slack is room for a new offender to slip in unnoticed; lower "total" to ${judged.rostered.length} in ${slash(cfg.roster)}`,
  );
}

if (problems.length) {
  console.error(`${NAME}: FAIL — ${problems.join(' · ')}`);
  process.exit(1);
}
const rosterPart = roster ? `, ${judged.rostered.length} rostered (total ${judged.total})` : '';
console.log(`${NAME}: PASS — 0 catalogue line citation(s) outside the roster${rosterPart}, ${files.length} file(s) walked, ${seen} (positive control OK)`);
