/**
 * Batch orchestrator — the merge queue, the integration branch, snapshots, the lease, `orch wait` and the git
 * integrity checks (scripts/lib/orch-{merge,snapshot,lease,integrity}.cjs). Scratch git repos only; the "gates" are
 * node one-liners. Every guard has a red case.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { ORCH, PACK, git, laneWorktree, orch, profileText, scratchRepo, tmp } from './fixtures/orch/rig.mjs';

const require = createRequire(import.meta.url);
const state = require('../scripts/lib/orch-state.cjs');
const merge = require('../scripts/lib/orch-merge.cjs');
const lease = require('../scripts/lib/orch-lease.cjs');

const OK = 'node -e "process.exit(0)"';
const RED = (n = 1) => `node -e "process.exit(${n})"`;

/** A primary checkout on dev, one lane worktree per spec, each DONE and queued in run m1. */
function rig(specs, { detach = false, run = 'm1' } = {}) {
  const { dir, repo, root } = scratchRepo();
  const wts = {};
  for (const [name, file, text] of specs) wts[name] = laneWorktree(dir, repo, `orch/${run}-${name}`, file, text);
  if (detach) git(repo, 'checkout', '-q', '--detach');
  const split = { maxLanes: 2, rows: [], lanes: specs.map(([n]) => ({ name: n, rows: [`R-${n}`], level: 'Standard', track: 'ADDITIVE', dispatch: 'full', ownedFiles: [`${n}.txt`], hotFiles: ['CHANGELOG.md'] })) };
  state.init(root, run, split, { repo, target: 'dev', preflightMode: 'parallel' });
  for (const [n] of specs) {
    state.setLane(root, run, n, { status: 'DONE', worktree: wts[n] });
    merge.enqueue(root, run, n);
  }
  return { dir, repo, root, wts, integrationWorktree: join(dir, 'integration') };
}
const opts = (r, gatesCmd = OK, extra = {}) => ({ repo: r.repo, slotOk: true, gatesCmd, integration: true, integrationWorktree: r.integrationWorktree, ...extra });
const parents = (repo, sha) => git(repo, 'rev-list', '--parents', '-n', '1', sha).split(' ').slice(1);

describe('direct mode: one merge at a time, a hot-file conflict stops with a heads-up', () => {
  test('red: the second lane on CHANGELOG.md stops, nothing deleted; gates red never merges; no slot, no merge', () => {
    const r = rig([['l1', 'CHANGELOG.md', '# Changelog\n\n## next\n- lane one\n'], ['l2', 'CHANGELOG.md', '# Changelog\n\n## next\n- lane two\n'], ['l3', 'b.txt', 'b\n']], { run: 'c1' });
    const o = { repo: r.repo, slotOk: true, gatesCmd: OK, integration: false };
    assert.throws(() => merge.mergeNext(r.root, 'c1', { ...o, slotOk: false }), /test slot/);
    assert.equal(merge.mergeNext(r.root, 'c1', o).ok, true);
    const tip2 = git(r.repo, 'rev-parse', 'orch/c1-l2');
    const second = merge.mergeNext(r.root, 'c1', o);
    assert.deepEqual([second.ok, second.lane, second.stage, second.files], [false, 'l2', 'dry-merge', ['CHANGELOG.md']]);
    assert.match(readFileSync(second.headsUp, 'utf8'), /Hot files among them: `CHANGELOG.md`/);
    assert.equal(git(r.repo, 'rev-parse', 'orch/c1-l2'), tip2);
    assert.match(readFileSync(join(r.wts.l2, 'CHANGELOG.md'), 'utf8'), /lane two/);
    assert.equal(state.load(r.root, 'c1').lanes.l2.status, 'STOPPED-CONFLICT');
    assert.match(state.nextActions(r.root, state.load(r.root, 'c1')).join('\n'), /HEADS-UP l2/);
    const tipDev = git(r.repo, 'rev-parse', 'dev');
    const red = merge.mergeNext(r.root, 'c1', { ...o, gatesCmd: RED(1) });
    assert.deepEqual([red.ok, red.lane, red.stage, red.exit], [false, 'l3', 'gates', 1]);
    assert.equal(git(r.repo, 'rev-parse', 'dev'), tipDev);
    assert.equal(git(r.repo, 'branch', '--list', 'orch/*').split('\n').length, 3); // no branch deleted
    assert.match(git(r.repo, 'log', '-1', '--format=%s', 'dev'), /merge\(c1-l1\)/);
  });

  test('red: a planted hook never runs inside a merge — every merge git call carries an empty core.hooksPath', () => {
    const r = rig([['l1', 'b.txt', 'b\n']], { run: 'h1' });
    const marker = join(r.dir, 'hook-ran');
    const hooks = join(r.repo, '.git', 'hooks');
    mkdirSync(hooks, { recursive: true });
    for (const h of ['pre-merge-commit', 'post-merge', 'prepare-commit-msg']) writeFileSync(join(hooks, h), `#!/bin/sh\necho ran > "${marker.split('\\').join('/')}"\n`, { mode: 0o755 });
    assert.equal(merge.mergeNext(r.root, 'h1', { repo: r.repo, slotOk: true, gatesCmd: OK, integration: false }).ok, true);
    assert.equal(existsSync(marker), false);
    git(r.repo, 'commit', '-q', '--allow-empty', '-m', 'positive control'); // a plain git call does run the hook
    assert.equal(existsSync(marker), true, 'positive control: the planted hook must run outside the merge, or this test proves nothing');
    assert.deepEqual(merge.gitArgv(['status']).slice(0, 1), ['-c']);
    assert.match(merge.gitArgv(['status'])[1], /^core\.hooksPath=/);
  });

  test('red: a lane holding a credit job not yet signed off is refused before anything moves', () => {
    const r = rig([['l1', 'b.txt', 'b\n']], { run: 'cr' });
    const d = join(r.wts.l1, '.pipeline', 'credit', 'runs', 'q1', 't1');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'verdict.json'), JSON.stringify({ review: 'PENDING', changed: ['tasks/k1.md'] }));
    const tip = git(r.repo, 'rev-parse', 'dev');
    assert.throws(() => merge.mergeNext(r.root, 'cr', { repo: r.repo, slotOk: true, gatesCmd: OK, integration: false }), /holds credit job\(s\) not signed off — q1\/t1 review PENDING/);
    assert.equal(git(r.repo, 'rev-parse', 'dev'), tip);
  });
});

