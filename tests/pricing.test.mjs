/**
 * pricing.cjs — the versioned rate table, the two cache-write TTL rates, the context-window suffix,
 * and `null` (never zero) for a model the table does not name.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pricing = require('../scripts/lib/pricing.cjs');

const M = 1_000_000;
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `expected ${expected}, got ${actual}`);

test('the table carries a version the board can print beside a total', () => {
  assert.match(pricing.version, /^\d{4}-\d{2}-\d{2}$/);
});

test('input, output and cache reads are priced per million tokens', () => {
  close(pricing.cost('claude-sonnet-5', { inputTokens: M, outputTokens: M, cacheReadTokens: M }), 2 + 10 + 0.2);
});

test('a 1-hour cache write is priced at the 1-hour rate, not the 5-minute one', () => {
  const oneHour = pricing.cost('claude-opus-5', { cacheWriteTokens: M, cacheWrite1hTokens: M });
  close(oneHour, 10);
  // red proof: the same tokens priced as a 5-minute write would be 6.25 — the split must not collapse
  assert.notEqual(oneHour, pricing.cost('claude-opus-5', { cacheWriteTokens: M, cacheWrite5mTokens: M }));
  close(pricing.cost('claude-opus-5', { cacheWriteTokens: M, cacheWrite5mTokens: M }), 6.25);
});

test('a cache write with no recorded split is priced at the 5-minute rate; a partial split prices the remainder that way', () => {
  close(pricing.cost('claude-opus-5', { cacheWriteTokens: M }), 6.25);
  close(pricing.cost('claude-opus-5', { cacheWriteTokens: 3 * M, cacheWrite5mTokens: M, cacheWrite1hTokens: M }), 2 * 6.25 + 10);
});

test('a context-window suffix on the model id is stripped before lookup', () => {
  close(pricing.cost('claude-opus-5[1m]', { inputTokens: M }), 5);
  // the current Opus and Sonnet are priced, so their dispatches are no longer "unpriced"
  close(pricing.cost('claude-opus-5-5', { inputTokens: M, outputTokens: M, cacheReadTokens: M }), 4 + 20 + 0.2);
  close(pricing.cost('claude-sonnet-5-5[1m]', { cacheWriteTokens: M, cacheWrite1hTokens: M }), 4);
  assert.equal(pricing.baseModel('claude-opus-5[1m]'), 'claude-opus-5');
});

test('a dated alias prices as its model', () => {
  close(pricing.cost('claude-haiku-4-5-20251001', { outputTokens: M }), 5);
});

test('an unknown model has no derivable cost: null, never 0', () => {
  assert.equal(pricing.cost('some-other-model', { inputTokens: M }), null);
  assert.equal(pricing.cost(undefined, {}), null);
});

test('a total with any unpriced row is null — a partial total is a lie', () => {
  close(pricing.total([{ model: 'claude-sonnet-5', inputTokens: M }]), 2);
  assert.equal(pricing.total([{ model: 'claude-sonnet-5', inputTokens: M }, { model: 'unknown', inputTokens: 1 }]), null);
});

test('missing usage fields count as zero tokens, not as an unknown price', () => {
  assert.equal(pricing.cost('claude-sonnet-5', {}), 0);
});
