/**
 * Batch orchestrator — run state, placement, claims, pause, resume after a kill, preflight, the tests switch and the
 * feature gate (scripts/lib/orch-{state,claims,preflight}.cjs, scripts/orch.mjs). Every guard has a red case.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { lanes, orch, profileText, tmp } from './fixtures/orch/rig.mjs';

const require = createRequire(import.meta.url);
const state = require('../scripts/lib/orch-state.cjs');
const claims = require('../scripts/lib/orch-claims.cjs');
const pre = require('../scripts/lib/orch-preflight.cjs');
const profile = require('../scripts/lib/profile.cjs');

/** A temp project dir with a profile and a store root. */
function project(orchestrator = {}) {
  const dir = tmp('proj');
  writeFileSync(join(dir, 'PIPELINE_PROFILE.md'), profileText({ orchestrator }));
  return { dir, root: join(dir, 'orch') };
}

describe('the feature gate', () => {
  test('red: with no profile, or the feature off, every command says "not configured" and changes nothing', () => {
    const dir = tmp('off');
    const root = join(dir, 'orch');
    for (const args of [['status'], ['pause'], ['split', 'x.md']]) {
      const r = orch(dir, root, args);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /^orchestrator: not configured$/m);
    }
    assert.equal(existsSync(join(root, 'PAUSE')), false);
    writeFileSync(join(dir, 'PIPELINE_PROFILE.md'), profileText({ orchestrator: { state: 'off' } }));
    assert.match(orch(dir, root, ['pause']).stdout, /orchestrator: not configured/);
    assert.equal(existsSync(join(root, 'PAUSE')), false);
  });

  test('the features line is printed and its absence never reads as on', () => {
    assert.equal(profile.feature(profile.DEFAULTS, 'orchestrator').line, 'orchestrator: not configured');
    assert.equal(profile.feature(profile.DEFAULTS, 'orchestrator').enabled, false);
    assert.equal(profile.FEATURES.orchestrator.defaults.credit.enabled, false);
  });

  test('red: an active orchestrator validates its shapes — target, seats, lite without liteSplit, secondary without a launcher, credit without a cap', () => {
    const errs = (o, extra = {}) => profile.parse(profileText({ orchestrator: o, ...extra })).errors.join('\n');
    assert.equal(errs({}), '');
    assert.match(errs({ target: null }), /features\.orchestrator\.target: required/);
    assert.match(errs({ seats: ['tertiary'] }), /features\.orchestrator\.seats/);
    assert.match(errs({ seats: [] }), /features\.orchestrator\.seats/);
    assert.match(errs({ standardPipeline: 'lite' }), /needs features\.liteSplit enabled/);
    assert.match(errs({ seats: ['secondary', 'primary'] }), /launchCommand: required while "secondary" is a seat/);
    assert.match(errs({ launchCommand: 'start-worker' }), /launchCommand: must contain \{brief\}/);
    assert.match(errs({ credit: { enabled: true } }), /credit\.dailyCapUsd: required/);
    assert.match(errs({ credit: { enabled: true, dailyCapUsd: 0, fallback: [] } }), /dailyCapUsd: must be > 0/);
    assert.match(errs({ credit: { enabled: true, dailyCapUsd: 5 } }), /secondaryConfigDir: required while the credit fallback names "secondary"/);
    assert.match(errs({ credit: { enabled: true, dailyCapUsd: 5, fallback: [], commands: ['npm run *'] } }), /no wildcards/);
    assert.match(errs({ tests: { mode: 'remote', local: null, remote: null } }), /tests\.remote: required/);
    assert.match(errs({ preflight: [{ name: 'x' }] }), /preflight\[0\]/);
    assert.match(errs({ modulePattern: '^src/modules/' }), /needs one capture group/);
    assert.equal(errs({ credit: { enabled: true, dailyCapUsd: 5, fallback: [] } }), '');
  });
});

describe('claims', () => {
  test('red: a second lane claiming an owned file is refused; a hot file is shared; release frees it', () => {
    const root = tmp('claims');
    assert.equal(claims.claim(root, { runId: 'r1', lane: 'l1', owned: ['src/modules/payments/**'], hot: ['CHANGELOG.md'] }).ok, true);
    const clash = claims.claim(root, { runId: 'r2', lane: 'l1', owned: ['src/modules/payments/refund.ts'], hot: [] });
    assert.equal(clash.ok, false);
    assert.equal(clash.conflicts[0].heldBy, 'r1/l1');
    assert.equal(claims.claim(root, { runId: 'r1', lane: 'l2', owned: ['src/modules/projects/**'], hot: ['CHANGELOG.md'] }).ok, true);
    assert.equal(claims.release(root, { runId: 'r1', lane: 'l1' }), 2);
    assert.equal(claims.claim(root, { runId: 'r2', lane: 'l1', owned: ['src/modules/payments/refund.ts'], hot: [] }).ok, true);
  });
});

