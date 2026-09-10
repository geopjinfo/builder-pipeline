import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const { observe, verdict, EXIT } = require('../scripts/lib/orchestrator-check.cjs');
const cli = join(here, '..', 'scripts', 'orchestrator-check.mjs');
const fx = (...p) => join(here, 'fixtures', 'hooks', ...p);
const run = (dir, args = []) =>
  spawnSync(process.execPath, [cli, ...args], { cwd: fx(dir), encoding: 'utf8', env: { ...process.env, CLAUDE_CODE_SESSION_ID: '' } });

const declared = 'model-alpha';
const seen = (dominant, turns = 40) => ({ models: { [dominant]: turns }, dominant, turns });
const turn = (id, model, extra = {}) => ({ type: 'assistant', message: { id, model }, ...extra });

test('red: a session on another model warns with exit 5 and names the switch', () => {
  const r = verdict({ declared, observed: seen('model-beta') });
  assert.equal(r.code, EXIT.WARN);
  assert.equal(r.code, 5);
  assert.equal(r.warn, true);
  assert.match(r.line, /^WARNING orchestrator model: this session runs model-beta, the profile declares model-alpha/);
});

test('silent on the declared model, including a context-window suffix on either side', () => {
  for (const [d, o] of [[declared, 'model-alpha'], [declared, 'model-alpha[1m]'], ['model-alpha[1m]', 'model-alpha']]) {
    const r = verdict({ declared: d, observed: seen(o) });
    assert.equal(r.code, 0);
    assert.equal(r.warn, false);
    assert.doesNotMatch(r.line, /WARNING/);
  }
});

test('red: no turns is unmeasured — never a warning and never "as declared"', () => {
  for (const observed of [null, observe([]), { models: {}, dominant: null, turns: 0 }]) {
    const r = verdict({ declared, observed });
    assert.equal(r.code, 0);
    assert.equal(r.warn, false);
    assert.equal(r.state, 'unmeasured');
    assert.match(r.line, /unmeasured, not a pass/);
    assert.doesNotMatch(r.line, /as declared/);
  }
});

test('a harness with no readable transcript says unmeasurable', () => {
  const r = verdict({ declared, observed: null, measurable: false });
  assert.equal(r.line, 'orchestrator model: unmeasurable with this harness');
  assert.equal(r.code, 0);
});

test('observe: one count per message id, sidechain and synthetic turns ignored, the recent window honoured', () => {
  const records = [
    turn('a', 'model-beta'),
    turn('a', 'model-beta'),
    turn('b', 'model-beta'),
    turn('s', 'model-alpha', { isSidechain: true }),
    turn('x', '<synthetic>'),
    { type: 'user', message: { content: 'hi' } },
    turn('c', 'model-alpha'),
    turn('d', 'model-alpha'),
    turn('e', 'model-alpha'),
  ];
  assert.deepEqual(observe(records), { models: { 'model-beta': 2, 'model-alpha': 3 }, dominant: 'model-alpha', turns: 5 });
  // An earlier switch: only the last three turns count.
  assert.equal(observe(records, 3).dominant, 'model-alpha');
  assert.deepEqual(observe(records, 3).models, { 'model-alpha': 3 });
});

test('CLI: a mismatched transcript exits 5 with the warning', () => {
  const r = run('orchestrator', ['--transcript', 'mismatch.jsonl']);
  assert.equal(r.status, 5, r.stderr);
  assert.match(r.stdout, /WARNING orchestrator model: this session runs model-beta/);
});

test('CLI: a matching [1m] transcript exits 0 without a warning', () => {
  const r = run('orchestrator', ['--transcript', 'match-1m.jsonl']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /model-alpha\[1m\] — as declared \(2 recent turns\)/);
  assert.doesNotMatch(r.stdout, /WARNING/);
});

test('CLI red: a transcript with no orchestrator turns is unmeasured, exit 0', () => {
  const r = run('orchestrator', ['--transcript', 'no-turns.jsonl']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /unmeasured, not a pass/);
});

test('CLI: feature off prints not configured; another reader prints unmeasurable', () => {
  const off = run('orchestrator-off');
  assert.equal(off.status, 0);
  assert.equal(off.stdout.trim(), 'orchestratorModel: not configured');
  const other = run('orchestrator-other');
  assert.equal(other.status, 0);
  assert.equal(other.stdout.trim(), 'orchestrator model: unmeasurable with this harness');
});
