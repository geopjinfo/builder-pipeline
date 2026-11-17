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
    assert.equal(profile.accounts.legacyView(profile.DEFAULTS).credit.enabled, false); // no api-key account: no credit lane
  });

  test('red: an active orchestrator validates its shapes — target, lite without liteSplit; accounts replace seats (REQ-101 to REQ-103)', () => {
    const errs = (o, extra = {}) => profile.parse(profileText({ orchestrator: o, ...extra, legacy: true })).errors.join('\n');
    const acc = (accounts, o = {}) => errs(o, { extraFeatures: { accounts: { state: 'on', accounts } } });
    assert.equal(errs({}), '');
    assert.match(errs({ target: null }), /features\.orchestrator\.target: required/);
    assert.match(errs({ standardPipeline: 'lite' }), /needs features\.liteSplit enabled/);
    assert.match(errs({ launchCommand: 'start-worker' }), /launchCommand: must contain \{brief\}/);
    assert.match(errs({ tests: { mode: 'remote', local: null, remote: null } }), /tests\.remote: required/);
    assert.match(errs({ preflight: [{ name: 'x' }] }), /preflight\[0\]/);
    assert.match(errs({ modulePattern: '^src/modules/' }), /needs one capture group/);
    // REQ-103: the 1.0 seat keys are refused while the orchestrator is on, naming the keys and the migrate command.
    for (const legacy of [{ seats: ['secondary', 'primary'] }, { limits: { primary: 50 } }, { secondaryConfigDir: '.x' }, { credit: { enabled: true, dailyCapUsd: 5 } }]) {
      const e = errs(legacy);
      assert.match(e, new RegExp(`features\\.orchestrator\\.${Object.keys(legacy)[0]}: 1\\.0 seat keys`), e);
      assert.match(e, /npx builder accounts migrate/);
    }
    assert.match(errs({ seats: ['secondary'], credit: { enabled: false } }), /features\.orchestrator\.seats, credit: 1\.0 seat keys/);
    // With the orchestrator off the same profile loads with one warning and no error.
    const off = profile.parse(profileText({ orchestrator: { state: 'off', seats: ['secondary', 'primary'] }, legacy: true }));
    assert.deepEqual(off.errors, []);
    assert.equal(off.warnings.length, 1);
    assert.match(off.warnings[0], /features\.orchestrator\.seats: 1\.0 seat keys.*accounts migrate/);
    // REQ-101, REQ-102: the registry validates each account.
    assert.match(acc({ alpha: { pays: 'subscription' } }), /accounts\.alpha\.worker: one of claude-code \| codex \| session/);
    assert.match(acc({ alpha: { worker: 'claude-code' } }), /accounts\.alpha\.pays: one of subscription \| gateway \| free \| api-key/);
    assert.match(acc({ alpha: { worker: 'claude-code', pays: 'coins' } }), /accounts\.alpha\.pays: one of/);
    assert.match(acc({ alpha: { worker: 'claude-code', pays: 'free', content: 'secret' } }), /accounts\.alpha\.content: public \| scratch \| any, or a non-empty list of path roots/);
    assert.match(acc({ alpha: { worker: 'claude-code', pays: 'free', roles: ['janitor'] } }), /unknown role "janitor"/);
    assert.match(acc({ alpha: { worker: 'session', pays: 'subscription' }, beta: { worker: 'session', pays: 'subscription' } }), /at most one account has worker "session"/);
    assert.match(acc({ Alpha: { worker: 'session', pays: 'subscription' } }), /an account name matches/);
    assert.match(acc({ key: { worker: 'session', pays: 'subscription' } }), /"key" is a reserved name/);
    assert.match(acc({ alpha: { worker: 'claude-code', pays: 'subscription', baseUrl: 'http://localhost:1/' , command: 'x {brief}' } }), /E_BASEURL_SUB/);
    assert.match(acc({ alpha: { worker: 'claude-code', pays: 'free', command: 'x {brief}', budget: { kind: 'tokens' } } }), /budget\.kind: one of percent \| usd/);
    assert.match(acc({ alpha: { worker: 'claude-code', pays: 'free', command: 'x {brief}', budget: { kind: 'percent', soft: 90, hard: 80 } } }), /soft: must not exceed hard/);
    assert.match(acc({ alpha: { worker: 'claude-code', pays: 'subscription' } }), /accounts\.alpha\.command: required for a terminal worker account/);
    const noModels = profile.parse(profileText({ models: { strong: null, mid: null, orchestrator: null }, extraFeatures: { accounts: { state: 'on', accounts: { alpha: { worker: 'claude-code', pays: 'api-key' } } } }, legacy: true })).errors.join('\n');
    assert.match(noModels, /models\.strong \/ models\.mid: at least one is required while an api-key account exists/);
    assert.equal(acc({ alpha: { worker: 'session', pays: 'subscription', budget: { kind: 'percent', hard: 60 } }, beta: { worker: 'claude-code', pays: 'subscription', command: 'go {brief}', configDir: '.claude-beta' }, gamma: { worker: 'claude-code', pays: 'api-key', budget: { kind: 'usd', hard: 5 } } }), '');
  });

  test('red: REQ-208 an antigravity worker is a known account worker (D53); it has no key mode, so pays api-key is refused; it never takes a 1.0 seat (D26)', () => {
    const errs = (o, extra = {}) => profile.parse(profileText({ orchestrator: o, ...extra, legacy: true })).errors.join('\n');
    const acc = (accounts, o = {}) => errs(o, { extraFeatures: { accounts: { state: 'on', accounts } } });
    const registry = profile.accounts;
    assert.ok(registry.WORKERS.includes('antigravity'));
    assert.equal(acc({ alpha: { worker: 'session', pays: 'subscription' }, charlie: { worker: 'antigravity', pays: 'subscription' } }), '');
    assert.match(acc({ charlie: { worker: 'antigravity', pays: 'api-key' } }), /accounts\.charlie\.pays: .*no key mode/);
    const view = registry.legacyView({ features: { accounts: { state: 'on', accounts: { charlie: { worker: 'antigravity', pays: 'subscription' }, bravo: { worker: 'claude-code', pays: 'subscription', command: 'go {brief}' } } } } });
    assert.equal(view.accounts.secondary, 'bravo', 'the antigravity account is never the secondary seat');
  });

  test('red: §16 account settings never hold a secret (REQ-105) — the kind of match is named, never the text', () => {
    const fake = ['sk-ant', 'api03', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'].join('-');
    const text = profileText({ extraFeatures: { accounts: { state: 'on', accounts: { alpha: { worker: 'session', pays: 'subscription', note: `use ${fake}` } } } } });
    const r = profile.parse(text);
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0], /features\.accounts\.accounts\.alpha\.note: holds a secret-shaped value \(Anthropic key\)/);
    assert.ok(!r.errors[0].includes(fake));
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

  test('red: a stray file under runs/ is not a run — pause, resume and status skip it', () => {
    const { dir, root } = project();
    state.init(root, 'r1', lanes(1), { preflightMode: 'parallel' });
    state.approve(root, 'r1', 'human');
    writeFileSync(join(root, 'runs', 'notes.txt'), 'not a run');
    const paused = orch(dir, root, ['pause']);
    assert.equal(paused.status, 0, paused.out);
    assert.match(paused.stdout, /PAUSED all runs \(1\)/);
    assert.equal(orch(dir, root, ['status']).status, 0);
    assert.equal(orch(dir, root, ['resume']).status, 0);
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
    assert.match(j.launch, /^start-worker --brief ".*l1\.md" --lane l1 --settings ".*l1\.settings\.json"$/); // M4: every launch carries the --settings pin (REQ-404)
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

describe('capacity policy and SELF-AUDIT (features.orchestrator.capacity, the credit lane busy)', () => {
  const CAP = { laneCap: 4, seat: 'secondary', underPct: 50, defaultLanes: 2 };
  const fresh = (root, run, pct) => state.recordUsage(root, run, 'secondary', pct);
  const runWith = (n, opts = {}) => {
    const { root } = project();
    state.init(root, 'cp', { ...lanes(n), plan: { title: 'p', file: '/plans/p.plan.md' } }, { preflightMode: 'parallel', seats: ['secondary', 'primary'], ...opts });
    state.approve(root, 'cp', 'lead');
    return root;
  };

  test('measuredLanes reads the last "<seat> <n>%" figure: under → laneCap, else defaultLanes; none → defaultLanes', () => {
    assert.deepEqual(state.measuredLanes('secondary 70%\nsecondary: 31%', CAP), { maxLanes: 4, pct: 31, seat: 'secondary' });
    assert.equal(state.measuredLanes('secondary 31%\nsecondary = 55 %', CAP).maxLanes, 2);
    assert.deepEqual(state.measuredLanes('nothing here', CAP), { maxLanes: 2, pct: null, seat: 'secondary' });
    assert.equal(state.measuredLanes('secondary 10%', null, 3).maxLanes, 3, 'no capacity policy: the fallback');
  });

  test('BUILDER_ORCH_LANE_CAP overrides laneCap only with a whole number 1–16', () => {
    assert.equal(state.capacityOf(CAP, { BUILDER_ORCH_LANE_CAP: '6' }).laneCap, 6);
    for (const v of ['0', '17', '2.5', 'x', '']) assert.equal(state.capacityOf(CAP, { BUILDER_ORCH_LANE_CAP: v }).laneCap, 4, v);
    assert.equal(state.capacityOf(null), null);
  });

  test('ADD-LANES while the seat is fresh under its percentage; waiting lanes hold slots; none in single-lane, over it, or with no policy', () => {
    const root = runWith(1, { capacity: CAP });
    fresh(root, 'cp', 20);
    const acts = state.nextActions(root, state.load(root, 'cp'));
    assert.ok(acts.includes('ADD-LANES: secondary at 20% — pull 3 row(s) from /plans/p.plan.md (0 of cap 4 lanes live)'), acts.join('\n'));
    fresh(root, 'cp', 60);
    assert.equal(state.nextActions(root, state.load(root, 'cp')).some((a) => a.startsWith('ADD-LANES')), false);
    const single = runWith(1, { capacity: CAP, preflightMode: 'single' });
    fresh(single, 'cp', 20);
    assert.equal(state.nextActions(single, state.load(single, 'cp')).some((a) => a.startsWith('ADD-LANES')), false);
    const off = runWith(1);
    fresh(off, 'cp', 20);
    assert.equal(state.nextActions(off, state.load(off, 'cp')).some((a) => a.startsWith('ADD-LANES')), false);
    const four = runWith(4, { capacity: CAP });
    fresh(four, 'cp', 20);
    assert.equal(state.nextActions(four, state.load(four, 'cp')).some((a) => a.startsWith('ADD-LANES')), false, 'four lanes waiting already hold the four slots');
  });

  test('a WAIT-P4 lane gets SELF-AUDIT while the credit lane is busy, ENQUEUE otherwise; a run without the credit lane never asks', () => {
    const root = runWith(1, { credit: true });
    state.setLane(root, 'cp', 'l1', { status: 'DONE', resultLine: 'RESULT: PASS WAIT-P4 k1 @ abc', worktree: '/wt/l1' });
    const s = state.load(root, 'cp');
    assert.ok(state.isWaitP4(s.lanes.l1));
    const seen = [];
    const busy = (wt, since) => (seen.push([wt, since]), 'runner busy');
    assert.match(state.nextActions(root, s, Date.now(), { creditBusy: busy }).join('\n'), /SELF-AUDIT l1: credit busy — resume the worker to run its owed seats itself \(runner busy\); gate-launch cp l1 --resume/);
    assert.equal(seen[0][0], '/wt/l1');
    assert.ok(seen[0][1], 'asked with the lane result time');
    assert.match(state.nextActions(root, s, Date.now(), { creditBusy: () => null }).join('\n'), /ENQUEUE l1: done — "RESULT: PASS WAIT-P4/);
    const plain = runWith(1);
    state.setLane(plain, 'cp', 'l1', { status: 'DONE', resultLine: 'RESULT: PASS WAIT-P4 k1 @ abc' });
    assert.match(state.nextActions(plain, state.load(plain, 'cp')).join('\n'), /ENQUEUE l1/);
  });
});

describe('gate-launch --resume of a WAIT-P4 lane', () => {
  test('red: refused unless next offers SELF-AUDIT for it — the credit lane not busy means its seats run there, not twice', () => {
    const { dir, root } = project({ seats: ['secondary', 'primary'], launchCommand: 'echo {brief}' });
    state.init(root, 'wp', lanes(1), { preflightMode: 'parallel', seats: ['secondary', 'primary'], credit: true, repo: dir });
    state.approve(root, 'wp', 'lead');
    state.setLane(root, 'wp', 'l1', { status: 'DONE', resultLine: 'RESULT: PASS WAIT-P4 k1 @ abc', worktree: join(dir, 'no-such-lane') });
    const p = orch(dir, root, ['gate-launch', 'wp', 'l1', '--resume']);
    assert.equal(p.status, 3, p.out);
    assert.match(p.out, /next offers no SELF-AUDIT for it — ENQUEUE l1/);
    const done = orch(dir, root, ['gate-launch', 'wp', 'l1']);
    assert.equal(done.status, 3, 'positive control: a DONE lane is never a plain launch either');
  });
});

describe('usage read: a report with no percentage is unknown, never 0%', () => {
  const cmd = (text) => `node -e "console.log(${JSON.stringify(text).replace(/"/g, '\\"')})"`;
  test('green: an "N% used" line still parses', () => {
    const u = pre.readUsage('primary', cmd('Session: 42% used'));
    assert.equal(u.pct, 42);
    assert.equal(u.unknown, false);
  });
  test('red: output with no "% used" line returns unknown with its raw lines, no throw', () => {
    const u = pre.readUsage('primary', cmd('Total cost: 0.12'));
    assert.equal(u.pct, null);
    assert.equal(u.unknown, true);
    assert.deepEqual(u.lines, ['Total cost: 0.12']);
  });
  test('red: recordUsage refuses null and an empty string (Number() of both is 0)', () => {
    const { root } = project();
    state.init(root, 'un', lanes(1), { target: 'dev', preflightMode: 'parallel' });
    for (const bad of [null, '', ' ', undefined]) assert.throws(() => state.recordUsage(root, 'un', 'primary', bad), /recordUsageUnknown/);
  });
  test('green: recordUsageUnknown keeps the lines and leaves the measured usage alone', () => {
    const { root } = project();
    state.init(root, 'uk', lanes(1), { target: 'dev', preflightMode: 'parallel' });
    state.recordUsage(root, 'uk', 'primary', 30);
    state.recordUsageUnknown(root, 'uk', 'primary', ['Total cost: 0.12']);
    const s = state.load(root, 'uk');
    assert.equal(s.usage.primary.pct, 30);
    assert.deepEqual(s.usageUnknown.primary.lines, ['Total cost: 0.12']);
  });
});

/* ------------------------------------------------------------------ 2.0: placement over accounts (M3) ---- */

import { ACCOUNTS_HOME_OF } from './fixtures/orch/rig.mjs';

const acct = require('../scripts/lib/orch-accounts.cjs');
const AT = Date.parse('2026-11-17T12:00:00.000Z');
const minsAgo = (n) => new Date(AT - n * 60000).toISOString();
const plan = (name, over = {}) => ({ name, worker: 'claude-code', pays: 'subscription', content: 'any', roles: [], budget: { kind: 'percent', soft: null, hard: 85 }, maxTurns: 40, timeoutMinutes: 90, command: 'go {brief}', ...over });
const key = (name, over = {}) => ({ name, worker: 'claude-code', pays: 'api-key', content: 'any', roles: [], budget: { kind: 'usd', soft: 8, hard: 10 }, maxTurns: 40, timeoutMinutes: 90, command: 'go {brief}', ...over });
/** A 2.0 run state over `accounts` with `usage` readings `{ name: [value, minutesAgo] }`; pure, no CLI. */
function run2(accounts, usage = {}, opts = {}) {
  const runId = 'a2';
  const s = {
    runId, lanes: {}, usage: {}, accounts, seats: accounts.map((a) => a.name), usageStaleMinutes: 30, softLimitPct: 80, approved: true, paused: false, maxLanes: 2, mergeQueue: [], placement: 'on', ...opts,
  };
  for (const [name, [v, ago]] of Object.entries(usage)) s.usage[name] = { ...(accounts.find((a) => a.name === name).budget.kind === 'usd' ? { usd: v } : { pct: v }), at: minsAgo(ago) };
  return s;
}
const place = (s, job = {}, o = {}) => state.placement(s, AT, o.running ?? 1, job, o);

describe('placement over accounts: the ordered account list (REQ-301 to REQ-304)', () => {
  test('red: REQ-301 account A at 90 % with cap 85 and B at 40 % → B, and the why names A\'s cap (AC-301a)', () => {
    const s = run2([plan('alpha'), plan('bravo')], { alpha: [90, 5], bravo: [40, 5] });
    const p = place(s);
    assert.equal(p.seat, 'bravo');
    assert.match(p.why, /^bravo at 40% under its limit 85%/);
    assert.match(p.why, /alpha at 90% \(limit 85%\) — at its hard cap/);
    assert.ok(p.notes.some((n) => /alpha at 90% \(limit 85%\)/.test(n)));
    const both = place(run2([plan('alpha'), plan('bravo')], { alpha: [90, 5], bravo: [85, 5] }));
    assert.equal(both.seat, null);
    assert.match(both.why, /^USAGE-HOLD: alpha at 90% \(limit 85%\) and bravo at 85% \(limit 85%\) — no new lanes$/);
  });

  test('red: REQ-301 the walk follows registry order and the lane\'s role: an account limited to headless roles never takes a lane', () => {
    const s = run2([plan('alpha', { roles: ['module-tester', 'module-reviewer'] }), plan('bravo'), plan('charlie')], { alpha: [10, 5], bravo: [50, 5], charlie: [10, 5] });
    assert.equal(place(s).seat, 'bravo', 'alpha has no builder role; bravo comes before charlie');
    assert.equal(place(s, { role: 'module-tester' }).seat, 'alpha', 'a tester job may use alpha');
    assert.equal(place(run2([plan('alpha', { roles: ['docs-maintainer'] })], { alpha: [10, 5] })).seat, null);
    assert.match(place(run2([plan('alpha', { roles: ['docs-maintainer'] })], { alpha: [10, 5] })).why, /^NO-ACCOUNT: no account allows role module-builder/);
    const content = run2([plan('alpha', { content: 'public' }), plan('bravo', { content: ['src/'] }), plan('charlie')], { alpha: [10, 5], bravo: [10, 5], charlie: [10, 5] });
    assert.equal(place(content, { content: 'scratch' }).seat, 'charlie', 'public and a path-root list do not take scratch work');
    assert.equal(place(content, { content: 'src/' }).seat, 'bravo');
    assert.equal(place(content).seat, 'alpha', 'a job with no content class goes to the first account');
  });

  test('red: REQ-302 above the soft limit an account takes only needs-account work: a plain job reads NEEDS-IT-ONLY, a brief naming it is placed on it (AC-302a)', () => {
    const s = run2([plan('alpha'), plan('bravo')], { alpha: [82, 5], bravo: [40, 5] });
    const p = place(s);
    assert.equal(p.seat, 'bravo');
    assert.ok(p.notes.some((n) => /^alpha: NEEDS-IT-ONLY at 82% \(soft limit 80%\)$/.test(n)), p.notes.join('\n'));
    const named = place(s, { needsAccount: 'alpha' });
    assert.equal(named.seat, 'alpha');
    assert.match(named.why, /^alpha at 82% above its soft limit 80% — the brief names it \(needs-account\)$/);
    assert.equal(place(run2([plan('alpha', { budget: { kind: 'percent', soft: 90, hard: 95 } })], { alpha: [82, 5] })).seat, 'alpha', 'budget.soft beats softLimitPct');
    const only = place(run2([plan('alpha')], { alpha: [82, 5] }));
    assert.equal(only.seat, null);
    assert.match(only.why, /^USAGE-HOLD: no account may take the lane — alpha: NEEDS-IT-ONLY/);
    const usd = run2([key('charlie', { budget: { kind: 'usd', soft: 8, hard: 10 } })], { charlie: [8.5, 5] });
    assert.ok(place(usd).notes.some((n) => /charlie: NEEDS-IT-ONLY at \$8\.5 \(soft limit \$8\)/.test(n)), 'a USD soft limit works the same way');
    assert.equal(place(usd, { needsAccount: 'charlie' }).seat, 'charlie');
  });

  test('red: REQ-303 pays: api-key accounts come last whatever their registry position (AC-303a)', () => {
    const s = run2([key('charlie'), plan('alpha')], { charlie: [2, 5], alpha: [40, 5] });
    assert.equal(place(s).seat, 'alpha');
    const full = run2([key('charlie'), plan('alpha')], { charlie: [2, 5], alpha: [90, 5] });
    const p = place(full);
    assert.equal(p.seat, 'charlie');
    assert.match(p.why, /^charlie at \$2 under its limit \$10 — skipped alpha at 90% \(limit 85%\) — at its hard cap$/);
    assert.equal(place(run2([key('charlie'), plan('alpha')], { charlie: [10, 5], alpha: [90, 5] })).seat, null, 'a key account at its USD cap is not ready either');
  });

  test('red: REQ-304 a reading older than usageStaleMinutes is unmeasured; only the first account in order may launch unmeasured, and only while nothing runs (AC-304a)', () => {
    const accounts = [plan('alpha'), plan('bravo')];
    const first = place(run2(accounts, { alpha: [5, 45] }), {}, { running: 0 });
    assert.deepEqual([first.seat, first.why], ['alpha', 'alpha: first lane, usage unmeasured']);
    assert.equal(place(run2(accounts, { alpha: [99, 45] }), {}, { running: 0 }).seat, null, 'a stale reading at the cap does not launch');
    const second = place(run2(accounts, { alpha: [5, 45] }), {}, { running: 1 });
    assert.equal(second.seat, null);
    assert.match(second.why, /^USAGE-UNKNOWN: alpha usage unmeasured in 30 min — orch usage-read a2 alpha \(or orch usage a2 alpha <pct>\)$/);
    assert.ok(second.notes.some((n) => /^alpha: usage unmeasured \(reading 45 min old\) — only the first account may launch unmeasured$/.test(n)));
    assert.ok(second.notes.some((n) => /^bravo: usage unmeasured — only the first account may launch unmeasured$/.test(n)));
    const later = place(run2(accounts, { alpha: [5, 45], bravo: [20, 5] }), {}, { running: 1 });
    assert.equal(later.seat, 'bravo', 'a measured account further down still takes the lane');
    assert.match(later.why, /skipped alpha: usage unmeasured/);
    const stale = place(run2(accounts, { alpha: [90, 5], bravo: [20, 45] }), {}, { running: 1 });
    assert.equal(stale.seat, null);
    assert.match(stale.why, /^USAGE-UNKNOWN: bravo usage unmeasured in 30 min and alpha at 90% \(limit 85%\)/);
  });

  test('red: REQ-304, REQ-309 the readiness record\'s reading counts, and the newest reading wins', () => {
    const s = run2([plan('alpha')], {});
    const readiness = { alpha: { usage: { pct: 30, source: 'measured', at: minsAgo(3) } } };
    assert.equal(place(s, {}, { readiness }).seat, 'alpha');
    s.usage.alpha = { pct: 90, at: minsAgo(1) };
    assert.equal(place(s, {}, { readiness }).seat, null, 'the run\'s newer reading is at the cap');
    assert.deepEqual(state.readingFor(s, readiness, 'alpha').pct, 90);
    assert.deepEqual(state.readingFor(s, {}, 'nobody'), null);
  });

  test('red: REQ-307 an account the readiness record holds not ready — LIMIT, BUDGET, AUTH or a failed probe — is skipped and the line says why (AC-307a)', () => {
    const s = run2([plan('alpha'), plan('bravo')], { alpha: [10, 5], bravo: [20, 5] });
    const until = new Date(AT + 3600000).toISOString();
    const readiness = { alpha: { state: 'ready', error: { kind: 'LIMIT', until, reason: '429' } } };
    const p = place(s, {}, { readiness });
    assert.equal(p.seat, 'bravo');
    assert.ok(p.notes.includes(`alpha: LIMIT until ${until}`), p.notes.join('\n'));
    assert.equal(place(s, {}, { readiness: { alpha: { state: 'not ready', reason: 'signed out' } } }).notes[0], 'alpha: not ready (signed out)');
    assert.equal(place(s, {}, { readiness: { alpha: { state: 'ready', error: { kind: 'LIMIT', until: minsAgo(1) } } } }).seat, 'alpha', 'a passed hold no longer blocks');
    assert.equal(place(s, {}, { readiness: { alpha: { state: 'unmeasured', reason: 'no probe' } } }).seat, 'alpha', 'no probe answer is not a refusal: the usage rule decides');
    const all = place(s, {}, { readiness: { alpha: { error: { kind: 'AUTH', until: null } }, bravo: { error: { kind: 'BUDGET', until } } } });
    assert.equal(all.seat, null);
    assert.match(all.why, /^USAGE-HOLD: no account may take the lane — alpha: AUTH until the next sign-in; bravo: BUDGET until /);
  });

  test('red: REQ-312 shadow placement writes the event with the rule\'s choice and places the 1.0 way (AC-312a)', () => {
    const root = tmp('shadow');
    state.init(root, 'sh', lanes(1), { preflightMode: 'parallel', accounts: [plan('alpha'), plan('bravo')], softLimitPct: 80, placement: 'shadow' });
    state.approve(root, 'sh', 'lead');
    state.recordUsage(root, 'sh', 'alpha', 82);
    state.recordUsage(root, 'sh', 'bravo', 40);
    const s = state.load(root, 'sh');
    assert.equal(s.placement, 'shadow');
    const acts = state.nextActions(root, s);
    assert.match(acts.find((a) => a.startsWith('LAUNCH l1')), / on alpha \(claude-code worker on account alpha\)$/, '1.0 way: the first ready account by order');
    const ev = readFileSync(join(root, 'runs', 'sh', 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.type === 'placement.shadow');
    assert.equal(ev.length, 1);
    assert.deepEqual([ev[0].chosen, ev[0].placed], ['bravo', 'alpha']);
    assert.match(ev[0].reason, /^bravo at 40% under its limit 85% — skipped alpha: NEEDS-IT-ONLY/);
    assert.throws(() => state.init(root, 'sh2', lanes(1), { accounts: [plan('alpha')], placement: 'off' }), /unknown placement mode "off"/);
    const on = tmp('on');
    state.init(on, 'on', lanes(1), { preflightMode: 'parallel', accounts: [plan('alpha'), plan('bravo')], softLimitPct: 80 });
    state.approve(on, 'on', 'lead');
    state.recordUsage(on, 'on', 'alpha', 82);
    state.recordUsage(on, 'on', 'bravo', 40);
    const onActs = state.nextActions(on, state.load(on, 'on'));
    assert.match(onActs.find((a) => a.startsWith('LAUNCH l1')), / on bravo /);
    assert.ok(onActs.includes('SKIP alpha: NEEDS-IT-ONLY at 82% (soft limit 80%)'), onActs.join('\n'));
    assert.equal(existsSync(join(on, 'runs', 'on', 'events.jsonl')) && readFileSync(join(on, 'runs', 'on', 'events.jsonl'), 'utf8').includes('placement.shadow'), false);
  });

  test('a 2.0 run state records the accounts, names them as seats, and recordUsage takes a USD reading or refuses an unknown name', () => {
    const root = tmp('rec');
    const s = state.init(root, 'rc', lanes(1), { accounts: [plan('alpha', { note: 'x', versionCommand: 'v' }), key('charlie')], softLimitPct: 70 });
    assert.deepEqual(s.seats, ['alpha', 'charlie']);
    assert.equal(s.limits, undefined);
    assert.equal(s.softLimitPct, 70);
    assert.equal(s.placement, 'on');
    assert.equal(s.accounts[0].versionCommand, undefined, 'only the placement fields are recorded');
    assert.equal(s.accounts[0].note, 'x');
    state.recordUsage(root, 'rc', 'charlie', { usd: 2.5, source: 'measured' });
    assert.equal(state.load(root, 'rc').usage.charlie.usd, 2.5);
    assert.throws(() => state.recordUsage(root, 'rc', 'secondary', 10), /unknown seat "secondary" \(alpha\|charlie\)/);
    assert.throws(() => state.recordUsage(root, 'rc', 'alpha', { usd: null }), /recordUsageUnknown/);
    assert.equal(state.runnerOf(s, 'charlie'), 'claude-code worker on account charlie, pays per use');
    assert.equal(state.runnerOf({ ...s, accounts: [{ ...plan('zulu'), worker: 'session' }] }, 'zulu'), state.SESSION_RUNNER);
  });
});

describe('the orch command places over accounts (REQ-303, REQ-305, REQ-307, REQ-309, REQ-311, REQ-313)', () => {
  /** A project whose §16 carries `features.accounts` rows beside the migrated session account; the run is made by the CLI. */
  function accountsProject(accounts, { usage = {}, orchestrator = {}, lanesN = 1 } = {}) {
    const dir = tmp('acc');
    const write = (acc) => writeFileSync(join(dir, 'PIPELINE_PROFILE.md'), profileText({ orchestrator: { launchCommand: 'go {brief}', ...orchestrator }, accounts: acc }));
    write(accounts);
    const root = join(dir, 'orch');
    const lanesFile = join(dir, 'lanes.json');
    writeFileSync(lanesFile, JSON.stringify(lanes(lanesN)));
    const init = orch(dir, root, ['init', 'ar', '--lanes', lanesFile, '--mode', 'parallel', '--repo', dir]);
    assert.equal(init.status, 0, init.out);
    state.approve(root, 'ar', 'lead');
    for (const [name, v] of Object.entries(usage)) state.recordUsage(root, 'ar', name, v);
    return { dir, root, write };
  }
  const events = (root, run = 'ar') => readFileSync(join(root, 'runs', run, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

  test('red: REQ-303 a launch on an api-key account writes `account.paid` and a decision-log row (AC-303a)', () => {
    const { dir, root } = accountsProject({ charlie: key('charlie') }, { usage: { primary: 70, charlie: { usd: 2 } } });
    const s = state.load(root, 'ar');
    assert.deepEqual(s.seats, ['primary', 'charlie']);
    state.setLane(root, 'ar', 'l1', { status: 'CLAIMED' });
    const r = orch(dir, root, ['gate-launch', 'ar', 'l1']);
    assert.equal(r.status, 0, r.out);
    const j = JSON.parse(r.stdout);
    assert.equal(j.account, 'charlie');
    assert.equal(j.pays, 'api-key');
    assert.equal(j.launch, `go ${s.lanes.l1.brief}`);
    const paid = events(root).filter((e) => e.type === 'account.paid');
    assert.equal(paid.length, 1);
    assert.deepEqual([paid[0].lane, paid[0].account], ['l1', 'charlie']);
    const log = readFileSync(join(dir, 'DECISIONS.md'), 'utf8');
    assert.match(log, /\| D-orch-ar-l1 \| \d{4}-\d{2}-\d{2} \| orchestrator \| lane l1 of run ar launched on api-key account charlie \|/);
    assert.match(log, /\| Id \| Date \| Module\/scope \| Decision \|/, 'created with its header');
  });

  test('red: REQ-305 an account with no maxTurns is refused naming the field; the launch line carries the caps, says unpriced for a model with no rate, and --max-budget-usd is a backstop (AC-305a, AC-305b)', () => {
    const dir = tmp('caps');
    writeFileSync(join(dir, 'PIPELINE_PROFILE.md'), profileText({ orchestrator: { seats: ['secondary', 'primary'], launchCommand: 'go {brief} --turns {maxTurns} --minutes {timeoutMinutes} --account {account}' }, caps: false }));
    const root = join(dir, 'orch');
    const lanesFile = join(dir, 'lanes.json');
    writeFileSync(lanesFile, JSON.stringify(lanes(1)));
    assert.equal(orch(dir, root, ['init', 'cp', '--lanes', lanesFile, '--mode', 'parallel', '--repo', dir]).status, 0);
    state.approve(root, 'cp', 'lead');
    state.setLane(root, 'cp', 'l1', { status: 'CLAIMED' });
    const refused = orch(dir, root, ['gate-launch', 'cp', 'l1']);
    assert.equal(refused.status, 3, refused.out);
    assert.match(refused.out, /REFUSED launch cp\/l1: account secondary has no maxTurns — set features\.accounts\.accounts\.secondary\.maxTurns/);
    writeFileSync(join(dir, 'PIPELINE_PROFILE.md'), profileText({ orchestrator: { seats: ['secondary', 'primary'], launchCommand: 'go {brief} --turns {maxTurns} --minutes {timeoutMinutes} --account {account}' }, caps: false, accounts: { secondary: { maxTurns: 25 } } }));
    const noTimeout = orch(dir, root, ['gate-launch', 'cp', 'l1']);
    assert.equal(noTimeout.status, 3);
    assert.match(noTimeout.out, /has no timeoutMinutes/);
    writeFileSync(join(dir, 'PIPELINE_PROFILE.md'), profileText({ orchestrator: { seats: ['secondary', 'primary'], launchCommand: 'go {brief} --turns {maxTurns} --minutes {timeoutMinutes} --account {account}' }, accounts: { secondary: { maxTurns: 25, timeoutMinutes: 60 } } }));
    const ok = orch(dir, root, ['gate-launch', 'cp', 'l1', '--max-budget-usd', '3']);
    assert.equal(ok.status, 0, ok.out);
    const j = JSON.parse(ok.stdout);
    assert.deepEqual([j.account, j.maxTurns, j.timeoutMinutes, j.model, j.price, j.maxBudgetUsd], ['secondary', 25, 60, 'strong-model', 'unpriced', 3]);
    assert.match(j.maxBudgetUsdRole, /backstop only — never a cap/);
    assert.match(j.launch, / --turns 25 --minutes 60 --account secondary$/);
  });

  test('red: REQ-307 the command runs the readiness assessment before placing: an account whose probe says signed out is skipped and the line says why (AC-307a)', () => {
    const { dir, root } = accountsProject({ delta: plan('delta', { configDir: '.claude-down' }), echo: plan('echo', { configDir: '.claude-echo' }) }, { usage: { primary: 70, delta: 10, echo: 20 } });
    const r = orch(dir, root, ['status', 'ar']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /SKIP delta: not ready \(signed out\)/);
    assert.match(r.stdout, /LAUNCH l1: .* on echo \(claude-code worker on account echo\)/);
    assert.match(r.stdout, /^  delta  not ready \(signed out, run claude auth login\)/m);
    assert.match(r.stdout, /^  echo  ready  20 % \(recorded \d{2}:\d{2}\)/m, 'the run\'s own reading shows with its time');
    const rec = acct.load(root).accounts;
    assert.equal(rec.delta.state, 'not ready');
    assert.equal(rec.echo.state, 'ready');
    assert.ok(rec.echo.assessedAt);
    // a LIMIT recorded by a worker holds the account until its time, and status says so
    acct.markError(root, 'echo', { kind: 'LIMIT', until: new Date(Date.now() + 3600000).toISOString(), reason: '429' });
    const held = orch(dir, root, ['next', 'ar']);
    assert.match(held.stdout, /SKIP echo: LIMIT until /);
    assert.equal(/LAUNCH l1/.test(held.stdout), false);
  });

  test('red: REQ-309 a stale usage reading is refreshed by the account\'s own reader on any orch command, and status prints the time of the reading (AC-309a)', () => {
    const reader = `node -e "const d = String.fromCharCode(36); console.log('spent ' + d + '3 of ' + d + '10')"`; // no $ for the shell to expand
    const { dir, root } = accountsProject({ foxtrot: plan('foxtrot', { configDir: '.claude-fox', usageCommand: reader }) }, { usage: { primary: 70 } });
    const r = orch(dir, root, ['status', 'ar']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /^  foxtrot  ready  30 % \(measured \d{2}:\d{2}\)/m);
    assert.match(r.stdout, /LAUNCH l1: .* on foxtrot/);
    const rec = acct.load(root).accounts.foxtrot;
    assert.equal(rec.usage.pct, 30);
    assert.ok(Number.isFinite(Date.parse(rec.usage.at)));
    // a command that places nothing still refreshes once the record is older than usageStaleMinutes
    acct.record(root, 'foxtrot', { assessedAt: new Date(Date.now() - 3 * 3600000).toISOString(), usage: null });
    assert.equal(orch(dir, root, ['claims']).status, 0);
    assert.equal(acct.load(root).accounts.foxtrot.usage.pct, 30, 'refreshed');
    acct.record(root, 'foxtrot', { assessedAt: new Date().toISOString(), usage: { pct: 55, source: 'measured', at: new Date().toISOString() } });
    assert.equal(orch(dir, root, ['claims']).status, 0);
    assert.equal(acct.load(root).accounts.foxtrot.usage.pct, 55, 'a fresh record is left alone by a command that places nothing');
  });

  test('red: REQ-313 at or above the soft limit the status account line and the lane row show `budget warn <used> of <cap>` (AC-313a)', () => {
    const { dir, root } = accountsProject({ golf: plan('golf', { configDir: '.claude-golf', budget: { kind: 'percent', soft: 80, hard: 85 } }) }, { usage: { primary: 70, golf: 82 } });
    state.setLane(root, 'ar', 'l1', { status: 'LAUNCHED', seat: 'golf', sessionId: 'g1' });
    const r = orch(dir, root, ['status', 'ar']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /^  golf  ready  82 % .*  budget warn 82 % of 85 %$/m);
    assert.match(r.stdout, /^l1 \| LAUNCHED \| .* \| golf \(budget warn 82 % of 85 %\) \| g1 \|/m);
    state.recordUsage(root, 'ar', 'golf', 50);
    assert.equal(/budget warn/.test(orch(dir, root, ['status', 'ar']).stdout), false);
  });

  test('red: REQ-313 a hard cap or soft limit raised in §16 without a decision-log line refuses gate-launch naming the field and the expected entry (AC-313b)', () => {
    const { dir, root, write } = accountsProject({ hotel: plan('hotel', { configDir: '.claude-hotel', budget: { kind: 'percent', soft: 80, hard: 85 } }) }, { usage: { primary: 70, hotel: 40 } });
    state.setLane(root, 'ar', 'l1', { status: 'CLAIMED' });
    assert.equal(orch(dir, root, ['gate-launch', 'ar', 'l1']).status, 0);
    write({ hotel: plan('hotel', { configDir: '.claude-hotel', budget: { kind: 'percent', soft: 80, hard: 90 } }) });
    const r = orch(dir, root, ['gate-launch', 'ar', 'l1']);
    assert.equal(r.status, 3, r.out);
    assert.match(r.out, /REFUSED launch ar\/l1: features\.accounts\.accounts\.hotel\.budget\.hard raised 85 → 90 without a decision-log line — add a row to DECISIONS\.md that carries "hotel budget\.hard 85 → 90"/);
    writeFileSync(join(dir, 'DECISIONS.md'), '| D-9 | 2026-11-17 | orchestrator | hotel budget.hard 85 → 90 | more headroom this week | — |\n');
    const ok = orch(dir, root, ['gate-launch', 'ar', 'l1']);
    assert.equal(ok.status, 0, ok.out);
    assert.equal(state.load(root, 'ar').accounts.find((a) => a.name === 'hotel').budget.hard, 90, 'the run records the new cap once the row exists');
    write({ hotel: plan('hotel', { configDir: '.claude-hotel', budget: { kind: 'percent', soft: 70, hard: 90 } }) });
    assert.equal(orch(dir, root, ['gate-launch', 'ar', 'l1']).status, 0, 'lowering a limit needs no entry');
  });

  test('red: REQ-311 a 1.0 state fixture — `orch status` prints the 1.0 rows and leaves the file unchanged (AC-311a)', () => {
    const { dir, root } = project({ seats: ['secondary', 'primary'], launchCommand: 'go {brief}' });
    const runDir = join(root, 'runs', 'old');
    mkdirSync(runDir, { recursive: true });
    const old = {
      runId: 'old', createdAt: '2026-10-01T10:00:00.000Z', updatedAt: '2026-10-01T12:00:00.000Z', repo: dir, target: 'dev', approved: true, approvedBy: 'lead', paused: false, preflightMode: 'parallel',
      plannedMaxLanes: 2, maxLanes: 2, seats: ['secondary', 'primary'], limits: { secondary: 80, primary: 60 }, usageStaleMinutes: 30,
      usage: { secondary: { pct: 40, at: '2026-10-01T11:55:00.000Z' } }, mergeQueue: [], rows: [],
      lanes: {
        l1: { name: 'old-l1', rows: ['R1'], level: 'Standard', track: 'ADDITIVE', dispatch: 'full', ownedFiles: ['a.ts'], hotFiles: [], seat: 'secondary', branch: 'orch/old-l1', worktree: null, status: 'MERGED', sessionId: 's1', brief: join(runDir, 'briefs', 'l1.md'), result: join(runDir, 'results', 'l1.md'), timings: { plannedAt: '2026-10-01T10:00:00.000Z' }, stallMinutes: 90 },
        l2: { name: 'old-l2', rows: ['R2'], level: 'Standard', track: 'ADDITIVE', dispatch: 'full', ownedFiles: ['b.ts'], hotFiles: [], seat: null, branch: 'orch/old-l2', worktree: null, status: 'CLAIMED', sessionId: null, brief: join(runDir, 'briefs', 'l2.md'), result: join(runDir, 'results', 'l2.md'), timings: { plannedAt: '2026-10-01T10:00:00.000Z' }, stallMinutes: 90 },
      },
    };
    const text = JSON.stringify(old, null, 2) + '\n';
    writeFileSync(join(runDir, 'state.json'), text);
    const r = orch(dir, root, ['status', 'old']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /^run old · target dev · preflight parallel · lanes ≤2 · seats secondary → primary · approved yes \(lead\)/m);
    assert.match(r.stdout, /^l1 \| MERGED \| Standard\/ADDITIVE \| full \| R1 \| secondary \| s1 \| /m);
    assert.match(r.stdout, /^l2 \| CLAIMED \| Standard\/ADDITIVE \| full \| R2 \| - \| - \| /m);
    assert.match(r.stdout, /LAUNCH l2: Standard\/ADDITIVE full rows R2 on secondary \(terminal worker on the secondary account\)/, 'the 1.0 first-lane rule: nothing runs, the stale reading is under the limit');
    assert.match(r.stdout, /^  secondary  ready  40 % \(recorded 11:55\)/m, 'the 1.0 reading is shown with its time');
    assert.equal(readFileSync(join(runDir, 'state.json'), 'utf8'), text, 'never written back');
    assert.equal(existsSync(join(runDir, 'state.json.bak')), false);
    assert.equal(orch(dir, root, ['next', 'old']).status, 0);
    assert.equal(readFileSync(join(runDir, 'state.json'), 'utf8'), text);
    assert.equal(state.isLegacyState(old), true);
    assert.deepEqual(state.accountsOf(old).map((a) => [a.name, a.worker, a.budget.hard]), [['secondary', 'claude-code', 80], ['primary', 'session', 60]]);
  });

  test('red: REQ-311 the orchestrator\'s own 429 record is still the global one (AC-306f)', () => {
    const { dir, root } = project();
    assert.equal(orch(dir, root, ['ratelimit', 'hit', '--planned', '4']).status, 0);
    const rl = JSON.parse(readFileSync(join(root, 'ratelimit.json'), 'utf8'));
    assert.deepEqual([rl.lanes, rl.consecutive429], [2, 1]);
    assert.equal(existsSync(join(root, acct.FILE)) ? Object.keys(acct.load(root).accounts).some((n) => acct.load(root).accounts[n].error) : false, false, 'no account carries the global 429');
    assert.ok(ACCOUNTS_HOME_OF());
  });
});

describe('placementNow agrees with next (REQ-312)', () => {
  test('red: in shadow mode gate-launch checks the account next placed the 1.0 way, not the rule\'s choice', () => {
    const root = tmp('pnow');
    const mk = (name) => ({ name, worker: 'claude-code', pays: 'subscription', content: 'any', roles: [], budget: { kind: 'percent', soft: null, hard: 85 }, maxTurns: 40, timeoutMinutes: 90, command: 'go {brief}' });
    state.init(root, 'pn', lanes(1), { preflightMode: 'parallel', accounts: [mk('alpha'), mk('bravo')], softLimitPct: 80, placement: 'shadow' });
    state.approve(root, 'pn', 'lead');
    state.recordUsage(root, 'pn', 'alpha', 82);
    state.recordUsage(root, 'pn', 'bravo', 40);
    const s = state.load(root, 'pn');
    assert.equal(state.placementNow(root, s).seat, 'alpha');
    assert.match(state.nextActions(root, s).find((a) => a.startsWith('LAUNCH l1')), / on alpha /);
    const on = tmp('pnow-on');
    state.init(on, 'pn', lanes(1), { preflightMode: 'parallel', accounts: [mk('alpha'), mk('bravo')], softLimitPct: 80 });
    state.recordUsage(on, 'pn', 'alpha', 82);
    state.recordUsage(on, 'pn', 'bravo', 40);
    assert.equal(state.placementNow(on, state.load(on, 'pn')).seat, 'bravo');
  });
});
