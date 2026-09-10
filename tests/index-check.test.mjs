import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const { EXIT, verdict, lineForCode, factsFrom, fromRun } = require('../scripts/lib/index-check.cjs');

const fx = (...p) => join(here, 'fixtures', 'index', ...p);
const facts = (name) => JSON.parse(readFileSync(fx(`facts-${name}.json`), 'utf8'));
const cli = join(here, '..', 'scripts', 'index-check.mjs');

function env(extra) {
  const e = { ...process.env, INDEX_FACTS: '', INDEX_EXIT: '', ...extra };
  const key = Object.keys(e).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
  e[key] = `${dirname(process.execPath)}${delimiter}${e[key] ?? ''}`;
  return e;
}
const run = (dir, extra = {}, args = []) => spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: 'utf8', env: env(extra) });

test('one fixture per exit code: fresh 0 · absent 3 · unmeasurable 4 · docs 10 · code 11 · both 12', () => {
  assert.equal(verdict(facts('fresh')).code, EXIT.FRESH);
  assert.equal(verdict(facts('absent')).code, EXIT.ABSENT);
  assert.equal(verdict(facts('unmeasurable')).code, EXIT.UNMEASURABLE);
  assert.equal(verdict(facts('docs')).code, EXIT.DOCS);
  assert.equal(verdict(facts('code')).code, EXIT.CODE);
  assert.equal(verdict(facts('both')).code, EXIT.BOTH);
  assert.deepEqual(Object.values(EXIT).sort((a, b) => a - b), [0, 1, 3, 4, 10, 11, 12]);
});

test('red: pending docs with no code change is 10, never the 0 a sync worker once returned over them', () => {
  const r = verdict(facts('docs'));
  assert.notEqual(r.code, EXIT.FRESH);
  assert.match(r.lines.join('\n'), /2 pending, 67 KB \(within the 300 KB auto-embed limit\)/);
});

test('the auto-embed limit comes from autoLimitKb; above it a person decides', () => {
  const over = verdict(facts('over-limit'), { autoLimitKb: 100 });
  assert.equal(over.overLimit, true);
  assert.match(over.lines.join('\n'), /200 KB \(ABOVE the 100 KB auto-embed limit — a person decides\)/);
  assert.equal(verdict(facts('over-limit'), { autoLimitKb: 200 }).overLimit, false);
});

test('the commit stamp is information, never the verdict', () => {
  const r = verdict(facts('over-limit'));
  assert.equal(r.code, EXIT.DOCS);
  assert.match(r.lines.join('\n'), /built at 0a1b2c3d ≠ HEAD 9f8e7d6c \(information — freshness is by content\)/);
});

test('fromRun: facts win over the exit code; a bare contract code maps to its line; anything else is an error', () => {
  const stdout = `checking\n${JSON.stringify(facts('docs'))}\n`;
  const r = fromRun({ status: 0, stdout });
  assert.equal(r.code, EXIT.DOCS);
  assert.match(r.lines.join('\n'), /the check exited 0; its facts say exit 10 — the facts win/);
  assert.deepEqual(fromRun({ status: 11, stdout: 'prose only' }), { code: 11, lines: [lineForCode(11)] });
  assert.equal(fromRun({ status: 7, stdout: '' }).code, EXIT.ERROR);
  assert.equal(fromRun({ spawnError: true, status: null }).code, EXIT.UNMEASURABLE);
  assert.equal(factsFrom('{not json\n[1,2]\n'), null);
});

test('CLI: the check command’s facts decide the exit code, one run per code', () => {
  const cases = { fresh: 0, absent: 3, unmeasurable: 4, docs: 10, code: 11, both: 12 };
  for (const [name, code] of Object.entries(cases)) {
    const r = run(fx(), { INDEX_FACTS: `facts-${name}.json` });
    assert.equal(r.status, code, `${name}: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, new RegExp(`verdict: [a-z+-]+ \\(exit ${code}\\)`));
  }
  const over = run(fx(), { INDEX_FACTS: 'facts-over-limit.json' });
  assert.match(over.stdout, /ABOVE the 100 KB auto-embed limit/);
});

test('CLI: a check that prints no facts is judged by its exit code; a code outside the contract is an error', () => {
  for (const code of [0, 3, 4, 10, 11, 12]) {
    const r = run(fx(), { INDEX_EXIT: String(code) });
    assert.equal(r.status, code, r.stdout);
    assert.equal(r.stdout.trim(), lineForCode(code));
  }
  const odd = run(fx(), { INDEX_EXIT: '7' });
  assert.equal(odd.status, EXIT.ERROR);
  assert.match(odd.stdout, /exited 7, which is not in the exit-code contract/);
  assert.equal(JSON.parse(run(fx(), { INDEX_FACTS: 'facts-code.json' }, ['--json']).stdout).code, 11);
});

test('CLI: feature off prints "graph: not configured" and exits 3, so the absent branch applies', () => {
  const r = run(fx('off'));
  assert.equal(r.status, 3);
  assert.equal(r.stdout.trim(), 'graph: not configured');
});
