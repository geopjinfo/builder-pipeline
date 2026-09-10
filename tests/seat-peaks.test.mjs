import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aggregate, dispatchPeak, dispatchTurns, inWindow, promptTokens, render } from '../scripts/seat-peaks.mjs';

const line = (id, ts, usage, model = 'model-alpha') => ({ type: 'assistant', timestamp: ts, message: { id, model, usage } });

// One dispatch: message m1 written as three lines (one per content block) repeating the same usage.
const dispatch = [
  { type: 'user', timestamp: '2026-01-01T10:00:00Z', message: { content: 'brief' } },
  line('m1', '2026-01-01T10:00:01Z', { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 500 }),
  line('m1', '2026-01-01T10:00:01Z', { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 500 }),
  line('m1', '2026-01-01T10:00:01Z', { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 500 }),
  line('m2', '2026-01-01T10:00:09Z', { input_tokens: 5, cache_read_input_tokens: 3000, cache_creation_input_tokens: 0 }),
  line('x', '2026-01-01T10:00:10Z', { input_tokens: 999999 }, '<synthetic>'),
];

test('the prompt a turn was billed on is input + cache read + cache write', () => {
  assert.equal(promptTokens({ input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 500, output_tokens: 70 }), 1510);
  assert.equal(promptTokens({}), 0);
});

test('turns are de-duplicated by message id; synthetic turns are not turns', () => {
  assert.equal(dispatchTurns(dispatch).length, 2);
  assert.deepEqual(dispatchPeak(dispatch), { peak: 3005, turns: 2, firstTs: '2026-01-01T10:00:01Z' });
});

test('red: a dispatch with no turns has no peak — unmeasured, not zero', () => {
  assert.equal(dispatchPeak([{ type: 'user', message: {} }]), null);
  assert.equal(dispatchPeak([]), null);
});

test('a dispatch is in the window by its first turn', () => {
  assert.equal(inWindow('2026-01-01T10:00:01Z', '2026-01-01', '2026-01-02'), true);
  assert.equal(inWindow('2026-01-03T00:00:00Z', '2026-01-01', '2026-01-02'), false);
  assert.equal(inWindow('2026-01-03T00:00:00Z', null, null), true);
  assert.equal(inWindow(null, null, null), false);
});

test('aggregate: median, p90 and max per seat, largest max first; an unpriced dispatch is counted, not summed as $0', () => {
  const rows = aggregate([
    { seat: 'module-builder', peak: 100_000, turns: 10, cost: 1 },
    { seat: 'module-builder', peak: 700_000, turns: 30, cost: null },
    { seat: 'module-builder', peak: 200_000, turns: 20, cost: 2 },
    { seat: 'module-tester', peak: 50_000, turns: 4, cost: 0.5 },
    { seat: null, peak: 10, turns: 1, cost: 0 },
  ]);
  assert.deepEqual(rows.map((r) => r.seat), ['module-builder', 'module-tester', 'unknown']);
  assert.deepEqual(rows[0], { seat: 'module-builder', dispatches: 3, medianPeak: 200_000, p90Peak: 700_000, maxPeak: 700_000, turnsPerDispatch: 20, cost: 3, unpriced: 1 });
  const table = render(rows, { since: '2026-01-01', until: '2026-01-02', rates: 'test-rates' });
  assert.match(table, /^window 2026-01-01 → 2026-01-02 · rates test-rates$/m);
  assert.match(table, /\| module-builder \| 3 \| 200k \| 700k \| 700k \| 20 \| \$3\.00 \(\+1 unpriced\) \|/);
});

test('an empty window renders the header only', () => {
  assert.equal(render(aggregate([]), { since: null, until: null, rates: null }).split('\n').length, 3);
});
