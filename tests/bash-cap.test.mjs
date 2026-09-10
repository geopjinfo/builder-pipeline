import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { digest, EXEMPT, MAX_ERROR_LINES } = require('../scripts/lib/bash-cap.cjs');

const big = (middle) =>
  [...Array.from({ length: 400 }, (_, i) => `line ${i} ok ${'x'.repeat(20)}`), middle, ...Array.from({ length: 400 }, (_, i) => `after ${i} ${'y'.repeat(20)}`)].join('\n');

test('output at or under the limit is untouched', () => {
  assert.deepEqual(digest({ stdout: 'small' }), { capped: false });
  assert.deepEqual(digest({ stdout: 'z'.repeat(4096) }), { capped: false });
  assert.equal(digest({ stdout: 'z'.repeat(4097) }).capped, true);
});

test('the limit is a parameter', () => {
  assert.equal(digest({ stdout: 'z'.repeat(200) }, { limit: 100 }).capped, true);
  assert.deepEqual(digest({ stdout: 'z'.repeat(200) }, { limit: 1000 }), { capped: false });
});

test('larger output becomes error lines + tail + log path', () => {
  const d = digest({ stdout: big('nothing to see') }, { logPath: 'logs/bash/x.log' });
  assert.equal(d.capped, true);
  assert.match(d.text, /full output: logs\/bash\/x\.log/);
  assert.match(d.text, /no error-shaped line before the tail/);
  assert.match(d.text, /after 399/);
  assert.doesNotMatch(d.text, /line 200 ok/);
  assert.ok(d.text.length < 4000, `digest is ${d.text.length} chars`);
});

test('red: an error line buried mid-output survives the cap, with its line number', () => {
  const d = digest({ stdout: big('Error: stale version token in items.service.ts') });
  assert.match(d.text, /^401: Error: stale version token in items\.service\.ts$/m);
  assert.equal(d.errorLines, 1);
});

test('stderr is kept', () => {
  const d = digest({ stdout: big('fine'), stderr: 'ERR! code ELIFECYCLE' });
  assert.match(d.text, /ERR! code ELIFECYCLE/);
});

test('past the error-line ceiling the digest says the rest are in the log', () => {
  const noisy = Array.from({ length: MAX_ERROR_LINES + 50 }, (_, i) => `FAIL test ${i} ${'z'.repeat(40)}`).join('\n') + '\n' + 'tail\n'.repeat(40);
  const d = digest({ stdout: noisy });
  assert.equal(d.capped, true);
  assert.match(d.text, new RegExp(`${MAX_ERROR_LINES + 50} error-shaped line\\(s\\) before the tail — first ${MAX_ERROR_LINES} shown, the rest are in the log`));
});

test('the tier runner and explicit opt-outs are exempt; an ordinary command is not', () => {
  assert.equal(EXEMPT.test('node scripts/run-tier.mjs integration'), true);
  assert.equal(EXEMPT.test('node scripts\\run-tier.mjs unit --affected'), true);
  assert.equal(EXEMPT.test('grep -rn foo . --no-cap'), true);
  assert.equal(EXEMPT.test('BUILDER_NO_BASH_CAP=1 grep -rn foo .'), true);
  assert.equal(EXEMPT.test('grep -rn foo .'), false);
  assert.equal(EXEMPT.test('grep -rn run-tier-notes docs'), false);
  assert.equal(EXEMPT.test('echo --no-capture'), false);
});
