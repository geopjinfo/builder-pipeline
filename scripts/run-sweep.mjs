#!/usr/bin/env node
/**
 * Old run folders and backups, moved by rename into <logs>/trash/<date>/ with --apply. Rule and its WHY:
 * scripts/lib/run-sweep.cjs (specs/repo-hygiene.spec.md REQ-1806, REQ-1807, D86).
 *
 *   npx builder-pipeline run run-sweep [--keep-days N] [--apply]
 * (folder layout: node scripts/run-sweep.mjs in place of npx builder-pipeline run run-sweep)
 *
 * Dry run unless --apply: SWEEP or KEEP per item with its size and age, then one summary line. A run with a lane in
 * LAUNCHED or STALLED is always KEEP. Snapshot refs of merged runs are listed with the delete command, never deleted.
 *
 * Settings (PIPELINE_PROFILE.md §16): features.runSweep.{state, keepDays, roots}. Off → "runSweep: not configured",
 * exit 3 — unless --keep-days or --apply is given: then it runs with the defaults and says so (REQ-1807).
 * Exit 0 ok · 1 a move failed · 2 usage or an invalid profile · 3 the feature is off.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runHint } = require('./lib/run-hint.cjs');
const sweep = require('./lib/run-sweep.cjs');
const profile = require('./lib/profile.cjs');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const val = (n) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};
const USAGE = `usage: ${runHint('run-sweep')} [--keep-days N] [--apply]`;
const die = (message) => {
  console.error(`run-sweep: ${message} — ${USAGE}`);
  process.exit(2);
};
const valued = ['--keep-days'];
const known = new Set(['--apply', '--help', '-h', ...valued]);
const unknown = argv.filter((a, i) => a.startsWith('-') && !known.has(a) && !valued.includes(argv[i - 1]));
if (flag('--help') || flag('-h')) {
  console.log(USAGE);
  process.exit(0);
}
if (unknown.length) die(`unknown flag "${unknown[0]}"`);
for (const f of valued) if (argv.includes(f) && (val(f) === undefined || val(f).startsWith('-'))) die(`${f} needs a value`);

const loaded = profile.load(process.cwd());
if (loaded.errors.length > 0) {
  console.error(`run-sweep: PIPELINE_PROFILE.md is invalid — run ${runHint('features')}`);
  for (const e of loaded.errors) console.error(`  ${e}`);
  process.exit(2);
}
const feature = profile.feature(loaded.settings, 'runSweep');
const standalone = !feature.enabled && (val('--keep-days') !== undefined || flag('--apply'));
if (!feature.enabled && !standalone) {
  console.log(feature.line); // off is exit 3, never a pass (spec INVARIANTS)
  process.exit(3);
}
const cfg = standalone ? { ...profile.FEATURES.runSweep.defaults } : feature.config;
const keepDays = val('--keep-days') !== undefined ? Number(val('--keep-days')) : cfg.keepDays;
if (!Number.isFinite(keepDays) || keepDays < 0) die('--keep-days must be a number >= 0');
const apply = flag('--apply');
const mode = apply ? '--apply: SWEEP items are moved into the trash folder' : 'dry run: nothing is moved; add --apply to move';
if (standalone) console.log(`${feature.line} — checking ${cfg.roots.join(', ')} with defaults (keepDays ${keepDays}; ${mode})`);
else console.log(`run-sweep: checking ${cfg.roots.join(', ')} (keepDays ${keepDays}; ${mode})`);

const out = sweep.run({ root: process.cwd(), roots: cfg.roots, keepDays, logsDir: loaded.settings.paths.logs, apply, report: (l) => console.log(l) });
console.log(out.summary);
process.exit(out.failed.length ? 1 : 0);
