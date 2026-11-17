'use strict';
/**
 * The loop runner above a board — `npx builder-pipeline run board-loop <account> <board>` and `orch loop <board>` share it
 * (plan M9, REQ-901 to REQ-907, REQ-909 to REQ-915; D17, D44, D48, D52). `features.boardLoop`, experimental-off:
 * EXPERIMENTS.md §17 holds the measurement that decides its future.
 *
 * WHY. A loop that re-reads its own transcript drifts; a loop whose memory is the board, the progress log and git does
 * not. Each pass is a fresh worker session from the same prompt file (worker-runner.cjs, the Claude Code adapter in
 * account mode). The RUNNER, never the worker, chooses the row (first open, not blocked), flips it, runs the gate, reads
 * the structured verdict, and judges the pass on the gate exit code and the verdict together. A passing pass is one
 * commit with the `Builder-Account:` and `Builder-Requirement:` trailers. A failing pass leaves no commit: it is pinned
 * to a snapshot ref (orch-snapshot.cjs) and the tree is restored and cleaned. Caps live here, not in the worker: the
 * pass timeout, the stall window, maxPasses, the per-row retry ceiling, consecutive failures and no progress (an
 * identical diff hash or gate digest). Every stop writes one reason from a closed set to the summary line, the run log
 * and the state file; the loop never pushes. The gate script, the test roots, the prompt file and the harness
 * configuration are denied whatever the scope; a write there is FAILED-SCOPE and stops the loop.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const profile = require('./profile.cjs');
const accountPaths = require('./account-paths.cjs');
const claude = require('./orch-worker-claude-code.cjs');
const { runWorker } = require('./worker-runner.cjs');
const { readVerdict, VERDICT_SCHEMA } = require('./worker-verdict.cjs');
const { childEnv } = require('./worker-env.cjs');
const snapshots = require('./orch-snapshot.cjs');
const runLog = require('./run-log.cjs');
const capacityLib = require('./capacity.cjs');
const store = require('./orch-store.cjs');
const { ROW_ID, stripAnnotation, normalizeStatus } = require('./board-rows.cjs');

const FEATURE = 'boardLoop';
const STOPS = Object.freeze(['all-pass', 'max-passes', 'not-ready', 'no-progress', 'consecutive-failures', 'rows-blocked', 'scope', 'stall', 'capacity']);
const BYPASS = /--dangerously-skip-permissions|--dangerously-bypass-approvals-and-sandbox|--permission-mode[= ]bypassPermissions|bypassPermissions|--yolo|--full-auto\b/;
const HARNESS_CONFIG = Object.freeze(['.claude/', 'CLAUDE.md', '.mcp.json', 'PIPELINE_PROFILE.md', 'AGENTS.md', '.codex/', '.agents/']);
const SETTLED = /^(DONE|DROPPED|DEFERRED→)/;
const BLOCKED = /^BLOCKED/;
const sha256 = (t) => crypto.createHash('sha256').update(t).digest('hex');
const git = (cwd, args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
};
const posix = (p) => p.split(path.sep).join('/');

/* ----------------------------------------------------------------- the board ---- */

/** The rows of every counted section (`## P<n>` / `## B<n>`): { id, task, cites, status, line }. */
function readRows(text) {
  const lines = text.split(/\r?\n/);
  const rows = [];
  let counted = false;
  let cols = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^## /.test(l)) {
      counted = /^## [PB]\d+\b/.test(l);
      cols = null;
      continue;
    }
    if (!counted || !l.startsWith('|')) continue;
    const cells = l.split(/(?<!\\)\|/).slice(1, -1).map((c) => c.trim());
    if (!cols) {
      if (cells[0] === '#' || /^task$/i.test(cells[1] || '')) cols = { task: cells.findIndex((c) => /^task$/i.test(c)), cites: cells.findIndex((c) => /^cites$/i.test(c)), status: cells.findIndex((c) => /^status$/i.test(c)) };
      continue;
    }
    if (/^[-: |]+$/.test(l.trim())) continue;
    const id = stripAnnotation(cells[0] || '');
    if (!ROW_ID.test(id)) continue;
    rows.push({ id, task: cells[cols.task] || '', cites: cells[cols.cites] || '', status: normalizeStatus(cells[cols.status] || ''), line: i, statusCol: cols.status });
  }
  return rows;
}
const isOpen = (r) => !SETTLED.test(r.status) && !BLOCKED.test(r.status);

