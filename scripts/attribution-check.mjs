#!/usr/bin/env node
/**
 * Attribution check: trailers, footers, author identities and branch names that carry an assistant or tool name, over
 * the commits since a ref. Rule and its WHY: scripts/lib/attribution-check.cjs (specs/repo-hygiene.spec.md REQ-1841;
 * decisions D99, D102, D104).
 *
 *   npx builder-pipeline run attribution-check [--since REF] [--target BRANCH] [--json] [--defaults]
 * (folder layout: node scripts/attribution-check.mjs in place of npx builder-pipeline run attribution-check)
 *
 * Settings (PIPELINE_PROFILE.md §16): features.attributionCheck.{state, target, patterns, authors, allow}.
 * Off → "attributionCheck: not configured", exit 3 (spec INVARIANTS); off with --defaults runs the built-in lists and
 * says so on the first line. Nothing is amended, renamed or pushed: every finding prints the command a person would run.
 * Exit 0 clean · 1 a finding · 2 usage, no git repository, or an invalid profile · 3 the feature is off.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runHint } = require('./lib/run-hint.cjs');
const check = require('./lib/attribution-check.cjs');
const profile = require('./lib/profile.cjs');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const val = (n) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};
const USAGE = `usage: ${runHint('attribution-check')} [--since REF] [--target BRANCH] [--json] [--defaults]`;
const die = (message) => {
  console.error(`attribution-check: ${message} — ${USAGE}`);
  process.exit(2);
};
const valued = ['--since', '--target'];
const known = new Set(['--json', '--defaults', '--help', '-h', ...valued]);
const unknown = argv.filter((a, i) => a.startsWith('-') && !known.has(a) && !valued.includes(argv[i - 1]));
if (flag('--help') || flag('-h')) {
  console.log(USAGE);
  process.exit(0);
}
if (unknown.length) die(`unknown flag "${unknown[0]}"`);
for (const f of valued) if (argv.includes(f) && (val(f) === undefined || val(f).startsWith('-'))) die(`${f} needs a value`);

const loaded = profile.load(process.cwd());
if (loaded.errors.length > 0) {
  console.error(`attribution-check: PIPELINE_PROFILE.md is invalid — run ${runHint('features')}`);
  for (const e of loaded.errors) console.error(`  ${e}`);
  process.exit(2);
}
const feature = profile.feature(loaded.settings, 'attributionCheck');
const standalone = !feature.enabled && flag('--defaults');
if (!feature.enabled && !standalone) {
  console.log(feature.line);
  process.exit(3);
}
const cfg = standalone ? { ...profile.FEATURES.attributionCheck.defaults } : feature.config;

const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
if (top.status !== 0 || !top.stdout.trim()) die('not a git repository');
const repo = top.stdout.trim();
const since = val('--since') || null;
const target = val('--target') || cfg.target || null;
if (since && spawnSync('git', ['rev-parse', '--verify', '--quiet', `${since}^{commit}`], { cwd: repo }).status !== 0) die(`--since ${since} is not a commit`);

let out;
try {
  out = check.run({ repo, since, target, patterns: cfg.patterns || [], authors: cfg.authors || [], allow: cfg.allow || [] });
} catch (e) {
  die(e.message);
}
const scope = since ? `${since}..HEAD` : 'every commit';
if (flag('--json')) {
  console.log(JSON.stringify({ check: 'attributionCheck', since, target, defaults: standalone, checked: out.checked, findings: out.findings }, null, 2));
} else {
  if (standalone) console.log(`${feature.line} — checking ${scope} with the built-in lists`);
  else console.log(`attribution-check: ${scope}${target ? `, branches not in ${target}` : ''} (${out.checked.commits} commits, ${out.checked.branches} branches)`);
  for (const f of out.findings) console.log(check.format(f));
  console.log(`attribution-check: ${out.findings.length} finding(s) — nothing was amended, renamed or pushed`);
}
process.exit(out.findings.length ? 1 : 0);
