#!/usr/bin/env node
/**
 * Remove finished `git worktree`s after their branch has merged. Rule and its WHY: scripts/lib/worktree-sweep.cjs.
 *
 *   npx builder run worktree-sweep [--apply] [--idle-hours N] [--target <branch>] [--keep <name,...>]
 * (folder layout: node scripts/worktree-sweep.mjs in place of npx builder run worktree-sweep)
 *
 * Dry run unless --apply: prints KEEP (with every reason) or SWEEP per worktree, then one summary line. With
 * --apply each SWEEP worktree has its backup dirs copied under <logs>/backups/worktrees-<date>/, a node_modules link
 * unlinked, and `git worktree remove` run without --force; a folder left behind is FAIL at rmdir. Branches are kept.
 * With a `prefix`, it also lists ORPHAN folders beside the primary (the prefix, unknown to `git worktree list`, no
 * .git) with their size, and never removes them. Run it from the primary checkout, after the merge — the person or
 * seat that merges a run runs it, never the run itself.
 *
 * Settings (PIPELINE_PROFILE.md §16): features.worktreeSweep.{state, target, idleHours, prefix, reserved,
 * backupDirs, holdCommand}.
 *   target       the branch a worktree's HEAD must be contained in (your integration branch) — required
 *   idleHours    no file in the worktree touched for this long (default 6)
 *   prefix       only worktree folders whose name starts with this are considered (null = every worktree)
 *   reserved     folder names never swept (long-lived lanes a tool reuses)
 *   backupDirs   gitignored dirs copied out before removal (default ["logs", ".pipeline"])
 *   holdCommand  optional shell command with {path}: exit 0 free · 1 held (stdout = reason) · other = fail closed
 * Off → "worktreeSweep: not configured", exit 0 (REQ-709). With the feature off and `--target <branch>` given, the sweep
 * runs with the default settings (idleHours 6 or --idle-hours, no prefix, nothing reserved, no hold command: REQ-710),
 * as a dry run unless --apply, and its first line says `worktreeSweep: not configured — checking worktrees against
 * <branch> with defaults (…)` (REQ-707, REQ-708). Outside a git repository, or with a flag that has no value, it is exit 2
 * (REQ-711).
 *
 * Exit 0 ok, or the feature is off · 1 a removal failed · 2 usage, no git repository, or an invalid profile.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runHint } = require('./lib/run-hint.cjs');
const sweep = require('./lib/worktree-sweep.cjs');
const profile = require('./lib/profile.cjs');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const val = (n) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};
const USAGE = `usage: ${runHint('worktree-sweep')} [--apply] [--idle-hours N] [--target <branch>] [--keep <name,...>]`;
const die = (message) => {
  console.error(`worktree-sweep: ${message} — ${USAGE}`);
  process.exit(2);
};
const valued = ['--idle-hours', '--target', '--keep'];
const known = new Set(['--apply', '--help', '-h', ...valued]);
const unknown = argv.filter((a, i) => a.startsWith('-') && !known.has(a) && !valued.includes(argv[i - 1]));
if (flag('--help') || flag('-h')) {
  console.log(USAGE);
  process.exit(0);
}
if (unknown.length) die(`unknown flag "${unknown[0]}"`);
// A flag that takes a value is refused without one, never read as its neighbour (REQ-711).
for (const f of valued) if (argv.includes(f) && (val(f) === undefined || val(f).startsWith('-'))) die(`${f} needs a value`);

const loaded = profile.load(process.cwd());
if (loaded.errors.length > 0) {
  console.error(`worktree-sweep: PIPELINE_PROFILE.md is invalid — run ${runHint('features')}`);
  for (const e of loaded.errors) console.error(`  ${e}`);
  process.exit(2);
}
const feature = profile.feature(loaded.settings, 'worktreeSweep');
const standalone = !feature.enabled && val('--target') !== undefined;
if (!feature.enabled && !standalone) {
  // No --target: the step records "not configured" as before; the sweep never guesses an integration branch (REQ-709).
  console.log(feature.line);
  process.exit(0);
}
// With the feature off, only the feature defaults apply: a config file beside the project has not turned the check on, so
// none of its values (least of all a holdCommand, a shell command) is read (REQ-710, DL-4 of the spec).
const cfg = standalone ? { ...profile.FEATURES.worktreeSweep.defaults } : feature.config;

const idleHours = val('--idle-hours') !== undefined ? Number(val('--idle-hours')) : cfg.idleHours;
if (!Number.isFinite(idleHours) || idleHours < 0) {
  console.error('worktree-sweep: --idle-hours must be a number >= 0');
  process.exit(2);
}
const extraKeep = (val('--keep') || '').split(',').map((s) => s.trim()).filter(Boolean);
const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
if (top.status !== 0 || !top.stdout.trim()) {
  console.error(`worktree-sweep: not a git repository — run it from the primary checkout`);
  process.exit(2);
}
const repo = top.stdout.trim();
const target = val('--target') || cfg.target;
if (standalone) {
  // A sweep removes folders: without a profile it is a dry run unless --apply, and the first line says which (REQ-707,
  // REQ-708, DL-3 of the spec).
  const mode = flag('--apply') ? '--apply: merged, clean, idle worktrees are removed' : 'dry run: nothing is removed; add --apply to remove';
  console.log(`${feature.line} — checking worktrees against ${target} with defaults (${mode})`);
}

const out = sweep.run({
  repo,
  apply: flag('--apply'),
  target,
  idleHours,
  prefix: cfg.prefix,
  reserved: [...cfg.reserved, ...extraKeep],
  holdCommand: standalone ? null : cfg.holdCommand,
  backupDirs: cfg.backupDirs,
  logsDir: loaded.settings.paths.logs,
  report: (l) => console.log(l),
});
console.log(out.summary);
process.exit(out.failed.length ? 1 : 0);
