'use strict';
/**
 * Remote lanes — a lane that runs on another machine over plain ssh (`features.remoteLanes`, experimental-off;
 * plan M12, REQ-1201 to REQ-1211, D58). EXPERIMENTS.md §18 holds the measurement that decides its future.
 *
 * WHY so small. The smallest shape that fits the kit's rules: git is the only data path (a shared origin both hosts
 * reach), ssh the only transport, one call per step, and every remote fact stored as data the orchestrator's own clock
 * orders. Nothing is mounted, copied or synced. No credential leaves this machine: a person logs the remote in once.
 *
 *   machine    a row in state.json: { host, user, remoteRoot, status, lastSeen, preflight }
 *              status: unknown | ready | not_ready | machine_unauthenticated | remote_unknown
 *   transport  ssh -T -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=15 user@host <cmd>
 *              exit 255 is ssh's own failure → the event `remote_unknown`, never a lane verdict (REQ-1202)
 *   preflight  one call: claude auth status · claude --version · git --version · test -d <root>/.git; a mount path
 *              is refused before the call (REQ-1203, REQ-1204)
 *   launch     one call: git fetch origin · git worktree add <wt> -b <lane> origin/<base> · the pin written into the
 *              worktree · every hook the pin names checked · setsid nohup claude -p … > .lane/out.json, pid in
 *              .lane/pid; CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1; the exit tail commits, pushes the lane branch,
 *              writes .lane/head and removes the pin (REQ-1205, REQ-1207, REQ-1208)
 *   poll       one call: kill -0 <pid> · mtimes of .lane/out.json and .lane/err.log · the remote clock · .lane/head.
 *              lane.heartbeat is this machine's clock; remote times are stored as remoteTs and never order anything;
 *              a stall is judged on remote mtimes against the remote clock (REQ-1206, REQ-1210)
 *   collect    one call reads .lane/head, .lane/out.json and .lane/err.log; `git fetch origin <lane>` locally; the
 *              verdict (worker-verdict.cjs) is judged against the fetched tip; a PASS lane is queued for the existing
 *              merge path (orch-merge.cjs enqueue); err.log goes through the outbound guard first (REQ-1207, REQ-1209)
 *
 * TODO(M9): the loop runner dispatches here — `place` then `launch`, `poll` on its tick, `collect` on exit.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const state = require('./orch-state.cjs');
const merge = require('./orch-merge.cjs');
const { runDir } = require('./orch-store.cjs');
const { readVerdict, VERDICT_SCHEMA } = require('./worker-verdict.cjs');
const guard = require('./outbound-guard.cjs');

const FEATURE = 'remoteLanes';
const STATUS = Object.freeze({ unknown: 'unknown', ready: 'ready', notReady: 'not_ready', unauth: 'machine_unauthenticated', remoteUnknown: 'remote_unknown' });
const SSH_OPTS = Object.freeze(['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15']);
const SSH_FAILED = 255;
const MOUNT_PATHS = Object.freeze([/^\/(mnt|media|net|nfs|smb|cifs|afs|Volumes)\//, /^\/\//, /^\\\\/, /^[A-Za-z]:\\/]);
const now = () => new Date().toISOString();
const target = (m) => (m.user ? `${m.user}@${m.host}` : m.host);
const q = (s) => (/^[\w@%+=:,./-]+$/.test(String(s)) ? String(s) : `'${String(s).replace(/'/g, `'\\''`)}'`);

/** The remote command over ssh. `code` is the remote command's exit code, or 255 when ssh itself failed. */
function ssh(machine, cmd, { env = process.env, timeoutMs = 120000 } = {}) {
  const r = spawnSync('ssh', [...SSH_OPTS, target(machine), cmd], { env, encoding: 'utf8', timeout: timeoutMs, windowsHide: true, input: '' });
  const code = r.status === null ? SSH_FAILED : r.status;
  return { code, stdout: r.stdout || '', stderr: r.stderr || '', sshFailed: code === SSH_FAILED, error: r.error ? r.error.message : null };
}

