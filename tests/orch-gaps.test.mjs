/**
 * Batch orchestrator — gaps found in a first real orchestrated batch:
 *   credit-audit   the P4 auditor seats (and optionally the P3 tester) of one gate-queue key become credit jobs,
 *                  built from the queue's own base/tip/files, with the profile's models (strong / mid);
 *   release-stale  claims held by a paused run (or a MERGED/FAILED lane, or a missing run) block new claims on the
 *                  same files; list them, release them only with --apply;
 *   digest --check the documented form and the other argument order both check the plan.
 * Every guard has a red case.
 */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { orch, profileText, scratchRepo, tmp } from './fixtures/orch/rig.mjs';

const require = createRequire(import.meta.url);
const audit = require('../scripts/lib/orch-credit-audit.cjs');
const queue = require('../scripts/lib/gate-queue.cjs');
const claims = require('../scripts/lib/orch-claims.cjs');
const state = require('../scripts/lib/orch-state.cjs');

const BASE = 'a'.repeat(40);
const TIP = 'b'.repeat(40);
const FILES = ['DEFERRED_TASKS.md', 'tasks/pay1.md', 'test/e2e/scen.pack.ts', 'src/modules/payments/payment.service.ts'];
const SETTINGS = { models: { strong: 'strong-model', mid: 'mid-model' }, paths: { boards: 'tasks', runs: '.pipeline', registry: 'DEFERRED_TASKS.md', decisions: 'DECISIONS.md' } };
const queueText = (over = {}) => queue.serialize(queue.add(queue.empty(), { key: 'pay1', base: BASE, tip: TIP, files: FILES, branch: 'lite/b1', ...over }));

function queueWorktree(text = queueText()) {
  const wt = tmp('gq');
  mkdirSync(join(wt, 'tasks'));
  writeFileSync(join(wt, 'tasks', '_gate-queue.md'), text);
  return wt;
}

describe('credit-audit builds the P4 seats as credit jobs from the gate queue', () => {
  test('four auditor jobs, on the profile\'s models, with the queue range and the changed files in every brief', () => {
    const jobs = audit.plan(queueWorktree(), 'pay1', { settings: SETTINGS });
    assert.deepEqual(jobs.map((j) => j.kind), ['standards-auditor', 'security-auditor', 'invariant-auditor', 'vuln-auditor']);
    assert.deepEqual(jobs.map((j) => j.model), ['strong-model', 'strong-model', 'strong-model', 'mid-model']);
    for (const j of jobs) {
      assert.ok(j.brief.includes(`DIFF-RANGE: ${'a'.repeat(8)}..${'b'.repeat(8)}`));
      assert.ok(j.brief.includes('test/e2e/scen.pack.ts'));
      assert.ok(j.brief.includes(`.pipeline/pay1/findings-${j.kind}.json`));
      assert.equal(j.task, `p4-pay1-${j.kind}`);
    }
  });

  test('the auditors scope the code files, never the ledgers; --tester adds a module-tester scoped under the test roots', () => {
    const jobs = audit.plan(queueWorktree(), 'pay1', { settings: SETTINGS, tester: true });
    assert.deepEqual(jobs.find((j) => j.kind === 'security-auditor').scope, ['src/modules/payments/payment.service.ts', 'test/e2e/scen.pack.ts']);
    const t = jobs.find((j) => j.kind === 'module-tester');
    assert.equal(t.model, 'strong-model');
    assert.deepEqual(t.scope, ['test/**', 'test/e2e/**', 'tests/**']);
  });

  test('red: an unknown key, a queue with no base/tip, an unknown seat, unset models, or no queue at all are refused', () => {
    const wt = queueWorktree();
    assert.throws(() => audit.plan(wt, 'nope', { settings: SETTINGS }), /no key "nope" in .*_gate-queue\.md/);
    const broken = queueWorktree(queueText().replace(`"base": "${BASE}"`, '"base": null'));
    assert.throws(() => audit.plan(broken, 'pay1', { settings: SETTINGS }), /has no base\/tip/);
    assert.throws(() => audit.plan(wt, 'pay1', { settings: SETTINGS, seats: ['module-builder'] }), /unknown seat/);
    assert.throws(() => audit.plan(wt, 'pay1', { settings: { paths: SETTINGS.paths } }), /models\.strong is not set/);
    assert.throws(() => audit.plan(tmp('noq'), 'pay1', { settings: SETTINGS }), /no gate queue at/);
  });

  test('the CLI: --dry lists the jobs; a real run prepares each job past the credit lane\'s floor and scope checks', () => {
    const profile = profileText({ orchestrator: { credit: { enabled: true, dailyCapUsd: 20, fallback: [] } } });
    const files = { 'tasks/_gate-queue.md': queueText(), 'test/e2e/scen.pack.ts': 'x\n', 'src/modules/payments/payment.service.ts': 'x\n', 'tasks/pay1.md': '# pay1\n', 'DEFERRED_TASKS.md': '# registry\n' };
    const { dir, repo, root } = scratchRepo({ profile, files });
    const env = { BUILDER_ORCH_CREDIT_DIR: join(dir, 'credit') };
    const dry = orch(repo, root, ['credit-audit', 'r1', '--key', 'pay1', '--worktree', repo, '--tester', '--dry'], env);
    assert.equal(dry.status, 0, dry.out);
    assert.equal(dry.stdout.split('\n').filter((l) => l.startsWith('DRY r1/')).length, 5);
    assert.match(dry.stdout, /DRY r1\/p4-pay1-vuln-auditor · vuln-auditor · mid-model/);
    const real = orch(repo, root, ['credit-audit', 'r1', '--key', 'pay1', '--worktree', repo, '--tester'], env);
    assert.equal(real.status, 0, real.out);
    assert.equal(real.stdout.split('\n').filter((l) => l.startsWith('PREPARED r1/')).length, 5);
    const task = JSON.parse(readFileSync(join(dir, 'credit', 'runs', 'r1', 'p4-pay1-standards-auditor', 'task.json'), 'utf8'));
    assert.deepEqual([task.kind, task.model], ['standards-auditor', 'strong-model']);
    assert.ok(task.writeGlobs.includes('.pipeline/pay1/**')); // the findings file is a record it may write
    assert.equal(task.writeGlobs.includes('src/modules/payments/payment.service.ts'), false); // read-only: never the code
  });

  test('red: behind the credit switch — off, it says so and prepares nothing; a missing --key is a usage error', () => {
    const { repo, root } = scratchRepo({ files: { 'tasks/_gate-queue.md': queueText() } });
    const off = orch(repo, root, ['credit-audit', 'r1', '--key', 'pay1', '--worktree', repo]);
    assert.equal(off.status, 0);
    assert.match(off.stdout, /credit lane: not configured/);
    const on = scratchRepo({ profile: profileText({ orchestrator: { credit: { enabled: true, dailyCapUsd: 20, fallback: [] } } }) });
    assert.equal(orch(on.repo, on.root, ['credit-audit', 'r1', '--worktree', on.repo]).status, 2);
  });
});

