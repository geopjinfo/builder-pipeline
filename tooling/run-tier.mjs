#!/usr/bin/env node
/**
 * The ONLY sanctioned way to run a test tier from an agent seat.
 *
 *   node scripts/run-tier.mjs integration              # full tier
 *   node scripts/run-tier.mjs integration --affected   # only what the diff can reach
 *   node scripts/run-tier.mjs unit --affected --since origin/development
 *   node scripts/run-tier.mjs gates                    # the whole gate chain, one line of output
 *
 * It (1) takes the tier lock, (2) runs jest with `--json --outputFile`, (3) writes the human
 * readable output to `logs/<tier>-<stamp>.log`, and (4) prints at most 25 lines. The exit code is
 * jest's, so it composes in a chain exactly like a bare jest call.
 *
 * `--affected` is an INNER-LOOP convenience and is NEVER merge evidence: a board row cites a full
 * run, and full tiers stay mandatory at pipeline Phase 3, Phase 6/6.5 and before every PR.
 *
 * Design rationale: the source repo's 2026-08-26 run-economy plan (evidence-backed; see PORTING.md).
 */
import { createRequire } from 'node:module';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { acquire, TierBusyError } = require('./lib/tier-lock.cjs');
const { selectTier } = require('./lib/affected.cjs');
const { summarize } = require('./lib/digest.cjs');

const NEWLINE = String.fromCharCode(10);
const WINDOWS = process.platform === 'win32';

/**
 * `spawnSync`'s default `maxBuffer` is 1 MB, and a full integration run prints ~4 MB — the child
 * gets KILLED at the cap, mid-suite, with no summary and no JSON. This bit on the very first full
 * run this script attempted: 1 050 113 bytes of log and an exit 1 that looked like a test failure
 * and was not. The whole point of the runner is that a tier's output is large, so the buffer must
 * be sized for the largest tier, not the default.
 */
const MAX_BUFFER = 256 * 1024 * 1024;

const CONFIGS = {
  unit: 'jest.config.cjs',
  arch: 'test/jest.arch.config.cjs',
  integration: 'test/jest.integration.config.cjs',
  e2e: 'test/jest.e2e.config.cjs',
};

const [tier, ...rest] = process.argv.slice(2);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

/**
 * `gates` is not a jest tier, but it is the second-largest context sink in the repo — twelve
 * chained sub-commands, and `logs/qa-app.log` shows the same shape at 3.13 MB. Scoping this runner
 * to jest alone would have left the biggest offenders untouched.
 */
if (tier === 'gates') {
  mkdirSync('logs', { recursive: true });
  const logPath = `logs/gates-${stamp}.log`;
  const run = spawnSync('npm', ['run', 'gates'], { encoding: 'utf8', shell: WINDOWS, maxBuffer: MAX_BUFFER });
  const output = `${run.stdout ?? ''}${NEWLINE}${run.stderr ?? ''}`;
  writeFileSync(logPath, output);
  const tail = output.split(NEWLINE).slice(-15).join(NEWLINE);
  console.log(run.status === 0 ? 'PASS — gates, exit 0' : `FAIL — gates, exit ${run.status}${NEWLINE}${tail}`);
  console.log(`full log: ${logPath}`);
  process.exit(run.status ?? 1);
}

if (!CONFIGS[tier]) {
  console.error(
    `usage: node scripts/run-tier.mjs <${Object.keys(CONFIGS).join('|')}|gates> [--affected] [--since <ref>]`,
  );
  process.exit(2);
}

const wantsAffected = rest.includes('--affected');
const since = rest.includes('--since') ? rest[rest.indexOf('--since') + 1] : 'development';

function changedFiles() {
  const committed = execFileSync('git', ['diff', '--name-only', `${since}...HEAD`], { encoding: 'utf8' });
  const working = execFileSync('git', ['diff', '--name-only', 'HEAD'], { encoding: 'utf8' });
  return [
    ...new Set(
      `${committed}${NEWLINE}${working}`
        .split(NEWLINE)
        .map((file) => file.trim())
        .filter(Boolean),
    ),
  ];
}

