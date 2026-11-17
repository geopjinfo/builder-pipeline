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
 *   launchCommand {run} {lane} {brief} {worktree} {result} {branch} {account} {maxTurns} {timeoutMinutes}
 *                            starts a terminal worker on the placed account (an account's own `command` wins)
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
const fill = (template, vars) => String(template).replace(/\{([a-zA-Z]+)\}/g, (m, k) => (vars[k] === undefined ? m : String(vars[k])));

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
/**
 * Run usageCommand for a seat; the highest "N% used" line wins (the one nearest its limit). Output with no such line
 * (a CLI whose usage report prints costs or token counts, not a limit percentage) is UNKNOWN —
 * `{ pct: null, unknown: true, lines: <first 5 raw lines> }` — never a throw: `orch usage-read` records it as a
 * `usage.unknown` event, leaves the measured usage alone and goes on to the next seat.
 */
function readUsage(seat, usageCommand, { cwd = process.cwd() } = {}) {
  if (!usageCommand) throw new Error('refused: no usageCommand configured (features.orchestrator.usageCommand) — record usage by hand: orch usage <run> <seat> <pct>');
  const r = run(fill(usageCommand, { seat }), { cwd, timeout: 120000 });
  const lines = `${r.out}\n${r.err}`.split(/\r?\n/).filter((l) => /\d+(?:\.\d+)?% used/.test(l));
  if (!lines.length) {
    const raw = `${r.out}\n${r.err}`.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 5);
    return { pct: null, unknown: true, lines: raw.length ? raw : [`(no output, exit ${r.code})`] };
  }
  const pcts = lines.map((l) => Number(/(\d+(?:\.\d+)?)% used/.exec(l)[1]));
  return { pct: Math.max(...pcts), unknown: false, lines: lines.map((l) => l.trim()) };
}

// --------------------------------------------------------------------------------------------- link guard
/**
 * LINK GUARD (features.orchestrator.linkDirs). A lane worktree whose dependency directory is a link (a junction or
 * symlink to the primary checkout's install) shares that install with every lane. A reinstall there — `npm ci`,
 * a recursive delete of the directory — deletes THROUGH the link and empties the install every lane shares. Reads
 * only (lstat / realpath); never removes, follows into or recreates anything. Returns one entry per linked dir.
 */
function linkGuard(folder, linkDirs = []) {
  const out = [];
  for (const name of linkDirs) {
    const link = path.join(path.resolve(folder), name);
    let st;
    try {
      st = fs.lstatSync(link);
    } catch (_) {
      out.push({ name, link, linked: false, missing: true });
      continue;
    }
    if (!st.isSymbolicLink()) {
      out.push({ name, link, linked: false, missing: false });
      continue;
    }
    let target = null;
    try {
      target = fs.realpathSync(link);
    } catch (_) {
      /* dangling */
    }
    out.push({ name, link, linked: true, missing: false, target });
  }
  return out;
}

/** The command that removes the LINK itself (never what it points at). */
const unlinkCommand = (link) => (process.platform === 'win32' ? `cmd /c rmdir "${link}"` : `rm "${link}"`);

// Every npm install alias, the ci-test ones, and the npm commands that rewrite the install THROUGH a link (update, prune,
// uninstall, dedupe, rebuild) — fail closed.
const NPM_VERBS = new Set(['ci', 'ic', 'clean-install', 'install-clean', 'isntall-clean', 'install', 'instal', 'insta', 'inst', 'ins', 'in', 'isnt', 'isnta', 'isntal', 'isntall', 'i', 'it', 'install-test',
  'cit', 'sit', 'clean-install-test', 'install-ci-test', 'add', 'update', 'up', 'upgrade', 'udpate', 'prune', 'uninstall', 'un', 'remove', 'rm', 'r', 'unlink', 'dedupe', 'ddp', 'rebuild', 'rb']);
