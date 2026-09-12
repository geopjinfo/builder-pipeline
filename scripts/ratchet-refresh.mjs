#!/usr/bin/env node
/**
 * Refresh shrink-only ratchet lists from measurement — the ONLY sanctioned way to move a bank. Rule:
 * scripts/lib/ratchet.cjs.
 *
 *   node scripts/ratchet-refresh.mjs                    dry run over every list: print what would drain
 *   node scripts/ratchet-refresh.mjs <name> …           only these lists
 *   --write                                             apply: items (sorted) + count + measuredAt in one motion
 *   --json                                              machine-readable result
 *
 * Settings: features.ratchets.lists — [{ "name", "bank", "measured" }], paths relative to the project root.
 *   bank      { "items": [strings], "count": N, "measuredAt"?: string } — the list and its ceiling, one file
 *   measured  [strings] or { "items": [strings], "measuredAt"?: string } — written by the project's measurement
 * Off → "ratchets: not configured", exit 0.
 *
 * Refuses to GROW a list: a measured item the bank does not hold is named and the run exits 1 — that item
 * shipped without coverage, and the fix is coverage. A bank with nothing to drain is left byte-identical.
 * `measuredAt` comes from the measured file, or that file's modification time when it carries none.
 *
 * Exit codes
 *   0  every list unchanged, or drained (dry run or --write) · feature not configured
 *   1  a list refused (new measured items) or disagrees with its own ceiling — that list is never written
 *   2  an invalid profile, an unknown or duplicate list name, a missing measured file ("run the measurement
 *      first"), or a missing or malformed bank or measured file
 */
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const profile = require('./lib/profile.cjs');
const ratchet = require('./lib/ratchet.cjs');

const argv = process.argv.slice(2);
const write = argv.includes('--write');
const asJson = argv.includes('--json');
const names = argv.filter((a) => !a.startsWith('--'));
const usage = (message) => {
  console.error(`ratchet-refresh: ${message}`);
  process.exit(2);
};

const root = process.cwd();
const loaded = profile.load(root);
if (loaded.errors.length > 0) usage(`PIPELINE_PROFILE.md is invalid — run node scripts/features.mjs\n  ${loaded.errors.join('\n  ')}`);
const feature = profile.feature(loaded.settings, 'ratchets');
if (!feature.enabled) {
  console.log(feature.line);
  process.exit(0);
}

const lists = feature.config.lists;
const seen = new Set();
for (const l of lists) {
  if (seen.has(l.name)) usage(`features.ratchets.lists names "${l.name}" twice — a list must have one bank`);
  seen.add(l.name);
}
const unknown = names.filter((n) => !seen.has(n));
if (unknown.length) usage(`no list named ${unknown.map((n) => `"${n}"`).join(', ')} — known: ${[...seen].join(', ')}`);
const chosen = names.length ? lists.filter((l) => names.includes(l.name)) : lists;

const at = (p) => (isAbsolute(p) ? p : resolve(root, p));
const show = (p) => p.replace(/\\/g, '/');
const readJson = (path, label) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    return { __error: `${label} ${show(path)}: ${e.message}` };
  }
};

const results = [];
for (const list of chosen) {
  const r = { name: list.name, bank: show(list.bank), measured: show(list.measured), status: 'error', banked: null, measuredCount: null, added: [], drained: [], problems: [], written: false, closable: false };
  results.push(r);
  const bankPath = at(list.bank);
  const measuredPath = at(list.measured);
  if (!existsSync(measuredPath)) {
    r.problems.push(`no measured set at ${r.measured} — run the measurement first — the measured set is runtime-only, it cannot be derived from source`);
    continue;
  }
  if (!existsSync(bankPath)) {
    r.problems.push(`no bank at ${r.bank}`);
    continue;
  }
  const bankJson = readJson(bankPath, 'bank');
  const measuredJson = readJson(measuredPath, 'measured');
  const parsedBank = bankJson.__error ? { errors: [bankJson.__error] } : ratchet.parseBank(bankJson);
  const parsedMeasured = measuredJson.__error ? { errors: [measuredJson.__error] } : ratchet.parseMeasured(measuredJson);
  if (parsedBank.errors.length || parsedMeasured.errors.length) {
    r.problems.push(...parsedBank.errors.map((e) => `${e} (${r.bank})`), ...parsedMeasured.errors.map((e) => `${e} (${r.measured})`));
    continue;
  }
  const p = ratchet.plan(parsedBank.bank, parsedMeasured.items);
  Object.assign(r, { status: p.status, banked: parsedBank.bank.items.length, measuredCount: parsedMeasured.items.length, added: p.added, drained: p.drained, problems: p.problems });
  if (p.status === 'drain') {
    r.closable = p.next.length === 0;
    if (write) {
      const measuredAt = parsedMeasured.measuredAt ?? statSync(measuredPath).mtime.toISOString();
      writeFileSync(bankPath, ratchet.renderBank(parsedBank.bank, p.next, measuredAt));
      r.written = true;
    }
  }
}

const exit = results.some((r) => r.status === 'error') ? 2 : results.some((r) => r.status === 'refused' || r.status === 'fail') ? 1 : 0;
const drainedTotal = results.reduce((n, r) => n + r.drained.length, 0);
const verdict =
  exit === 0
    ? `ratchet-refresh: PASS — ${results.length} list(s); ${drainedTotal ? `${drainedTotal} item(s) drained${write ? ', written' : ' (dry run — re-run with --write to apply)'}` : 'nothing drained, every bank left byte-identical'}`
    : `ratchet-refresh: FAIL — ${results.filter((r) => ['error', 'refused', 'fail'].includes(r.status)).map((r) => `${r.name} ${r.status}`).join(', ')}`;

if (asJson) {
  console.log(JSON.stringify({ feature: feature.line, write, lists: results, verdict }, null, 2));
  process.exit(exit);
}

console.log(feature.line);
for (const r of results) {
  const head = `${r.name} — bank ${r.bank}`;
  if (r.status === 'error') {
    console.log(`${head}: ERROR`);
    for (const m of r.problems) console.log(`    ${m}`);
  } else if (r.status === 'fail') {
    console.log(`${head}: FAIL`);
    for (const m of r.problems) console.log(`    ${m}`);
  } else if (r.status === 'refused') {
    console.log(`${head}: REFUSED — ${r.added.length} item(s) are uncovered NOW but were not banked:`);
    for (const a of r.added) console.log(`    + ${a}`);
    console.log('  This list is shrink-only. A newly uncovered item is not a bookkeeping event: it shipped without coverage.');
    console.log('  Add the coverage, re-run the measurement, and this refresh will have nothing to add.');
  } else if (r.status === 'unchanged') {
    console.log(`${head}: ${r.banked} banked · ${r.measuredCount} measured — nothing drained, bank left byte-identical`);
  } else {
    console.log(`${head}: ${r.banked} banked · ${r.measuredCount} measured — ${r.drained.length} item(s) gained coverage:`);
    for (const d of r.drained) console.log(`    - ${d}`);
    console.log(`  count ${r.banked} → ${r.banked - r.drained.length}${r.written ? ' (written)' : ' (dry run)'}`);
    if (r.closable) console.log(`  the bank ${r.written ? 'is' : 'would be'} EMPTY — the list can be closed.`);
  }
}
console.log(verdict);
process.exit(exit);
