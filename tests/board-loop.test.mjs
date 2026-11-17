/**
 * M9 — the loop runner above a board (REQ-901 to REQ-907, REQ-909 to REQ-915; D44, D48, D52): a stub worker with
 * scripted passes and a stub gate in a scratch repo. No model, no key, no push.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
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

const settingsBlock = (over = {}, accounts = {}, extraFeatures = {}) => ({
  schema: 2,
  commands: { tier: null, tiers: [], affected: null, typecheck: null },
  models: { strong: 's', mid: 'm', orchestrator: null },
  features: {
    bashCap: { state: 'off', limitBytes: 4096 },
    accounts: { state: 'on', accounts: { alpha: { worker: 'claude-code', pays: 'subscription' }, ...accounts } },
    boardLoop: { state: 'experimental-on', promptFile: 'LOOP_PROMPT.md', gate: `${q(process.execPath)} gate.cjs {row}`, maxPasses: 8, passTimeoutMinutes: 1, maxTurnsPerPass: 20, stallMinutes: 1, ...over },
    ...extraFeatures,
  },
});
const profileOf = (block) => `# P\n\n\`\`\`json pipeline-settings\n${JSON.stringify(block, null, 2)}\n\`\`\`\n`;

/** A repo with a board of n rows, the gate, the prompt file and the stub worker scripted. */
function rig({ rows = ['r1', 'r2', 'r3', 'r4', 'r5'], over = {}, script = {}, accounts = {}, extraFeatures = {} } = {}) {
  const { dir, repo } = scratchRepo({ profile: profileOf(settingsBlock(over, accounts, extraFeatures)), files: { 'tasks/demo.md': boardText(rows), 'gate.cjs': readFileSync(GATE, 'utf8'), 'rows.txt': rows.map((r, i) => `T${i + 1} ${r}`).join('\n') + '\n', 'LOOP_PROMPT.md': 'You solve one board row. Write `ok` into the row file named in the row.\n', 'tests/keep.txt': 'test root\n' } });
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

describe('D69 — the gate command in its two extra forms, nothing wider (tests/board-loop, hooks/claude-code/lane-shell-allow.cjs)', () => {
  const allow = require('../hooks/claude-code/lane-shell-allow.cjs');
  const HOOK = join(PACK, 'hooks', 'claude-code', 'lane-shell-allow.cjs');
  const wt = '/work/lanes/demo';
  const gate = './gate-row.sh T1';
  const ok = (cmd) => allow.allowed(cmd, { gate, worktree: wt });
  test('red: the gate as written, with a cd to the own worktree, or piped once to head or tail is accepted', () => {
    assert.equal(ok('./gate-row.sh T1'), true);
    assert.equal(ok(`cd ${wt} && ./gate-row.sh T1`), true);
    assert.equal(ok(`cd ${wt}/ && ./gate-row.sh T1`), true, 'a trailing slash normalises away');
    assert.equal(ok(`cd /work/lanes/./demo && ./gate-row.sh T1`), true, 'a dot segment normalises away');
    assert.equal(ok('./gate-row.sh T1 | tail -n 15'), true);
    assert.equal(ok(`cd ${wt} && ./gate-row.sh T1 | head -n 40`), true);
  });
  test('red: another path, a .., a second command, or a pipe to anything else is refused', () => {
    assert.equal(ok('cd /work/lanes/other && ./gate-row.sh T1'), false, 'another path');
    assert.equal(ok(`cd ${wt}/../demo && ./gate-row.sh T1`), false, '.. is refused even when it resolves to the worktree');
    assert.equal(ok(`cd ${wt} && ./gate-row.sh T1 && git rev-parse HEAD`), false, 'a second command');
    assert.equal(ok(`cd ${wt} && ./gate-row.sh T1; git status`), false, 'a second command after ;');
    assert.equal(ok('./gate-row.sh T1 | grep FAIL'), false, 'a pipe to grep');
    assert.equal(ok('./gate-row.sh T1 | tail -n 5 | head -n 1'), false, 'two pipes');
    assert.equal(ok('./gate-row.sh T1 | tail -n all'), false, 'N must be numeric');
    assert.equal(ok('./gate-row.sh T2'), false, 'another row');
    assert.equal(ok(`cd ${wt} && cat > x.py <<'EOF'\nprint(1)\nEOF`), false, 'a heredoc write');
    assert.equal(ok(`cd ${wt} && ./gate-row.sh T1 2>&1 | tail -n 15`), false, 'a redirection');
  });
  test('red: as a PreToolUse hook: an accepted command answers permissionDecision allow; a refused one answers nothing and exits 0', () => {
    const run = (command) => spawnSync(process.execPath, [HOOK, '--gate', gate, '--worktree', wt, '--marker', 'builder-pipeline-lane-gate'], { input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } }), encoding: 'utf8' });
    const a = run(`cd ${wt} && ./gate-row.sh T1 | tail -n 15`);
    assert.equal(a.status, 0, a.stderr);
    assert.equal(JSON.parse(a.stdout).hookSpecificOutput.permissionDecision, 'allow');
    const d = run('cd /elsewhere && ./gate-row.sh T1');
    assert.equal(d.status, 0);
    assert.equal(d.stdout.trim(), '', 'a refused command gets no decision from the hook: the permission system denies it');
    const other = spawnSync(process.execPath, [HOOK, '--gate', gate, '--worktree', wt], { input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'x' } }), encoding: 'utf8' });
    assert.equal(other.stdout.trim(), '', 'a non-Bash tool is not the hook\'s business');
  });
  test('red: the loop pin carries the PreToolUse entry with the marker, the gate and the worktree', () => {
    const r = rig({ script: solveInOrder(), over: { maxPasses: 1 } });
    assert.equal(r.run().status, 10);
    const pin = JSON.parse(readFileSync(join(r.repo, '.pipeline', 'loop', 'demo.settings.json'), 'utf8'));
    const pre = pin.hooks.PreToolUse;
    assert.ok(Array.isArray(pre) && pre.length === 1 && pre[0].matcher === 'Bash');
    const cmd = pre[0].hooks[0].command;
    assert.match(cmd, /lane-shell-allow\.cjs/);
    assert.match(cmd, /--marker builder-pipeline-lane-gate/);
    assert.ok(cmd.includes('--worktree'), cmd);
  });
});

