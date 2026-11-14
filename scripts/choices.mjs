/**
 * Records the overlap review's decisions — `node scripts/choices.mjs`.
 *
 *   node scripts/choices.mjs list [--json]
 *   node scripts/choices.mjs set <kind>:<name> <keep|kit|both> --by <who> [--project <path>[,<path>]] [--note <text>]
 *   node scripts/choices.mjs unset <kind>:<name>
 *   node scripts/choices.mjs check
 *
 * Writes builder.choices.json at the project root (scripts/lib/choices.cjs). Only a person's confirmed answer goes
 * in — the `builder-init` skill calls `set` after the human said yes to that item, never before.
 *
 * Exit 0 ok · 1 bad arguments or an invalid file (every problem printed).
 */
import { createRequire } from 'node:module';

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const lib = require('./lib/choices.cjs');

const root = resolve(process.env.BUILDER_PROJECT_ROOT || process.cwd());

/**
 * The kit whose items a key must name: BUILDER_KIT_ROOT (set by `builder choices`), else the kit this script sits in,
 * else a `builder/` folder or the installed package. null → keys are checked for shape only (and `check` says so).
 */
function findKit() {
  const isKit = (d) => d && existsSync(join(d, 'agents')) && existsSync(join(d, 'cli.js'));
  for (const d of [process.env.BUILDER_KIT_ROOT, join(dirname(fileURLToPath(import.meta.url)), '..'), join(root, 'builder')]) if (isKit(d)) return resolve(d);
  try {
    return dirname(require.resolve('@geopjinfo/builder-pipeline/package.json', { paths: [root] }));
  } catch {
    return null;
  }
}
const KIT = findKit();
const kitContext = () => {
  if (!KIT) return null;
  const inv = require(join(KIT, 'scripts', 'lib', 'inventory.cjs'));
  return { keys: inv.kitKeys(KIT), seats: inv.pipelineSeats(KIT) };
};
const [cmd, ...rest] = process.argv.slice(2);
const opt = (name) => {
  const i = rest.indexOf(name);
  return i === -1 ? undefined : rest[i + 1];
};
const fail = (msg) => {
  console.error(`choices: ${msg}`);
  process.exit(1);
};

const loaded = lib.read(root);
if (loaded.errors.length && cmd !== 'check') fail(`${lib.FILE} is invalid — fix or remove it first:\n  ${loaded.errors.join('\n  ')}`);

if (cmd === 'list') {
  if (rest.includes('--json')) console.log(JSON.stringify(loaded.choices, null, 2));
  else {
    const rows = Object.entries(loaded.choices.items);
    if (!rows.length) console.log(`no choices recorded (${loaded.found ? lib.FILE + ' is empty' : 'no ' + lib.FILE})`);
    for (const [k, c] of rows) console.log(`  ${k.padEnd(36)}${c.decision.padEnd(6)}${c.by}  ${c.decidedAt}${c.note ? `  — ${c.note}` : ''}`);
  }
} else if (cmd === 'set') {
  const [key, decision] = rest;
  const by = opt('--by');
  if (!key || !decision) fail('usage: set <kind>:<name> <keep|kit|both> --by <who>');
  if (!by) fail('set needs --by <who> — a decision without a person is not a decision');
  const project = opt('--project') ? opt('--project').split(',').map((s) => s.trim()).filter(Boolean) : undefined;
  // The key must name a kit item, and a pipeline seat cannot be "both": a typo or a renamed seat would leave the real
  // clash undecided, or the pipeline dispatching the wrong agent, while the file says it was decided.
  const ctx = kitContext();
  if (ctx) {
    const probe = lib.checkKeys({ items: { [key]: { decision } } }, ctx);
    if (probe.unknown.length) fail(`${key} names no kit item — nothing recorded. Kit items: ${[...ctx.keys].sort().join(', ')}`);
    if (probe.seatBoth.length) fail(lib.seatBoth(key));
  }
  let next;
  try {
    next = lib.set(loaded.choices, key, decision, by, { project, note: opt('--note') });
  } catch (e) {
    fail(e.message);
  }
  lib.write(root, next);
  console.log(`recorded: ${key} = ${decision} (by ${by}) in ${lib.FILE}`);
} else if (cmd === 'unset') {
  const [key] = rest;
  if (!key) fail('usage: unset <kind>:<name>');
  lib.write(root, lib.unset(loaded.choices, key));
  console.log(`removed: ${key} — it is undecided again and will be skipped until a choice is recorded`);
} else if (cmd === 'check') {
  if (loaded.errors.length) fail(`${lib.FILE} is invalid:\n  ${loaded.errors.join('\n  ')}`);
  const ctx = kitContext();
  if (ctx) {
    const k = lib.checkKeys(loaded.choices, ctx);
    if (k.errors.length) fail(`${lib.FILE} records ${k.errors.length} choice(s) the installer cannot honour:\n  ${k.errors.join('\n  ')}`);
  } else console.log('note: the kit was not found — keys checked for shape only');
  console.log(loaded.found ? `${lib.FILE}: valid, ${Object.keys(loaded.choices.items).length} choice(s)` : `no ${lib.FILE} — every clashing kit item will be skipped`);
} else {
  fail('usage: list [--json] | set <kind>:<name> <keep|kit|both> --by <who> [--project <paths>] [--note <text>] | unset <kind>:<name> | check');
}
