#!/usr/bin/env node
/**
 * `node scripts/contract-oracle.mjs [--spec <file>] [--transcript <jsonl>] [--baseline <json>] [--write-baseline]`
 *
 * After a behavioural test run that writes a request/response transcript: judge every served request
 * against the written contract. Classes and config: `scripts/lib/contract-oracle.cjs`; the contract format
 * is an adapter (`features.contractOracle.adapter`, default `openapi3` → `oracles/openapi3.cjs`, or a path
 * to an adapter file relative to the project root).
 *
 * A finding already in the baseline is reported and does not fail; a NEW failing finding exits 1. A baseline
 * entry the transcript no longer produces is listed as resolved — prune it with `--write-baseline`. Writing
 * a baseline is a deliberate act: every entry it records is drift someone has chosen to carry.
 *
 * Exit codes
 *   0  no new drift · baseline written · feature not configured ("contractOracle: not configured")
 *   1  one or more NEW failing findings
 *   2  missing input, unreadable contract or transcript, unknown adapter, or an invalid profile
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const profile = require('./lib/profile.cjs');
const oracle = require('./lib/contract-oracle.cjs');

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1] ?? null;
};
const fail = (message) => {
  console.error(`contract-oracle: ${message}`);
  process.exit(2);
};

const root = process.cwd();
const { settings, errors } = profile.load(root);
if (errors.length > 0) fail(`the profile is invalid —\n  ${errors.join('\n  ')}`);

const feature = profile.feature(settings, 'contractOracle');
if (!feature.enabled) {
  console.log(feature.line);
  process.exit(0);
}
const config = feature.config;
const at = (p) => (p ? (isAbsolute(p) ? p : resolve(root, p)) : null);
const specPath = at(arg('--spec') ?? config.spec);
const transcriptPath = at(arg('--transcript') ?? config.transcript);
const baselinePath = at(arg('--baseline') ?? config.baseline);

function loadAdapter(name) {
  const candidates = /[\\/]|\.c?js$/.test(name)
    ? [at(name)]
    : [join(here, '..', 'oracles', `${name}.cjs`), join(here, 'oracles', `${name}.cjs`)];
  const found = candidates.find((c) => c && existsSync(c));
  if (!found) fail(`no adapter "${name}" (looked in ${candidates.join(', ')})`);
  return require(found);
}

if (!specPath || !existsSync(specPath)) fail(`no contract at ${specPath ?? '(features.contractOracle.spec unset)'}`);
if (!transcriptPath || !existsSync(transcriptPath)) fail(`no transcript at ${transcriptPath ?? '(features.contractOracle.transcript unset)'} — run the behavioural tests first`);

let ops;
let records;
try {
  ops = loadAdapter(config.adapter).compileOperations(JSON.parse(readFileSync(specPath, 'utf8')), config);
  records = oracle.parseTranscript(readFileSync(transcriptPath, 'utf8'));
} catch (e) {
  fail(e.message);
}

const result = oracle.findings(records, ops, config);
let baseline = null;
if (baselinePath && existsSync(baselinePath)) {
  try {
    baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  } catch (e) {
    fail(`baseline ${baselinePath}: ${e.message}`);
  }
}
const { failing, fresh, known, resolved } = oracle.compare(result, baseline);

console.log(`contract-oracle — ${result.total} served request(s), ${result.matched} matched to ${ops.length} contract operation(s)`);
const byClass = result.findings.reduce((acc, f) => ({ ...acc, [f.class]: (acc[f.class] ?? 0) + 1 }), {});
console.log(`  distinct findings by class: ${JSON.stringify(byClass)}`);
for (const f of fresh.slice(0, 30)) console.log(`  NEW       ${f.key} ×${f.count} — e.g. ${f.example}`);
if (fresh.length > 30) console.log(`  … ${fresh.length - 30} more new finding(s)`);
if (known.length) console.log(`  baselined: ${known.length} known finding(s) (${baselinePath})`);
if (resolved.length) console.log(`  resolved since the baseline: ${resolved.length} (prune with --write-baseline)`);

if (argv.includes('--write-baseline')) {
  if (!baselinePath) fail('--write-baseline needs --baseline <file> or features.contractOracle.baseline');
  writeFileSync(baselinePath, `${JSON.stringify(oracle.baselineDocument(failing, arg('--transcript') ?? config.transcript), null, 2)}\n`);
  console.log(`contract-oracle: baseline written — ${failing.length} failing finding(s) recorded in ${baselinePath}`);
  process.exit(0);
}
console.log(fresh.length === 0 ? 'contract-oracle: PASS (no new drift)' : `contract-oracle: FAIL — ${fresh.length} new drift finding(s)`);
process.exit(fresh.length === 0 ? 0 : 1);
