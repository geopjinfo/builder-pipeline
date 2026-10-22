/**
 * The lite-split gate queue (scripts/lib/gate-queue.cjs, feature `liteSplit`).
 *
 * Every DONE is anchored to the sha it was proven at and goes stale when the code it proved changes; a queue
 * that trusted its first result would let a gate batch skip a phase over code that has since moved. The path
 * rules (what counts as bookkeeping, what counts as docs) come from the profile, so they are tested through it.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, test } from 'node:test';

const require = createRequire(import.meta.url);
const q = require('../scripts/lib/gate-queue.cjs');
const profile = require('../scripts/lib/profile.cjs');

/** A fake `git diff --name-only from..to`: the files each sha changed, in order. */
const history = (commits) => (from, to) => {
  const i = commits.findIndex((c) => c.sha === from);
  const j = commits.findIndex((c) => c.sha === to);
  if (i === -1 || j === -1) throw new Error(`unknown sha ${from}..${to}`);
  return [...new Set(commits.slice(i + 1, j + 1).flatMap((c) => c.files))];
};

const C = [
  { sha: 'b0', files: [] },
  { sha: 'a1', files: ['src/alpha/alpha.service.ts', 'test/alpha.spec.ts'] },
  { sha: 'g1', files: ['src/gamma/gamma.service.ts'] },
  { sha: 'x1', files: ['tasks/alpha.md', '.pipeline/alpha/state.md', 'DEFERRED_TASKS.md', 'CHANGELOG.md'] },
  { sha: 'a2', files: ['src/alpha/alpha.controller.ts'] },
];
const cfg = q.config(profile.DEFAULTS);

function alpha(files = ['src/alpha/alpha.service.ts', 'test/alpha.spec.ts']) {
  let s = q.add(q.empty(), { key: 'alpha', base: 'b0', tip: 'a1', files, moduleDir: 'src/alpha' });
  for (const p of q.LITE_PHASES) s = q.mark(s, 'alpha', p, { sha: 'a1', evidence: `${p} ok` });
  return s;
}
function proven(extra) {
  let s = alpha();
  for (const p of q.GATE_PHASES) s = q.mark(s, 'alpha', p, { sha: 'a1', evidence: 'ok' });
  for (const b of q.BATCH_CHECKS) s = q.mark(s, q.BATCH, b, { sha: 'a1', evidence: 'ok' });
  return { s, diff: history([...C.slice(0, 2), ...extra]) };
}

