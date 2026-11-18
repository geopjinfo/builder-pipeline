#!/usr/bin/env node
/**
 * Artifact check: assistant files, scratch files, archives, assistant lines in .gitignore and generated-content labels
 * in the tree, since a ref, or in the index. Rule and its WHY: scripts/lib/artifact-check.cjs
 * (specs/repo-hygiene.spec.md REQ-1842, REQ-1843; decisions D99 to D101, D103).
 *
 *   npx builder-pipeline run artifact-check [--since REF | --staged] [--json] [--defaults]
 * (folder layout: node scripts/artifact-check.mjs in place of npx builder-pipeline run artifact-check)
 *
 * Settings (PIPELINE_PROFILE.md §16): features.artifactCheck.{state, extra, allow}.
 * Off → "artifactCheck: not configured", exit 3 (spec INVARIANTS); off with --defaults runs the built-in catalogues
 * and says so on the first line. --staged reads the index, as hooks/artifact-check-precommit.sh does before a commit.
 * Nothing is removed or rewritten: every finding prints the command a person would run.
 * Exit 0 clean · 1 a finding · 2 usage, no git repository, or an invalid profile · 3 the feature is off.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runHint } = require('./lib/run-hint.cjs');
const check = require('./lib/artifact-check.cjs');
const profile = require('./lib/profile.cjs');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const val = (n) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};
const USAGE = `usage: ${runHint('artifact-check')} [--since REF | --staged] [--json] [--defaults]`;
const die = (message) => {
  console.error(`artifact-check: ${message} — ${USAGE}`);
  process.exit(2);
};
const valued = ['--since'];
const known = new Set(['--staged', '--json', '--defaults', '--help', '-h', ...valued]);
const unknown = argv.filter((a, i) => a.startsWith('-') && !known.has(a) && !valued.includes(argv[i - 1]));
if (flag('--help') || flag('-h')) {
  console.log(USAGE);
  process.exit(0);
}
if (unknown.length) die(`unknown flag "${unknown[0]}"`);
for (const f of valued) if (argv.includes(f) && (val(f) === undefined || val(f).startsWith('-'))) die(`${f} needs a value`);
if (flag('--staged') && val('--since')) die('--staged and --since do not combine');

const loaded = profile.load(process.cwd());
if (loaded.errors.length > 0) {
  console.error(`artifact-check: PIPELINE_PROFILE.md is invalid — run ${runHint('features')}`);
  for (const e of loaded.errors) console.error(`  ${e}`);
  process.exit(2);
}
const feature = profile.feature(loaded.settings, 'artifactCheck');
const standalone = !feature.enabled && flag('--defaults');
if (!feature.enabled && !standalone) {
  console.log(feature.line);
  process.exit(3);
}
const cfg = standalone ? { ...profile.FEATURES.artifactCheck.defaults } : feature.config;

const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
if (top.status !== 0 || !top.stdout.trim()) die('not a git repository');
const repo = top.stdout.trim();
const since = val('--since') || null;
if (since && spawnSync('git', ['rev-parse', '--verify', '--quiet', `${since}^{commit}`], { cwd: repo }).status !== 0) die(`--since ${since} is not a commit`);

let out;
try {
  out = check.run({ repo, since, staged: flag('--staged'), extra: cfg.extra || [], allow: cfg.allow || [] });
} catch (e) {
  die(e.message);
}
if (flag('--json')) {
  console.log(JSON.stringify({ check: 'artifactCheck', since, staged: flag('--staged'), defaults: standalone, checked: out.checked, findings: out.findings }, null, 2));
} else {
  if (standalone) console.log(`${feature.line} — checking the ${out.checked.mode} (${out.checked.files} files) with the built-in catalogues`);
  else console.log(`artifact-check: ${out.checked.mode} (${out.checked.files} files)`);
  for (const f of out.findings) console.log(check.format(f));
  console.log(`artifact-check: ${out.findings.length} finding(s) — nothing was removed or rewritten`);
}
process.exit(out.findings.length ? 1 : 0);
