#!/usr/bin/env node
/**
 * The hygiene runner and the completion gate. Rules and their WHY: scripts/lib/hygiene.cjs
 * (specs/repo-hygiene.spec.md REQ-1831, REQ-1832, REQ-1844; decisions D87, D99).
 *
 *   npx builder-pipeline run hygiene [--json] [--since REF] [--check LIST] [--apply]
 *   npx builder-pipeline run hygiene --gate [--since BASE] [--json]
 * (folder layout: node scripts/hygiene.mjs in place of npx builder-pipeline run hygiene)
 *
 * Runs every hygiene-class check whose §16 feature is on, through the check's own script, and prints one report; a
 * check that is off prints its `not configured` line. --apply reaches only the three sweeps. --gate prints the seven
 * rows of the completion gate (PASS, FAIL, NOT CONFIGURED) and the findings behind a FAIL.
 * Exit 0 clean (or every configured gate row passes) · 1 a hard finding or a FAIL row · 2 usage · 3 no check is on.
 * The report is written to <runs>/hygiene/last.json (the gate: gate.json) for the progress reporter.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { runHint } = require('./lib/run-hint.cjs');
const hygiene = require('./lib/hygiene.cjs');
const profile = require('./lib/profile.cjs');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const val = (n) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};
const USAGE = `usage: ${runHint('hygiene')} [--json] [--since REF] [--check LIST] [--apply] | --gate [--since BASE] [--json]`;
const die = (message) => {
  console.error(`hygiene: ${message} — ${USAGE}`);
  process.exit(2);
};
const valued = ['--since', '--check'];
const known = new Set(['--json', '--apply', '--gate', '--help', '-h', ...valued]);
const unknown = argv.filter((a, i) => a.startsWith('-') && !known.has(a) && !valued.includes(argv[i - 1]));
if (flag('--help') || flag('-h')) {
  console.log(USAGE);
  process.exit(0);
}
if (unknown.length) die(`unknown flag "${unknown[0]}"`);
for (const f of valued) if (argv.includes(f) && (val(f) === undefined || val(f).startsWith('-'))) die(`${f} needs a value`);
if (flag('--gate') && (flag('--apply') || val('--check'))) die('--gate takes only --since and --json');

const loaded = profile.load(process.cwd());
if (loaded.errors.length > 0) {
  console.error(`hygiene: PIPELINE_PROFILE.md is invalid — run ${runHint('features')}`);
  for (const e of loaded.errors) console.error(`  ${e}`);
  process.exit(2);
}
const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
if (top.status !== 0 || !top.stdout.trim()) die('not a git repository');
const repo = top.stdout.trim();
const since = val('--since') || null;
if (since && spawnSync('git', ['rev-parse', '--verify', '--quiet', `${since}^{commit}`], { cwd: repo }).status !== 0) die(`--since ${since} is not a commit`);
const only = val('--check') ? val('--check').split(',').map((s) => s.trim()).filter(Boolean) : null;
if (only) {
  const names = new Set(hygiene.CHECKS.flatMap((c) => [c.name, c.script]));
  for (const n of only) if (!names.has(n)) die(`--check: unknown check "${n}" (one of ${hygiene.CHECKS.map((c) => c.script).join(', ')})`);
}
const kitScripts = path.dirname(fileURLToPath(import.meta.url));
const opts = { kitScripts, repo, settings: loaded.settings, since, apply: flag('--apply'), only, timeoutMs: Number(process.env.BUILDER_HYGIENE_TIMEOUT_MS) || 300000 };

if (flag('--gate')) {
  const g = hygiene.gate(opts);
  hygiene.writeRecord(hygiene.recordPath(process.cwd(), loaded.settings, 'gate.json'), g);
  console.log(flag('--json') ? JSON.stringify(g, null, 2) : hygiene.formatGate(g));
  process.exit(g.exit);
}
const report = hygiene.run(opts);
hygiene.writeRecord(hygiene.recordPath(process.cwd(), loaded.settings, 'last.json'), report);
console.log(flag('--json') ? JSON.stringify(report, null, 2) : hygiene.format(report));
process.exit(report.exit);