/** Why `remoteRoot` looks like a network mount, or null (REQ-1204). */
const mountPathFault = (p) => (MOUNT_PATHS.some((re) => re.test(String(p))) ? `remoteRoot ${p} is on a mount path — a remote lane works in its own clone, never on a shared or mounted tree` : null);

/** An event with a sequence number; remote times travel as `remoteTs` only (REQ-1210). */
function remoteEvent(root, runId, type, data = {}) {
  const file = path.join(runDir(root, runId), 'events.jsonl');
  let seq = 1;
  try {
    seq = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length + 1;
  } catch (_) {
    /* first event */
  }
  state.event(root, runId, type, { seq, ...data });
}

function featureOn(settings) {
  const f = settings && settings.features && settings.features[FEATURE];
  return !!f && ['on', 'unmeasured', 'experimental-on'].includes(f.state);
}
const notConfigured = () => `${FEATURE}: not configured`;

/** Add a machine row (REQ-1201). */
function addMachine(root, runId, name, { host, user = null, remoteRoot }) {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(String(name))) throw new Error(`refused: machine name ${JSON.stringify(name)} (lowercase, digits, dashes)`);
  if (!host || !remoteRoot) throw new Error('refused: a machine needs host and remoteRoot');
  return state.update(root, runId, (s) => {
    s.machines = s.machines || {};
    if (s.machines[name]) throw new Error(`refused: machines.${name} exists`);
    s.machines[name] = { host, user, remoteRoot, status: STATUS.unknown, lastSeen: null, preflight: null };
    return s.machines[name];
  }, { type: 'machine.add', data: { machine: name, host, user, remoteRoot } });
}

function machineOf(s, name) {
  const m = s.machines && s.machines[name];
  if (!m) throw new Error(`refused: unknown machine ${JSON.stringify(name)} — no row machines.${name} in state.json`);
  return m;
}

const preflightCommand = (m) => ['claude auth status >/dev/null 2>&1; echo __AUTH=$?', 'claude --version >/dev/null 2>&1; echo __VER=$?', 'git --version >/dev/null 2>&1; echo __GIT=$?', `test -d ${q(`${m.remoteRoot}/.git`)}; echo __ROOT=$?`].join('; ');

/** One preflight per machine (REQ-1203); the `true` result is stored on the row (REQ-1202). */
function preflight(root, runId, name, { env = process.env } = {}) {
  const s = state.load(root, runId);
  const m = machineOf(s, name);
  const mount = mountPathFault(m.remoteRoot);
  if (mount) throw new Error(`refused: ${mount}`);
  const probe = ssh(m, 'true', { env });
  const set = (status, reason, extra = {}) => {
    state.update(root, runId, (st) => {
      Object.assign(st.machines[name], { status, lastSeen: now(), preflight: { true: probe.code, ...extra, reason: reason || null } });
    }, { type: 'machine.preflight', data: { machine: name, status, reason: reason || null } });
    return { status, reason: reason || null };
  };
  if (probe.sshFailed) {
    remoteEvent(root, runId, STATUS.remoteUnknown, { machine: name, step: 'preflight', stderr: redact(probe.stderr) });
    return set(STATUS.remoteUnknown, 'ssh exit 255');
  }
  const r = ssh(m, preflightCommand(m), { env });
  if (r.sshFailed) {
    remoteEvent(root, runId, STATUS.remoteUnknown, { machine: name, step: 'preflight', stderr: redact(r.stderr) });
    return set(STATUS.remoteUnknown, 'ssh exit 255');
  }
  const codes = {};
  for (const [, k, v] of r.stdout.matchAll(/__(AUTH|VER|GIT|ROOT)=(\d+)/g)) codes[k] = Number(v);
  const checks = [['AUTH', 'claude auth status'], ['VER', 'claude --version'], ['GIT', 'git --version'], ['ROOT', `test -d ${m.remoteRoot}/.git`]];
  for (const [k, label] of checks) if (codes[k] === undefined) return set(STATUS.notReady, `${label}: no result in the preflight output`, { codes });
  if (codes.AUTH !== 0) return set(STATUS.unauth, 'claude auth status: login missing or expired', { codes });
  const failed = checks.find(([k]) => codes[k] !== 0);
  if (failed) return set(STATUS.notReady, `${failed[1]}: exit ${codes[failed[0]]}`, { codes });
  return set(STATUS.ready, null, { codes });
}

