#!/usr/bin/env node
/**
 * Regenerate the decision index from the anchors themselves. Rule: scripts/lib/decision-index.cjs.
 *
 *   npx builder run decision-index             write features.decisionIndex.out — only when its content changed
 *   npx builder run decision-index --check    write nothing; fail when the index is stale or missing, or when any
 *                                              id is cited but never anchored, or anchored more than once
 * (folder layout: node scripts/decision-index.mjs in place of npx builder run decision-index)
 *
 * Settings: features.decisionIndex.{roots, idPattern, out}. A root is a file or a directory, relative to the
 * project root; directories are walked for .md .txt .mjs .cjs .js .ts .py .json .yml .yaml, skipping
 * node_modules, .git and the `out` file itself (a corpus that indexes itself reports its own examples as data).
 * Off → "decisionIndex: not configured", exit 0.
 *
 * Line endings are ignored when comparing with the existing file, so a checkout that converts them does not
 * read as stale; a write happens only when the text differs.
 *
 * Exit codes
 *   0  index current (or written) and every id anchored exactly once · feature not configured
 *   1  --check: index stale or missing · any run: an id cited but never anchored, or anchored more than once
 *      (the default run still writes the index, so the gap is visible in it)
 *   2  an invalid profile, a root that does not exist, or no file to read under the roots
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const require = createRequire(import.meta.url);
const { runHint } = require('./lib/run-hint.cjs');
const profile = require('./lib/profile.cjs');
const decisions = require('./lib/decision-index.cjs');

const EXTENSIONS = new Set(['.md', '.txt', '.mjs', '.cjs', '.js', '.ts', '.py', '.json', '.yml', '.yaml']);
const SKIP_DIRS = new Set(['node_modules', '.git']);
const check = process.argv.includes('--check');
const usage = (message) => {
  console.error(`decision-index: ${message}`);
  process.exit(2);
};

const root = process.cwd();
const loaded = profile.load(root);
if (loaded.errors.length > 0) usage(`PIPELINE_PROFILE.md is invalid — run ${runHint('features')}\n  ${loaded.errors.join('\n  ')}`);
const feature = profile.feature(loaded.settings, 'decisionIndex');
if (!feature.enabled) {
  console.log(feature.line);
  process.exit(0);
}
const { roots, idPattern } = feature.config;
const at = (p) => (isAbsolute(p) ? p : resolve(root, p));
const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
const rel = (p) => relative(root, p).split(sep).join('/');
const outPath = at(feature.config.out);

const files = [];
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (EXTENSIONS.has(extname(e.name).toLowerCase()) && !same(resolve(p), outPath)) files.push(p);
  }
};
for (const r of roots) {
  const p = at(r);
  if (!existsSync(p)) usage(`root ${r} does not exist — a missing root would index nothing and look clean`);
  if (statSync(p).isDirectory()) walk(p);
  else if (!same(resolve(p), outPath)) files.push(p);
}
const unique = [...new Set(files.map((f) => resolve(f)))];
if (unique.length === 0) usage(`no file to read under ${roots.join(', ')} — an empty corpus proves nothing`);

const index = decisions.buildIndex(
  unique.map((f) => ({ file: rel(f), text: readFileSync(f, 'utf8') })),
  idPattern,
);
const text = decisions.render(index);
const { unanchored, duplicates } = decisions.problems(index);
const existing = existsSync(outPath) ? readFileSync(outPath, 'utf8') : null;
const current = existing !== null && existing.replace(/\r\n/g, '\n') === text;
const outShown = rel(outPath);

const anchored = [...index.values()].filter((v) => v.anchors.length > 0).length;
console.log(`decision-index — ${unique.length} file(s) read · ${index.size} id(s) · ${anchored} anchored · ${unanchored.length} unanchored · ${duplicates.length} anchored more than once`);
for (const id of unanchored) console.log(`  UNANCHORED  ${id} — cited at ${index.get(id).citations.slice(0, 3).map((c) => c.where).join(', ')}`);
for (const id of duplicates) console.log(`  TWICE       ${id} — ${index.get(id).anchors.map((a) => a.where).join(', ')}`);

const reasons = [];
if (check) {
  if (existing === null) reasons.push(`${outShown} is missing`);
  else if (!current) reasons.push(`${outShown} is stale — regenerate with ${runHint('decision-index')}`);
} else if (current) {
  console.log(`  index unchanged — ${outShown} left byte-identical`);
} else {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, text);
  console.log(`  index written — ${outShown}`);
}
if (unanchored.length) reasons.push(`${unanchored.length} id(s) cited but never anchored (${unanchored.join(', ')})`);
if (duplicates.length) reasons.push(`${duplicates.length} id(s) anchored more than once (${duplicates.join(', ')})`);

console.log(reasons.length === 0 ? `decision-index: PASS — ${anchored} id(s), each anchored once; ${outShown} current` : `decision-index: FAIL — ${reasons.join(' · ')}`);
process.exit(reasons.length === 0 ? 0 : 1);