describe('integration mode: gates on the integration tip, compare-and-swap onto the target', () => {
  test('green: the lane is merged --no-ff on orch/integration and the target moves to it by CAS', () => {
    const r = rig([['l1', 'b.txt', 'b\n']], { detach: true });
    const base = git(r.repo, 'rev-parse', 'dev');
    const res = merge.mergeNext(r.root, 'm1', opts(r));
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(git(r.repo, 'rev-parse', 'dev'), res.sha);
    assert.equal(git(r.repo, 'rev-parse', 'orch/integration'), res.sha);
    assert.deepEqual(parents(r.repo, res.sha), [base, git(r.repo, 'rev-parse', 'orch/m1-l1')]);
    assert.equal(git(r.integrationWorktree, 'rev-parse', 'HEAD'), res.sha);
    assert.equal(state.load(r.root, 'm1').lanes.l1.status, 'MERGED');
  });

  test('a target checked out in a worktree is never moved under it: the ff-only command is handed back (CLI exit 12)', () => {
    const r = rig([['l1', 'b.txt', 'b\n']]);
    const base = git(r.repo, 'rev-parse', 'dev');
    const p = orch(r.repo, r.root, ['merge', 'm1', '--slot-ok', '--gates', OK, '--repo', r.repo, '--integration-wt', r.integrationWorktree]);
    assert.equal(p.status, 12, p.out);
    assert.match(p.stdout, /FF-NEEDED l1: run {2}git -C ".*primary" merge --ff-only [0-9a-f]{40}/);
    assert.equal(git(r.repo, 'rev-parse', 'dev'), base);
    const sha = /merge --ff-only ([0-9a-f]{40})/.exec(p.stdout)[1];
    git(r.repo, 'merge', '-q', '--ff-only', sha);
    const done = merge.mergeNext(r.root, 'm1', opts(r));
    assert.deepEqual([done.ok, done.sha], [true, sha]);
    assert.equal(state.load(r.root, 'm1').lanes.l1.status, 'MERGED');
  });

  test('red: the target moves between the build and the CAS — refused, target left where it moved, lane re-queued, then rebuilt', () => {
    const r = rig([['l1', 'b.txt', 'b\n']], { detach: true });
    const moved = git(r.repo, 'commit-tree', 'dev^{tree}', '-p', 'dev', '-m', 'someone else landed');
    const res = merge.mergeNext(r.root, 'm1', opts(r, `git update-ref refs/heads/dev ${moved}`));
    assert.deepEqual([res.ok, res.stage], [false, 'cas']);
    assert.match(readFileSync(res.headsUp, 'utf8'), /target moved, rebuild integration/);
    assert.equal(git(r.repo, 'rev-parse', 'dev'), moved);
    const s = state.load(r.root, 'm1');
    assert.deepEqual([s.lanes.l1.status, s.mergeQueue], ['QUEUED', ['l1']]);
    const again = merge.mergeNext(r.root, 'm1', opts(r));
    assert.equal(again.ok, true);
    assert.equal(parents(r.repo, again.sha)[0], moved);
  });

  test('red: gates red on the integration tip — target unchanged, lane FAILED, next says FIX', () => {
    const r = rig([['l1', 'b.txt', 'b\n']], { detach: true });
    const base = git(r.repo, 'rev-parse', 'dev');
    const res = merge.mergeNext(r.root, 'm1', opts(r, RED(3)));
    assert.deepEqual([res.ok, res.stage, res.exit], [false, 'gates', 3]);
    assert.equal(git(r.repo, 'rev-parse', 'dev'), base);
    assert.equal(state.load(r.root, 'm1').lanes.l1.status, 'FAILED');
    state.approve(r.root, 'm1', 'human');
    assert.ok(state.nextActions(r.root, state.load(r.root, 'm1')).some((a) => a.startsWith('FIX l1')));
  });

  test('red: no gates command configured is a refusal, never a merge without gates', () => {
    const r = rig([['l1', 'b.txt', 'b\n']], { detach: true });
    assert.throws(() => merge.mergeNext(r.root, 'm1', opts(r, null)), /no gates command/);
  });
});

