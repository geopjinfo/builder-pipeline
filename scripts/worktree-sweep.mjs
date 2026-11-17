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
 * Off → "worktreeSweep: not configured", exit 0.
 *
 * Exit 0 ok, or the feature is off · 1 a removal failed · 2 usage or an invalid profile.
 */
import { execFileSync } from 'node:child_process';
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
const known = new Set(['--apply', '--idle-hours', '--target', '--keep', '--help', '-h']);
const unknown = argv.filter((a, i) => a.startsWith('-') && !known.has(a) && !['--idle-hours', '--target', '--keep'].includes(argv[i - 1]));
if (flag('--help') || flag('-h') || unknown.length) {
  (unknown.length ? console.error : console.log)(`usage: ${runHint('worktree-sweep')} [--apply] [--idle-hours N] [--target <branch>] [--keep <name,...>]`);
  process.exit(unknown.length ? 2 : 0);
}

const loaded = profile.load(process.cwd());
if (loaded.errors.length > 0) {
  console.error(`worktree-sweep: PIPELINE_PROFILE.md is invalid — run ${runHint('features')}`);
  for (const e of loaded.errors) console.error(`  ${e}`);
  process.exit(2);
}
const feature = profile.feature(loaded.settings, 'worktreeSweep');
if (!feature.enabled) {
  console.log(feature.line);
  process.exit(0);
}
const cfg = feature.config;

const idleHours = val('--idle-hours') !== undefined ? Number(val('--idle-hours')) : cfg.idleHours;
if (!Number.isFinite(idleHours) || idleHours < 0) {
  console.error('worktree-sweep: --idle-hours must be a number >= 0');
  process.exit(2);
}
// --keep <lane,...> (REQ-405): each worktree named by a lane id, folder name or branch tail stays, reported as kept
const extraKeep = (val('--keep') || '').split(',').map((s) => s.trim()).filter(Boolean);
const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();

const out = sweep.run({
  repo,
  apply: flag('--apply'),
  target: val('--target') || cfg.target,
  idleHours,
  prefix: cfg.prefix,
  reserved: cfg.reserved,
  keep: extraKeep,
  holdCommand: cfg.holdCommand,
  backupDirs: cfg.backupDirs,
  logsDir: loaded.settings.paths.logs,
  report: (l) => console.log(l),
});
console.log(out.summary);
process.exit(out.failed.length ? 1 : 0);