/* ------------------------------------------------------------------ 2.1.0: the capacity governor (M15) ---- */

describe('REQ-1509, REQ-1516 — the loop runner reads the capacity record and samples the pass RSS', () => {
  const capacityOn = { capacity: { state: 'on', perLaneMb: 1500, intervalSeconds: 1, holdMaxMinutes: 1 } };
  const record = (root, lanes, { ttlSeconds = 600, binding = 'memory' } = {}) => {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'capacity.json'), JSON.stringify({ lanes, plannedMax: 2, binding, caps: {}, reasons: [], at: new Date().toISOString(), ttlSeconds, tick: 1 }));
  };
  const withFeatures = (over) => ({ rows: ['r1'], over: { maxPasses: 3 }, script: solveInOrder(), extraFeatures: over });

  test('red: a record at 0 → no worker is spawned, the run log holds capacity.hold, and after holdMaxMinutes the stop is capacity (AC-1509a)', () => {
    const r = rig(withFeatures(capacityOn));
    const root = join(r.dir, 'orch');
    record(root, 0);
    // the clock: holdMaxMinutes is 1, so the test squeezes the poll to 100 ms and ages the record's hold by writing a
    // state file that says the hold started a minute ago — the runner reads wall time, so we instead cap the wait by a
    // poll that counts: 1 minute of real time is too long for a test, hence the stub poll plus the start-time override
    const out = r.run([], { BUILDER_ORCH_DIR: root, BUILDER_LOOP_STUB_CAPACITY_POLL_MS: '100', BUILDER_LOOP_STUB_HOLD_START_MS: String(Date.now() - 61000) });
    assert.equal(out.status, 10, out.out);
    assert.match(out.out, /^capacity: 0 lanes \(memory\) — holding up to 1 min, reading again every 1 s$/m);
    assert.match(out.out, /^STOP capacity — 0 pass\(es\), 0\/1 rows done · held \d+ read\(s\) at 0 lanes — memory$/m);
    const log = r.log();
    assert.deepEqual(log.filter((e) => e.kind === 'pass'), [], 'no worker ran');
    const holds = log.filter((e) => e.kind === 'capacity.hold');
    assert.equal(holds.length, 1, 'one run-log row per hold');
    assert.equal(holds[0].ended, 'stop');
    assert.equal(holds[0].binding, 'memory');
    assert.equal(r.status('T1'), 'PLANNED');
  });

  test('red: a record that rises to 1 on the second read → the pass runs (AC-1509b)', () => {
    const r = rig(withFeatures(capacityOn));
    const root = join(r.dir, 'orch');
    record(root, 0);
    // a side process raises the record after 400 ms, while the runner holds
    const raiser = spawn(process.execPath, ['-e', `setTimeout(() => { const f = require('node:fs'); const p = ${JSON.stringify(join(root, 'capacity.json'))}; const j = JSON.parse(f.readFileSync(p, 'utf8')); j.lanes = 1; j.at = new Date().toISOString(); f.writeFileSync(p, JSON.stringify(j)); }, 400)`], { stdio: 'ignore', detached: true });
    raiser.unref();
    const out = r.run([], { BUILDER_ORCH_DIR: root, BUILDER_LOOP_STUB_CAPACITY_POLL_MS: '100' });
    assert.equal(out.status, 0, out.out);
    assert.match(out.out, /^capacity: 1 lane\(s\) — the pass runs after \d+ read\(s\)$/m);
    const holds = r.log().filter((e) => e.kind === 'capacity.hold');
    assert.equal(holds.length, 1);
    assert.equal(holds[0].ended, 'pass');
    assert.equal(r.status('T1'), 'DONE');
  });

  test('red: the pass row carries passPeakRssMb from ps (1572864 kB → 1536 MB); win32 → null, unmeasured (AC-1516a, AC-1516b)', () => {
    const r = rig(withFeatures(capacityOn));
    const root = join(r.dir, 'orch');
    record(root, 2);
    const out = r.run([], { BUILDER_ORCH_DIR: root, BUILDER_LOOP_STUB_PS_KB: ' 1572864\n' });
    assert.equal(out.status, 0, out.out);
    const pass = r.log().find((e) => e.kind === 'pass');
    assert.equal(pass.passPeakRssMb, 1536);
    assert.equal(pass.passPeakRssSource, 'ps');
    const w = rig(withFeatures(capacityOn));
    record(join(w.dir, 'orch'), 2);
    const win = w.run([], { BUILDER_ORCH_DIR: join(w.dir, 'orch'), BUILDER_LOOP_STUB_PLATFORM: 'win32', BUILDER_LOOP_STUB_PS_KB: '1572864' });
    assert.equal(win.status, 0, win.out);
    const row = w.log().find((e) => e.kind === 'pass');
    assert.equal(row.passPeakRssMb, null);
    assert.equal(row.passPeakRssSource, 'unmeasured');
    const off = rig({ rows: ['r1'], over: { maxPasses: 3 }, script: solveInOrder() });
    assert.equal(off.run([]).status, 0);
    assert.equal('passPeakRssMb' in off.log().find((e) => e.kind === 'pass'), false, 'with the feature off the field is absent');
  });
});