describe('linked directories in the integration worktree', () => {
  const SEES = 'node -e "process.exit(require(\'fs\').existsSync(\'deps/marker.txt\') ? 0 : 7)"';

  test('red: a missing linked dir is junctioned to the repo checkout\'s own before the gates, one line logged', () => {
    const r = rig([['l1', 'b.txt', 'b\n']], { detach: true });
    mkdirSync(join(r.repo, 'deps'));
    writeFileSync(join(r.repo, 'deps', 'marker.txt'), 'repo deps\n');
    const res = merge.mergeNext(r.root, 'm1', opts(r, SEES, { linkDirs: ['deps'] }));
    assert.equal(res.ok, true, JSON.stringify(res));
    const link = join(r.integrationWorktree, 'deps');
    assert.equal(lstatSync(link).isSymbolicLink(), true);
    assert.equal(realpathSync(link), realpathSync(join(r.repo, 'deps')));
    assert.deepEqual(res.deps.length, 1);
    assert.match(res.deps[0], /^deps: linked /);
  });

  test('red: an existing real directory is used as is — never replaced, deleted or entered', () => {
    const repo = tmp('lrepo');
    const wt = tmp('lwt');
    mkdirSync(join(repo, 'deps'));
    mkdirSync(join(wt, 'deps', 'pkg'), { recursive: true });
    writeFileSync(join(wt, 'deps', 'pkg', 'x.js'), 'own install\n');
    const lines = merge.provisionLinks(repo, wt, 'unused', { linkDirs: ['deps'] });
    assert.match(lines[0], /^deps: present /);
    assert.equal(lstatSync(join(wt, 'deps')).isSymbolicLink(), false);
    assert.equal(readFileSync(join(wt, 'deps', 'pkg', 'x.js'), 'utf8'), 'own install\n');
  });

  test('red: the tip changes a guard file — refused before the gates, no link, target unmoved, lane still queued', () => {
    const r = rig([['l1', 'b.txt', 'b\n']], { detach: true });
    mkdirSync(join(r.repo, 'deps'));
    writeFileSync(join(r.wts.l1, 'deps.lock'), 'v2\n');
    git(r.wts.l1, 'add', '.');
    git(r.wts.l1, 'commit', '-q', '-m', 'dependency change');
    const base = git(r.repo, 'rev-parse', 'dev');
    assert.throws(() => merge.mergeNext(r.root, 'm1', opts(r, OK, { linkDirs: ['deps'], linkGuard: ['deps.lock'] })), /refused: .*changes deps\.lock .*install it in /);
    assert.equal(existsSync(join(r.integrationWorktree, 'deps')), false);
    assert.equal(git(r.repo, 'rev-parse', 'dev'), base);
    const s = state.load(r.root, 'm1');
    assert.deepEqual([s.lanes.l1.status, s.mergeQueue], ['QUEUED', ['l1']]);
  });
});

