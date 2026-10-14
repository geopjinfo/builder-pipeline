'use strict';
/**
 * Preflight, the tests switch, and the project's own command hooks for the batch orchestrator.
 *
 * PREFLIGHT. Parallel lanes only when the machinery is up. The checks are the PROJECT's (features.orchestrator.
 * preflight: [{ name, command, tests? }]): each command exits 0 for pass. Any failed check downgrades the run to ONE
 * lane (mode "single"); it never blocks single-lane work. No checks configured is also "single": absent evidence is
 * never a pass, and a second lane is exactly the case where something unchecked (a standing unlock, a missing
 * login, a test host that is down) costs the most. A check with `tests: "local"|"remote"` gates only in that tests
 * mode and is reported SKIP in the other — it never runs there.
 *
 * TESTS SWITCH. Where the heavy test tiers run: `local` (the project's own tier command, one run at a time on this
 * machine) or `remote` (a remote runner command). The profile sets the default (`tests.mode`); `orch set tests`
 * stores a runtime override in <orch root>/tests.json. An unreadable or unknown switch reads as `local` — remote is
 * only ever set on purpose — and `remote` is refused while no remote command is configured.
 *
 * COMMAND HOOKS. Seat-specific actions are the project's commands with placeholders, so the core stays
 * harness-neutral (the Claude Code values are in adapters/claude-code.md):
 *   usageCommand  {seat}     prints lines containing "N% used"; the highest N is recorded
 *   stateCommand  {session}  prints one word: working | done | idle | blocked | failed | stopped
 *   stopCommand   {session}  stops a live worker session
 *   launchCommand {run} {lane} {brief} {worktree} {result} {branch}  starts a secondary-seat terminal worker
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const store = require('./orch-store.cjs');

const TEST_MODES = Object.freeze(['local', 'remote']);
const testsFile = (root) => path.join(root, 'tests.json');

const run = (command, opts = {}) => {
  const r = spawnSync(command, { shell: true, encoding: 'utf8', timeout: 60000, windowsHide: true, ...opts });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || (r.error && r.error.message) || '').trim() };
};

/** Fill `{name}` placeholders. Unknown placeholders are left as they are (and named by the caller's check). */
const fill = (template, vars) => String(template).replace(/\{([a-z]+)\}/g, (m, k) => (vars[k] === undefined ? m : String(vars[k])));

// ------------------------------------------------------------------------------------------- tests switch
function testsMode(root, profileMode = 'local') {
  try {
    const m = JSON.parse(fs.readFileSync(testsFile(root), 'utf8')).mode;
    return TEST_MODES.includes(m) ? m : 'local';
  } catch (e) {
    if (e.code === 'ENOENT') return TEST_MODES.includes(profileMode) ? profileMode : 'local';
    return 'local';
  }
}
const testsIsDefault = (root) => !fs.existsSync(testsFile(root));

function setTests(root, mode, tests = {}) {
  if (!TEST_MODES.includes(mode)) throw new Error(`usage: set tests ${TEST_MODES.join('|')}`);
  if (mode === 'remote' && !tests.remote) throw new Error('refused: no remote test command configured (features.orchestrator.tests.remote)');
  fs.mkdirSync(root, { recursive: true });
  store.writeJsonAtomic(testsFile(root), { mode, at: new Date().toISOString() });
  return mode;
}

/** The tier command template for a mode: remote → tests.remote; local → tests.local, else commands.tier. */
const testsCommand = (mode, tests = {}, tierCmd = null) => (mode === 'remote' ? tests.remote || null : tests.local || tierCmd || null);

function testsLine(mode, tests = {}, tierCmd = null) {
  const cmd = testsCommand(mode, tests, tierCmd);
  return mode === 'remote'
    ? `tests: remote — ${cmd || '(no remote command configured)'}; the remote runner queues runs on its own slots`
    : `tests: local — ${cmd || '(no tier command configured)'}; heavy tiers one at a time on this machine (confirm the slot)`;
}

// ---------------------------------------------------------------------------------------------- preflight
/**
 * @param {object} o
 *   checks     features.orchestrator.preflight
 *   testsMode  the current tests mode
 *   cwd        where the commands run (the primary checkout)
 *   overrides  { name: () => ({ ok, detail }) } — tests replace a named check
 */
function preflight({ checks = [], testsMode: mode = 'local', cwd = process.cwd(), overrides = {} } = {}) {
  const results = checks.map((c) => {
    if (c.tests && c.tests !== mode) return { name: c.name, ok: true, skipped: true, detail: `SKIP (tests=${mode})` };
    try {
      if (overrides[c.name]) return { name: c.name, ...overrides[c.name]() };
      const r = run(c.command, { cwd });
      const last = (r.out.split(/\r?\n/).pop() || r.err.split(/\r?\n/)[0] || '').slice(0, 160);
      return { name: c.name, ok: r.code === 0, detail: `exit ${r.code}${last ? `: ${last}` : ''}` };
    } catch (e) {
      return { name: c.name, ok: false, detail: `check threw: ${e.message}` };
    }
  });
  const ran = results.filter((r) => !r.skipped);
  const none = ran.length === 0;
  const mode2 = !none && results.every((r) => r.ok) ? 'parallel' : 'single';
  return { mode: mode2, tests: mode, none, checks: results };
}

// --------------------------------------------------------------------------------------------- the hooks
/** Run usageCommand for a seat; the highest "N% used" line wins (the one nearest its limit). */
function readUsage(seat, usageCommand, { cwd = process.cwd() } = {}) {
  if (!usageCommand) throw new Error('refused: no usageCommand configured (features.orchestrator.usageCommand) — record usage by hand: orch usage <run> <seat> <pct>');
  const r = run(fill(usageCommand, { seat }), { cwd, timeout: 120000 });
  const lines = `${r.out}\n${r.err}`.split(/\r?\n/).filter((l) => /\d+(?:\.\d+)?% used/.test(l));
  if (!lines.length) throw new Error(`usage ${seat}: no "N% used" line in the output (exit ${r.code})`);
  const pcts = lines.map((l) => Number(/(\d+(?:\.\d+)?)% used/.exec(l)[1]));
  return { pct: Math.max(...pcts), lines: lines.map((l) => l.trim()) };
}

const SESSION_STATES = ['working', 'done', 'idle', 'blocked', 'failed', 'stopped', 'missing'];

/** Run stateCommand for a session: the first word of its output, or 'unknown'. */
function sessionState(session, stateCommand, { cwd = process.cwd() } = {}) {
  if (!stateCommand) return { state: 'unknown', detail: 'no stateCommand configured' };
  const r = run(fill(stateCommand, { session }), { cwd });
  const word = (r.out.split(/\s+/)[0] || '').toLowerCase();
  return SESSION_STATES.includes(word) ? { state: word } : { state: 'unknown', detail: (r.out || r.err).slice(0, 160) };
}

module.exports = { TEST_MODES, testsFile, testsMode, testsIsDefault, setTests, testsCommand, testsLine, preflight, readUsage, sessionState, fill, run, SESSION_STATES };
