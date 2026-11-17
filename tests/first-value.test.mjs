import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

test('red: first value under 300 s', () => {
  const result = spawnSync(process.execPath, ['scripts/first-value.mjs', '--json'], {
    cwd: root, encoding: 'utf8', timeout: 360000,
  });
  assert.equal(result.status, 0, result.stderr || String(result.error || ''));
  const report = JSON.parse(result.stdout);
  assert.ok(report.seconds > 0);
  assert.ok(report.seconds < 300, `first value took ${report.seconds} s`);
  for (const step of ['pack', 'install', 'inventory', 'claimsCheck']) {
    assert.ok(Object.hasOwn(report.steps, step), `missing step: ${step}`);
  }
});

test('first value refuses an unknown flag', () => {
  const result = spawnSync(process.execPath, ['scripts/first-value.mjs', '--unknown'], {
    cwd: root, encoding: 'utf8',
  });
  assert.equal(result.status, 2, result.stderr);
});
