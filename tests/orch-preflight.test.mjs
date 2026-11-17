/**
 * The smoke re-run before an account's first launch — `scripts/lib/orch-preflight.cjs` `smokeDue` / `runSmoke` and the
 * gate-launch refusal (REQ-308; D31).
 *
 * WHY. An account whose last smoke pass is old may have lost its login or its write path since. The kit re-runs the
 * account's own `smokeCommand` itself before the first launch on it in a run; a failure refuses the launch naming the
 * account, so nobody has to run `accounts` first. Every command here is `node -e …`, so the test runs on every CI host.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { describe, test } from 'node:test';
import { ACCOUNTS_HOME_OF, lanes, orch, profileText, tmp } from './fixtures/orch/rig.mjs';

const require = createRequire(import.meta.url);
const pre = require('../scripts/lib/orch-preflight.cjs');
const state = require('../scripts/lib/orch-state.cjs');
const acct = require('../scripts/lib/orch-accounts.cjs');
const accountPaths = require('../scripts/lib/account-paths.cjs');

const NOW = Date.parse('2026-11-17T12:00:00.000Z');
const ago = (min) => new Date(NOW - min * 60000).toISOString();
const exit = (code) => `node -e "process.exit(${code})"`;

describe('smokeDue and runSmoke (REQ-308)', () => {
  test('red: REQ-308 a pass older than the stale window, a failed pass or no record is due; a fresh pass is not', () => {
    assert.equal(pre.smokeDue(null, NOW, 30), true);
    assert.equal(pre.smokeDue({ ok: true, at: ago(45) }, NOW, 30), true);
    assert.equal(pre.smokeDue({ ok: true, at: ago(10) }, NOW, 30), false);
    assert.equal(pre.smokeDue({ ok: false, at: ago(1) }, NOW, 30), true, 'a failed pass is always due again');
    assert.equal(pre.smokeDue({ ok: true, at: 'nonsense' }, NOW, 30), true);
  });

  test('red: REQ-308 runSmoke runs the account\'s smokeCommand in its scrubbed env and writes smoke.json with the verdict and the time', () => {
    const home = tmp('smoke-home');
    const account = { name: 'alpha', worker: 'claude-code', smokeCommand: exit(0) };
    const paths = accountPaths.paths(home, 'alpha', account);
    const r = pre.runSmoke(account, paths, { cwd: home, now: NOW });
    assert.deepEqual([r.ok, r.exit, r.at], [true, 0, new Date(NOW).toISOString()]);
    assert.deepEqual(JSON.parse(readFileSync(paths.smokeFile, 'utf8')), r);
    const bad = pre.runSmoke({ ...account, smokeCommand: exit(4) }, paths, { cwd: home, now: NOW + 1000 });
    assert.deepEqual([bad.ok, bad.exit], [false, 4]);
    assert.equal(JSON.parse(readFileSync(paths.smokeFile, 'utf8')).ok, false, 'the record is replaced');
    assert.throws(() => pre.runSmoke({ name: 'bravo', worker: 'claude-code' }, paths), /refused: account bravo has no smokeCommand/);
    const probes = require('../scripts/lib/account-probes.cjs');
    assert.equal(probes.smokeRecord(paths).ok, false, 'the assessment reads the same file');
  });
});

describe('gate-launch re-runs a stale smoke before the first launch on an account (REQ-308)', () => {
  const plan = (over = {}) => ({ worker: 'claude-code', pays: 'subscription', content: 'any', roles: [], budget: { kind: 'percent', soft: null, hard: 85 }, maxTurns: 40, timeoutMinutes: 90, command: 'go {brief}', configDir: '.claude-india', ...over });
  function project(smokeCommand) {
    const dir = tmp('smoke');
    writeFileSync(join(dir, 'PIPELINE_PROFILE.md'), profileText({ orchestrator: { launchCommand: 'go {brief}' }, accounts: { india: plan({ smokeCommand }) } }));
    const root = join(dir, 'orch');
    const lanesFile = join(dir, 'lanes.json');
    writeFileSync(lanesFile, JSON.stringify(lanes(2)));
    const init = orch(dir, root, ['init', 'sm', '--lanes', lanesFile, '--mode', 'parallel', '--repo', dir]);
    assert.equal(init.status, 0, init.out);
    state.approve(root, 'sm', 'lead');
    state.recordUsage(root, 'sm', 'primary', 70);
    state.recordUsage(root, 'sm', 'india', 20);
    state.setLane(root, 'sm', 'l1', { status: 'CLAIMED' });
    return { dir, root, smokeFile: accountPaths.paths(ACCOUNTS_HOME_OF(), 'india', {}).smokeFile };
  }
  const smokes = (root) => readFileSync(join(root, 'runs', 'sm', 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.type === 'account.smoke');

  test('red: REQ-308 a failing smokeCommand refuses the launch naming the account, records it not ready, and the next placement skips it (AC-308a)', () => {
    const { dir, root } = project(exit(3));
    const r = orch(dir, root, ['gate-launch', 'sm', 'l1']);
    assert.equal(r.status, 3, r.out);
    assert.match(r.out, /REFUSED launch sm\/l1: smoke failed on account india \(exit 3\) — the account is not ready/);
    assert.equal(smokes(root).length, 1);
    assert.equal(smokes(root)[0].ok, false);
    const rec = acct.load(root).accounts.india;
    assert.equal(rec.state, 'not ready');
    assert.match(rec.reason, /smoke failed \(exit 3\)/);
    assert.equal(/LAUNCH l1/.test(orch(dir, root, ['next', 'sm'], { }).stdout), true, 'the next assessment re-reads the probe: the account is signed in, the smoke record alone is read-only');
  });

  test('red: REQ-308 a stale pass re-runs once before the first launch; a fresh pass and a later launch on the same account do not', () => {
    const { dir, root, smokeFile } = project(exit(0));
    writeFileSync(smokeFile, JSON.stringify({ ok: true, at: new Date(Date.now() - 45 * 60000).toISOString() })); // stale against the real clock the CLI reads
    const r = orch(dir, root, ['gate-launch', 'sm', 'l1']);
    assert.equal(r.status, 0, r.out);
    assert.equal(smokes(root).length, 1);
    assert.equal(smokes(root)[0].ok, true);
    assert.equal(JSON.parse(readFileSync(smokeFile, 'utf8')).ok, true);
    assert.ok(Date.now() - Date.parse(JSON.parse(readFileSync(smokeFile, 'utf8')).at) < 60000, 'the record carries the new pass time');
    state.setLane(root, 'sm', 'l1', { status: 'LAUNCHED', seat: 'india', sessionId: 'i1' });
    state.setLane(root, 'sm', 'l2', { status: 'CLAIMED' });
    assert.equal(orch(dir, root, ['gate-launch', 'sm', 'l2']).status, 0);
    assert.equal(smokes(root).length, 1, 'the second launch on the account runs no smoke');
    assert.ok(existsSync(smokeFile));
  });
});