const resultPath = `logs/${tier}.result.json`;
const args = ['jest', '--config', CONFIGS[tier], '--json', '--outputFile', resultPath];

if (wantsAffected) {
  const selection = selectTier(changedFiles());
  if (selection.mode === 'none') {
    console.log(`SKIP — ${selection.reason}`);
    process.exit(0);
  }
  if (selection.mode === 'related') {
    args.push('--findRelatedTests', ...selection.files);
    console.log(`AFFECTED — ${selection.reason}`);
  } else {
    console.log(`ESCALATED TO FULL — ${selection.reason}`);
  }
}

mkdirSync('logs', { recursive: true });
const logPath = `logs/${tier}-${stamp}.log`;

/**
 * A BUSY LOCK IS AN ANSWER, NOT A CRASH.
 *
 * `acquire()` throws `TierBusyError` when a sibling holds the lock, which is the machine-wide
 * serialisation working as designed. Letting it propagate printed a Node stack trace — and a stack
 * trace reads as "the tooling broke", which is the reading most likely to make the next caller
 * delete the lock file and run anyway. That would put two tiers back on one PostgreSQL container,
 * which is the failure the lock exists to prevent (observed 2026-08-26: `FATAL: sorry, too many
 * clients already` from three worktrees sharing one database).
 *
 * So the busy case prints ONE line and exits `75` (EX_TEMPFAIL — "try again later"), distinct from
 * jest's `1` so a caller can tell "did not run" from "ran and failed". The stack is not
 * information here; the holder's pid and start time are.
 */
let held;
try {
  held = acquire(tier);
} catch (error) {
  if (!(error instanceof TierBusyError)) throw error;
  console.log(`BUSY — ${error.message}`);
  process.exit(75);
}
try {
  /**
   * DELETE the previous run's machine-readable result before spawning.
   *
   * Without this the runner cannot tell THIS run's result from the last one's. Jest writes
   * `--outputFile` only once it has actually run tests, so anything that kills it earlier — a
   * globalSetup throw, no container runtime, a bad config — leaves the PREVIOUS result file in
   * place, and the summarize() call below parses it happily and prints the previous run's PASS
   * for a run that executed nothing. Observed 2026-08-26: a tier whose globalSetup died with
   * "Could not find a working container runtime strategy" reported
   * `PASS — 177/177 suites, 2389/2390 tests` from a result file 48 minutes old.
   *
   * That is the worst failure a governed runner can have, because this file is "the ONLY
   * sanctioned way to run a test tier from an agent seat" and the line it prints is what board
   * rows quote. The exit code was always correct; only the human-readable line lied, which is
   * precisely the half an agent reads.
   *
   * Removing the file first makes the honest branch — "no machine-readable result" — reachable,
   * which is what the catch below was already written to say.
   */
  rmSync(resultPath, { force: true });
  const run = spawnSync('npx', args, { encoding: 'utf8', shell: WINDOWS, maxBuffer: MAX_BUFFER });
  writeFileSync(logPath, `${run.stdout ?? ''}${NEWLINE}${run.stderr ?? ''}`);
  try {
    console.log(summarize(JSON.parse(readFileSync(resultPath, 'utf8')), { logPath }));
  } catch {
    // jest died before writing a machine-readable result — say so rather than reporting a pass.
    // `run.error` is what distinguishes "the harness killed the child" (ENOBUFS, ETIMEDOUT) from
    // "jest crashed on its own"; printing it turns a mystery exit 1 into a one-line diagnosis.
    const cause = run.error ? ` (${run.error.code ?? run.error.message})` : '';
    console.log(`no machine-readable result — jest exited before writing one${cause}. full log: ${logPath}`);
  }
  process.exit(run.status ?? 1);
} finally {
  held.release();
}
