/**
 * M12 — remote lanes (REQ-1201 to REQ-1211): a stub `ssh` on PATH records argv and plays scripted exits. No network.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { FIX, PACK, git, profileText, scratchRepo, tmp } from './fixtures/orch/rig.mjs';

const require = createRequire(import.meta.url);
const remote = require('../scripts/lib/orch-remote.cjs');
const state = require('../scripts/lib/orch-state.cjs');
const profile = require('../scripts/lib/profile.cjs');
const STUB_SSH = join(FIX, 'stub-ssh.cjs');
const ORCH = join(PACK, 'scripts', 'orch.mjs');


const SPLIT = { lanes: [{ name: 'l1', rows: ['R1'], level: 'L1', track: 'LITE', ownedFiles: ['a.txt'], hotFiles: [] }], rows: [], maxLanes: 2 };
const MACHINE = { host: 'box.local', user: 'dev', remoteRoot: '/srv/work/proj' };

/** A run with one lane, a bare origin the repo pushes `dev` to, and the stub ssh scripted. */
function rig(script = [], { remoteLanes = { state: 'experimental-on' } } = {}) {
  const { dir, repo } = scratchRepo({ profile: profileText({ extraFeatures: { remoteLanes } }) });
  const origin = join(dir, 'origin.git');
  git(dir, 'init', '-q', '--bare', origin);
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', '-u', 'origin', 'dev');
  const root = join(dir, 'orch');
  state.init(root, 'r1', SPLIT, { repo, target: 'dev', worktreeBase: join(dir, 'wt') });
  const scriptFile = join(dir, 'ssh-script.json');
  writeFileSync(scriptFile, JSON.stringify(script));
  const log = join(dir, 'ssh.jsonl');
  const env = { ...process.env, BUILDER_SSH_BIN: STUB_SSH, BUILDER_SSH_SCRIPT: scriptFile, BUILDER_SSH_LOG: log }; // the stub on every platform (no .cmd shim: the remote command carries newlines)
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l).argv) : []);
  const events = () => readFileSync(join(root, 'runs', 'r1', 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const settings = profile.load(repo).settings;
  return { dir, repo, origin, root, env, calls, events, settings, lane: () => state.load(root, 'r1').lanes.l1, machine: () => state.load(root, 'r1').machines.m1 };
}
const PREFLIGHT_OK = { match: 'claude auth status', code: 0, stdout: '__AUTH=0\n__VER=0\n__GIT=0\n__ROOT=0\n' };

describe('REQ-1202 — the transport', () => {
  test('red: ssh is spawned with -T, BatchMode, ConnectTimeout, ServerAliveInterval, user@host and the command', () => {
    assert.deepEqual(remote.sshBin({}), ['ssh', []]);
    assert.throws(() => remote.sshBin({ BUILDER_SSH_BIN: 'relative.cjs' }), /absolute/);
    const r = rig();
    const res = remote.ssh({ ...MACHINE }, 'true', { env: r.env });
    assert.equal(res.code, 0);
    assert.deepEqual(r.calls()[0], ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', 'dev@box.local', 'true']);
  });
  test('red: exit 255 is sshFailed and becomes a remote_unknown event, never a lane verdict; exit 1 is the remote command\'s', () => {
    const r = rig([{ match: '^true$', code: 255, stderr: 'ssh: connect to host box.local: Connection refused\n' }, { match: 'kill -0', code: 1 }]);
    remote.addMachine(r.root, 'r1', 'm1', MACHINE);
    const res = remote.ssh({ ...MACHINE }, 'true', { env: r.env });
    assert.equal(res.sshFailed, true);
    assert.equal(remote.ssh({ ...MACHINE }, 'kill -0 7', { env: r.env }).code, 1);
  });
});

describe('REQ-1201 — the flag and the machine row', () => {
  test('red: flag off: a plan machine prints "remoteLanes: not configured" and the lane stays local', () => {
    const r = rig([], { remoteLanes: { state: 'experimental-off' } });
    const p = remote.place(r.root, 'r1', 'l1', 'm1', { settings: r.settings });
    assert.equal(p.placed, 'local');
    assert.match(p.line, /^remoteLanes: not configured$/m);
    assert.equal(r.lane().machine, undefined);
  });
  test('red: flag on: an unknown machine is refused naming the row; a known ready machine is placed', () => {
    const r = rig([PREFLIGHT_OK]);
    assert.throws(() => remote.place(r.root, 'r1', 'l1', 'ghost', { settings: r.settings }), /machines\.ghost/);
    remote.addMachine(r.root, 'r1', 'm1', MACHINE);
    const m = r.machine();
    assert.deepEqual(Object.keys(m).sort(), ['host', 'lastSeen', 'preflight', 'remoteRoot', 'status', 'user']);
    assert.throws(() => remote.place(r.root, 'r1', 'l1', 'm1', { settings: r.settings }), /not ready|unknown/);
    remote.preflight(r.root, 'r1', 'm1', { env: r.env });
    assert.equal(r.machine().status, 'ready');
    assert.equal(remote.place(r.root, 'r1', 'l1', 'm1', { settings: r.settings }).placed, 'm1');
    assert.equal(r.lane().machine, 'm1');
  });
});

describe('REQ-1203 and REQ-1204 — preflight', () => {
  test('red: one ssh call runs claude auth status, claude --version, git --version and tests remoteRoot/.git; a failing login is machine_unauthenticated', () => {
    const r = rig([{ match: 'claude auth status', code: 0, stdout: '__AUTH=1\n__VER=0\n__GIT=0\n__ROOT=0\n' }]);
    remote.addMachine(r.root, 'r1', 'm1', MACHINE);
    const pf = remote.preflight(r.root, 'r1', 'm1', { env: r.env });
    assert.equal(pf.status, 'machine_unauthenticated');
    const cmd = r.calls().find((a) => /claude auth status/.test(a[a.length - 1]))[8];
    for (const part of ['claude auth status', 'claude --version', 'git --version', '/srv/work/proj/.git']) assert.ok(cmd.includes(part), part);
    assert.equal(r.calls().filter((a) => /claude auth status/.test(a[a.length - 1])).length, 1);
    assert.throws(() => remote.place(r.root, 'r1', 'l1', 'm1', { settings: r.settings }), /machine_unauthenticated/);
  });
  test('red: a failing check names itself; the `true` result is stored on the row; 255 is remote_unknown', () => {
    const r = rig([{ match: 'claude auth status', code: 0, stdout: '__AUTH=0\n__VER=0\n__GIT=127\n__ROOT=0\n' }]);
    remote.addMachine(r.root, 'r1', 'm1', MACHINE);
    const pf = remote.preflight(r.root, 'r1', 'm1', { env: r.env });
    assert.equal(pf.status, 'not_ready');
    assert.match(pf.reason, /git --version/);
    assert.equal(r.machine().preflight.true, 0);
    const d = rig([{ match: '.*', code: 255 }]);
    remote.addMachine(d.root, 'r1', 'm1', MACHINE);
    assert.equal(remote.preflight(d.root, 'r1', 'm1', { env: d.env }).status, 'remote_unknown');
    assert.ok(d.events().some((e) => e.type === 'remote_unknown'));
  });
  test('red: a remoteRoot on a mount path is refused naming the path', () => {
    const r = rig();
    remote.addMachine(r.root, 'r1', 'm1', { ...MACHINE, remoteRoot: '/mnt/nas/proj' });
    assert.throws(() => remote.preflight(r.root, 'r1', 'm1', { env: r.env }), /\/mnt\/nas\/proj/);
    assert.ok(remote.mountPathFault('//server/share/x'));
    assert.equal(remote.mountPathFault('/home/dev/work'), null);
  });
});

function launched(script = [], opts = {}) {
  const r = rig([PREFLIGHT_OK, ...script]);
  remote.addMachine(r.root, 'r1', 'm1', MACHINE);
  remote.preflight(r.root, 'r1', 'm1', { env: r.env });
  remote.place(r.root, 'r1', 'l1', 'm1', { settings: r.settings });
  state.setLane(r.root, 'r1', 'l1', { status: 'CLAIMED' });
  const pin = join(r.dir, 'pin.json');
  writeFileSync(pin, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node .claude/hooks/lane-gate.cjs --gate "npm test" --marker builder-pipeline-lane-gate' }] }] } }));
  mkdirSync(join(r.root, 'runs', 'r1', 'briefs'), { recursive: true });
  writeFileSync(join(r.root, 'runs', 'r1', 'briefs', 'l1.md'), 'Build row R1.\n');
  const res = remote.launch(r.root, 'r1', 'l1', { env: r.env, settingsFile: pin, base: 'dev', maxTurns: 20, model: 'm', ...opts });
  return { r, res, pin };
}

describe('REQ-1205, REQ-1208, REQ-1209 — the launch', () => {
  test('red: one ssh call holds the fetch, the worktree add on a fresh branch, the nohup launch and CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1', () => {
    const { r, res } = launched([{ match: 'git fetch origin', code: 0, stdout: 'PID=4242\n' }]);
    assert.equal(res.ok, true, res.reason);
    const launches = r.calls().filter((a) => /git fetch origin/.test(a[a.length - 1]));
    assert.equal(launches.length, 1);
    const cmd = launches[0][8];
    for (const part of ['git fetch origin', 'git worktree add', '-b orch/r1-l1 origin/dev', 'setsid nohup', 'claude -p', '--output-format json', '.lane/out.json', '.lane/pid', 'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1', '--settings', '--max-turns 20']) assert.ok(cmd.includes(part), part);
    assert.ok(/git push -u origin orch\/r1-l1/.test(cmd) && /\.lane\/head/.test(cmd), 'the exit tail commits, pushes and writes .lane/head');
    assert.ok(/rm -f .*\.lane\/settings\.json/.test(cmd), 'the pin is removed after');
    for (const bad of ['~/.claude', 'scp ', 'rsync', '.env', 'id_rsa', 'id_ed25519', '/key', 'credentials']) assert.ok(!cmd.includes(bad), `${bad} must not be copied`);
    assert.equal(r.lane().status, 'LAUNCHED');
    assert.equal(r.lane().remotePid, 4242);
  });
  test('red: a hook the pin needs that the remote lacks refuses the launch and the event names the hook', () => {
    const { r, res } = launched([{ match: 'git fetch origin', code: 3, stdout: 'MISSING_HOOK .claude/hooks/lane-gate.cjs\n' }]);
    assert.equal(res.ok, false);
    assert.match(res.reason, /lane-gate\.cjs/);
    assert.equal(r.lane().status, 'CLAIMED');
    assert.ok(r.events().some((e) => e.type === 'remote.launch.refused' && /lane-gate\.cjs/.test(e.hook)));
  });
  test('a 255 on launch is remote_unknown, the lane stays CLAIMED', () => {
    const { r, res } = launched([{ match: 'git fetch origin', code: 255 }]);
    assert.equal(res.ok, false);
    assert.equal(res.state, 'remote_unknown');
    assert.equal(r.lane().status, 'CLAIMED');
  });
});

const POLL = (alive, { out = 1000, err = 1000, remoteNow = 1000, head = '' } = {}) => ({ match: 'kill -0', code: 0, stdout: `${alive ? 'ALIVE' : 'EXITED'}\nOUT=${out}\nERR=${err}\nNOW=${remoteNow}\nHEAD=${head}\n` });

describe('REQ-1206 and REQ-1210 — polling, stall, cancel, clocks', () => {
  test('red: a live pid with mtimes older than the idle threshold is FAILED-STALL; the heartbeat is the orchestrator\'s clock, the remote time is remoteTs', () => {
    const { r } = launched([{ match: 'git fetch origin', stdout: 'PID=4242\n' }, POLL(true, { out: 1000, err: 1000, remoteNow: 1000 + 91 * 60 })]);
    const now = Date.parse('2026-11-17T10:00:00Z');
    const p = remote.poll(r.root, 'r1', 'l1', { env: r.env, now });
    assert.equal(p.state, 'FAILED-STALL');
    assert.equal(r.lane().status, 'FAILED');
    assert.equal(r.lane().heartbeat, new Date(now).toISOString());
    const ev = r.events().filter((e) => e.type === 'remote.poll');
    assert.equal(ev.length, 1);
    assert.equal(ev[0].remoteTs.now, 1000 + 91 * 60);
    assert.ok(Number.isInteger(ev[0].seq));
  });
  test('red: a 255 while polling is remote_unknown and the lane is not FAILED; exit 1 records the remote exit code', () => {
    const { r } = launched([{ match: 'git fetch origin', stdout: 'PID=4242\n' }, { match: 'kill -0', code: 255 }]);
    const p = remote.poll(r.root, 'r1', 'l1', { env: r.env });
    assert.equal(p.state, 'remote_unknown');
    assert.equal(r.lane().status, 'LAUNCHED');
    const o = launched([{ match: 'git fetch origin', stdout: 'PID=4242\n' }, { match: 'kill -0', code: 1, stdout: 'EXITED\n' }]);
    const q = remote.poll(o.r.root, 'r1', 'l1', { env: o.r.env });
    assert.equal(q.exitCode, 1);
  });
  test('red: cancel kills the process group and the lane is cancelling until a poll confirms exit', () => {
    const { r } = launched([{ match: 'git fetch origin', stdout: 'PID=4242\n' }]);
    const c = remote.cancel(r.root, 'r1', 'l1', { env: r.env });
    assert.equal(c.state, 'cancelling');
    assert.ok(r.calls().some((a) => /kill -- -4242/.test(a[a.length - 1])));
    writeFileSync(r.env.BUILDER_SSH_SCRIPT, JSON.stringify([POLL(true)]));
    assert.equal(remote.poll(r.root, 'r1', 'l1', { env: r.env }).state, 'cancelling');
    writeFileSync(r.env.BUILDER_SSH_SCRIPT, JSON.stringify([POLL(false)]));
    assert.equal(remote.poll(r.root, 'r1', 'l1', { env: r.env }).state, 'cancelled');
    assert.equal(r.lane().status, 'FAILED');
  });
  test('red: events are ordered by seq, never by the remote clock one hour ahead', () => {
    const { r } = launched([{ match: 'git fetch origin', stdout: 'PID=4242\n' }, POLL(true, { out: 5000, err: 5000, remoteNow: 5000 + 3600 })]);
    remote.poll(r.root, 'r1', 'l1', { env: r.env, now: Date.parse('2026-11-17T10:00:00Z') });
    remote.poll(r.root, 'r1', 'l1', { env: r.env, now: Date.parse('2026-11-17T10:00:30Z') });
    const ev = r.events();
    const seqs = ev.filter((e) => e.seq !== undefined).map((e) => e.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
    assert.ok(ev.every((e) => !('remoteAt' in e)));
  });
});

/** The "remote" pushes the lane branch to the origin and the verdict names a head. */
function remoteWork(r, { headOf = 'tip', verdictHead = null, errLog = 'all fine\n' }) {
  const wt = join(r.dir, 'remote-wt');
  git(r.dir, 'clone', '-q', r.origin, wt);
  git(wt, 'config', 'user.email', 'remote@test.local');
  git(wt, 'config', 'user.name', 'remote');
  git(wt, 'config', 'commit.gpgsign', 'false');
  git(wt, 'checkout', '-q', '-b', 'orch/r1-l1', 'origin/dev');
  writeFileSync(join(wt, 'a.txt'), 'from the remote\n');
  git(wt, 'commit', '-qam', 'remote work');
  git(wt, 'push', '-q', 'origin', 'orch/r1-l1');
  const tip = git(wt, 'rev-parse', 'HEAD');
  const head = verdictHead || (headOf === 'tip' ? tip : git(wt, 'rev-parse', 'HEAD~1'));
  const out = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: { verdict: 'PASS', summary: 'done', filesTouched: ['a.txt'], head, requirements: ['R1'] } });
  return { tip, collect: { match: 'cat .lane/head', code: 0, stdout: `${tip}\n__SEP__\n${out}\n__SEP__\n${errLog}` } };
}

describe('REQ-1207 and REQ-1209 — exit, verdict, redaction', () => {
  test('red: a pushed branch whose verdict head equals the tip is fetched, validated and queued for the existing merge path', () => {
    const { r } = launched([{ match: 'git fetch origin', stdout: 'PID=4242\n' }]);
    const w = remoteWork(r, { headOf: 'tip' });
    writeFileSync(r.env.BUILDER_SSH_SCRIPT, JSON.stringify([POLL(false, { head: w.tip }), w.collect]));
    const p = remote.poll(r.root, 'r1', 'l1', { env: r.env });
    assert.equal(p.state, 'VERDICT');
    const l = r.lane();
    assert.equal(l.status, 'QUEUED');
    assert.deepEqual(state.load(r.root, 'r1').mergeQueue, ['l1']);
    assert.equal(git(r.repo, 'rev-parse', 'refs/heads/orch/r1-l1'), w.tip);
  });
  test('red: a verdict naming another head is FAILED-STALE-VERDICT', () => {
    const { r } = launched([{ match: 'git fetch origin', stdout: 'PID=4242\n' }]);
    const w = remoteWork(r, { headOf: 'previous' });
    writeFileSync(r.env.BUILDER_SSH_SCRIPT, JSON.stringify([POLL(false, { head: w.tip }), w.collect]));
    assert.equal(remote.poll(r.root, 'r1', 'l1', { env: r.env }).state, 'FAILED-STALE-VERDICT');
    assert.equal(r.lane().status, 'FAILED');
  });
  test('red: a 255 during the collect is remote_unknown and retried, never FAILED', () => {
    const { r } = launched([{ match: 'git fetch origin', stdout: 'PID=4242\n' }]);
    const w = remoteWork(r, { headOf: 'tip' });
    writeFileSync(r.env.BUILDER_SSH_SCRIPT, JSON.stringify([POLL(false, { head: w.tip }), { match: 'cat .lane/head', code: 255 }]));
    assert.equal(remote.poll(r.root, 'r1', 'l1', { env: r.env }).state, 'remote_unknown');
    assert.equal(r.lane().status, 'LAUNCHED');
    writeFileSync(r.env.BUILDER_SSH_SCRIPT, JSON.stringify([POLL(false, { head: w.tip }), w.collect]));
    assert.equal(remote.poll(r.root, 'r1', 'l1', { env: r.env }).state, 'VERDICT');
  });
  test('red: a secret-shaped err.log line reaches events.jsonl as a redaction marker, never as text', () => {
    const { r } = launched([{ match: 'git fetch origin', stdout: 'PID=4242\n' }]);
    const secret = 'sk-ant-' + 'a'.repeat(40);
    const w = remoteWork(r, { headOf: 'tip', errLog: `warning: retrying\nAuthorization: ${secret}\n` });
    writeFileSync(r.env.BUILDER_SSH_SCRIPT, JSON.stringify([POLL(false, { head: w.tip }), w.collect]));
    remote.poll(r.root, 'r1', 'l1', { env: r.env });
    const text = readFileSync(join(r.root, 'runs', 'r1', 'events.jsonl'), 'utf8');
    assert.ok(!text.includes(secret));
    assert.match(text, /\[REDACTED: Anthropic key\]/);
    assert.match(text, /warning: retrying/);
  });
});

describe('REQ-1211 — the flag and the docs', () => {
  test('red: `features` prints remoteLanes: experimental-off and names §18', () => {
    const dir = tmp('feat');
    const r = spawnSync(process.execPath, [join(PACK, 'scripts', 'features.mjs')], { cwd: dir, encoding: 'utf8' });
    assert.match(r.stdout, /^remoteLanes: experimental-off.*§18/m);
  });
  test('red: GUIDE carries the Git FAQ sentence on not sharing a working tree across systems; the template lists the flag', () => {
    assert.match(readFileSync(join(PACK, 'GUIDE.md'), 'utf8'), /working tree across (two )?systems/);
    assert.match(readFileSync(join(PACK, 'PIPELINE_PROFILE.template.md'), 'utf8'), /"remoteLanes":\s*\{ "state": "experimental-off"/);
  });
  test('the orch CLI: `remote` is a command and refuses while the flag is off', () => {
    const { dir, repo } = scratchRepo({ profile: profileText() });
    const r = spawnSync(process.execPath, [ORCH, 'remote', 'add', 'r1', 'm1', '--host', 'h', '--user', 'u', '--root', '/x'], { cwd: repo, encoding: 'utf8', env: { ...process.env, BUILDER_ORCH_DIR: join(dir, 'orch') } });
    assert.match(r.stdout + r.stderr, /remoteLanes: not configured/);
  });
});
