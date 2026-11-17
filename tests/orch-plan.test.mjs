/**
 * Batch orchestrator — plan split (scripts/lib/orch-plan.cjs): risk → level → track → dispatch per row, disjoint
 * lanes, dependency order, hot files queued. Every guard has a red case.
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { FIX, PATHS, orch, profileText, tmp } from './fixtures/orch/rig.mjs';

const require = createRequire(import.meta.url);
const plan = require('../scripts/lib/orch-plan.cjs');
const state = require('../scripts/lib/orch-state.cjs');

const SAMPLE = readFileSync(join(FIX, 'sample-plan.md'), 'utf8');

describe('plan split on the sample plan', () => {
  const res = plan.split(SAMPLE, PATHS);
  const by = Object.fromEntries(res.rows.map((r) => [r.id, r]));
  const lane = (n) => res.lanes.find((l) => l.name === n);

  test('lanes share no owned file', () => {
    assert.equal(res.rows.length, 10);
    assert.deepEqual(plan.laneOverlaps(res.lanes), []);
  });

  test('hot files are queued, never joining lanes', () => {
    for (const h of ['CHANGELOG.md', 'contracts/openapi.json', 'db/migrations/**', 'config/permissions.csv']) assert.ok(res.hotFilesQueued.includes(h), h);
    assert.notEqual(by.R1.lane, by.R5.lane); // both touch CHANGELOG.md — hot, so not joined
    for (const l of res.lanes) for (const f of l.ownedFiles) assert.equal(plan.isHot(f, PATHS.hot), false, f);
  });

  test('dependent rows run in one lane, in order', () => {
    assert.equal(by.R2.lane, by.R1.lane);
    assert.deepEqual(lane(by.R1.lane).rows, ['R1', 'R2']);
    assert.deepEqual(lane(by.R3.lane).rows, ['R3', 'R4']);
  });

  test('every row gets a risk, a level, a track, a dispatch and a reason by rule', () => {
    for (const r of res.rows) assert.ok(r.risk && r.level && r.track && r.dispatch && /\S/.test(r.reason), r.id);
    assert.deepEqual([by.R1.risk, by.R1.riskReason, by.R1.level, by.R1.reason], ['high', 'high: money', 'Full', 'Full: money']);
    assert.match(by.R3.reason, /migration \(from files\)/);
    assert.deepEqual([by.R8.level, by.R8.reason], ['Full', 'Full: permission (from files)']);
    assert.deepEqual([by.R10.level, by.R10.reason], ['Full', 'Full: cross-module (from files)']);
    assert.deepEqual([by.R6.risk, by.R6.level, by.R6.track, by.R6.dispatch], ['low', 'Micro', 'SOLO', 'solo']);
    assert.deepEqual([by.R7.risk, by.R7.level, by.R7.track], ['medium', 'Standard', 'ADDITIVE']); // record-only but touches production source
    assert.deepEqual([by.R9.level, by.R9.track], ['Standard', 'FIX']);
    assert.match(by.R9.reason, /Small ignored/);
    for (const r of res.rows) assert.equal({ Full: 'high', Standard: 'medium', Micro: 'low' }[r.level], r.risk);
    assert.equal(plan.levelFor({ id: 'P', kind: 'build', files: ['src/platform/x.ts'], flags: [], levelHint: '' }, PATHS).track, 'PLATFORM');
  });

  test('dispatch: Full rows run the full pipeline; Standard rows the configured one; SOLO a single agent', () => {
    assert.equal(by.R1.dispatch, 'full');
    assert.equal(by.R5.dispatch, 'full');
    const lite = plan.split(SAMPLE, { ...PATHS, standardPipeline: 'lite' });
    const l = Object.fromEntries(lite.rows.map((r) => [r.id, r]));
    assert.deepEqual([l.R1.dispatch, l.R5.dispatch, l.R6.dispatch], ['full', 'lite', 'solo']);
    const laneR1 = lite.lanes.find((x) => x.rows.includes('R1'));
    assert.equal(laneR1.dispatch, 'full'); // a lane runs at its strongest row's dispatch
  });

  test('red: without the project path rules nothing is inferred from files — the rules are the project\'s, not the pack\'s', () => {
    const bare = plan.split(SAMPLE);
    const b = Object.fromEntries(bare.rows.map((r) => [r.id, r]));
    assert.equal(b.R8.level, 'Standard');
    assert.equal(b.R10.level, 'Standard');
  });
});

describe('plan split refusals', () => {
  test('red: lanes sharing an owned file are caught; a dependency cycle is refused', () => {
    assert.equal(plan.laneOverlaps([{ name: 'a', ownedFiles: ['src/modules/x/**'] }, { name: 'b', ownedFiles: ['src/modules/x/y.ts'] }]).length, 1);
    const cyc = SAMPLE.replace('| src/modules/payments/**; CHANGELOG.md; contracts/openapi.json | - |', '| src/modules/payments/**; CHANGELOG.md; contracts/openapi.json | R2 |');
    assert.throws(() => plan.split(cyc, PATHS), /dependency cycle/);
  });

  test('red: a level hint never lowers a level, and never changes the risk', () => {
    assert.equal(plan.levelFor({ id: 'L', kind: 'fix', files: ['src/a.ts'], flags: [], levelHint: 'micro' }).level, 'Standard');
    const r = plan.levelFor({ id: 'X', kind: 'build', files: ['src/modules/a/x.ts'], flags: ['money'], levelHint: 'micro' }, PATHS);
    assert.deepEqual([r.risk, r.level, r.track], ['high', 'Full', 'FULL']);
    assert.match(r.reason, /hint Micro ignored: a level is never lowered/);
    const up = plan.levelFor({ id: 'Y', kind: 'record', files: ['tasks/a.md'], flags: ['record-only'], levelHint: 'standard' }, PATHS);
    assert.deepEqual([up.risk, up.level], ['low', 'Standard']);
  });

  test('red: a row with no files, an unknown flag or kind, or a dangling dependency is refused', () => {
    const row = (cells) => `## Rows\n| id | title | kind | files | depends-on | flags |\n|---|---|---|---|---|---|\n| ${cells} |\n`;
    assert.throws(() => plan.split(row('A | t | build | - | - | -')), /no files listed/);
    assert.throws(() => plan.split(row('A | t | build | a.ts | - | shiny')), /unknown flag/);
    assert.throws(() => plan.split(row('A | t | deploy | a.ts | - | -')), /kind "deploy"/);
    assert.throws(() => plan.split(row('A | t | build | a.ts | B | -')), /depends-on B, which is not a row/);
  });
});

describe('risk reaches the run state and the status page', () => {
  test('state.init keeps each row\'s risk; `orch status --split` prints it', () => {
    const res = plan.split(SAMPLE, PATHS);
    const dir = tmp('risk');
    const root = join(dir, 'orch');
    state.init(root, 'rk1', res, { target: 'dev' });
    assert.equal(state.load(root, 'rk1').rows.find((r) => r.id === 'R1').riskReason, 'high: money');
    writeFileSync(join(dir, 'PIPELINE_PROFILE.md'), profileText());
    const st = orch(dir, root, ['status', 'rk1', '--split']);
    assert.equal(st.status, 0, st.out);
    assert.match(st.stdout, /row \| lane \| risk \| level\/track \| dispatch \| reason/);
    assert.match(st.stdout, /R1 \| l\d+ \| high \(high: money\) \| Full\/FULL \| full \| Full: money/);
  });
});

describe('the worker brief carries the account the lane is placed on (REQ-502)', () => {
  const TEMPLATE = readFileSync(join(FIX, '..', '..', '..', 'templates', 'orchestrator-worker-brief.md'), 'utf8');

  test('red: REQ-502 renderBrief fills the Account: line, the lane facts and the rows; unknown placeholders stay for the orchestrator (AC-502a)', () => {
    const res = plan.split(SAMPLE, PATHS);
    const lane = { ...res.lanes[0], worktree: '/w/wt-l1', branch: 'orch/l1', result: '/r/l1.md', brief: '/b/l1.md' };
    const text = plan.renderBrief(TEMPLATE, { run: 'ar', lane, rows: res.rows, target: 'dev', account: { name: 'alpha', worker: 'claude-code', pays: 'subscription' } });
    assert.match(text, /^# Brief — ar\/l1 {2}\(Full\/FULL · dispatch full\)$/m);
    assert.match(text, /^- Account: alpha \(worker claude-code, pays subscription\)/m);
    assert.match(text, /^\| R1 \| Payments: refund verb \| Full\/FULL \| Full: money \|$/m);
    assert.match(text, /- Owned \(claimed for you; edit freely\): src\/modules\/payments\/\*\*, src\/modules\/payments\/reports\/refunds\.ts$/m);
    assert.match(text, /- Hot \(shared; .*\): CHANGELOG\.md, contracts\/openapi\.json$/m);
    assert.match(text, /- Worktree: \/w\/wt-l1 {3}Branch: orch\/l1 \(cut from dev\)$/m);
    assert.match(text, /^## Result — write it to \/r\/l1\.md$/m);
    assert.ok(!text.includes('```markdown'), 'the fence around the template body is not part of the brief');
    assert.ok(!text.includes('<account>') && !text.includes('<ownedFiles>') && !text.includes('<run>'), 'a filled placeholder stays');
    assert.ok(text.includes('<the exact command(s) and expected digest'), 'the done-test stays for the orchestrator to fill');
    const noAccount = plan.renderBrief(TEMPLATE, { run: 'ar', lane, rows: res.rows, target: 'dev', account: null });
    assert.match(noAccount, /^- Account: <account>/m, 'with no placement the Account: line stays a placeholder, never an empty account');
  });

  test('red: REQ-502 `orch brief <run> <lane>` prints the brief with the placed account; --write writes it once at the lane brief path', () => {
    const dir = tmp('brief');
    const root = join(dir, 'orch');
    const plan1 = { worker: 'claude-code', pays: 'subscription', content: 'any', roles: [], budget: { kind: 'percent', soft: null, hard: 85 }, maxTurns: 40, timeoutMinutes: 90, command: 'go {brief}' };
    writeFileSync(join(dir, 'PIPELINE_PROFILE.md'), profileText({ orchestrator: { launchCommand: 'go {brief}' }, accounts: { bravo: plan1 } }));
    const lanesFile = join(dir, 'lanes.json');
    writeFileSync(lanesFile, JSON.stringify(plan.split(SAMPLE, PATHS)));
    const init = orch(dir, root, ['init', 'br', '--lanes', lanesFile, '--mode', 'parallel', '--repo', dir]);
    assert.equal(init.status, 0, init.out);
    state.approve(root, 'br', 'lead');
    state.recordUsage(root, 'br', 'primary', 70); // the session account is full: placement goes to bravo
    state.recordUsage(root, 'br', 'bravo', 20);
    const r = orch(dir, root, ['brief', 'br', 'l1']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /^- Account: bravo \(worker claude-code, pays subscription\)/m);
    assert.match(r.stdout, /^# Brief — br\/l1 /m);
    const w = orch(dir, root, ['brief', 'br', 'l1', '--write']);
    assert.equal(w.status, 0, w.out);
    const briefPath = state.load(root, 'br').lanes.l1.brief;
    assert.match(readFileSync(briefPath, 'utf8'), /^- Account: bravo /m);
    const again = orch(dir, root, ['brief', 'br', 'l1', '--write']);
    assert.equal(again.status, 3, 'a second --write never overwrites the brief the orchestrator may have edited');
    assert.match(again.out, /exists/);
  });
});
