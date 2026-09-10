#!/usr/bin/env node
/**
 * `node scripts/mutation-step.mjs <module> [--summary]` — the pipeline's mutation step, NON-BLOCKING.
 *
 * Runs `features.mutation.command` with `{module}` replaced by the argument (Stryker is the JS/TS example:
 * a command that mutates the module's pure logic against its own unit tests), writes the tool's output to
 * `<paths.logs>/mutation-<module>.log`, then summarises `features.mutation.report` (`{module}` substituted
 * there too) — score, and survivors split into payload and logic (`scripts/lib/mutation-summary.cjs`,
 * split by `features.mutation.payloadPattern`).
 *
 * `--summary` re-reads the last report without running the tool.
 *
 * Exit codes
 *   0  a report was produced and summarised — with or without survivors: the score is recorded on the
 *      board, it does not gate the run · feature off ("mutation: not configured")
 *   1  the tool did not produce a readable report (a missing, stale or unparseable report): "mutation: NOT
 *      RUN", so the board records an absence, never a zero
 *   2  usage error or invalid profile
 *
 * A tool that exits non-zero but writes a fresh report (a score under its own break threshold) still
 * counts as a produced report: the threshold is the tool's opinion, the board records the number.
 */
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const profile = require('./lib/profile.cjs');
const { summarise, lines } = require('./lib/mutation-summary.cjs');

const argv = process.argv.slice(2);
const target = argv.find((a) => !a.startsWith('--')) ?? null;
const root = process.cwd();

const { settings, errors } = profile.load(root);
if (errors.length > 0) {
  console.error(`mutation-step: the profile is invalid —\n  ${errors.join('\n  ')}`);
  process.exit(2);
}
const feature = profile.feature(settings, 'mutation');
if (!feature.enabled) {
  console.log(feature.line);
  process.exit(0);
}
if (!target || !/^[\w.@-]+$/.test(target)) {
  console.error('usage: node scripts/mutation-step.mjs <module> [--summary]   (a plain name: letters, digits, _ . @ -)');
  process.exit(2);
}

const { command, report, payloadPattern } = feature.config;
const reportPath = (() => {
  const p = report.replace(/\{module\}/g, target);
  return isAbsolute(p) ? p : resolve(root, p);
})();
const started = Date.now();

if (!argv.includes('--summary')) {
  const logDir = resolve(root, settings.paths?.logs ?? 'logs');
  mkdirSync(logDir, { recursive: true });
  const logFile = join(logDir, `mutation-${target}.log`);
  const fd = openSync(logFile, 'w');
  const run = spawnSync(command.replace(/\{module\}/g, target), { cwd: root, shell: true, stdio: ['ignore', fd, fd], windowsHide: true });
  closeSync(fd);
  const fresh = existsSync(reportPath) && statSync(reportPath).mtimeMs >= started - 1000;
  if (!fresh) {
    console.log(`mutation-step: the tool ${run.error ? `failed to start (${run.error.message})` : `exited ${run.status}`} and wrote no fresh report at ${reportPath} (log ${logFile}) — mutation: NOT RUN`);
    process.exit(1);
  }
  if (run.status !== 0) console.log(`mutation-step: the tool exited ${run.status} but wrote a report — summarising it (log ${logFile})`);
}

if (!existsSync(reportPath)) {
  console.log(`mutation-step: no report at ${reportPath} — mutation: NOT RUN`);
  process.exit(1);
}
let parsed;
try {
  parsed = JSON.parse(readFileSync(reportPath, 'utf8'));
} catch (e) {
  console.log(`mutation-step: the report at ${reportPath} is not JSON (${e.message}) — mutation: NOT RUN`);
  process.exit(1);
}
let summary;
try {
  summary = summarise(parsed, { payloadPattern });
} catch (e) {
  console.log(`mutation-step: ${e.message} — mutation: NOT RUN`);
  process.exit(1);
}
for (const line of lines(summary, { target, reportPath: report.replace(/\{module\}/g, target), payloadPattern })) console.log(line);
process.exit(0);