describe('gate queue — what is checked, what is owed', () => {
  test('a lite entry owes every gate phase and every batch check, none of its lite phases', () => {
    const o = q.owed(alpha(), history(C), 'a1', cfg);
    assert.deepEqual(o.modules.alpha, q.GATE_PHASES);
    assert.deepEqual(o.batch, q.BATCH_CHECKS);
  });

  test('red: a change to the module after its sha re-opens P3/P3a, never the plan or the build', () => {
    const o = q.owed(alpha(), history(C), 'a2', cfg).modules.alpha;
    assert.ok(o.includes('3') && o.includes('3a'));
    assert.ok(!o.includes('1') && !o.includes('2'));
  });

  test('another module\'s change and ledger-only commits re-open nothing', () => {
    assert.deepEqual(q.owed(alpha(), history(C), 'x1', cfg).modules.alpha, q.GATE_PHASES);
  });

  test('red: the module\'s own board, listed in base..tip, is still a ledger', () => {
    const s = alpha(['src/alpha/alpha.service.ts', 'tasks/alpha.md']);
    assert.deepEqual(q.owed(s, history(C), 'x1', cfg).modules.alpha, q.GATE_PHASES);
  });

  test('a batch check goes stale on any code move, not on a ledger-only commit', () => {
    let s = alpha();
    for (const b of q.BATCH_CHECKS) s = q.mark(s, q.BATCH, b, { sha: 'g1', evidence: 'green' });
    assert.deepEqual(q.owed(s, history(C), 'x1', cfg).batch, []);
    assert.deepEqual(q.owed(s, history(C), 'a2', cfg).batch, q.BATCH_CHECKS);
  });

  test('red: a README under the module re-opens no module phase; a code file beside it still does', () => {
    const { s, diff } = proven([
      { sha: 'd1', files: ['src/alpha/README.md'] },
      { sha: 'd2', files: ['src/alpha/README.md', 'src/alpha/alpha.service.ts'] },
    ]);
    assert.deepEqual(q.owed(s, diff, 'd1', cfg).modules.alpha, []);
    assert.ok(q.owed(s, diff, 'd2', cfg).modules.alpha.includes('4'));
  });

  test('the path rules follow the profile: a renamed boards directory and an extra ledger pattern', () => {
    const custom = q.config({
      paths: { ...profile.DEFAULTS.paths, boards: 'plan/boards' },
      features: { liteSplit: { state: 'experimental-on', ledgers: ['^reviews/'] } },
    });
    const { s, diff } = proven([{ sha: 'r1', files: ['plan/boards/alpha.md', 'reviews/alpha.md'] }]);
    assert.deepEqual(q.owed(s, diff, 'r1', custom).batch, []);
    assert.deepEqual(q.owed(s, diff, 'r1', cfg).batch, q.BATCH_CHECKS); // the defaults do not know either path
    assert.equal(custom.boards, 'plan/boards');
  });

  test('done() lists every DONE with its sha', () => {
    const s = q.mark(alpha(), q.BATCH, 'gates', { sha: 'g1', evidence: 'green' });
    assert.deepEqual(q.done(s).modules.alpha, q.LITE_PHASES.map((phase) => ({ phase, sha: 'a1' })));
    assert.deepEqual(q.done(s).batch, [{ phase: 'gates', sha: 'g1' }]);
  });

  test('close refuses while anything is owed and flips to GATED when nothing is; reset needs every module GATED', () => {
    assert.throws(() => q.close(alpha(), 'alpha', history(C), 'a1', cfg), /OWED/);
    const { s } = proven([]);
    const closed = q.close(s, 'alpha', history(C), 'a1', cfg);
    assert.equal(closed.modules[0].status, 'GATED');
    assert.throws(() => q.reset(s), /open/);
    assert.deepEqual(q.reset(closed), q.empty(closed.cap));
  });

  test('a DONE needs evidence; add refuses past the cap', () => {
    assert.throws(() => q.mark(alpha(), 'alpha', '4', { sha: 'a1', evidence: ' ' }), /evidence/);
    let s = q.empty(2);
    for (const k of ['m1', 'm2']) s = q.add(s, { key: k, base: 'b0', tip: 'a1', files: [], moduleDir: `src/${k}` });
    assert.throws(() => q.add(s, { key: 'm3', base: 'b0', tip: 'a1', files: [], moduleDir: 'src/m3' }), /cap/);
  });

  test('the queue file round-trips, and the batch board is counted sections with unique ids', () => {
    const s = alpha();
    assert.deepEqual(q.parse(q.serialize(s)), s);
    const b = q.board(q.add(s, { key: 'gamma', base: 'a1', tip: 'g1', files: [], moduleDir: 'src/gamma' }), { boards: 'tasks', batchId: 'one' });
    assert.deepEqual([...b.matchAll(/^## (B\d+) — (.+)$/gm)].map((m) => `${m[1]} ${m[2]}`), ['B0 batch checks', 'B1 alpha', 'B2 gamma']);
    const ids = [...b.matchAll(/^\| (T\d+) \|/gm)].map((m) => m[1]);
    assert.equal(new Set(ids).size, ids.length);
  });

  test('red: a sha-blind queue would report nothing owed after a module change', () => {
    const { s } = proven([]);
    assert.ok(q.owed(s, history(C), 'a2', cfg).modules.alpha.length > 0);
    assert.deepEqual(q.owed(s, history(C), 'a1', cfg).modules.alpha, []);
  });
});

describe('gate queue — retip after a FIX', () => {
  test('re-records tip and files, keeps the phase stamps', () => {
    const s = q.retip(alpha(), 'alpha', { tip: 'a2', files: ['src/alpha/alpha.controller.ts', 'src/alpha/alpha.service.ts'], ancestry: { fromBase: true, fromTip: true } });
    const m = s.modules[0];
    assert.equal(m.tip, 'a2');
    assert.deepEqual(m.files, ['src/alpha/alpha.controller.ts', 'src/alpha/alpha.service.ts']);
    assert.equal(m.phases['1'].sha, 'a1');
  });
  test('refuses no tip, an unknown key, a GATED key, and a tip off the key\'s history', () => {
    assert.throws(() => q.retip(alpha(), 'alpha', { tip: '' }), /--tip <sha> is required/);
    assert.throws(() => q.retip(alpha(), 'beta', { tip: 'a2' }), /beta is not queued/);
    const gated = JSON.parse(JSON.stringify(alpha()));
    gated.modules[0].status = 'GATED';
    assert.throws(() => q.retip(gated, 'alpha', { tip: 'a2' }), /GATED/);
    assert.throws(() => q.retip(alpha(), 'alpha', { tip: 'z9', ancestry: { fromBase: false, fromTip: true } }), /does not descend from the base/);
    assert.throws(() => q.retip(alpha(), 'alpha', { tip: 'z9', ancestry: { fromBase: true, fromTip: false } }), /rebased or side branch/);
  });
});

describe('gate queue — the feature is opt-in', () => {
  test('liteSplit ships experimental-off, and the loader knows its keys', () => {
    const f = profile.feature(profile.DEFAULTS, 'liteSplit');
    assert.equal(f.state, 'experimental-off');
    assert.equal(f.enabled, false);
    assert.equal(f.config.cap, 4);
    assert.equal(f.config.trigger, 3);
  });
});
