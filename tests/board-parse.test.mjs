/**
 * board-parse.cjs — header, phases, counted sections, deferred list, and the named sections a page
 * shows beside the rows (Todo, Definition of Done, Modules & endpoints).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { parseBoard } = require('../scripts/lib/board-parse.cjs');

const here = dirname(fileURLToPath(import.meta.url));
const sample = readFileSync(join(here, 'fixtures', 'board', 'tasks', 'sample.md'), 'utf8');
const bare = readFileSync(join(here, 'fixtures', 'board', 'tasks', 'bare.md'), 'utf8');

test('header facts are read; absent facts are null', () => {
  const { header } = parseBoard(sample);
  assert.equal(header.title, 'Sample module — build board');
  assert.equal(header.started, '2026-01-05');
  assert.equal(header.track, 'FULL');
  assert.equal(header.branch, 'feat/sample');
  assert.equal(header.scope, 'stock adjustments');
  assert.equal(header.unlock, 'none');
  assert.equal(parseBoard(bare).header.branch, null);
});

test('the phase:status block is read with emphasis normalised', () => {
  const { phases } = parseBoard(sample);
  assert.equal(phases.length, 3);
  assert.equal(phases[1].status, 'DONE');
  assert.equal(phases[2].seat, 'security-auditor');
});

test('counted sections, row ids, escaped pipes and totals', () => {
  const board = parseBoard(sample);
  assert.deepEqual(board.sections.map((s) => s.id), ['P2', 'P4']);
  assert.deepEqual(board.sections[0].rows.map((r) => r.id), ['T1', 'T2a', 'T2b', 'C1', 'D3-a', 'D3-b']);
  assert.equal(board.sections[1].rows[0].cells[1], 'Escape the | in reason text');
  assert.deepEqual(board.totals, { settled: 5, doing: 1, total: 8 });
  assert.deepEqual(board.unrecognised, []);
  assert.deepEqual(board.deferred, [{ id: 'REG-D3', text: 'the second half waits on the stock service — mirrored in DEFERRED_TASKS.md' }]);
});

test('a row under an undeclared series is reported, never counted and never dropped silently', () => {
  const board = parseBoard(`${bare}| A-12 | A row somebody would rather not rename | PLANNED |\n`);
  assert.deepEqual(board.unrecognised, [{ section: 'P1', id: 'A-12' }]);
  assert.equal(board.totals.total, 1);
});

test('a Status-table row under a non-counted "##" heading is returned as uncounted, named and never counted', () => {
  const extra = '\n## Notes\n\n| # | Task | Status |\n|---|---|---|\n| T9 | A row filed under prose | PLANNED |\n| odd one | no id at all | DONE |\n';
  const board = parseBoard(`${bare}${extra}`);
  assert.deepEqual(board.uncounted, [{ heading: 'Notes', id: 'T9' }, { heading: 'Notes', id: 'odd one' }]);
  assert.equal(board.totals.total, parseBoard(bare).totals.total, 'the totals are unchanged');
  assert.deepEqual(parseBoard(sample).uncounted, [], 'positive control: the sample board files every row under a counted heading');
});

test('Todo, Definition of Done and Modules & endpoints are parsed verbatim', () => {
  const board = parseBoard(sample);
  assert.deepEqual(board.todo, [
    { done: true, text: 'Open the run log' },
    { done: false, text: 'Render the page' },
  ]);
  assert.deepEqual(board.dod, { columns: ['Batch', 'Done when'], rows: [['P2', 'every row settled and its test named']] });
  assert.deepEqual(board.modules, { columns: ['Module', 'Endpoints'], rows: [['inventory', 'POST /adjustments']] });
});

test('absent Todo, Definition of Done and Modules are none — never an invented table', () => {
  const board = parseBoard(bare);
  assert.deepEqual(board.todo, []);
  assert.equal(board.dod, null);
  assert.equal(board.modules, null);
});

test('a heading with no table under it is none as well', () => {
  const board = parseBoard(`${bare}\n## Definition of Done\n\nprose only, no table\n\n## Modules and endpoints\n\n| Module | Endpoints |\n|---|---|\n| stock | GET /levels |\n`);
  assert.equal(board.dod, null);
  assert.deepEqual(board.modules.rows, [['stock', 'GET /levels']]);
});
