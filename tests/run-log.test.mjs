/**
 * run-log.cjs — the append-only run log: its fold rules (steps, gates, findings, decisions), the four
 * discriminator spellings, and corrupt / unrecognised lines counted rather than dropped.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const runLog = require('../scripts/lib/run-log.cjs');
const { parseBoard } = require('../scripts/lib/board-parse.cjs');

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, 'fixtures', 'board');
const sampleLog = join(fixtures, '.pipeline', 'sample', 'run.jsonl');

test('a re-emitted step amends the earlier one; both lines stay in the events', () => {
  const log = runLog.read(sampleLog);
  assert.deepEqual(log.steps.map((s) => s.id), ['P1', 'P2', 'P4a', 'P4b']);
  const p2 = log.steps[1];
  assert.equal(p2.status, 'DONE');
  assert.equal(p2.agentId, 'fg1');
  assert.equal(log.events.filter((e) => e.id === 'P2').length, 2);
  assert.equal(log.files.length, 2);
});

test('a re-emitted decision amends the earlier one instead of adding a second', () => {
  const log = runLog.read(sampleLog);
  assert.equal(log.decisions.length, 2);
  const dec1 = log.decisions.find((d) => d.id === 'DEC-1');
  assert.equal(dec1.what, 'Round quantities down');
  assert.equal(dec1.reversal, 'restore fractional stock in one migration');
});

test('a gate re-run supersedes the earlier result; a finding closes by a later event', () => {
  const log = runLog.read(sampleLog);
  assert.equal(log.gates.length, 2);
  assert.deepEqual(log.gatesLatest.map((g) => g.result), ['GREEN']);
  assert.equal(log.findings[0].closedBy, 'FIX-1');
  assert.equal(log.ceiling.length, 1);
  assert.equal(log.run.branch, 'feat/sample');
  assert.equal(log.end.verdict, 'MERGE-READY');
  assert.equal(log.lastEventAt, '2026-01-05T12:00:00.000Z');
  assert.equal(log.corrupt, 0);
  assert.equal(log.unrecognised, 0);
});

test('all four discriminator spellings are read; corrupt and unrecognised lines are counted, not dropped', () => {
  const log = runLog.read(join(fixtures, 'run-drift.jsonl'));
  assert.equal(log.steps.length, 1);
  assert.equal(log.gates.length, 1);
  assert.ok(log.run);
  assert.equal(log.corrupt, 1);
  assert.equal(log.unrecognised, 2);
});

test('a missing log is an empty run, with empty decisions — not an error', () => {
  const log = runLog.read(join(fixtures, 'no-such-run.jsonl'));
  assert.deepEqual(log.steps, []);
  assert.deepEqual(log.decisions, []);
  assert.equal(log.run, null);
});

test('append stamps ts and writes the canonical kind', () => {
  const dir = mkdtempSync(join(tmpdir(), 'run-log-'));
  try {
    const file = join(dir, 'nested', 'run.jsonl');
    const stamped = runLog.append(file, { type: 'decision', id: 'DEC-9', what: 'x' });
    assert.equal(stamped.kind, 'decision');
    assert.ok(stamped.ts);
    const line = JSON.parse(readFileSync(file, 'utf8').trim());
    assert.equal(line.kind, 'decision');
    assert.equal(runLog.read(file).decisions.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('closureGaps: a closed run with every done phase logged has no gap; a done phase with no step is one', () => {
  const board = parseBoard(readFileSync(join(fixtures, 'tasks', 'sample.md'), 'utf8'));
  const log = runLog.read(sampleLog);
  assert.deepEqual(runLog.closureGaps(board, log), []);
  const claimed = { phases: [...board.phases, { phase: 'P5 Docs', status: 'DONE' }] };
  assert.deepEqual(runLog.closureGaps(claimed, log), ['P5']);
  assert.deepEqual(runLog.closureGaps(claimed, { ...log, end: null }), []);
});