/** The board text with one row's status replaced. */
function setStatus(text, row, status) {
  const lines = text.split(/\r?\n/);
  const cells = lines[row.line].split(/(?<!\\)\|/);
  cells[row.statusCol + 1] = ` ${status} `;
  lines[row.line] = cells.join('|');
  return lines.join('\n');
}

/* ----------------------------------------------------------------- helpers ---- */

/** Why the loop may not start: a bypass flag anywhere in what the worker would receive (REQ-913). */
function bypassFault({ promptText = '', account = {}, cfg = {} }) {
  for (const [where, text] of [['the prompt file', promptText], ['the account command', account.command || ''], ['features.boardLoop.gate', cfg.gate || '']]) {
    const m = BYPASS.exec(String(text));
    if (m) return `refused: ${where} asks for a bypass flag (${m[0]}) — every pass runs under the sandbox with a permission mode that never bypasses prompts (REQ-913)`;
  }
  return null;
}

/** Cap a gate output at `limit` bytes: the head, a marker, and the tail (REQ-903). */
function capOutput(text, limit) {
  const t = String(text || '');
  if (Buffer.byteLength(t) <= limit) return t;
  const head = Math.floor(limit * 0.4);
  const tail = Math.floor(limit * 0.4);
  const lines = t.split('\n');
  const headText = t.slice(0, head);
  const tailText = t.slice(-tail);
  const errors = lines.filter((l) => /\b(FAIL|ERROR|Error|error:|not ok|AssertionError|Traceback)\b/.test(l)).slice(0, 20).join('\n');
  return `${headText}\n…[gate output capped at ${limit} bytes: ${Buffer.byteLength(t)} bytes total]…\n${errors ? `[error-shaped lines]\n${errors}\n` : ''}${tailText}`;
}

