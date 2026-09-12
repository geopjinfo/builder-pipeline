#!/usr/bin/env node
/**
 * `node scripts/contract-oracle.mjs [--spec <file>] [--transcript <jsonl>] [--baseline <json>]`
 * `node scripts/contract-oracle.mjs --write-baseline [--accept "<key>"]… | --write-baseline --initial`
 *
 * After a behavioural test run that writes a request/response transcript: judge every served request
 * against the written contract. Classes and config: `scripts/lib/contract-oracle.cjs`; the contract format
 * is an adapter (`features.contractOracle.adapter`, default `openapi3` → `oracles/openapi3.cjs`, or a path
 * to an adapter file relative to the project root).
 *
 * Settings: features.contractOracle.{adapter, spec, transcript, baseline, codeField, statusFamilies,
 * platformCodePattern}. `--spec`, `--transcript`, `--baseline` override the matching setting.
 *
 * A finding already in the baseline is reported and does not fail; a NEW failing finding exits 1. A baseline
 * entry the transcript no longer produces is listed as resolved.
 *
 * THE BASELINE IS SHRINK-ONLY. A write that re-records "whatever fails now" would absorb every new finding in
 * one motion and destroy the evidence the baseline exists to keep, so:
 *   --write-baseline              prunes resolved entries and never adds one. Any NEW failing finding → refused
 *                                 (exit 1, each key named, nothing written). Nothing to prune → the file is
 *                                 left byte-identical, and the output says so.
 *   --accept "<key>"  (repeat)    with --write-baseline: also carry exactly these keys. Each must be a NEW
 *                                 failing finding of this run (a key the run does not produce → exit 2; a key
 *                                 already carried → a no-op line). Unnamed new findings are still refused.
 *                                 Every accepted key owes a registry row saying why it is carried.
 *   --initial                     with --write-baseline, and only when NO baseline file exists: record every
 *                                 failing finding. The adoption path; over an existing file → exit 2.
 *
 * Exit codes
 *   0  no new drift · baseline pruned/extended as asked · nothing moved · feature not configured
 *      ("contractOracle: not configured")
 *   1  one or more NEW failing findings (a check run, or a --write-baseline that refused them)
 *   2  missing input, unreadable contract, transcript or baseline, unknown adapter, an invalid profile, or a
 *      misused flag (--accept/--initial without --write-baseline, --initial over an existing baseline, an
 *      --accept key this run does not produce as a new failing finding)
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

/** Every value of a repeatable flag; a flag with no value is a usage error, not an empty list. */
const args = (name) =>
  argv.flatMap((a, i) => {
    if (a !== name) return [];
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) fail(`${name} needs a value`);
    return [v];
  });
const writing = argv.includes('--write-baseline');
const initial = argv.includes('--initial');
const accept = args('--accept');
if (!writing && (initial || accept.length)) fail('--accept and --initial only act with --write-baseline');

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

if (writing) {
  if (!baselinePath) fail('--write-baseline needs --baseline <file> or features.contractOracle.baseline');
  const next = oracle.nextBaseline(failing, baseline, { accept, initial, transcript: arg('--transcript') ?? config.transcript });
  if (next.invalid.length) fail(next.invalid.join('\n  '));
  if (next.unknown.length) {
    fail(
      `--accept names ${next.unknown.length} key(s) this run does not produce as a failing finding — nothing written:\n` +
        next.unknown.map((k) => `    ? ${k}`).join('\n') +
        '\n  Copy the key exactly as the NEW line prints it.',
    );
  }
  for (const key of next.noop) console.log(`  already baselined — no-op: ${key}`);
  if (next.refused.length) {
    console.log(
      `\ncontract-oracle: FAIL — --write-baseline refused: ${next.refused.length} NEW failing finding(s) not named; the baseline only shrinks, nothing written:\n` +
        next.refused.map((f) => `    + ${f.key}`).join('\n') +
        '\n  Two ways forward:\n' +
        '    1. fix the drift — make the served behaviour match the contract (or correct the contract) and re-run;\n' +
        '    2. carry it deliberately — re-run with --write-baseline --accept "<key>" for each, with a registry row saying why.',
    );
    process.exit(1);
  }
  const where = baselinePath.replace(/\\/g, '/');
  if (!next.changed) {
    console.log(`contract-oracle: PASS — nothing moved; baseline left byte-identical (${where})`);
    process.exit(0);
  }
  writeFileSync(baselinePath, `${JSON.stringify(next.document, null, 2)}\n`);
  for (const f of next.pruned) console.log(`  pruned    ${f.key}`);
  for (const f of next.added) console.log(`  ${initial ? 'recorded' : 'accepted'}  ${f.key}`);
  const what = initial
    ? `initial baseline recorded — ${next.added.length} failing finding(s)`
    : `baseline written — ${next.pruned.length} pruned, ${next.added.length} accepted, ${next.document.findings.length} carried`;
  console.log(`contract-oracle: PASS — ${what} (${where})`);
  process.exit(0);
}
console.log(fresh.length === 0 ? 'contract-oracle: PASS (no new drift)' : `contract-oracle: FAIL — ${fresh.length} new drift finding(s)`);
process.exit(fresh.length === 0 ? 0 : 1);
