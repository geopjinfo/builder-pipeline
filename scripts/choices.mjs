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

const require = createRequire(import.meta.url);
const lib = require('./lib/choices.cjs');

const root = process.cwd();
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
  console.log(loaded.found ? `${lib.FILE}: valid, ${Object.keys(loaded.choices.items).length} choice(s)` : `no ${lib.FILE} — every clashing kit item will be skipped`);
} else {
  fail('usage: list [--json] | set <kind>:<name> <keep|kit|both> --by <who> [--project <paths>] [--note <text>] | unset <kind>:<name> | check');
}