describe('a killed orchestrator resumes from the state file', () => {
  test('red: a lock left by a killed process is taken over, and a fresh process derives the same next steps', () => {
    const { dir, root } = project();
    state.init(root, 'k1', lanes(3), { target: 'dev', preflightMode: 'parallel' });
    state.approve(root, 'k1', 'human');
    state.recordUsage(root, 'k1', 'primary', 20);
    state.setLane(root, 'k1', 'l1', { status: 'LAUNCHED', seat: 'primary', sessionId: 'sess-1' });
    state.setLane(root, 'k1', 'l2', { status: 'CLAIMED' });
    const lock = join(root, 'runs', 'k1', 'state.lock');
    const killed = spawnSync(process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(lock)}, 'dead'); process.kill(process.pid, 'SIGKILL')`]);
    assert.ok(killed.signal || killed.status);
    assert.ok(existsSync(lock));
    const old = new Date(Date.now() - 120000);
    utimesSync(lock, old, old);
    const status = orch(dir, root, ['status', 'k1']);
    assert.equal(status.status, 0, status.out);
    assert.match(status.stdout, /WAIT l1: running on primary \(session sess-1\)/);
    assert.match(status.stdout, /LAUNCH l2:/);
    const set = orch(dir, root, ['set', 'k1', 'l2', 'status=LAUNCHED', 'sessionId=sess-2']);
    assert.equal(set.status, 0, set.out); // the stale lock was taken over
    const s = state.load(root, 'k1');
    assert.deepEqual([s.lanes.l1.sessionId, s.lanes.l2.status], ['sess-1', 'LAUNCHED']);
    assert.equal(state.nextActions(root, s).some((a) => a.startsWith('LAUNCH l3')), false); // two lanes max
    assert.ok(readFileSync(join(root, 'runs', 'k1', 'events.jsonl'), 'utf8').trim().split('\n').length >= 5);
  });

  test('red: init refuses to overwrite a run', () => {
    const root = tmp('reinit');
    state.init(root, 'x1', lanes(1), {});
    assert.throws(() => state.init(root, 'x1', lanes(1), {}), /already exists — resume it/);
  });

  test('red: no notice in time is a STALL; a finish notice without a result file is not DONE', () => {
    const root = tmp('stall');
    state.init(root, 's1', lanes(1), { preflightMode: 'parallel' });
    state.approve(root, 's1', 'human');
    state.setLane(root, 's1', 'l1', { status: 'LAUNCHED', sessionId: 'z', stallMinutes: 1 });
    assert.match(state.nextActions(root, state.load(root, 's1'), Date.now() + 5 * 60000)[0], /^STALL l1/);
    assert.equal(state.notice(root, 's1', 'l1').status, 'STALLED');
    const result = state.load(root, 's1').lanes.l1.result;
    mkdirSync(dirname(result), { recursive: true });
    writeFileSync(result, 'RESULT: PASS ok\n');
    assert.deepEqual(state.notice(root, 's1', 'l1'), { lane: 'l1', status: 'DONE', resultLine: 'RESULT: PASS ok' });
  });

  test('red: an unapproved run launches nothing — it waits for the human', () => {
    const root = tmp('approve');
    state.init(root, 'a1', lanes(2), { preflightMode: 'parallel' });
    const acts = state.nextActions(root, state.load(root, 'a1'));
    assert.match(acts[0], /^AWAIT-APPROVAL/);
    assert.equal(acts.some((a) => a.startsWith('LAUNCH')), false);
  });

  test('red: one pause halts every run — no launches, no merges; resume restores them', () => {
    const { dir, root } = project();
    for (const r of ['p1', 'p2']) {
      state.init(root, r, lanes(1), { preflightMode: 'parallel' });
      state.approve(root, r, 'human');
    }
    assert.equal(orch(dir, root, ['pause']).status, 0);
    for (const r of ['p1', 'p2']) assert.match(state.nextActions(root, state.load(root, r))[0], /^PAUSED/);
    const merge = require('../scripts/lib/orch-merge.cjs');
    assert.throws(() => merge.mergeNext(root, 'p1', { slotOk: true, gatesCmd: 'x' }), /paused/);
    assert.equal(orch(dir, root, ['resume']).status, 0);
    assert.match(state.nextActions(root, state.load(root, 'p1'))[0], /^LAUNCH l1/);
  });
});

describe('lane placement: the secondary seat first, then the primary under its lower limit, hold when both are full', () => {
  const run = (id, seats = ['secondary', 'primary']) => {
    const root = tmp(id);
    state.init(root, id, lanes(2), { preflightMode: 'parallel', seats, limits: { secondary: 80, primary: 60 } });
    state.approve(root, id, 'human');
    return root;
  };
  const launches = (root, id) => state.nextActions(root, state.load(root, id)).filter((a) => a.startsWith('LAUNCH'));

  test('secondary under its limit → the lane goes to the secondary terminal worker', () => {
    const root = run('pb');
    state.recordUsage(root, 'pb', 'secondary', 40);
    state.recordUsage(root, 'pb', 'primary', 10);
    assert.match(launches(root, 'pb')[0], /^LAUNCH l1: .* on secondary \(terminal worker on the secondary account\)$/);
  });

  test('red: secondary at its limit, primary under its lane limit → the lane goes to the primary seat, not held', () => {
    const root = run('pa');
    state.recordUsage(root, 'pa', 'secondary', 85);
    state.recordUsage(root, 'pa', 'primary', 30);
    const acts = state.nextActions(root, state.load(root, 'pa'));
    assert.equal(acts.some((a) => a.startsWith('USAGE-HOLD')), false);
    assert.match(acts.find((a) => a.startsWith('LAUNCH l1')), /on primary \(primary account: a sub-agent for a solo lane, its own session for a pipeline lane\)$/);
  });

  test('red: both seats full → USAGE-HOLD, nothing launches', () => {
    const root = run('ph');
    state.recordUsage(root, 'ph', 'secondary', 90);
    state.recordUsage(root, 'ph', 'primary', 60);
    const acts = state.nextActions(root, state.load(root, 'ph'));
    assert.ok(acts.some((a) => /^USAGE-HOLD: secondary at 90% .*primary at 60%/.test(a)), acts.join('\n'));
    assert.deepEqual(launches(root, 'ph'), []);
  });

  test('red: secondary full and primary unmeasured → USAGE-UNKNOWN for primary, nothing launches', () => {
    const root = run('pu');
    state.recordUsage(root, 'pu', 'secondary', 95);
    const acts = state.nextActions(root, state.load(root, 'pu'));
    assert.ok(acts.some((a) => a.startsWith('USAGE-UNKNOWN: primary usage unmeasured')), acts.join('\n'));
    assert.deepEqual(launches(root, 'pu'), []);
  });

  test('red: the first lane may start unmeasured; a second lane needs a fresh reading', () => {
    const root = run('p1st');
    assert.equal(launches(root, 'p1st').length, 2); // nothing running: both slots, first seat unmeasured
    state.setLane(root, 'p1st', 'l1', { status: 'LAUNCHED', seat: 'secondary' });
    const acts = state.nextActions(root, state.load(root, 'p1st'));
    assert.ok(acts.some((a) => a.startsWith('USAGE-UNKNOWN: secondary')), acts.join('\n'));
    assert.deepEqual(launches(root, 'p1st'), []);
  });

  test('a primary-only project places every lane on the primary seat', () => {
    const root = run('ponly', ['primary']);
    state.recordUsage(root, 'ponly', 'primary', 10);
    assert.match(launches(root, 'ponly')[0], /on primary/);
  });

  test('red: gate-launch (the terminal-worker launcher) refuses a lane placed on the primary seat', () => {
    const { dir, root } = project({ seats: ['secondary', 'primary'], launchCommand: 'start-worker --brief "{brief}"' });
    state.init(root, 'pg', lanes(2), { preflightMode: 'parallel', seats: ['secondary', 'primary'] });
    state.approve(root, 'pg', 'human');
    state.recordUsage(root, 'pg', 'secondary', 85);
    state.recordUsage(root, 'pg', 'primary', 30);
    state.setLane(root, 'pg', 'l1', { status: 'CLAIMED' });
    const r = orch(dir, root, ['gate-launch', 'pg', 'l1']);
    assert.equal(r.status, 3);
    assert.match(r.out, /placed on the primary seat — start it on the primary account/);
  });

  test('gate-launch on a secondary placement prints the filled launch command', () => {
    const { dir, root } = project({ seats: ['secondary', 'primary'], launchCommand: 'start-worker --brief "{brief}" --lane {lane}' });
    state.init(root, 'pl', lanes(1), { preflightMode: 'parallel', seats: ['secondary', 'primary'] });
    state.approve(root, 'pl', 'human');
    state.setLane(root, 'pl', 'l1', { status: 'CLAIMED' });
    const r = orch(dir, root, ['gate-launch', 'pl', 'l1']);
    assert.equal(r.status, 0, r.out);
    const j = JSON.parse(r.stdout);
    assert.match(j.launch, /^start-worker --brief ".*l1\.md" --lane l1$/);
    assert.equal(orch(dir, root, ['gate-launch', 'pl', 'l1']).status, 0); // still CLAIMED: idempotent
    state.setLane(root, 'pl', 'l1', { status: 'DONE' });
    assert.equal(orch(dir, root, ['gate-launch', 'pl', 'l1']).status, 3); // red: a lane next does not say to launch
  });
});

describe('preflight and the tests switch', () => {
  const pass = () => ({ ok: true, detail: 'stub pass' });
  const fail = () => ({ ok: false, detail: 'stub fail' });

  test('red: no checks configured is one lane — absent evidence is never a pass', () => {
    const r = pre.preflight({ checks: [] });
    assert.deepEqual([r.mode, r.none], ['single', true]);
  });

  test('red: one failed check downgrades to one lane; all green allows parallel', () => {
    const checks = [{ name: 'login', command: 'x' }, { name: 'unlock', command: 'y' }];
    assert.equal(pre.preflight({ checks, overrides: { login: pass, unlock: pass } }).mode, 'parallel');
    assert.equal(pre.preflight({ checks, overrides: { login: pass, unlock: fail } }).mode, 'single');
  });

  test('a real check command runs; its exit code is the verdict', () => {
    const ok = pre.preflight({ checks: [{ name: 'node', command: 'node -e "process.exit(0)"' }] });
    const bad = pre.preflight({ checks: [{ name: 'node', command: 'node -e "process.exit(4)"' }] });
    assert.deepEqual([ok.mode, bad.mode, bad.checks[0].detail], ['parallel', 'single', 'exit 4']);
  });

  test('red: a tests-host check gates only in its own mode; the other mode reports SKIP and never runs it', () => {
    const checks = [{ name: 'docker', command: 'x', tests: 'local' }, { name: 'ssh', command: 'y', tests: 'remote' }, { name: 'login', command: 'z' }];
    const local = pre.preflight({ checks, testsMode: 'local', overrides: { docker: pass, ssh: fail, login: pass } });
    assert.equal(local.mode, 'parallel');
    assert.equal(local.checks.find((c) => c.name === 'ssh').skipped, true);
    assert.equal(pre.preflight({ checks, testsMode: 'local', overrides: { docker: fail, ssh: pass, login: pass } }).mode, 'single');
    assert.equal(pre.preflight({ checks, testsMode: 'remote', overrides: { docker: fail, ssh: pass, login: pass } }).mode, 'parallel');
  });

  test('red: the tests switch — unset = the profile mode, unreadable = local, remote refused without a remote command', () => {
    const root = tmp('tests');
    assert.equal(pre.testsMode(root, 'local'), 'local');
    assert.throws(() => pre.setTests(root, 'remote', { remote: null }), /no remote test command configured/);
    assert.throws(() => pre.setTests(root, 'cloud', {}), /usage: set tests/);
    pre.setTests(root, 'remote', { remote: 'ssh runner tier {tier}' });
    assert.equal(pre.testsMode(root, 'local'), 'remote');
    writeFileSync(pre.testsFile(root), '{ not json');
    assert.equal(pre.testsMode(root, 'remote'), 'local');
    assert.match(pre.testsLine('local', {}, 'make test-{tier}'), /^tests: local — make test-\{tier\}/);
  });

  test('the CLI preflight exits 6 for single-lane and says why', () => {
    const { dir, root } = project({ preflight: [{ name: 'always-red', command: 'node -e "process.exit(1)"' }] });
    const r = orch(dir, root, ['preflight']);
    assert.equal(r.status, 6, r.out);
    assert.match(r.stdout, /FAIL always-red: exit 1/);
    assert.match(r.stdout, /MODE single/);
  });
});
