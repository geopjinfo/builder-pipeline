/**
 * M9 — the loop runner above a board (REQ-901 to REQ-907, REQ-909 to REQ-915; D44, D48, D52): a stub worker with
 * scripted passes and a stub gate in a scratch repo. No model, no key, no push.
 */
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { FIX, PACK, git, scratchRepo, tmp } from './fixtures/orch/rig.mjs';

const require = createRequire(import.meta.url);
const loop = require('../scripts/lib/board-loop.cjs');
const profile = require('../scripts/lib/profile.cjs');
const STUB = join(PACK, 'tests', 'fixtures', 'loop', 'stub-loop-worker.cjs');
const GATE = join(PACK, 'tests', 'fixtures', 'loop', 'gate.cjs');
const BOARD_LOOP = join(PACK, 'scripts', 'board-loop.mjs');
const q = (s) => JSON.stringify(s);

const boardText = (rows) => `# demo — build board

_Started: 2026-11-17 · Track: LITE · Brief: solve each row · Plan: .pipeline/demo/plan.md · State: .pipeline/demo/state.md_

<!-- phase:status start -->
| Phase | Seat | Status | Artifact | Verdict |
|---|---|---|---|---|
| P2 Code | module-builder | IN-PROGRESS | — | — |
<!-- phase:status end -->

## P2 — Code

| # | Task | Cites | Status | Test-seed / evidence | Notes |
|---|------|-------|--------|----------------------|-------|
${rows.map((r, i) => `| T${i + 1} | solve ${r} | REQ-${i + 1} | PLANNED | ${r}.txt | |`).join('\n')}
`;

const settingsBlock = (over = {}, accounts = {}) => ({
  schema: 2,
  commands: { tier: null, tiers: [], affected: null, typecheck: null },
  models: { strong: 's', mid: 'm', orchestrator: null },
  features: {
    bashCap: { state: 'off', limitBytes: 4096 },
    accounts: { state: 'on', accounts: { alpha: { worker: 'claude-code', pays: 'subscription' }, ...accounts } },
    boardLoop: { state: 'experimental-on', promptFile: 'LOOP_PROMPT.md', gate: `${q(process.execPath)} gate.cjs {row}`, maxPasses: 8, passTimeoutMinutes: 1, maxTurnsPerPass: 20, stallMinutes: 1, ...over },
  },
});
const profileOf = (block) => `# P\n\n\`\`\`json pipeline-settings\n${JSON.stringify(block, null, 2)}\n\`\`\`\n`;

