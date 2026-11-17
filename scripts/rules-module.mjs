#!/usr/bin/env node
/**
 * `npx builder-pipeline run rules-module [<target>] [--json]` — structural rule hits for one area of the code, each
 * NEW or BASELINED with its written why. Interface and key: `scripts/lib/rules-module.cjs`.
 * (folder layout: node scripts/rules-module.mjs in place of npx builder-pipeline run rules-module)
 *
 * `features.rules.scan` is the command; `{target}` in it is replaced by the argument (a module directory,
 * a path). A target given to a scan command without `{target}` is refused rather than silently ignored.
 * `features.rules.baseline` is the baseline file; `features.rules.ratcheted` the rule ids that count.
 * Example rules for one runner: `examples/ast-grep/typescript/`.
 *
 * The pipeline's audit step writes this output to `<runs>/<key>/rules.txt` and hands the path to the
 * auditor, who must account for every line.
 *
 * Exit codes
 *   0  report printed — a NEW hit is the auditor's to judge (and a ratchet test's to fail), not this report's;
 *      a scan that could not run prints "rules: NOT RUN", never an empty list; feature off prints
 *      "rules: not configured"
 *   1  usage error (a target the command cannot take, or one with shell metacharacters)
 *   2  invalid profile
 *
 * Commands run through the platform shell. On Windows that is cmd.exe, which rewrites some regex
 * metacharacters — keep patterns in the runner's config files, not on the command line.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const profile = require('./lib/profile.cjs');
const { classify, report } = require('./lib/rules-module.cjs');

const argv = process.argv.slice(2);
const target = argv.find((a) => !a.startsWith('--')) ?? null;
const root = process.cwd();

const { settings, errors } = profile.load(root);
if (errors.length > 0) {
  console.error(`rules-module: the profile is invalid —\n  ${errors.join('\n  ')}`);
  process.exit(2);
}
const feature = profile.feature(settings, 'rules');
if (!feature.enabled) {
  console.log(feature.line);
  process.exit(0);
}
const { scan, baseline: baselineSetting, ratcheted } = feature.config;

if (target !== null && !/^[\w./@-]+$/.test(target)) {
  console.error(`rules-module: "${target}" is not a plain path (letters, digits, _ . / @ -)`);
  process.exit(1);
}
if (target !== null && !scan.includes('{target}')) {
  console.error('rules-module: features.rules.scan has no {target} placeholder — run without a target, or add {target} to the command');
  process.exit(1);
}
const command = target === null ? scan.replace(/\s*\{target\}/g, '') : scan.replace(/\{target\}/g, target);

const r = spawnSync(command, { cwd: root, shell: true, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true });
if (r.error || r.status !== 0) {
  console.log(`rules-module: scan failed (${r.error?.message ?? `exit ${r.status}`}) — rules: NOT RUN`);
  const tail = String(r.stderr ?? '').trim().split(/\r?\n/).slice(-5).join('\n');
  if (tail) console.log(tail);
  process.exit(0);
}

let entries = [];
const baselinePath = baselineSetting ? (isAbsolute(baselineSetting) ? baselineSetting : resolve(root, baselineSetting)) : null;
if (baselinePath && existsSync(baselinePath)) {
  try {
    entries = JSON.parse(readFileSync(baselinePath, 'utf8'));
  } catch (e) {
    console.log(`rules-module: baseline ${baselineSetting} is not JSON (${e.message}) — rules: NOT RUN`);
    process.exit(0);
  }
} else if (baselinePath) {
  console.log(`rules-module: no baseline at ${baselineSetting} — every hit is NEW`);
}

let hits;
try {
  hits = classify(r.stdout, entries, ratcheted);
} catch (e) {
  console.log(`rules-module: ${e.message} — rules: NOT RUN`);
  process.exit(0);
}

if (argv.includes('--json')) console.log(JSON.stringify({ target, ratcheted: ratcheted.length ? ratcheted : 'all', hits }, null, 2));
else for (const line of report(hits, { target, baselinePath: baselineSetting })) console.log(line);