describe('snapshots when a lane stalls or fails, or a merge stops', () => {
  const snaps = (repo, prefix) => {
    const out = git(repo, 'for-each-ref', '--format=%(refname) %(objectname)', prefix);
    return out ? out.split(/\r?\n/).map((l) => l.split(' ')) : [];
  };

  test('a merge stopped by red gates leaves a snapshot of the lane tip; `orch snapshots <run>` lists it', () => {
    const r = rig([['l1', 'b.txt', 'b\n']], { detach: true });
    merge.mergeNext(r.root, 'm1', opts(r, RED(1)));
    const refs = snaps(r.repo, 'refs/orch/snapshots/m1/l1');
    assert.equal(refs.length, 1);
    assert.match(refs[0][0], /^refs\/orch\/snapshots\/m1\/l1\/\d{8}T\d{6}Z$/);
    assert.equal(refs[0][1], git(r.repo, 'rev-parse', 'orch/m1-l1'));
    const p = orch(r.repo, r.root, ['snapshots', 'm1']);
    assert.equal(p.status, 0, p.out);
    assert.ok(p.stdout.includes(refs[0][0]));
  });

  test('red: a stalled lane with a dirty worktree gets the tip ref AND a -wip ref; the worktree is untouched', () => {
    const r = rig([['l1', 'b.txt', 'b\n']]);
    const wt = r.wts.l1;
    writeFileSync(join(wt, 'b.txt'), 'half-done edit\n');
    writeFileSync(join(wt, 'scratch.md'), 'untracked\n');
    const before = { status: git(wt, 'status', '--porcelain'), stash: git(wt, 'stash', 'list'), head: git(wt, 'rev-parse', 'HEAD'), files: readdirSync(wt).sort() };
    state.setLane(r.root, 'm1', 'l1', { status: 'STALLED', stallReason: 'test' });
    const refs = snaps(r.repo, 'refs/orch/snapshots/m1/l1');
    assert.deepEqual(refs.map(([n]) => n.replace(/\d{8}T\d{6}Z/, '<stamp>')), ['refs/orch/snapshots/m1/l1/<stamp>', 'refs/orch/snapshots/m1/l1/<stamp>-wip']);
    assert.equal(git(r.repo, 'show', `${refs[1][1]}:b.txt`), 'half-done edit');
    assert.deepEqual({ status: git(wt, 'status', '--porcelain'), stash: git(wt, 'stash', 'list'), head: git(wt, 'rev-parse', 'HEAD'), files: readdirSync(wt).sort() }, before);
    state.setLane(r.root, 'm1', 'l1', { status: 'FAILED' });
    assert.equal(snaps(r.repo, 'refs/orch/snapshots/m1/l1').length, 4); // a second failure adds refs, never replaces
  });
});

describe('integrity: git config / hooks around a lane', () => {
  test('red: a lane whose worker changed .git/config between launch and the finish notice is STALLED, not DONE', () => {
    const r = rig([['l1', 'b.txt', 'b\n']]);
    state.setLane(r.root, 'm1', 'l1', { status: 'LAUNCHED' });
    assert.ok(state.integrityBaseline(r.root, 'm1', 'l1'));
    const result = state.load(r.root, 'm1').lanes.l1.result;
    mkdirSync(join(result, '..'), { recursive: true });
    writeFileSync(result, 'RESULT: PASS done\n');
    appendFileSync(join(r.repo, '.git', 'config'), '[core]\n\tfsmonitor = ./evil\n');
    const n = state.notice(r.root, 'm1', 'l1');
    assert.equal(n.status, 'STALLED');
    assert.match(state.load(r.root, 'm1').lanes.l1.stallReason, /integrity: .*common:config: changed/);
  });
});