describe('release-stale frees claims held by paused runs', () => {
  const project = () => {
    const dir = tmp('stale');
    writeFileSync(join(dir, 'PIPELINE_PROFILE.md'), profileText());
    return { dir, root: join(dir, 'orch') };
  };
  const lanes = (owned) => ({ maxLanes: 2, rows: [], lanes: [{ name: 'l1', rows: ['R'], level: 'Standard', track: 'ADDITIVE', dispatch: 'full', ownedFiles: owned, hotFiles: [] }] });

  test('red: a paused run blocks a claim; release-stale lists it and frees it only with --apply', () => {
    const { dir, root } = project();
    state.init(root, 'old', lanes(['src/x/**']));
    state.setPaused(root, 'old', true);
    claims.claim(root, { runId: 'old', lane: 'l1', owned: ['src/x/**'] });
    state.init(root, 'new', lanes(['src/x/**']));
    assert.equal(claims.claim(root, { runId: 'new', lane: 'l1', owned: ['src/x/**'] }).ok, false);
    const dry = orch(dir, root, ['release-stale']);
    assert.equal(dry.status, 0, dry.out);
    assert.match(dry.stdout, /STALE old\/l1 src\/x\/\*\* — run paused/);
    assert.equal(claims.list(root).length, 1); // a dry run releases nothing
    assert.match(orch(dir, root, ['release-stale', '--apply']).stdout, /released 1 stale claim/);
    assert.equal(claims.claim(root, { runId: 'new', lane: 'l1', owned: ['src/x/**'] }).ok, true);
  });

  test('red: a MERGED lane and a missing run are stale; a live run\'s claim never is', () => {
    const { dir, root } = project();
    state.init(root, 'done', lanes(['a.ts']));
    state.setLane(root, 'done', 'l1', { status: 'MERGED' });
    claims.claim(root, { runId: 'done', lane: 'l1', owned: ['a.ts'] });
    claims.claim(root, { runId: 'ghost', lane: 'l1', owned: ['b.ts'] });
    state.init(root, 'live', lanes(['c.ts']));
    claims.claim(root, { runId: 'live', lane: 'l1', owned: ['c.ts'] });
    const r = orch(dir, root, ['release-stale', '--apply']);
    assert.match(r.stdout, /STALE done\/l1 a\.ts — lane MERGED/);
    assert.match(r.stdout, /STALE ghost\/l1 b\.ts — run not found/);
    assert.match(r.stdout, /released 2 stale claim/);
    assert.deepEqual(claims.list(root).map((c) => c.runId), ['live']);
  });
});

describe('digest --check, in both argument orders', () => {
  test('red: the documented form and the other order both check the plan; neither prints usage', () => {
    const dir = tmp('dchk');
    writeFileSync(join(dir, 'PIPELINE_PROFILE.md'), profileText());
    const plan = join(dir, 'p.plan.md');
    writeFileSync(plan, '## Rows\n| id | title | kind | files | depends-on | flags | confirm |\n|---|---|---|---|---|---|---|\n| Z-1 | x | record | tasks/z.md | - | record-only | |\n');
    for (const args of [['digest', '--check', plan], ['digest', plan, '--check']]) {
      const r = orch(dir, join(dir, 'orch'), args);
      assert.doesNotMatch(r.stderr, /usage:/);
      assert.equal(r.status, 0, r.out);
      assert.match(r.stdout, /1 row\(s\) · 0 still ⚠ CONFIRM/);
    }
  });
});