// A step counts as negated only with the negation RIGHT before it (at most run/use/do/ever between); "Don't forget:
// npm ci" still counts the step — fail closed.
const NEGATED_BEFORE = /\b(never|not|don't|no)\b(?:\s+(?:run|use|do|ever))?[\s`'"*]*$/i;
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Offsets of every reinstall / recursive-delete step in `text`, negated ones dropped: an npm install verb (any alias
 * or flag order, `npm.cmd`, `npx npm`), `yarn` / `yarn install|add` / `pnpm i|install|add`, a line naming a linked
 * dir with any delete word and any recursive switch, `rimraf`, and `git clean -x` (it removes ignored trees). Every
 * scan is linear per line (capped windows) — a long one-line brief cannot make it backtrack.
 */
function reinstallAt(t, linkDirs = ['node_modules']) {
  const out = [];
  const negated = (i) => {
    const st = Math.max(0, i - 49);
    let w = t.slice(st, i);
    const nl = w.lastIndexOf('\n');
    if (nl >= 0) w = w.slice(nl + 1);
    else if (st > 0) w = w.replace(/^[a-z0-9_]*/i, ''); // a window cut mid-word never reads its tail as a negation
    return NEGATED_BEFORE.test(w);
  };
  for (const m of t.matchAll(/(?<![a-z0-9])npm(?:\.cmd)?(?![a-z0-9])/gi)) {
    const from = m.index + m[0].length;
    const rest = t.slice(from, from + 400);
    const cut = !rest.includes('\n') && from + 400 < t.length;
    const toks = rest.split(/\n/)[0].split(/[\s&|;>]+/).map((x) => x.replace(/^[^\w-]+/, '')).filter(Boolean);
    if (cut) toks.pop(); // the last token may be cut mid-word
    let decided = false;
    for (let k = 0; k < toks.length; k++) {
      const verb = (/^[a-z][a-z-]*/i.exec(toks[k]) || [''])[0].toLowerCase();
      if (/^-/.test(toks[k])) {
        const nx = toks[k + 1] && (/^[a-z][a-z-]*/i.exec(toks[k + 1]) || [''])[0].toLowerCase();
        if (!toks[k].includes('=') && toks[k + 1] && !/^-/.test(toks[k + 1]) && !NPM_VERBS.has(nx)) k++;
        continue;
      }
      if (NPM_VERBS.has(verb) && !negated(m.index)) out.push(m.index);
      decided = true;
      break;
    }
    if (!decided && cut && !negated(m.index)) out.push(m.index); // the cap cut the line before a verb: fail closed
  }
  for (const m of t.matchAll(/\byarn\b(?:\s+(?:install|add)\b|\s*(?=$|[`'";&|\n]))|\bpnpm\s+(?:i|install|add)\b/gim)) if (!negated(m.index)) out.push(m.index);
  const dirs = new RegExp(linkDirs.map(escapeRe).join('|') || '(?!)', 'i');
  let lineStart = 0;
  for (const line of t.split('\n')) {
    const at = (re) => {
      for (const m of line.matchAll(new RegExp(re.source, 'gi'))) if (!negated(lineStart + m.index)) return lineStart + m.index;
      return -1;
    };
    const hits = [];
    if (dirs.test(line)) {
      if (/(?:^|[\s'"`(])--?[a-z]*r[a-z]*(?![a-z0-9])|\/s(?![a-z0-9])/i.test(line)) hits.push(at(/(?<![a-z0-9])(?:rm|ri|rmdir|rd|del|erase|Remove-Item)(?![a-z0-9])/));
      hits.push(at(/(?<![a-z0-9])rimraf(?![a-z0-9])/));
    }
    const g = at(/(?<![a-z0-9])git(?![a-z0-9])/);
    if (g >= 0) {
      const after = line.slice(g - lineStart);
      const clean = after.search(/(?<![a-z0-9])clean(?![a-z0-9])/i);
      if (clean > 0 && /(?:^|[\s'"`])-[a-z]*x/i.test(after.slice(clean))) hits.push(g);
    }
    for (const h of hits) if (h >= 0 && !negated(h)) out.push(h);
    lineStart += line.length + 1;
  }
  return out.sort((x, y) => x - y);
}

/**
 * A brief "asks for a reinstall" when it names any reinstall step. No brief wording exempts it: rounds of clause
 * splitting, word windows and negation lists each left an escape in one adopting project. The orchestrator unlinks the
 * linked dir ITSELF before the launch (the guard then reads no link).
 */
const briefAsksReinstall = (text, linkDirs) => reinstallAt(String(text).replace(/[‘’ʼ]/g, "'"), linkDirs).length > 0;

// ------------------------------------------------------------------------------------------------ smoke
/**
 * SMOKE (REQ-308, D31). An account with `smokeCommand` proves it can write before its first launch in a run: when the
 * last pass on record is older than the stale window (`usageStaleMinutes`), the command runs again, under the
 * account's own config dir, and the result is written to the account's `smoke.json` (`{ ok, at, exit }`). A failed
 * smoke makes the account not ready and the launch is refused naming it.
 */
const smokeDue = (record, now = Date.now(), staleMinutes = 30) => !record || record.ok === false || !Number.isFinite(Date.parse(record.at)) || now - Date.parse(record.at) > staleMinutes * 60000;

function runSmoke(account, paths, { cwd = process.cwd(), env = process.env, now = Date.now(), timeoutMs = 120000 } = {}) {
  if (!account || typeof account.smokeCommand !== 'string' || !account.smokeCommand.trim()) throw new Error(`refused: account ${account && account.name} has no smokeCommand`);
  const probes = require('./account-probes.cjs');
  const scrubbed = probes.probeEnv(env, account.worker, paths && paths.configDir);
  const r = probes.runCommand(account.smokeCommand, { env: scrubbed, cwd, timeoutMs });
  const record = { ok: !r.error && r.status === 0, at: new Date(Number(new Date(now))).toISOString(), exit: r.status, ...(r.error ? { error: r.error } : {}) };
  if (paths && paths.smokeFile) {
    fs.mkdirSync(path.dirname(paths.smokeFile), { recursive: true });
    fs.writeFileSync(paths.smokeFile, JSON.stringify(record, null, 2) + '\n');
  }
  return record;
}

const SESSION_STATES = ['working', 'done', 'idle', 'blocked', 'failed', 'stopped', 'missing'];

/** Run stateCommand for a session: the first word of its output, or 'unknown'. */
function sessionState(session, stateCommand, { cwd = process.cwd() } = {}) {
  if (!stateCommand) return { state: 'unknown', detail: 'no stateCommand configured' };
  const r = run(fill(stateCommand, { session }), { cwd });
  const word = (r.out.split(/\s+/)[0] || '').toLowerCase();
  return SESSION_STATES.includes(word) ? { state: word } : { state: 'unknown', detail: (r.out || r.err).slice(0, 160) };
}

module.exports = {
  TEST_MODES, testsFile, testsMode, testsIsDefault, setTests, testsCommand, testsLine, preflight, readUsage, sessionState, fill, run, SESSION_STATES,
  linkGuard, unlinkCommand, reinstallAt, briefAsksReinstall, smokeDue, runSmoke,
};
