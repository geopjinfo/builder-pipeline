#!/usr/bin/env node
/**
 * Run the pack's own test suite — `node builder/tests/run.mjs` (or `node tests/run.mjs` inside the pack).
 *
 * Zero dependencies: every `*.test.mjs` beside this file runs under `node:test`. Tests read fixtures from
 * `tests/fixtures/` only, so the suite passes in any checkout of the pack, with no project around it.
 * Exit code is `node --test`'s: 0 all green, non-zero otherwise.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const only = process.argv.slice(2);
const files = readdirSync(here)
  .filter((f) => f.endsWith('.test.mjs'))
  .filter((f) => only.length === 0 || only.some((o) => f.includes(o)))
  .sort()
  .map((f) => join(here, f));

if (files.length === 0) {
  console.error('pack tests: no *.test.mjs found — a suite with no tests asserts nothing, so this is a failure');
  process.exit(1);
}

const major = Number(process.versions.node.split('.')[0]);
if (major < 18) {
  console.error(`pack tests: Node ${process.versions.node} — the pack needs Node 18 or newer`);
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
