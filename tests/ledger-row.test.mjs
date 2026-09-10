import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const { findRows } = require('../scripts/lib/table-row.cjs');

const fixture = join(here, 'fixtures', 'ledger', 'project');
const registry = readFileSync(join(fixture, 'DEFERRED_TASKS.md'), 'utf8');

describe('table-row — pure', () => {
  test('returns the row with its section and the REAL header (the line above the separator)', () => {
    assert.deepEqual(findRows(registry, 'STK-D4'), [
      { section: 'Section B — Still blocked', header: '| Id | Raised by | Task | Status |', line: 8, row: '| STK-D4 | stock-levels | supplier lead times | DEFERRED |' },
    ]);
  });

  test('red: the header is never returned as a data row, and the first data row is never taken for the header', () => {
    assert.deepEqual(findRows(registry, 'Id'), []);
    assert.doesNotMatch(findRows(registry, 'STK-D4')[0].header, /STK-D6/);
    assert.equal(findRows(registry, 'STK-D6')[0].header, '| Id | Raised by | Task | Status |');
  });

  test('a struck-through id resolves, under its own section', () => {
    assert.deepEqual(findRows(registry, 'STK-D1'), [{ section: 'Section A — Closed', header: '| Id | Raised by | Task | Status |', line: 14, row: '| ~~STK-D1~~ | restock | reorder e-mail | DONE |' }]);
  });

  test('an unknown id returns nothing', () => {
    assert.deepEqual(findRows(registry, 'STK-D99'), []);
  });
});

const cli = join(here, '..', 'scripts', 'ledger-row.mjs');
const made = [];
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));
const project = () => {
  const dir = mkdtempSync(join(tmpdir(), 'builder-ledger-'));
  cpSync(fixture, dir, { recursive: true });
  made.push(dir);
  return dir;
};
const run = (cwd, ...args) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });

describe('ledger-row — CLI on a fixture project', () => {
  test('registry <ID> prints the section with file:line, the header and the row', () => {
    const r = run(project(), 'registry', 'STK-D4');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^## Section B — Still blocked — DEFERRED_TASKS\.md:8$/m);
    assert.match(r.stdout, /^\| Id \| Raised by \| Task \| Status \|$/m);
    assert.match(r.stdout, /^\| STK-D4 \|/m);
    assert.doesNotMatch(r.stdout, /STK-D6/, 'one row, not the ledger');
  });

  test('board <key> <ROW> reads the board from paths.boards', () => {
    const r = run(project(), 'board', 'stock-levels', 'FIX-2');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^## P2 — Code — tasks\/stock-levels\.md:\d+$/m);
    assert.match(r.stdout, /^\| FIX-2 \|/m);
  });

  test('red: an unknown id exits 1 and says so', () => {
    const r = run(project(), 'registry', 'STK-D4', 'STK-D99');
    assert.equal(r.status, 1);
    assert.match(r.stdout, /STK-D99: not found in DEFERRED_TASKS\.md/);
  });

  test('usage and a missing file exit 2; the feature off prints "rowReader: not configured"', () => {
    const dir = project();
    assert.equal(run(dir, 'everything').status, 2);
    assert.equal(run(dir, 'board', 'no-such-board', 'T1').status, 2);
    writeFileSync(join(dir, 'PIPELINE_PROFILE.md'), '```json pipeline-settings\n{ "schema": 2, "features": { "rowReader": { "state": "off" } } }\n```\n');
    const r = run(dir, 'registry', 'STK-D4');
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), 'rowReader: not configured');
  });
});
