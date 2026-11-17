#!/usr/bin/env node
/**
 * Orphan source files on a ratchet bank, and stale TODO markers (specs/repo-hygiene.spec.md REQ-1823, REQ-1824, D91;
 * EXPERIMENTS §23). Rule and its WHY: scripts/lib/dead-code.cjs.
 *
 *   npx builder-pipeline run dead-code [--json]
 * (folder layout: node scripts/dead-code.mjs in place of npx builder-pipeline run dead-code)
 *
 * Settings (PIPELINE_PROFILE.md §16): features.deadCode.{state, roots, extensions, entries, baseline, testPattern,
 * todoDays}; `roots`, `extensions` and `baseline` are required while the feature is on. Prints ORPHAN REFUSED (new),
 * ORPHAN … (in the bank), DRAINED (left the bank) and STALE-TODO lines, then one summary line. The bank is rewritten only
 * to shrink. Nothing is deleted.
 *
 * Experimental-off by default: off, "deadCode: not configured" and exit 3, nothing else runs. Exit 0 clean (stale markers
 * are reported, never failed) · 1 a new ORPHAN · 2 usage, an invalid profile or a bank that disagrees with itself · 3 not
 * configured.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { runHint } = require('./lib/run-hint.cjs');
const dead = require('./lib/dead-code.cjs');
const deps = require('./lib/deps-check.cjs');
const ratchet = require('./lib/ratchet.cjs');
const profile = require('./lib/profile.cjs');

const argv = process.argv.slice(2);
const USAGE = `usage: ${runHint('dead-code')} [--json]`;
const die = (message) => { console.error(`dead-code: ${message} — ${USAGE}`); process.exit(2); };
const known = new Set(['--json', '--help', '-h']);
const unknown = argv.filter((a) => !known.has(a));
if (argv.includes('--help') || argv.includes('-h')) { console.log(USAGE); process.exit(0); }
if (unknown.length) die(`unknown argument "${unknown[0]}"`);
const json = argv.includes('--json');

const root = process.cwd();
const loaded = profile.load(root);
if (loaded.errors.length > 0) {
  console.error(`dead-code: PIPELINE_PROFILE.md is invalid — run ${runHint('features')}`);
  for (const e of loaded.errors) console.error(`  ${e}`);
  process.exit(2);
}
const feature = profile.feature(loaded.settings, 'deadCode');
if (!feature.enabled) {
  // Off is off: no walk, no blame, no bank read (REQ-1823 "nothing of it runs").
  console.log(`deadCode: not configured (${feature.state} — its measurement is EXPERIMENTS.md §23)`);
  process.exit(3);
}
const cfg = feature.config;
for (const k of ['roots', 'extensions']) if (!Array.isArray(cfg[k]) || cfg[k].length === 0) die(`features.deadCode.${k} is required while the feature is on`);
if (!cfg.baseline) die('features.deadCode.baseline (the ratchet bank path) is required while the feature is on');

const files = deps.sourceFiles(root, cfg.roots, cfg.extensions);
const read = (f) => readFileSync(join(root, f), 'utf8');
let manifest = null;
if (existsSync(join(root, 'package.json'))) { try { manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')); } catch { manifest = null; } }
const found = dead.orphans({ files, read, manifest, entries: cfg.entries ?? [], testPattern: cfg.testPattern ?? dead.DEFAULT_TEST_PATTERN, extensions: cfg.extensions });

const bankPath = join(root, cfg.baseline);
let bank = { items: [], count: 0 };
if (existsSync(bankPath)) {
  let parsed;
  try { parsed = JSON.parse(readFileSync(bankPath, 'utf8')); } catch (e) { die(`${cfg.baseline}: ${e.message}`); }
  const b = ratchet.parseBank(parsed);
  if (b.errors.length) die(`${cfg.baseline}: ${b.errors.join('; ')}`);
  bank = b.bank;
}
const plan = ratchet.plan(bank, found);
if (plan.status === 'fail') {
  for (const p of plan.problems) console.error(`dead-code: ${cfg.baseline}: ${p}`);
  process.exit(2);
}
const lines = [];
const banked = found.filter((f) => bank.items.includes(f));
for (const f of plan.added) lines.push(`ORPHAN REFUSED ${f} — no file imports it and it is no entry; delete it, or add an entries glob with the reason`);
for (const f of banked) lines.push(`ORPHAN ${f} (in the bank)`);
for (const f of plan.drained) lines.push(`DRAINED ${f} — no longer an orphan; the bank shrinks`);
if (plan.status === 'drain') writeFileSync(bankPath, ratchet.renderBank(bank, plan.next, new Date().toISOString()));

// STALE-TODO: one blame per file that holds a marker; the author lines are never read out.
let stale = [];
let blameFailed = 0;
for (const f of files) {
  const text = read(f);
  if (!dead.markers(text).length) continue;
  const times = dead.blame(root, f);
  if (!times) { blameFailed++; continue; }
  stale.push(...dead.staleMarkers(f, text, times, cfg.todoDays));
}
stale = stale.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
for (const s of stale) lines.push(`STALE-TODO ${s.file}:${s.line}: ${s.kind}, ${s.days} days old — move it to the deferred registry or delete it`);
if (blameFailed) lines.push(`STALE-TODO: unmeasurable for ${blameFailed} file${blameFailed === 1 ? '' : 's'} — git blame failed (not a repository, or the file is untracked)`);

const refused = plan.status === 'refused';
const summary = refused
  ? `dead-code: REFUSED — ${plan.added.length} new ORPHAN${plan.added.length === 1 ? '' : 's'} (${files.length} files read, ${banked.length} in the bank); nothing was deleted`
  : `dead-code: PASS — ${files.length} files read, ${banked.length} ORPHAN in the bank, ${plan.drained.length} drained, ${stale.length} STALE-TODO`;
if (json) console.log(JSON.stringify({ ok: !refused, files: files.length, orphans: { refused: plan.added, banked, drained: plan.drained }, stale, blameFailed }, null, 2));
else { for (const l of lines) console.log(l); console.log(summary); }
process.exit(refused ? 1 : 0);
