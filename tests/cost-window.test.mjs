import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addSummary, dispatchInWindow, render, summarise } from '../scripts/cost-window.mjs';

const summary = (over = {}) => ({ turns: 10, inputTokens: 100, outputTokens: 2_000_000, cacheReadTokens: 30_000_000, cacheWriteTokens: 1_000_000, firstTs: '2026-01-01T10:00:00Z', ...over });

test('a dispatch is in the window by its first turn, and a dispatch with no turns never is', () => {
  assert.equal(dispatchInWindow(summary(), '2026-01-01', '2026-01-02'), true);
  assert.equal(dispatchInWindow(summary({ firstTs: '2025-12-31T23:59:59Z' }), '2026-01-01', '2026-01-02'), false);
  assert.equal(dispatchInWindow(summary({ turns: 0 }), '2026-01-01', '2026-01-02'), false);
  assert.equal(dispatchInWindow(null, '2026-01-01', '2026-01-02'), false);
});

test('rows sum per seat and sort by cost; shares add up', () => {
  const seats = new Map();
  addSummary(seats, 'orchestrator', summary(), 30);
  addSummary(seats, 'module-builder', summary(), 50);
  addSummary(seats, 'module-builder', summary({ turns: 5 }), 20);
  addSummary(seats, null, summary(), 0);
  const result = summarise(seats);
  assert.deepEqual(result.rows.map((r) => r.seat), ['module-builder', 'orchestrator', 'unknown']);
  assert.equal(result.rows[0].dispatches, 2);
  assert.equal(result.rows[0].turns, 15);
  assert.equal(result.rows[0].outputTokens, 4_000_000);
  assert.equal(result.total, 100);
  assert.equal(result.partial, false);
  const table = render(result, { since: 'a', until: 'b', rates: 'r1' });
  assert.match(table, /\| module-builder \| 2 \| 15 \| 4\.0M \| 60\.0M \| 2\.0M \| \$70\.00 \| 70% \|/);
  assert.match(table, /^TOTAL \$100\.00$/m);
});

test('red: an unpriced dispatch is never summed as $0 — the total says it is partial', () => {
  const seats = new Map();
  addSummary(seats, 'module-builder', summary(), 10);
  addSummary(seats, 'module-builder', summary(), null);
  const result = summarise(seats);
  assert.equal(result.total, 10);
  assert.equal(result.partial, true);
  const table = render(result, { since: 'a', until: 'b', rates: 'r1' });
  assert.match(table, /\$10\.00 \(\+1 unpriced\)/);
  assert.match(table, /^TOTAL \$10\.00 — PARTIAL: 1 dispatch\(es\) unpriced$/m);
});