describe('the lease and orch wait', () => {
  function run1() {
    const { repo, root } = scratchRepo();
    state.init(root, 'w1', { maxLanes: 2, rows: [], lanes: [{ name: 'l1', rows: ['A'], level: 'Micro', track: 'SOLO', dispatch: 'solo', ownedFiles: ['x.md'], hotFiles: [] }] }, { preflightMode: 'parallel', target: 'dev' });
    return { repo, root, cli: (...args) => orch(repo, root, args) };
  }

  test('the holder takes and renews its lease; with its --holder state changes pass; without --holder they behave as before', () => {
    const { root, cli } = run1();
    assert.equal(cli('lease', 'w1', '--holder', 'orch-a', '--ttl', '300').status, 0);
    assert.match(cli('lease', 'w1', '--holder', 'orch-a').stdout, /LEASE renew w1 → orch-a/);
    assert.equal(cli('set', 'w1', 'l1', 'status=CLAIMED', '--holder', 'orch-a').status, 0);
    assert.equal(cli('approve', 'w1', '--by', 'human').status, 0);
    const s = state.load(root, 'w1');
    assert.deepEqual([s.approved, s.lanes.l1.status], [true, 'CLAIMED']);
  });

  test('red: a second holder is refused (exit 3) while the lease is live — for the lease and for every state change', () => {
    const { root, cli } = run1();
    assert.equal(cli('lease', 'w1', '--holder', 'orch-a').status, 0);
    const take = cli('lease', 'w1', '--holder', 'orch-b');
    assert.equal(take.status, 3);
    assert.match(take.stderr, /refused: run w1 is leased by orch-a/);
    for (const args of [['set', 'w1', 'l1', 'status=CLAIMED'], ['claim', 'w1', 'l1'], ['approve', 'w1', '--by', 'x'], ['notice', 'w1', 'l1'], ['enqueue', 'w1', 'l1'], ['merge', 'w1', '--slot-ok']]) {
      assert.deepEqual([args[0], cli(...args, '--holder', 'orch-b').status], [args[0], 3]);
    }
    const s = state.load(root, 'w1');
    assert.deepEqual([s.approved, s.lanes.l1.status], [false, 'PLANNED']);
  });

  test('red: an expired lease is taken over by another holder, and the takeover is an event', () => {
    const { root } = run1();
    const t0 = Date.parse('2026-10-13T10:00:00Z');
    assert.equal(lease.take(root, 'w1', 'orch-a', { ttlSec: 1, now: t0 }).kind, 'take');
    assert.throws(() => lease.take(root, 'w1', 'orch-b', { ttlSec: 60, now: t0 + 500 }), /leased by orch-a/);
    const r = lease.take(root, 'w1', 'orch-b', { ttlSec: 60, now: t0 + 2000 });
    assert.deepEqual([r.kind, r.lease.holder, r.previous.holder], ['takeover', 'orch-b', 'orch-a']);
    assert.match(readFileSync(join(root, 'runs', 'w1', 'events.jsonl'), 'utf8'), /"type":"lease.takeover".*"from":"orch-a"/);
    assert.throws(() => lease.check(root, 'w1', 'orch-a', t0 + 3000), /leased by orch-b/);
    assert.doesNotThrow(() => lease.check(root, 'w1', undefined, t0 + 3000));
  });

  test('red: wait times out at --timeout (exit 9) and never waits past 110 s', () => {
    const { cli } = run1();
    const t = Date.now();
    const p = cli('wait', 'w1', '--timeout', '1');
    assert.equal(p.status, 9);
    assert.match(p.stdout, /TIMEOUT w1 after 1 s/);
    assert.ok(Date.now() - t < 15000);
    assert.equal(lease.waitSeconds(500), 110);
    assert.equal(lease.waitSeconds(undefined), 110);
  });

  test('wait returns as soon as the run logs a new event (exit 0) and prints it', async () => {
    const { repo, root } = run1();
    const child = spawn(process.execPath, [ORCH, 'wait', 'w1', '--timeout', '20'], { cwd: repo, env: { ...process.env, BUILDER_ORCH_DIR: root } });
    let stdout = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    await new Promise((res) => setTimeout(res, 1500));
    state.event(root, 'w1', 'test.ping', { n: 1 });
    const code = await new Promise((res) => child.on('close', res));
    assert.equal(code, 0);
    assert.match(stdout, /"type":"test.ping"/);
  });
});

