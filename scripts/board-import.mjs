#!/usr/bin/env node
/**
 * `npx builder-pipeline run board-import --format <ralph|spec-kit> <source> --out <board.md> [--force]`
 * (folder layout: node scripts/board-import.mjs in place of npx builder-pipeline run board-import)
 *
 * Writes another tool's task file as a kit build board, so `check-ledgers`, `board-progress` and the ledger audit
 * run over that tool's work in a project that never adopted the pipeline. Rule and formats: scripts/lib/board-import.cjs
 * (keep what the source states, mark what is inferred `⚠ CONFIRM`, list every unmapped line). Needs no profile.
 *
 * Exit 0 written · 2 usage, unknown format, missing or unreadable source, invalid source, or the output exists and
 *      --force was not given — nothing is written on any refusal.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, relative, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { runHint } = require('./lib/run-hint.cjs');
const lib = require('./lib/board-import.cjs');

const NAME = 'board-import';
const usage = `usage: ${runHint(NAME)} --format <${lib.FORMATS.join('|')}> <source> --out <board.md> [--force]`;
const die = (message) => {
  console.error(`${NAME}: ${message}`);
  process.exit(2);
};

const args = process.argv.slice(2);
let format = null;
let out = null;
let force = false;
const positional = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--format' || a === '--out') {
    const value = args[i + 1];
    if (!value || value.startsWith('--')) die(`${a} needs a value — ${usage}`);
    if (a === '--format') format = value;
    else out = value;
    i++;
  } else if (a === '--force') force = true;
  else if (a.startsWith('--')) die(`unknown flag ${a} — ${usage}`);
  else positional.push(a);
}
if (!format || !out || positional.length !== 1) die(usage);
if (!lib.FORMATS.includes(format)) die(`unknown format "${format}" — one of ${lib.FORMATS.join(', ')}`);

const source = resolve(positional[0]);
const target = resolve(out);
const slash = (p) => (relative(process.cwd(), p) || p).split('\\').join('/');
if (!existsSync(source)) die(`source missing — ${slash(source)}`);
if (existsSync(target) && !force) die(`${slash(target)} exists — pass --force to overwrite it (the import is a fresh projection; a board you edited is lost)`);

let text;
try {
  text = readFileSync(source, 'utf8');
} catch (e) {
  die(`source unreadable — ${slash(source)}: ${e.message}`);
}
const result = lib.read(format, text);
if (result.errors.length > 0) die(result.errors.join('; '));

const key = basename(target).replace(/\.md$/i, '');
const board = lib.render({ key, format, source: slash(source), date: new Date().toISOString().slice(0, 10) }, result);
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, board);
console.log(`${NAME}: wrote ${slash(target)} — ${lib.summary(result)}`);
