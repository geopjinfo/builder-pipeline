/**
 * board-rows.cjs — the one row-id vocabulary every board tool imports.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ROW_ID, stripAnnotation, isDecorativeCell, normalizeStatus } = require('../scripts/lib/board-rows.cjs');

test('every documented row form is admitted', () => {
  for (const id of ['T1', 'T12', 'T2a', 'C1', 'D3', 'FIX-1', 'FIX-12', 'FIX-A', 'IC-4', 'NR-3']) {
    assert.ok(ROW_ID.test(id), `${id} should be a row`);
  }
});

test('a sub-lettered deferral half counts as a row', () => {
  assert.ok(ROW_ID.test('D3-a'));
  assert.ok(ROW_ID.test('D14-z'));
});

test('series no board format declares are NOT admitted — widening is deliberate, never incidental', () => {
  for (const id of ['A-12', 'RP-1', 'RUL-2', 'PRB-3', 'N-1', 'D3-A', 'D3-ab', 'T1-a', 'fix-1', 'T', '']) {
    assert.equal(ROW_ID.test(id), false, `${JSON.stringify(id)} must not be a row`);
  }
});

test('an annotation is not identity', () => {
  assert.equal(stripAnnotation('T13 *(added by the plan)*'), 'T13');
  assert.equal(stripAnnotation('NR-3'), 'NR-3');
});

test('separators and bold labels are decorative; anything else is a real row under a wrong name', () => {
  assert.equal(isDecorativeCell(''), true);
  assert.equal(isDecorativeCell('---'), true);
  assert.equal(isDecorativeCell('**TOTAL**'), true);
  assert.equal(isDecorativeCell('A-12'), false);
});

test('emphasis on a status cell does not change what it means', () => {
  assert.equal(normalizeStatus('**DONE**'), 'DONE');
  assert.equal(normalizeStatus('`DEFERRED→REG-D1`'), 'DEFERRED→REG-D1');
  assert.equal(normalizeStatus(undefined), '');
});