describe('mechanical resolution of the hot ledger files (features.orchestrator.mechanical)', () => {
  const resolver = require('../scripts/lib/orch-merge-resolve.cjs');
  const MECH = { semver: ['package.json', 'package-lock.json'], changelog: ['CHANGELOG.md'], json: ['contracts/api.json'], union: ['audits/ledger.md'] };
  const pkg = (v, extra = {}) => `${JSON.stringify({ name: 'x', version: v, ...extra }, null, 2)}\n`;
  const log = (...secs) => `# Changelog\n\n${secs.map(([v, line]) => `## ${v}\n\n- ${line}`).join('\n\n')}\n`;

  test('resolveVersion: the lane bump kind applied to the target, or the lane version when already higher', () => {
    assert.equal(resolver.resolveVersion({ base: '1.2.0', ours: '1.3.0', theirs: '1.3.0' }), '1.4.0');
    assert.equal(resolver.resolveVersion({ base: '1.2.0', ours: '1.2.1', theirs: '1.3.0' }), '1.3.0');
    assert.equal(resolver.resolveVersion({ base: '1.2.0', ours: '1.3.0', theirs: '1.2.1' }), '1.3.1');
    assert.throws(() => resolver.resolveVersion({ base: '1', ours: 'x', theirs: '1.0.0' }), resolver.NotMechanical);
  });

  test('merge3 keeps both sides keys, refuses a key both changed, and keeps a "__proto__" key an own key', () => {
    assert.deepEqual(resolver.merge3({ a: 1 }, { a: 1, b: 2 }, { a: 1, c: 3 }), { a: 1, b: 2, c: 3 });
    assert.throws(() => resolver.merge3({ a: 1 }, { a: 2 }, { a: 3 }), /both sides changed \$\.a/);
    const out = resolver.merge3({}, JSON.parse('{"__proto__":{"x":1}}'), {});
    assert.equal(Object.prototype.hasOwnProperty.call(out, '__proto__'), true);
    assert.equal({}.x, undefined);
  });

  test('CHANGELOG: union by version section, newest first, the lane section re-versioned with a note', () => {
    const b = log(['1.2.0', 'base']);
    const o = log(['1.3.0', 'target lane'], ['1.2.0', 'base']);
    const t = log(['1.3.0', 'this lane'], ['1.2.0', 'base']);
    const m = resolver.mergeChangelog(b, o, t, { from: '1.3.0', to: '1.4.0' });
    assert.match(m, /## 1\.4\.0\n\n_Re-versioned from 1\.3\.0 at merge \(orch merge\)\._\n- this lane\n\n## 1\.3\.0\n\n- target lane\n\n## 1\.2\.0/);
    assert.throws(() => resolver.mergeChangelog(b, log(['1.2.0', 'edited A']), log(['1.2.0', 'edited B']), { from: '1.2.0', to: '1.2.0' }), /both sides edited/);
  });

  test('resolve: off (null) resolves nothing; a non-mechanical file, a modify/delete and a JSON key both changed stay named', () => {
    const blobs = { base: { 'package.json': pkg('1.0.0'), 'x.ts': 'a', 'contracts/api.json': '{"a":1}' }, ours: { 'package.json': pkg('1.1.0'), 'x.ts': 'b', 'contracts/api.json': '{"a":2}' }, theirs: { 'package.json': pkg('1.1.0'), 'x.ts': 'c', 'contracts/api.json': '{"a":3}' } };
    const blob = (s, f) => (f in blobs[s] ? blobs[s][f] : null);
    const off = resolver.resolve(['package.json'], blob, null);
    assert.deepEqual([off.resolved, off.unresolved.map((u) => u.file)], [{}, ['package.json']]);
    const r = resolver.resolve(['x.ts', 'contracts/api.json'], blob, MECH);
    assert.deepEqual(r.unresolved.map((u) => u.file).sort(), ['contracts/api.json', 'x.ts']);
    assert.match(r.unresolved.find((u) => u.file === 'x.ts').why, /not a mechanical file/);
    assert.equal(JSON.parse(r.resolved['package.json']).version, '1.2.0', 'both bumped: package.json is re-versioned even without a conflict');
    const md = resolver.resolve(['CHANGELOG.md'], (s, f) => (f === 'CHANGELOG.md' ? (s === 'ours' ? null : log(['1.0.0', 'x'])) : null), MECH);
    assert.match(md.unresolved[0].why, /absent on one side/);
  });

  test('integration: a second lane that took the same version merges mechanically, re-versioned; with mechanical off it stops', () => {
    for (const mechanical of [MECH, null]) {
      const { dir, repo, root } = scratchRepo({ files: { 'package.json': pkg('1.0.0'), 'CHANGELOG.md': log(['1.0.0', 'base']) } });
      const bump = (branch, line) => {
        const wt = join(dir, branch.replace(/\//g, '-'));
        git(repo, 'worktree', 'add', '-q', '-b', branch, wt, 'dev');
        writeFileSync(join(wt, 'package.json'), pkg('1.1.0'));
        writeFileSync(join(wt, 'CHANGELOG.md'), log(['1.1.0', line], ['1.0.0', 'base']));
        writeFileSync(join(wt, `${line}.txt`), line);
        git(wt, 'add', '.');
        git(wt, 'commit', '-q', '-m', line);
        return wt;
      };
      const w1 = bump('orch/v1-l1', 'one');
      const w2 = bump('orch/v1-l2', 'two');
      git(repo, 'checkout', '-q', '--detach');
      const split = { maxLanes: 2, rows: [], lanes: ['l1', 'l2'].map((n) => ({ name: n, rows: [`R-${n}`], level: 'Standard', track: 'ADDITIVE', dispatch: 'full', ownedFiles: [], hotFiles: ['CHANGELOG.md', 'package.json'] })) };
      state.init(root, 'v1', split, { repo, target: 'dev', preflightMode: 'parallel' });
      for (const [n, wt] of [['l1', w1], ['l2', w2]]) {
        state.setLane(root, 'v1', n, { status: 'DONE', worktree: wt });
        merge.enqueue(root, 'v1', n);
      }
      const o = { repo, slotOk: true, gatesCmd: OK, integration: true, integrationWorktree: join(dir, 'integration'), mechanical };
      assert.equal(merge.mergeNext(root, 'v1', o).ok, true);
      const second = merge.mergeNext(root, 'v1', o);
      if (!mechanical) {
        assert.deepEqual([second.ok, second.stage], [false, 'dry-merge']);
        assert.ok(second.files.includes('CHANGELOG.md'), JSON.stringify(second));
        continue;
      }
      assert.equal(second.ok, true, JSON.stringify(second));
      assert.equal(JSON.parse(git(repo, 'show', 'dev:package.json')).version, '1.2.0');
      assert.match(git(repo, 'show', 'dev:CHANGELOG.md'), /## 1\.2\.0\n\n_Re-versioned from 1\.1\.0 at merge \(orch merge\)\._\n- two\n\n## 1\.1\.0\n\n- one\n\n## 1\.0\.0/);
      assert.equal(git(repo, 'show', 'dev:two.txt'), 'two');
    }
  });
});

describe('the review hold fails closed', () => {
  test('red: a lane whose worktree folder is gone is refused, and a REJECTED job for the lane in ANOTHER queue (moved aside) holds it', () => {
    const r = rig([['l1', 'b.txt', 'b\n']], { run: 'gh' });
    const real = state.load(r.root, 'gh').lanes.l1.worktree;
    state.setLane(r.root, 'gh', 'l1', { worktree: join(r.dir, 'gone') });
    const o = { repo: r.repo, slotOk: true, gatesCmd: OK, integration: false };
    assert.throws(() => merge.mergeNext(r.root, 'gh', o), /worktree .*gone is gone/);
    state.setLane(r.root, 'gh', 'l1', { worktree: real });
    const d = join(r.repo, '.pipeline', 'credit', 'runs', 'q9', 't9');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'task.json'), JSON.stringify({ worktree: r.wts.l1 }));
    writeFileSync(join(d, 'verdict.prev-20261015T000000Z.json'), JSON.stringify({ review: 'REJECTED', changed: ['b.txt'] }));
    assert.throws(() => merge.mergeNext(r.root, 'gh', o), /q9\/t9 review REJECTED \(verdict\.prev-20261015T000000Z\.json\)/);
    writeFileSync(join(d, 'task.json'), JSON.stringify({ worktree: join(r.dir, 'some-other-lane') }));
    assert.equal(merge.mergeNext(r.root, 'gh', o).ok, true, 'positive control: a job for another lane does not hold this one');
  });
});

describe('REQ-1845 — the completion gate runs before the gates command when `hygiene-gate` is among the gates', () => {
  const kitScripts = join(PACK, 'scripts');
  test('red: AC-1845 a lane whose diff adds .cursorrules is refused with the gate rows, the lane is FAILED and dequeued, the target unmoved; a clean lane merges', () => {
    const { dir, repo, root } = scratchRepo({ profile: profileText({ extraFeatures: { artifactCheck: { state: 'on' } } }) });
    const wts = { l1: laneWorktree(dir, repo, 'orch/g1-l1', '.cursorrules', 'be terse\n'), l2: laneWorktree(dir, repo, 'orch/g1-l2', 'b.txt', 'b\n') };
    git(repo, 'checkout', '-q', '--detach'); // the target is not checked out: the ref moves by compare-and-swap
    const split = { maxLanes: 2, rows: [], lanes: ['l1', 'l2'].map((n) => ({ name: n, rows: [`R-${n}`], level: 'Standard', track: 'ADDITIVE', dispatch: 'full', ownedFiles: [`${n}.txt`], hotFiles: [] })) };
    state.init(root, 'g1', split, { repo, target: 'dev', preflightMode: 'parallel' });
    for (const n of ['l1', 'l2']) {
      state.setLane(root, 'g1', n, { status: 'DONE', worktree: wts[n] });
      merge.enqueue(root, 'g1', n);
    }
    const o = { repo, slotOk: true, gatesCmd: OK, integration: true, integrationWorktree: join(dir, 'integration'), hygieneGate: true, kitScripts };
    const tipDev = git(repo, 'rev-parse', 'dev');
    const r = merge.mergeNext(root, 'g1', o);
    assert.deepEqual([r.ok, r.lane, r.stage, r.exit], [false, 'l1', 'hygiene-gate', 1]);
    assert.ok(r.rows.some((l) => /^FAIL\s+file scope/.test(l)), r.rows.join('\n'));
    assert.ok(r.rows.some((l) => l.includes('.cursorrules')), r.rows.join('\n'));
    assert.ok(existsSync(r.log) && readFileSync(r.log, 'utf8').includes('.cursorrules'));
    const s = state.load(root, 'g1');
    assert.equal(s.lanes.l1.status, 'FAILED');
    assert.deepEqual(s.mergeQueue, ['l2']);
    assert.equal(git(repo, 'rev-parse', 'dev'), tipDev);
    assert.equal(git(repo, 'branch', '--list', 'orch/g1-*').split('\n').length, 2); // nothing deleted
    const ok = merge.mergeNext(root, 'g1', o);
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.equal(state.load(root, 'g1').lanes.l2.status, 'MERGED');
  });
  test('red: AC-1845 with no gate check on in the lane\'s profile the gate is "not configured" — a note in the log, never a pass and never a refusal; the gates command decides', () => {
    const r = rig([['n1', 'c.txt', 'c\n']], { run: 'g2' });
    const o = opts(r, RED(1), { hygieneGate: true, kitScripts });
    const red = merge.mergeNext(r.root, 'g2', o);
    assert.deepEqual([red.ok, red.stage, red.exit], [false, 'gates', 1]);
    const logs = readdirSync(join(r.root, 'runs', 'g2', 'logs')).filter((f) => f.startsWith('hygiene-gate-n1-'));
    assert.equal(logs.length, 1);
    assert.match(readFileSync(join(r.root, 'runs', 'g2', 'logs', logs[0]), 'utf8'), /hygiene gate: not configured in this lane/);
  });
  test('red: AC-1845 `orch merge` prints the failing rows on stderr and exits 5', () => {
    const { dir, repo, root } = scratchRepo({ profile: profileText({ orchestrator: { gates: ['hygiene-gate', OK] }, extraFeatures: { artifactCheck: { state: 'on' } } }) });
    const wt = laneWorktree(dir, repo, 'orch/g3-l1', 'notes.tmp', 'scratch\n');
    const split = { maxLanes: 1, rows: [], lanes: [{ name: 'l1', rows: ['R-l1'], level: 'Standard', track: 'ADDITIVE', dispatch: 'full', ownedFiles: ['l1.txt'], hotFiles: [] }] };
    state.init(root, 'g3', split, { repo, target: 'dev', preflightMode: 'parallel' });
    state.setLane(root, 'g3', 'l1', { status: 'DONE', worktree: wt });
    merge.enqueue(root, 'g3', 'l1');
    const r = orch(repo, root, ['merge', 'g3', '--slot-ok', '--integration-wt', join(dir, 'integration')]);
    assert.equal(r.status, 5, r.out);
    assert.match(r.stderr, /HYGIENE GATE FAIL l1/);
    assert.match(r.stderr, /FAIL\s+file scope/);
    assert.match(r.stderr, /notes\.tmp/);
  });
});