/** The denied paths of a pass: the gate script, the test roots, the prompt file, the harness config (REQ-906). */
function denyList(cfg, cwd) {
  const out = new Set(HARNESS_CONFIG);
  for (const tok of String(cfg.gate || '').split(/\s+/).map((s) => s.replace(/^["']|["']$/g, ''))) if (tok && !tok.startsWith('-') && !tok.startsWith('{') && fs.existsSync(path.join(cwd, tok)) && fs.statSync(path.join(cwd, tok)).isFile()) out.add(posix(tok));
  for (const r of cfg.testRoots || []) out.add(r.endsWith('/') ? r : `${r}/`);
  if (cfg.promptFile) out.add(posix(cfg.promptFile));
  return [...out];
}
const denied = (file, list) => list.find((d) => (d.endsWith('/') ? file === d.slice(0, -1) || file.startsWith(d) : file === d)) || null;

/** The files the worker changed (tracked, untracked), repository-relative with `/`. */
function changedFiles(cwd) {
  const r = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd, encoding: 'utf8' });
  return String(r.stdout || '').split(/\r?\n/).filter((l) => l.length > 3).map((l) => l.slice(3).replace(/^"|"$/g, '').split(' -> ').pop());
}

/** The commit message of a passing pass with its two trailers and nothing else kit-made (REQ-915). */
function commitMessage({ pass, row, account }) {
  const ids = String(row.cites || '').split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
  return `loop pass ${pass}: ${row.id} ${row.task}`.slice(0, 120) + `\n\nBuilder-Account: ${account}\nBuilder-Requirement: ${ids.join(', ') || 'none'}\n`;
}

const statePath = (cwd, key) => path.join(cwd, '.pipeline', 'loop', `${key}.state.json`);
const logPath = (cwd, key) => path.join(cwd, '.pipeline', 'loop', `${key}.jsonl`);
const progressPath = (cwd, key) => path.join(cwd, '.pipeline', 'loop', `${key}.progress.md`);
const readJson = (f, dflt) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (_) {
    return dflt;
  }
};
const writeJson = (f, v) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(`${f}.tmp`, JSON.stringify(v, null, 2) + '\n');
  fs.renameSync(`${f}.tmp`, f);
};

/* ----------------------------------------------------------------- the run ---- */

/**
 * Run the loop. Resolves { reason, passes, rowsDone, rowsTotal, exitCode, lines }.
 * io: { env, workerBin, now, ready(accountName) → { ready, reason }, log(line) }.
 */
async function runLoop({ cwd, settings, accountName, board, morePasses = 0, io = {} }) {
  const f = profile.feature(settings, FEATURE);
  if (!f.enabled) return { notConfigured: true, line: f.line, exitCode: 0, lines: [f.line] };
  const cfg = f.config;
  const env = io.env || process.env;
  const accounts = (settings.features.accounts && settings.features.accounts.accounts) || {};
  const account = accounts[accountName];
  if (!account) throw new Error(`refused: no account "${accountName}" in features.accounts`);
  if (account.worker !== 'claude-code') throw new Error(`refused: account "${accountName}" is a ${account.worker} account — the loop runner drives Claude Code workers (REQ-902)`);
  const boardFile = path.resolve(cwd, board);
  if (!fs.existsSync(boardFile)) throw new Error(`refused: no board at ${board}`);
  const key = path.basename(boardFile).replace(/\.md$/, '');
  const promptFile = path.resolve(cwd, cfg.promptFile);
  if (!fs.existsSync(promptFile)) throw new Error(`refused: no prompt file at ${cfg.promptFile} (features.boardLoop.promptFile)`);
  const promptText = fs.readFileSync(promptFile, 'utf8');
  const bypass = bypassFault({ promptText, account, cfg });
  if (bypass) throw new Error(bypass);
  const dirty = git(cwd, ['status', '--porcelain', '--untracked-files=all']).out.split('\n').filter((l) => l && !/\.pipeline\//.test(l));
  if (dirty.length) throw new Error(`refused: the worktree is dirty (${dirty.length} file(s)) — a loop starts clean so every pass is its own`);
  const branch = git(cwd, ['symbolic-ref', '--short', 'HEAD']).out || 'HEAD';
  const limit = (settings.features.bashCap && settings.features.bashCap.limitBytes) || 4096;
  const lines = [];
  const say = (l) => {
    lines.push(l);
    if (io.log) io.log(l);
  };
  const log = (ev) => runLog.append(logPath(cwd, key), ev);
  // M15 (REQ-1509, REQ-1516): with features.capacity on, the runner reads the governor's record before each pass and
  // holds at 0 lanes; and it samples its worker's RSS by pid, the one honest per-lane memory measurement (D83).
  const capF = profile.feature(settings, capacityLib.FEATURE);
  const capOn = capF.enabled;
  const capCfg = capF.config;
  const orchRoot = store.orchRoot(env, cwd);
  const stub = !!env.BUILDER_LOOP_WORKER_BIN;
  const holdPollMs = stub && Number(env.BUILDER_LOOP_STUB_CAPACITY_POLL_MS) > 0 ? Number(env.BUILDER_LOOP_STUB_CAPACITY_POLL_MS) : capCfg.intervalSeconds * 1000;
  const rssIo = stub && env.BUILDER_LOOP_STUB_PS_KB !== undefined ? { platform: env.BUILDER_LOOP_STUB_PLATFORM || 'linux', ps: () => env.BUILDER_LOOP_STUB_PS_KB } : stub && env.BUILDER_LOOP_STUB_PLATFORM ? { platform: env.BUILDER_LOOP_STUB_PLATFORM } : {};
  const rssSampleMs = stub ? 25 : 2000;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const state = readJson(statePath(cwd, key), { passes: 0, cap: cfg.maxPasses, extended: false, retries: {}, consecutiveFailures: 0, history: [], stopReason: null, account: accountName });
  if (morePasses) {
    if (state.extended) throw new Error(`refused: this run was already extended once (--more-passes adds passes once per run, REQ-914)`);
    state.cap += morePasses;
    state.extended = true;
    state.stopReason = null;
    log({ kind: 'more-passes', added: morePasses, cap: state.cap, by: 'restart' });
    say(`more-passes: cap raised by ${morePasses} to ${state.cap} (once for this run)`);
  }
  const deny = denyList(cfg, cwd);
  const pin = path.join(cwd, '.pipeline', 'loop', `${key}.settings.json`);
  const p = accountPaths.paths(accountPaths.home(env), accountName, account);
  const bin = env.BUILDER_LOOP_WORKER_BIN || claude.resolveBin(env);
  // REQ-602: a subscription account must start on its login ('none'); any other account on a key — the API key variable,
  // an auth token (a gateway) or the apiKeyHelper of its settings. Anything else stops the worker before a model call.
  // A gateway account reached through its base URL may hold an auth token the CLI reports as 'none' (no API key in play):
  // the request goes to the gateway, never to a plan account, so 'none' is acceptable there too.
  const acceptableKeySources = account.pays === 'subscription' ? ['none'] : account.pays === 'gateway' ? [claude.API_KEY_VAR, 'ANTHROPIC_AUTH_TOKEN', 'apiKeyHelper', 'none'] : [claude.API_KEY_VAR, 'ANTHROPIC_AUTH_TOKEN', 'apiKeyHelper'];
  const keySourceVerdict = (events) => {
    for (const ev of events) {
      if (ev && ev.type === 'system' && ev.subtype === 'init') return acceptableKeySources.includes(ev.apiKeySource) ? 'ok' : `apiKeySource is ${JSON.stringify(ev.apiKeySource)}, not one of ${acceptableKeySources.join(' | ')} — worker stopped before any model call`;
      if (!(ev && ev.type === 'system' && /^hook/.test(String(ev.subtype)))) return `first non-hook stream event is ${ev && ev.type}/${ev && ev.subtype}, not system/init — worker stopped`;
    }
    return events.length > 50 ? 'no system/init within 50 events — worker stopped' : null;
  };

  const finish = (reason, extra = {}) => {
    const rows = readRows(fs.readFileSync(boardFile, 'utf8'));
    const done = rows.filter((r) => SETTLED.test(r.status)).length;
    state.stopReason = reason;
    writeJson(statePath(cwd, key), state);
    const summary = `STOP ${reason} — ${state.passes} pass(es), ${done}/${rows.length} rows done${extra.detail ? ` · ${extra.detail}` : ''}`;
    say(summary);
    return { reason, passes: state.passes, rowsDone: done, rowsTotal: rows.length, exitCode: done === rows.length ? 0 : 10, lines, key };
  };

  for (;;) {
    let text = fs.readFileSync(boardFile, 'utf8');
    const rows = readRows(text);
    if (!rows.length) throw new Error(`refused: the board ${board} has no rows in a counted section`);
    const open = rows.filter(isOpen);
    if (!open.length) return finish(rows.some((r) => BLOCKED.test(r.status)) ? 'rows-blocked' : 'all-pass');
    if (state.passes >= state.cap) return finish('max-passes');
    if (io.ready) {
      const rd = io.ready(accountName);
      if (rd && rd.ready === false) return finish('not-ready', { detail: `${accountName}: ${rd.reason || 'not ready'}` });
    }
    if (capOn) {
      // REQ-1509: at 0 lanes wait intervalSeconds and read again, up to holdMaxMinutes, then stop with the reason capacity
      const holdStart = stub && Number(env.BUILDER_LOOP_STUB_HOLD_START_MS) > 0 ? Number(env.BUILDER_LOOP_STUB_HOLD_START_MS) : Date.now();
      let reads = 0;
      let last = null;
      for (;;) {
        const g = capacityLib.laneCap(orchRoot, Date.now());
        reads += 1;
        if (g.lanes === null || g.lanes > 0) {
          if (last) {
            log({ kind: 'capacity.hold', reads, seconds: Math.round((Date.now() - holdStart) / 1000), binding: last.binding || null, ended: 'pass' });
            say(`capacity: ${g.lanes === null ? 'no fresh record' : `${g.lanes} lane(s)`} — the pass runs after ${reads} read(s)`);
          }
          break;
        }
        if (!last) say(`capacity: 0 lanes (${g.binding || 'capacity'}) — holding up to ${capCfg.holdMaxMinutes} min, reading again every ${capCfg.intervalSeconds} s`);
        last = g;
        if (Date.now() - holdStart >= capCfg.holdMaxMinutes * 60000) {
          log({ kind: 'capacity.hold', reads, seconds: Math.round((Date.now() - holdStart) / 1000), binding: g.binding || null, ended: 'stop' });
          return finish('capacity', { detail: `held ${reads} read(s) at 0 lanes — ${g.binding || 'capacity'}` });
        }
        await sleep(holdPollMs);
      }
    }
    const row = open[0];
    const pass = state.passes + 1;
    const before = Object.fromEntries(rows.map((r) => [r.id, r.status]));
    text = setStatus(text, row, 'IN-PROGRESS');
    fs.writeFileSync(boardFile, text);
    const gateCmd = String(cfg.gate).split('{row}').join(row.id);
    const prevDigest = state.lastGateDigest || '(none: first pass)';
    const note = state.progressNote || '(none: first pass)';
    const ids = String(row.cites || '').split(/[,\s]+/).filter(Boolean);
    const input = `${promptText}\n\n## Pass ${pass}\nBoard: ${posix(path.relative(cwd, boardFile))}\nRow: ${row.id} — ${row.task}\nRequirement ids: ${ids.join(', ')}\nGate: ${gateCmd}\n\n## Previous gate output (digest)\n${prevDigest}\n\n## Progress note\n${note}\n`;
    const allow = ['Read', 'Grep', 'Glob', 'Edit(./**)', 'Write(./**)', `Bash(${gateCmd})`, 'Bash(git status)', 'Bash(git diff)'];
    const denyEntries = deny.flatMap((d) => [`Edit(${d}${d.endsWith('/') ? '**' : ''})`, `Write(${d}${d.endsWith('/') ? '**' : ''})`]);
    fs.mkdirSync(path.dirname(pin), { recursive: true });
    // D69: the gate command is also accepted with a `cd <own worktree> &&` prefix or one `| head/tail -n N`, through the
    // PreToolUse hook; everything else stays with the exact allow list.
    const shellAllow = path.join(__dirname, '..', '..', 'hooks', 'claude-code', 'lane-shell-allow.cjs');
    const q = (x) => (/^[\w@%+=:,./-]+$/.test(x) ? x : `'${String(x).replace(/'/g, `'\\''`)}'`);
    const preToolUse = [{ matcher: 'Bash', hooks: [{ type: 'command', command: `node ${q(shellAllow)} --gate ${q(gateCmd)} --worktree ${q(cwd)} --marker ${claude.KIT_HOOK_MARKER}`, timeout: 20 }] }];
    fs.writeFileSync(pin, JSON.stringify({ ...claude.settings({ allow, deny: denyEntries }), hooks: { PreToolUse: preToolUse, ...claude.gateHookEntries({ gateCommand: gateCmd, hookScript: path.join(__dirname, '..', '..', 'hooks', 'claude-code', 'lane-gate.cjs') }) } }, null, 2));
    const childEnvironment = childEnv(env, { worker: 'claude-code', configDir: p.configDir });
    if (env.BUILDER_LOOP_WORKER_BIN) for (const k of Object.keys(env)) if (k.startsWith('BUILDER_LOOP_STUB_')) childEnvironment[k] = env[k];
    const args = claude.launchArgs({ model: account.model || null, maxTurns: cfg.maxTurnsPerPass, settingsFile: pin, schema: VERDICT_SCHEMA });
    const started = Date.now();
    let peakRssMb = null;
    let sampler = null;
    const onSpawn = capOn
      ? (child) => {
          const sample = () => {
            const mb = capacityLib.rssMb(child.pid, rssIo);
            if (mb !== null && (peakRssMb === null || mb > peakRssMb)) peakRssMb = mb;
          };
          sample();
          sampler = setInterval(sample, rssSampleMs);
        }
      : null;
    const res = await runWorker({ bin, args, env: childEnvironment, cwd, prompt: input, passTimeoutMs: cfg.passTimeoutMinutes * 60000, stallTimeoutMs: cfg.stallMinutes * 60000, keySourceVerdict, onSpawn });
    if (sampler) clearInterval(sampler);
    const changed = changedFiles(cwd).filter((fl) => !fl.startsWith('.pipeline/'));
    // scope: denied paths and the board outside the chosen row (REQ-906, REQ-912)
    const scopeFaults = [];
    for (const fl of changed) {
      const d = denied(fl, deny);
      if (d) scopeFaults.push(`${fl} (denied: ${d})`);
    }
    const afterRows = readRows(fs.readFileSync(boardFile, 'utf8'));
    for (const r of afterRows) if (r.id !== row.id && before[r.id] !== undefined && r.status !== before[r.id]) scopeFaults.push(`board row ${r.id} changed to ${r.status} by the worker`);
    // the diff hash of the worker's own changes: the board (the runner flipped a row) is left out (REQ-910)
    const boardRel = posix(path.relative(cwd, boardFile));
    const workerFiles = changed.filter((fl) => fl !== boardRel);
    const diffHash = sha256(`${workerFiles.join('\n')}\n${git(cwd, ['diff', '--', '.', `:!${boardRel}`]).out}\n${workerFiles.filter((fl) => fs.existsSync(path.join(cwd, fl)) && fs.statSync(path.join(cwd, fl)).isFile()).map((fl) => `${fl}:${fs.readFileSync(path.join(cwd, fl), 'utf8')}`).join('\n')}`);
    let gate = { status: null, text: '' };
    if (!scopeFaults.length) {
      const g = spawnSync(gateCmd, { cwd, shell: true, encoding: 'utf8', windowsHide: true, timeout: cfg.passTimeoutMinutes * 60000, env: { ...env, BUILDER_NO_BASH_CAP: '1' } });
      gate = { status: g.status, text: `${g.stdout || ''}${g.stderr ? `\n[stderr]\n${g.stderr}` : ''}` };
    }
    const gateDigest = capOutput(gate.text, limit);
    const head = git(cwd, ['rev-parse', 'HEAD']).out;
    const verdict = readVerdict(claude.structuredVerdict(res.events), { head, claimed: ids, exitCode: res.exitCode, denials: claude.denials(res.events) });
    const why = scopeFaults.length ? `FAILED-SCOPE: ${scopeFaults.join('; ')}` : res.outcome !== 'EXITED' ? `${res.outcome}${res.keyFault ? `: ${res.keyFault}` : ''}` : gate.status !== 0 ? `gate exit ${gate.status}` : verdict.job !== 'VERDICT' ? `${verdict.job}: ${verdict.reason}` : verdict.verdict.verdict !== 'PASS' ? `verdict ${verdict.verdict.verdict}` : null;
    const passed = why === null;
    const turns = res.events.filter((e) => e && e.type === 'assistant').length;
    const result = claude.resultOf(res.events);
    const cost = result && typeof result.total_cost_usd === 'number' ? result.total_cost_usd : 'unmeasured';
    let stop = null;
    if (passed) {
      fs.writeFileSync(boardFile, setStatus(fs.readFileSync(boardFile, 'utf8'), row, 'DONE'));
      git(cwd, ['add', '-A', '--', '.', ':!.pipeline']);
      const c = git(cwd, ['commit', '-q', '-m', commitMessage({ pass, row, account: accountName })]);
      if (c.code !== 0) throw new Error(`git commit failed after a passing pass: ${c.err}`);
      state.consecutiveFailures = 0;
    } else {
      snapshots.snapshot({ repo: cwd, runId: 'loop', lane: key, branch, worktree: cwd });
      git(cwd, ['checkout', '--', '.']);
      git(cwd, ['clean', '-fdq', '-e', '.pipeline']);
      state.consecutiveFailures += 1;
      state.retries[row.id] = (state.retries[row.id] || 0) + 1;
      if (scopeFaults.length) stop = 'scope';
      else if (state.retries[row.id] >= cfg.maxRetriesPerRow) {
        fs.writeFileSync(boardFile, setStatus(fs.readFileSync(boardFile, 'utf8'), row, `BLOCKED (loop: ${state.retries[row.id]} failed passes)`));
        git(cwd, ['add', '--', posix(path.relative(cwd, boardFile))]);
        git(cwd, ['commit', '-q', '-m', `loop: ${row.id} blocked after ${state.retries[row.id]} failed passes\n\nBuilder-Account: ${accountName}\nBuilder-Requirement: ${ids.join(', ') || 'none'}\n`]);
      }
    }
    state.passes = pass;
    state.history.push({ diffHash, gateHash: sha256(gate.text) });
    state.lastGateDigest = gateDigest;
    state.progressNote = `pass ${pass}: row ${row.id} ${passed ? 'passed its gate and was committed' : `failed (${why})`}; retries ${JSON.stringify(state.retries)}`;
    fs.mkdirSync(path.dirname(progressPath(cwd, key)), { recursive: true });
    fs.appendFileSync(progressPath(cwd, key), `- ${state.progressNote}\n`);
    const rowsNow = readRows(fs.readFileSync(boardFile, 'utf8'));
    const rowsPassing = rowsNow.filter((r) => SETTLED.test(r.status)).length;
    const n = cfg.maxConsecutiveNoProgress;
    const last = state.history.slice(-n);
    if (!stop && last.length >= n && (last.every((h) => h.diffHash === last[0].diffHash) || last.every((h) => h.gateHash === last[0].gateHash)) && !passed) stop = 'no-progress';
    if (!stop && state.consecutiveFailures >= cfg.maxConsecutiveFailures) stop = 'consecutive-failures';
    if (!stop && res.outcome === 'FAILED-STALL') stop = 'stall';
    const openNow = rowsNow.filter(isOpen);
    if (!stop && !openNow.length) stop = rowsNow.some((r) => BLOCKED.test(r.status)) ? 'rows-blocked' : 'all-pass';
    if (!stop && pass >= state.cap) stop = 'max-passes';
    log({ kind: 'pass', pass, row: row.id, rowsPassing, retries: state.retries[row.id] || 0, gateDigest: sha256(gate.text), gateExit: gate.status, turns, cost, passed, why, outcome: res.outcome, verdict: verdict.job, stopReason: stop, seconds: Math.round((Date.now() - started) / 1000), ...(capOn ? { passPeakRssMb: peakRssMb, passPeakRssSource: peakRssMb === null ? 'unmeasured' : 'ps' } : {}) });
    say(`pass ${pass}: ${row.id} ${passed ? 'PASSED' : `failed — ${why}`} (${rowsPassing}/${rowsNow.length} rows done)`);
    writeJson(statePath(cwd, key), state);
    if (stop) return finish(stop, scopeFaults.length ? { detail: why } : {});
  }
}

/* ----------------------------------------------------------------- EXPERIMENTS §17 ---- */

/** One dated measurement row for §17 (REQ-909). */
function experimentRow({ date, commit, passes, rowsDone, rowsTotal, costUsd, turns, timeouts, silentFailures, note = '' }) {
  const rate = rowsTotal ? `${Math.round((rowsDone / rowsTotal) * 100)}% (${rowsDone}/${rowsTotal})` : 'no rows';
  return `| ${date} | ${commit} | ${passes} | ${rate} | ${costUsd === null || costUsd === undefined ? 'unmeasured' : `$${Number(costUsd).toFixed(2)}`} | ${turns} | ${timeouts} | ${silentFailures} | ${note} |`;
}

/** Append `row` to the table of §17 in `file`; the flag itself is never touched (experiments.cjs recordRow). */
function recordExperiment(file, row) {
  if (!fs.existsSync(file)) throw new Error(`no §17 to record into: ${file} does not exist`);
  require('./experiments.cjs').recordRow(file, 17, row);
}

module.exports = { FEATURE, STOPS, BYPASS, HARNESS_CONFIG, readRows, setStatus, isOpen, bypassFault, capOutput, denyList, denied, changedFiles, commitMessage, runLoop, experimentRow, recordExperiment, statePath, logPath, progressPath };