/** Place a lane on a machine (REQ-1201). Flag off: the line and a local placement. */
function place(root, runId, lane, machineName, { settings }) {
  if (!featureOn(settings)) return { placed: 'local', line: notConfigured() };
  const s = state.load(root, runId);
  if (!s.lanes[lane]) throw new Error(`no lane ${lane} in ${runId}`);
  const m = machineOf(s, machineName);
  if (m.status !== STATUS.ready) throw new Error(`refused: machines.${machineName} is ${m.status}${m.preflight && m.preflight.reason ? ` (${m.preflight.reason})` : ''} — not placed`);
  state.setLane(root, runId, lane, { machine: machineName });
  return { placed: machineName, line: `${lane} placed on machine ${machineName} (${target(m)})` };
}

/** The hook scripts a settings pin runs, as the relative paths its commands name. */
function hooksNamed(pin) {
  const out = new Set();
  for (const groups of Object.values((pin && pin.hooks) || {})) for (const g of Array.isArray(groups) ? groups : []) for (const h of Array.isArray(g.hooks) ? g.hooks : []) {
    const m = /(?:^|\s)(?:node\s+)?["']?((?:\.\/)?\.claude\/hooks\/[\w./-]+\.(?:cjs|js|mjs|sh))/.exec(String(h.command || ''));
    if (m) out.add(m[1].replace(/^\.\//, ''));
  }
  return [...out];
}

/** The one launch command (REQ-1205, REQ-1207, REQ-1208). Pure. */
function launchCommand({ machine: m, lane: l, base, pinText, hooks, briefText, maxTurns, model, permissionMode = 'dontAsk' }) {
  const wt = `${m.remoteRoot}/.lanes/${l.name}`;
  const claude = ['claude', '-p', '--output-format', 'json', '--max-turns', String(maxTurns), '--permission-mode', permissionMode, '--permission-prompts', 'none', '--settings', '.lane/settings.json', '--json-schema', q(JSON.stringify(VERDICT_SCHEMA)), '--strict-mcp-config', '--no-session-persistence', ...(model ? ['--model', q(model)] : [])].join(' ');
  const tail = `git add -A; git commit -qm ${q(`lane ${l.name}: remote work [orchestrator]`)} || true; git push -u origin ${q(l.branch)}; git rev-parse HEAD > .lane/head; rm -f .lane/settings.json`;
  return [
    'set -e',
    `cd ${q(m.remoteRoot)}`,
    'git fetch origin',
    `git worktree add ${q(wt)} -b ${q(l.branch)} ${q(`origin/${base}`)}`,
    `cd ${q(wt)}`,
    'mkdir -p .lane',
    `printf '%s' ${q(pinText)} > .lane/settings.json`,
    `printf '%s' ${q(briefText)} > .lane/brief.md`,
    ...hooks.map((h) => `test -f ${q(h)} || { echo MISSING_HOOK ${h}; exit 3; }`),
    `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 setsid nohup sh -c ${q(`${claude} < .lane/brief.md > .lane/out.json 2> .lane/err.log; ${tail}`)} > /dev/null 2>&1 &`,
    'echo $! > .lane/pid',
    'echo PID=$(cat .lane/pid)',
  ].join('\n');
}

/** Start a remote lane with one ssh call. */
function launch(root, runId, lane, { env = process.env, settingsFile, base, maxTurns, model = null, permissionMode } = {}) {
  const s = state.load(root, runId);
  const l = s.lanes[lane];
  if (!l) throw new Error(`no lane ${lane} in ${runId}`);
  if (!l.machine) throw new Error(`refused: lane ${lane} is not placed on a machine`);
  const m = machineOf(s, l.machine);
  if (typeof settingsFile !== 'string' || !path.isAbsolute(settingsFile)) throw new Error('refused: the --settings pin must be an absolute path (REQ-1208)');
  if (!(Number.isInteger(maxTurns) && maxTurns > 0)) throw new Error('refused: maxTurns must be a positive integer (REQ-305)');
  if (!base) throw new Error('refused: the base branch is required');
  const pinText = fs.readFileSync(settingsFile, 'utf8');
  let pin = {};
  try {
    pin = JSON.parse(pinText);
  } catch (_) {
    throw new Error(`refused: the pin ${settingsFile} is not JSON`);
  }
  const briefText = fs.existsSync(l.brief) ? fs.readFileSync(l.brief, 'utf8') : '';
  const cmd = launchCommand({ machine: m, lane: l, base, pinText, hooks: hooksNamed(pin), briefText, maxTurns, model, permissionMode });
  const r = ssh(m, cmd, { env });
  if (r.sshFailed) {
    remoteEvent(root, runId, STATUS.remoteUnknown, { lane, machine: l.machine, step: 'launch', stderr: redact(r.stderr) });
    return { ok: false, state: STATUS.remoteUnknown, reason: 'ssh exit 255 on launch — the lane is not started (retry)' };
  }
  const missing = /MISSING_HOOK (\S+)/.exec(r.stdout);
  if (missing) {
    remoteEvent(root, runId, 'remote.launch.refused', { lane, machine: l.machine, hook: missing[1] });
    return { ok: false, state: 'refused', reason: `the pin needs ${missing[1]}, which the remote worktree lacks — launch refused` };
  }
  if (r.code !== 0) {
    remoteEvent(root, runId, 'remote.launch.failed', { lane, machine: l.machine, exitCode: r.code, stderr: redact(r.stderr) });
    return { ok: false, state: 'failed', reason: `remote launch exit ${r.code}` };
  }
  const pid = Number((/PID=(\d+)/.exec(r.stdout) || [])[1]);
  if (!pid) return { ok: false, state: 'failed', reason: 'remote launch printed no pid' };
  state.setLane(root, runId, lane, { status: 'LAUNCHED', remotePid: pid, remoteWorktree: `${m.remoteRoot}/.lanes/${l.name}`, remoteState: 'running', heartbeat: now() });
  remoteEvent(root, runId, 'remote.launch', { lane, machine: l.machine, pid });
  return { ok: true, pid };
}

const pollCommand = (wt, pid) => `cd ${q(wt)} 2>/dev/null || { echo NOWT; exit 1; }; kill -0 ${pid} 2>/dev/null && echo ALIVE || echo EXITED; echo OUT=$(stat -c %Y .lane/out.json 2>/dev/null || echo 0); echo ERR=$(stat -c %Y .lane/err.log 2>/dev/null || echo 0); echo NOW=$(date +%s); echo HEAD=$(cat .lane/head 2>/dev/null)`;

/** Redact a text through the outbound guard: a line with a secret shape becomes its marker (REQ-1209). */
function redact(text) {
  const lines = String(text || '').split(/\r?\n/);
  const hits = guard.scan(lines.join('\n'));
  return lines.map((line, i) => {
    const h = hits.filter((x) => x.line === i + 1);
    return h.length ? `[REDACTED: ${h.map((x) => x.kind).join(', ')}]` : line;
  }).join('\n');
}

/** One liveness poll (REQ-1206). `now` is this machine's clock (ms). */
function poll(root, runId, lane, { env = process.env, now: at = Date.now() } = {}) {
  const s = state.load(root, runId);
  const l = s.lanes[lane];
  if (!l) throw new Error(`no lane ${lane} in ${runId}`);
  if (!l.machine || !l.remotePid) throw new Error(`refused: lane ${lane} is not a running remote lane`);
  const m = machineOf(s, l.machine);
  const r = ssh(m, pollCommand(l.remoteWorktree, l.remotePid), { env });
  const hb = new Date(at).toISOString();
  if (r.sshFailed) {
    remoteEvent(root, runId, STATUS.remoteUnknown, { lane, machine: l.machine, step: 'poll', stderr: redact(r.stderr) });
    state.update(root, runId, (st) => {
      st.machines[l.machine].status = STATUS.remoteUnknown;
      st.lanes[lane].heartbeat = hb;
    });
    return { state: STATUS.remoteUnknown, exitCode: r.code };
  }
  const num = (k) => Number((new RegExp(`^${k}=(\\d+)`, 'm').exec(r.stdout) || [])[1] || 0);
  const alive = /^ALIVE$/m.test(r.stdout);
  const remoteTs = { out: num('OUT'), err: num('ERR'), now: num('NOW') };
  const head = (/^HEAD=(\S*)/m.exec(r.stdout) || [])[1] || null;
  state.update(root, runId, (st) => {
    st.lanes[lane].heartbeat = hb;
    st.machines[l.machine].lastSeen = hb;
    if (st.machines[l.machine].status === STATUS.remoteUnknown) st.machines[l.machine].status = STATUS.ready;
  });
  remoteEvent(root, runId, 'remote.poll', { lane, machine: l.machine, alive, exitCode: r.code, remoteTs, head });
  if (r.code !== 0) return { state: 'poll-error', exitCode: r.code, alive };
  if (l.remoteState === 'cancelling') {
    if (alive) return { state: 'cancelling', exitCode: r.code };
    state.setLane(root, runId, lane, { status: 'FAILED', remoteState: 'cancelled', stallReason: 'cancelled' });
    return { state: 'cancelled', exitCode: r.code };
  }
  if (alive) {
    const idleSec = (l.stallMinutes || state.DEFAULTS.stallMinutes) * 60;
    const last = Math.max(remoteTs.out, remoteTs.err);
    if (last && remoteTs.now && remoteTs.now - last > idleSec) {
      state.setLane(root, runId, lane, { status: 'FAILED', remoteState: 'stalled', stallReason: `FAILED-STALL: no write to .lane/out.json or .lane/err.log for ${Math.round((remoteTs.now - last) / 60)} min (remote clock)` });
      remoteEvent(root, runId, 'remote.stall', { lane, machine: l.machine, remoteTs });
      return { state: 'FAILED-STALL', exitCode: r.code };
    }
    return { state: 'running', exitCode: r.code };
  }
  return collect(root, runId, lane, { env });
}

const collectCommand = (wt) => `cd ${q(wt)}; cat .lane/head 2>/dev/null; echo __SEP__; cat .lane/out.json 2>/dev/null; echo __SEP__; cat .lane/err.log 2>/dev/null`;

/** The worker exited: fetch, judge the verdict against the fetched head, queue for the merge path (REQ-1207). */
function collect(root, runId, lane, { env = process.env, repo = null } = {}) {
  const s = state.load(root, runId);
  const l = s.lanes[lane];
  const m = machineOf(s, l.machine);
  const r = ssh(m, collectCommand(l.remoteWorktree), { env });
  if (r.sshFailed) {
    remoteEvent(root, runId, STATUS.remoteUnknown, { lane, machine: l.machine, step: 'collect', stderr: redact(r.stderr) });
    return { state: STATUS.remoteUnknown, exitCode: r.code, retry: true };
  }
  const [headText = '', outText = '', errText = ''] = r.stdout.split(/^__SEP__\r?\n?/m);
  const errLines = redact(errText).split(/\r?\n/).filter(Boolean);
  if (errLines.length) remoteEvent(root, runId, 'remote.errlog', { lane, machine: l.machine, lines: errLines.slice(-40) });
  const repoDir = repo || s.repo;
  const fetch = spawnSync('git', ['fetch', '-q', 'origin', `${l.branch}:refs/remotes/origin/${l.branch}`], { cwd: repoDir, encoding: 'utf8', env });
  if (fetch.status !== 0) {
    remoteEvent(root, runId, STATUS.remoteUnknown, { lane, machine: l.machine, step: 'fetch', stderr: redact(fetch.stderr) });
    return { state: STATUS.remoteUnknown, retry: true, reason: `git fetch origin ${l.branch} failed` };
  }
  const tip = spawnSync('git', ['rev-parse', `refs/remotes/origin/${l.branch}`], { cwd: repoDir, encoding: 'utf8' }).stdout.trim();
  let raw = null;
  try {
    const out = JSON.parse(outText.trim());
    raw = out && out.structured_output && typeof out.structured_output === 'object' ? out.structured_output : typeof out.result === 'string' ? JSON.parse(out.result) : null;
  } catch (_) {
    raw = null;
  }
  const denials = (() => {
    try {
      const out = JSON.parse(outText.trim());
      return Array.isArray(out.permission_denials) ? out.permission_denials.map((d) => `${d.tool_name}: ${JSON.stringify(d.tool_input || {}).slice(0, 120)}`) : [];
    } catch (_) {
      return [];
    }
  })();
  const v = readVerdict(raw, { head: tip, claimed: l.rows || [], denials });
  remoteEvent(root, runId, 'remote.verdict', { lane, machine: l.machine, job: v.job, reason: v.reason, head: tip, remoteHead: headText.trim() || null });
  if (v.job !== 'VERDICT') {
    state.setLane(root, runId, lane, { status: 'FAILED', remoteState: 'exited', stallReason: `${v.job}: ${v.reason}` });
    return { state: v.job, reason: v.reason };
  }
  // the lane branch locally at the fetched tip, then the existing merge path
  spawnSync('git', ['branch', '-f', l.branch, tip], { cwd: repoDir, encoding: 'utf8' });
  state.setLane(root, runId, lane, { status: 'DONE', remoteState: 'exited', verdict: v.verdict });
  merge.enqueue(root, runId, lane);
  return { state: 'VERDICT', verdict: v.verdict, head: tip };
}

/** Cancel: kill the remote process group; the lane stays cancelling until a poll confirms exit (REQ-1206). */
function cancel(root, runId, lane, { env = process.env } = {}) {
  const s = state.load(root, runId);
  const l = s.lanes[lane];
  if (!l || !l.machine || !l.remotePid) throw new Error(`refused: lane ${lane} is not a running remote lane`);
  const m = machineOf(s, l.machine);
  const r = ssh(m, `kill -- -${l.remotePid} 2>/dev/null || kill ${l.remotePid} 2>/dev/null; true`, { env });
  if (r.sshFailed) {
    remoteEvent(root, runId, STATUS.remoteUnknown, { lane, machine: l.machine, step: 'cancel', stderr: redact(r.stderr) });
    return { state: STATUS.remoteUnknown };
  }
  state.setLane(root, runId, lane, { remoteState: 'cancelling' });
  remoteEvent(root, runId, 'remote.cancel', { lane, machine: l.machine, pid: l.remotePid });
  return { state: 'cancelling' };
}

module.exports = {
  FEATURE, STATUS, SSH_OPTS, SSH_FAILED, MOUNT_PATHS,
  ssh, mountPathFault, featureOn, notConfigured, remoteEvent, addMachine, preflight, preflightCommand, place, hooksNamed, launchCommand, launch, pollCommand, poll, collect, cancel, redact,
};
