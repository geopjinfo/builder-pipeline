#!/usr/bin/env node
/**
 * One verdict per local branch, a restorable removal with --apply. Rule and its WHY: scripts/lib/branch-sweep.cjs
 * (specs/repo-hygiene.spec.md REQ-1801 to REQ-1807, D86).
 *
 *   npx builder-pipeline run branch-sweep [--target <branch>] [--stale-days N] [--keep <name,...>] [--apply]
 * (folder layout: node scripts/branch-sweep.mjs in place of npx builder-pipeline run branch-sweep)
 *
 * Dry run unless --apply: MERGED, STALE or KEEP per branch, with the reason, then one summary line. With --apply each
 * MERGED branch gets `refs/builder/branches/<name>` at its tip, then `git branch -d` (never -D); STALE and KEEP are
 * never deleted. Remote branches contained in target are listed with the push command; the kit never pushes. With
 * --apply, remote-tracking refs whose remote branch is gone are pruned.
 *
 * Settings (PIPELINE_PROFILE.md §16): features.branchSweep.{state, target, staleDays, keep, remote}.
 * Off → "branchSweep: not configured", exit 0. Off with --target → runs with the defaults and says so (REQ-1807).
 * Exit 0 ok, or the feature is off · 1 a delete failed · 2 usage, no git repository, or an invalid profile.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { runHint } = require('./lib/run-hint.cjs');
const sweep = require('./lib/branch-sweep.cjs');
const profile = require('./lib/profile.cjs');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const val = (n) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};
const USAGE = `usage: ${runHint('branch-sweep')} [--target <branch>] [--stale-days N] [--keep <name,...>] [--apply]`;
const die = (message) => {
  console.error(`branch-sweep: ${message} — ${USAGE}`);
  process.exit(2);
};
const valued = ['--target', '--stale-days', '--keep'];
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
  console.error(`branch-sweep: PIPELINE_PROFILE.md is invalid — run ${runHint('features')}`);
  for (const e of loaded.errors) console.error(`  ${e}`);
  process.exit(2);
}
const feature = profile.feature(loaded.settings, 'branchSweep');
const standalone = !feature.enabled && val('--target') !== undefined;
if (!feature.enabled && !standalone) {
  console.log(feature.line); // no --target: the sweep never guesses an integration branch
  process.exit(0);
}
const cfg = standalone ? { ...profile.FEATURES.branchSweep.defaults } : feature.config;
const staleDays = val('--stale-days') !== undefined ? Number(val('--stale-days')) : cfg.staleDays;
if (!Number.isFinite(staleDays) || staleDays < 0) die('--stale-days must be a number >= 0');
const keep = [...(cfg.keep || []), ...(val('--keep') || '').split(',').map((s) => s.trim()).filter(Boolean)];

const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
if (top.status !== 0 || !top.stdout.trim()) die('not a git repository');
const repo = top.stdout.trim();
const target = val('--target') || cfg.target;
const apply = flag('--apply');
const mode = apply ? '--apply: MERGED branches are removed after a snapshot ref' : 'dry run: nothing is removed; add --apply to remove';
if (standalone) console.log(`${feature.line} — checking branches against ${target} with defaults (staleDays ${staleDays}, keep ${JSON.stringify(cfg.keep)}, remote ${cfg.remote}; ${mode})`);
else console.log(`branch-sweep: checking branches against ${target} (staleDays ${staleDays}; ${mode})`);

// The orchestrator store root, as scripts/lib/orch-store.cjs resolves it (BUILDER_ORCH_DIR, else <primary>/.pipeline/orchestrator
// through the git common dir) — computed here so the hygiene group does not pull the orchestrator's libraries in.
const common = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: repo, encoding: 'utf8' });
const orchRoot = process.env.BUILDER_ORCH_DIR
  ? path.resolve(process.env.BUILDER_ORCH_DIR)
  : common.status === 0 && common.stdout.trim() ? path.join(path.dirname(common.stdout.trim()), '.pipeline', 'orchestrator') : null;
const out = sweep.run({ repo, target, staleDays, keep, apply, remote: cfg.remote, orchRoot, report: (l) => console.log(l) });
console.log(out.summary);
process.exit(out.failed.length ? 1 : 0);
