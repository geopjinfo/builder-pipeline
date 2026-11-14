/**
 * One ledger row, not the ledger. Rules: scripts/lib/table-row.cjs.
 *
 *   npx builder run ledger-row registry <ID> [<ID> …]           rows of paths.registry
 *   npx builder run ledger-row board <board.md | key> <ROW> …    rows of a task board (<paths.boards>/<key>.md)
 * (folder layout: node scripts/ledger-row.mjs in place of npx builder run ledger-row)
 *
 * Prints the section, the table header and the row, with its `file:line`. Settings: paths.registry · paths.boards ·
 * features.rowReader.state (off → "rowReader: not configured", exit 0).
 *
 * Exit 0 every id found · 1 an id is not found — a seat that cannot find its row must say so, not fall back to
 * reading the whole file · 2 usage, a missing file, or an invalid profile.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { runHint } = require('./lib/run-hint.cjs');
const { findRows } = require('./lib/table-row.cjs');
const profile = require('./lib/profile.cjs');

const [mode, ...rest] = process.argv.slice(2);
if (mode !== 'registry' && mode !== 'board') {
  console.error(`usage: ${runHint('ledger-row')} registry <ID>… | board <board.md | key> <ROW>…`);
  process.exit(2);
}

const loaded = profile.load(process.cwd());
if (loaded.errors.length > 0) {
  console.error(`ledger-row: PIPELINE_PROFILE.md is invalid — run ${runHint('features')}`);
  for (const e of loaded.errors) console.error(`  ${e}`);
  process.exit(2);
}
const feature = profile.feature(loaded.settings, 'rowReader');
if (!feature.enabled) {
  console.log(feature.line);
  process.exit(0);
}
const { paths } = loaded.settings;

let file;
let ids;
if (mode === 'registry') {
  file = paths.registry;
  ids = rest;
} else {
  const target = rest[0] ?? '';
  file = target.endsWith('.md') ? target : join(paths.boards, `${target}.md`);
  ids = rest.slice(1);
}
if (!existsSync(file) || ids.length === 0) {
  console.error(`ledger-row: ${!existsSync(file) ? `no such file ${file}` : 'no row id given'}`);
  process.exit(2);
}

const shown = file.replace(/\\/g, '/');
const text = readFileSync(file, 'utf8');
let missing = 0;
for (const id of ids) {
  const hits = findRows(text, id);
  if (hits.length === 0) {
    console.log(`${id}: not found in ${shown}`);
    missing += 1;
    continue;
  }
  for (const h of hits) {
    console.log(`## ${h.section ?? '(no section)'} — ${shown}:${h.line}`);
    console.log(h.header);
    console.log(h.row);
    console.log('');
  }
}
process.exit(missing === 0 ? 0 : 1);