/** A repo with a board of n rows, the gate, the prompt file and the stub worker scripted. */
function rig({ rows = ['r1', 'r2', 'r3', 'r4', 'r5'], over = {}, script = {}, accounts = {} } = {}) {
  const { dir, repo } = scratchRepo({ profile: profileOf(settingsBlock(over, accounts)), files: { 'tasks/demo.md': boardText(rows), 'gate.cjs': readFileSync(GATE, 'utf8'), 'rows.txt': rows.map((r, i) => `T${i + 1} ${r}`).join('\n') + '\n', 'LOOP_PROMPT.md': 'You solve one board row. Write `ok` into the row file named in the row.\n', 'tests/keep.txt': 'test root\n' } });
  const scriptFile = join(dir, 'script.json');
  writeFileSync(scriptFile, JSON.stringify(script));
  const counter = join(dir, 'counter');
  const inputs = join(dir, 'inputs');
  const env = { ...process.env, BUILDER_NO_BASH_CAP: '1', BUILDER_ACCOUNTS_HOME: join(dir, 'home'), BUILDER_LOOP_WORKER_BIN: STUB, BUILDER_LOOP_STUB_SCRIPT: scriptFile, BUILDER_LOOP_STUB_COUNTER: counter, BUILDER_LOOP_STUB_INPUTS: inputs };
  mkdirSync(join(dir, 'home', 'accounts', 'alpha'), { recursive: true });
  const run = (args = [], extra = {}) => {
    const r = spawnSync(process.execPath, [BOARD_LOOP, 'alpha', 'tasks/demo.md', ...args], { cwd: repo, encoding: 'utf8', env: { ...env, ...extra }, timeout: 120000 });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', out: `${r.stdout || ''}${r.stderr || ''}` };
  };
  const board = () => readFileSync(join(repo, 'tasks', 'demo.md'), 'utf8');
  const status = (row) => (new RegExp(`^\\| ${row} \\|[^|]*\\|[^|]*\\| ([^|]+) \\|`, 'm').exec(board()) || [, ''])[1].trim();
  const log = () => (existsSync(join(repo, '.pipeline', 'loop', 'demo.jsonl')) ? readFileSync(join(repo, '.pipeline', 'loop', 'demo.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  const commits = () => git(repo, 'log', '--format=%H %s').split('\n').filter(Boolean);
  return { dir, repo, env, run, board, status, log, commits, inputs, settings: () => profile.load(repo).settings };
}
/** A pass that writes `ok` into the row's file: the row passes its gate. */
const solves = (row) => ({ writes: [{ path: `${row}.txt`, text: 'ok\n' }] });
const ROWFILE = ['r1', 'r2', 'r3', 'r4', 'r5'];
const solveInOrder = () => ({ passes: ROWFILE.map(solves) });

describe('REQ-901 — the flag', () => {
  test('red: off → the not-configured line, exit 0; on without maxPasses → invalid naming maxPasses', () => {
    const r = rig({ over: { state: 'experimental-off' } });
    const off = r.run();
    assert.equal(off.status, 0, off.out);
    assert.match(off.stdout, /^boardLoop: experimental(-off)? — not enabled|^boardLoop: not configured/m);
    const { maxPasses, ...noCap } = settingsBlock().features.boardLoop;
    const parsed = profile.parse(profileOf({ ...settingsBlock(), features: { ...settingsBlock().features, boardLoop: noCap } }));
    assert.ok(parsed.errors.some((e) => /features\.boardLoop\.maxPasses/.test(e)), parsed.errors.join('\n'));
    const f = profile.feature(profile.parse(profileOf(settingsBlock())).settings, 'boardLoop');
    assert.deepEqual([f.config.passTimeoutMinutes, f.config.maxTurnsPerPass, f.config.stallMinutes, f.config.maxRetriesPerRow, f.config.maxConsecutiveFailures, f.config.maxConsecutiveNoProgress], [1, 20, 1, 2, 3, 3]);
  });
});

describe('REQ-904, REQ-905, REQ-907, REQ-915 — passes, commits, the run log', () => {
  test('red: 5 rows, one passing per pass, maxPasses 8 → stops at pass 5 with all-pass, one commit per pass with the trailers, never pushes', () => {
    const r = rig({ script: solveInOrder() });
    const origin = join(r.dir, 'origin.git');
    git(r.dir, 'init', '-q', '--bare', origin);
    git(r.repo, 'remote', 'add', 'origin', origin);
    const res = r.run();
    assert.equal(res.status, 0, res.out);
    assert.match(res.stdout, /^STOP all-pass — 5 pass\(es\), 5\/5 rows done/m);
    for (let i = 1; i <= 5; i++) assert.equal(r.status(`T${i}`), 'DONE');
    const c = r.commits();
    assert.equal(c.length, 6, c.join('\n')); // the base commit + one per pass
    const msg = git(r.repo, 'log', '-1', '--format=%B');
    assert.match(msg, /^Builder-Account: alpha$/m);
    assert.match(msg, /^Builder-Requirement: REQ-5$/m);
    assert.equal((msg.match(/^Builder-/gm) || []).length, 2, 'no other kit trailer');
    assert.ok(!/prompt|transcript|sk-/i.test(msg));
    assert.equal(git(r.dir, '-C', origin, 'rev-list', '--all', '--count'), '0', 'nothing was pushed');
    const rows = r.log().filter((e) => e.kind === 'pass');
    assert.equal(rows.length, 5);
    for (const k of ['pass', 'row', 'rowsPassing', 'retries', 'gateDigest', 'turns', 'cost', 'stopReason']) assert.ok(k in rows[4], `run-log row has ${k}`);
    assert.equal(rows[4].stopReason, 'all-pass');
    assert.equal(rows[4].rowsPassing, 5);
    assert.equal(rows[0].turns, 2);
  });
  test('red: maxPasses 3 → 2 rows open, reason max-passes, exit 10', () => {
    const r = rig({ over: { maxPasses: 3 }, script: solveInOrder() });
    const res = r.run();
    assert.equal(res.status, 10, res.out);
    assert.match(res.stdout, /^STOP max-passes — 3 pass\(es\), 3\/5 rows done/m);
    assert.equal(r.status('T4'), 'PLANNED');
  });
  test('red: a failing pass leaves no commit, a snapshot ref exists and the tree is clean; a verdict of PASS with gate exit 1 is a failed pass', () => {
    const r = rig({ over: { maxPasses: 2 }, script: { passes: [{ writes: [{ path: 'r1.txt', text: 'wrong\n' }], verdict: 'PASS' }, solves('r1')] } });
    const res = r.run();
    assert.equal(res.status, 10, res.out);
    const rows = r.log().filter((e) => e.kind === 'pass');
    assert.equal(rows[0].passed, false);
    assert.match(rows[0].why, /gate exit 1/);
    assert.equal(rows[1].passed, true);
    assert.equal(r.commits().length, 2, 'the failing pass left no commit; the passing one did');
    assert.ok(git(r.repo, 'for-each-ref', 'refs/orch/snapshots/').split('\n').some((l) => /-wip$/.test(l)), 'the failing pass is pinned to a snapshot ref');
    assert.equal(git(r.repo, 'status', '--porcelain'), '', 'the tree is clean');
  });
});

describe('REQ-903 — the memory between passes', () => {
  test('red: 20 KB of gate output reaches the next pass as a digest under bashCap.limitBytes, with the progress note and the prompt file only', () => {
    const r = rig({ over: { maxPasses: 2 }, script: { passes: [{ writes: [{ path: 'r1.txt', text: 'wrong\n' }] }, solves('r1')] } });
    const res = r.run([], { GATE_PAD: '20000' });
    assert.equal(res.status, 10, res.out);
    const input = readFileSync(join(r.inputs, 'pass-2.txt'), 'utf8');
    assert.ok(input.includes('You solve one board row.'), 'the prompt file');
    assert.match(input, /## Progress note\n.*pass 1.*T1/i);
    assert.match(input, /## Previous gate output/);
    assert.ok(Buffer.byteLength(input) < 4096 + 2000, `the input is ${Buffer.byteLength(input)} bytes`);
    assert.ok(!input.includes('.'.repeat(5000)), 'the raw 20 KB never reaches the worker');
  });
});

describe('REQ-906, REQ-912, REQ-913 — scope and bypass', () => {
  test('red: a worker that writes to the gate script → FAILED-SCOPE and the loop stops with reason scope', () => {
    const r = rig({ script: { passes: [{ writes: [{ path: 'gate.cjs', text: 'process.exit(0)\n' }, { path: 'r1.txt', text: 'ok\n' }] }] } });
    const res = r.run();
    assert.equal(res.status, 10, res.out);
    assert.match(res.stdout, /^STOP scope — /m);
    assert.match(res.stdout, /FAILED-SCOPE.*gate\.cjs/);
    assert.equal(readFileSync(join(r.repo, 'gate.cjs'), 'utf8'), readFileSync(GATE, 'utf8'), 'the gate script is restored');
    assert.equal(r.commits().length, 1);
  });
  test('red: a worker that marks a second row done → FAILED-SCOPE; writes under a test root are denied too', () => {
    const r = rig({ script: { passes: [{ ...solves('r1'), boardEdit: { row: 'T2', status: 'DONE' } }] } });
    const res = r.run();
    assert.match(res.stdout, /FAILED-SCOPE.*T2/);
    assert.equal(r.status('T2'), 'PLANNED');
    const t = rig({ script: { passes: [{ writes: [{ path: 'r1.txt', text: 'ok\n' }, { path: 'tests/new.test.mjs', text: 'x' }] }] } });
    assert.match(t.run().stdout, /FAILED-SCOPE.*tests\/new\.test\.mjs/);
  });
  test('red: a bypass flag in the account command or the prompt file refuses the loop naming the flag', () => {
    const r = rig({ accounts: { alpha: { worker: 'claude-code', pays: 'subscription', command: 'claude --dangerously-skip-permissions {brief}' } } });
    const res = r.run();
    assert.notEqual(res.status, 0);
    assert.match(res.out, /--dangerously-skip-permissions/);
    assert.equal(existsSync(join(r.repo, '.pipeline', 'loop', 'demo.jsonl')), false, 'no pass ran');
    const p = rig();
    writeFileSync(join(p.repo, 'LOOP_PROMPT.md'), 'run with --dangerously-bypass-approvals-and-sandbox\n');
    assert.match(p.run().out, /--dangerously-bypass-approvals-and-sandbox/);
  });
});

describe('REQ-910, REQ-911, REQ-914 — the stop rules', () => {
  test('red: the same diff three times → STOP no-progress after pass 3', () => {
    const r = rig({ script: { default: { writes: [{ path: 'r1.txt', text: 'wrong\n' }] } } });
    const res = r.run();
    assert.equal(res.status, 10, res.out);
    assert.match(res.stdout, /^STOP no-progress — 3 pass\(es\)/m);
  });
  test('red: a row failing maxRetriesPerRow times is marked blocked and the loop moves on; all open rows blocked → rows-blocked', () => {
    const r = rig({ rows: ['r1', 'r2'], script: { passes: [{ writes: [{ path: 'r1.txt', text: 'wrong a\n' }] }, { writes: [{ path: 'r1.txt', text: 'wrong b\n' }] }, solves('r2')] } });
    const res = r.run();
    assert.equal(res.status, 10, res.out);
    assert.match(r.status('T1'), /^BLOCKED/);
    assert.equal(r.status('T2'), 'DONE');
    assert.match(res.stdout, /^STOP rows-blocked — 3 pass\(es\), 1\/2 rows done/m);
  });
  test('red: three different failing passes → STOP consecutive-failures, and the run-log row carries it', () => {
    const r = rig({ rows: ['r1', 'r2', 'r3', 'r4'], over: { maxRetriesPerRow: 9 }, script: { passes: [{ writes: [{ path: 'r1.txt', text: 'a\n' }] }, { writes: [{ path: 'r1.txt', text: 'b\n' }] }, { writes: [{ path: 'r1.txt', text: 'c\n' }] }] } });
    const res = r.run();
    assert.match(res.stdout, /^STOP consecutive-failures — 3 pass\(es\)/m);
    assert.equal(r.log().filter((e) => e.kind === 'pass').at(-1).stopReason, 'consecutive-failures');
  });
  test('red: a stopped loop restarted with --more-passes 5 raises the cap once for that run and logs the grant', () => {
    const r = rig({ over: { maxPasses: 2 }, script: solveInOrder() });
    assert.equal(r.run().status, 10);
    const again = r.run(['--more-passes', '5']);
    assert.equal(again.status, 0, again.out);
    assert.match(again.stdout, /^STOP all-pass — 5 pass\(es\)/m);
    assert.ok(r.log().some((e) => e.kind === 'more-passes' && e.added === 5));
    const third = r.run(['--more-passes', '5']);
    assert.match(third.out, /already extended|once/);
  });
});

describe('REQ-909 — the measurement row', () => {
  test('red: a finished run appends one dated row to EXPERIMENTS §17 and leaves the flag alone', () => {
    const dir = tmp('exp');
    const file = join(dir, 'EXPERIMENTS.md');
    writeFileSync(file, '# E\n\n## 17. Board loop — `boardLoop` (planned, experimental)\n\n**Measurement.** text.\n\n| Date | Commit | Passes | Pass rate | Cost | Turns | Timeouts | Silent failures |\n|---|---|---|---|---|---|---|---|\n\n**Decision (2026-11-17).** not yet measured — no measurement.\n\n## 18. Next\n');
    const row = loop.experimentRow({ date: '2026-11-17', commit: 'abc1234', passes: 5, rowsDone: 5, rowsTotal: 5, costUsd: null, turns: 10, timeouts: 0, silentFailures: 0, note: 'stub dry run' });
    loop.recordExperiment(file, row);
    const text = readFileSync(file, 'utf8');
    assert.match(text, /^\| 2026-11-17 \| abc1234 \| 5 \| 100% \(5\/5\) \| unmeasured \| 10 \| 0 \| 0 \| stub dry run \|$/m);
    assert.ok(text.indexOf('| 2026-11-17 |') < text.indexOf('## 18.'));
    assert.throws(() => loop.recordExperiment(join(dir, 'none.md'), row), /no §17/);
  });
});
