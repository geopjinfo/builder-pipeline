'use strict';
/**
 * Credit-lane worker adapter — Claude Code (`features.orchestrator.credit.worker: "claude-code"`).
 *
 * Everything harness-specific about a headless credit worker lives here; orch-credit.cjs holds the guards that do
 * not depend on the harness (allow list, scope check, integrity check, caps, fallback chain, review hold). Another
 * harness gets its own adapter with the same exports.
 *
 *   start      `claude -p --output-format stream-json --verbose` with the prompt on STDIN. Never --bare (it would
 *              skip the repo's own fence hooks). --strict-mcp-config (no MCP servers), --setting-sources project
 *              (repo hooks stay; no user or local settings), --permission-mode dontAsk with an exact allow list,
 *              bypass mode disabled, --no-session-persistence, a per-job --max-budget-usd.
 *   key source the stream is read up to the system/init event. Its apiKeySource must be what the account should use:
 *              the API key for the credit lane, "none" (an OAuth login) for a plan account. Anything else — or a
 *              non-hook event before init — stops the worker before any model call. A plan account that would bill
 *              the key is stopped the same way.
 *   env        every CLAUDE* variable is dropped (an inherited one makes the child a nested session); the credit
 *              lane runs in a clean guard config dir; a plan account gets its own config dir (secondary) or the
 *              default (primary), and never the API key or an auth token. Values are never read or printed.
 *
 * Tests drive a stub binary through BUILDER_CREDIT_WORKER_BIN (tests/fixtures/orch/stub-worker.cjs).
 */
const fs = require('fs');
const path = require('path');

const NAME = 'claude-code';
const API_KEY_VAR = 'ANTHROPIC_API_KEY';
const KEY_SOURCE = Object.freeze({ credit: API_KEY_VAR, secondary: 'none', primary: 'none' });
/** The harness's own config: never written by a credit job, whatever its scope says. */
const CONFIG_GLOBS = Object.freeze(['.claude/**', 'CLAUDE.md', '.mcp.json']);
const DEFAULT_GUARD_DIR = '.claude-credit-worker';
const DENIED_TEXT = /haven't granted|requested permissions|permission to use|denied|blocked by|hook error/i;

function settings({ allow, deny }) {
  return {
    autoMemoryEnabled: false,
    permissions: { allow, deny, defaultMode: 'dontAsk', disableBypassPermissionsMode: 'disable' },
  };
}

function args(t, settingsFile) {
  const out = [
    '-p', '--output-format', 'stream-json', '--verbose',
    '--model', t.model, '--max-budget-usd', String(t.budgetUsd),
    '--permission-mode', 'dontAsk', '--strict-mcp-config', '--setting-sources', 'project',
    '--settings', settingsFile, '--no-session-persistence',
  ];
  if (out.includes('--bare')) throw new Error('internal: --bare is never used (it skips the fence hooks)');
  return out;
}

/** The allow-list entries for a job: read tools, Edit/Write per glob, and whole named Bash commands (no wildcards). */
const allowEntries = ({ writeGlobs, commands }) => ['Read', 'Grep', 'Glob', ...writeGlobs.map((g) => `Edit(${g})`), ...writeGlobs.map((g) => `Write(${g})`), ...commands.map((c) => `Bash(${c})`)];
const denyEntries = ({ forbidden }) => forbidden.flatMap((g) => [`Edit(${g})`, `Write(${g})`]);

/**
 * The worker env. credit = the guard dir (the key stays, inherited from the shell — never read here);
 * secondary = `configDir` under home, key and token removed; primary = the default config dir, key and token removed.
 */
function env(base, home, account, { guardDir = DEFAULT_GUARD_DIR, secondaryConfigDir = null } = {}) {
  const out = {};
  for (const k of Object.keys(base)) if (!/^CLAUDE/i.test(k)) out[k] = base[k];
  if (account === 'credit') {
    out.CLAUDE_CONFIG_DIR = path.join(home, guardDir);
    return out;
  }
  for (const k of Object.keys(out)) if (/^ANTHROPIC_(API_KEY|AUTH_TOKEN)$/i.test(k)) delete out[k];
  if (account === 'secondary') {
    if (!secondaryConfigDir) throw new Error('refused: the secondary account has no config dir (features.orchestrator.secondaryConfigDir)');
    out.CLAUDE_CONFIG_DIR = path.join(home, secondaryConfigDir);
  }
  return out;
}

/** A guard dir that carries user memory, plugins or MCP servers is refused (it would leak into the worker). */
function guardDirFaults(dir) {
  const faults = [];
  if (fs.existsSync(path.join(dir, 'CLAUDE.md'))) faults.push(`${dir}/CLAUDE.md exists (user memory)`);
  try {
    if (fs.readdirSync(path.join(dir, 'plugins')).length) faults.push(`${dir}/plugins is not empty`);
  } catch (_) {
    /* none */
  }
  for (const f of ['settings.json', '.claude.json']) {
    let j = null;
    try {
      j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    } catch (_) {
      continue;
    }
    if (j && j.enabledPlugins && Object.keys(j.enabledPlugins).length) faults.push(`${dir}/${f} enables plugins`);
    if (j && j.mcpServers && Object.keys(j.mcpServers).length) faults.push(`${dir}/${f} declares MCP servers`);
  }
  return faults;
}

/** Judge the events seen so far. null = keep reading; 'ok' = init passed; otherwise the fault. */
function keySourceVerdict(events, expected = API_KEY_VAR) {
  for (const ev of events) {
    if (ev && ev.type === 'system' && ev.subtype === 'init') {
      return ev.apiKeySource === expected ? 'ok' : `apiKeySource is ${JSON.stringify(ev.apiKeySource)}, not ${expected} — worker stopped before any model call`;
    }
    if (!(ev && ev.type === 'system' && /^hook/.test(String(ev.subtype)))) {
      return `first non-hook stream event is ${ev && ev.type}/${ev && ev.subtype}, not system/init — worker stopped`;
    }
  }
  return events.length > 50 ? 'no system/init within 50 events — worker stopped' : null;
}

/** The job's cost from its own stream: the last result's total_cost_usd; $0 when refused at init before any model event; else null. */
function streamCost(events, keyFault) {
  const result = [...events].reverse().find((e) => e && e.type === 'result');
  if (result && typeof result.total_cost_usd === 'number' && Number.isFinite(result.total_cost_usd)) return result.total_cost_usd;
  if (keyFault && !events.some((e) => e && (e.type === 'result' || e.type === 'assistant'))) return 0;
  return null;
}

const resultOf = (events) => [...events].reverse().find((e) => e && e.type === 'result') || null;
const resultLine = (result) => (result && typeof result.result === 'string' ? result.result.split(/\r?\n/).reverse().find((l) => /^RESULT: /.test(l)) || null : null);
/** Did the run itself succeed (independent of the job's own RESULT line)? */
const runSucceeded = (result, exitCode) => !!result && !result.is_error && result.subtype === 'success' && exitCode === 0;
/** The API error texts of a failed run (for classification). */
const errorTexts = (result) => (result && result.is_error ? [String(result.result ?? ''), JSON.stringify(result.errors ?? '')] : []);

const describeInput = (i = {}) => String(i.command ?? i.file_path ?? i.path ?? i.pattern ?? JSON.stringify(i)).slice(0, 160);

/** Every denied action in the stream, de-duplicated by tool_use_id. */
function denials(events) {
  const uses = new Map();
  const out = new Map();
  for (const ev of events) {
    const content = ev && ev.message && Array.isArray(ev.message.content) ? ev.message.content : [];
    if (ev.type === 'assistant') for (const c of content) if (c.type === 'tool_use') uses.set(c.id, c);
    if (ev.type === 'user') {
      for (const c of content) {
        if (c.type !== 'tool_result' || !c.is_error) continue;
        const text = Array.isArray(c.content) ? c.content.map((x) => x.text || '').join(' ') : String(c.content || '');
        if (!DENIED_TEXT.test(text)) continue;
        const u = uses.get(c.tool_use_id);
        out.set(c.tool_use_id, `${u ? u.name : 'tool'}: ${u ? describeInput(u.input) : '?'}`);
      }
    }
    if (ev.type === 'result' && Array.isArray(ev.permission_denials)) {
      for (const d of ev.permission_denials) out.set(d.tool_use_id || `${d.tool_name}:${describeInput(d.tool_input)}`, `${d.tool_name}: ${describeInput(d.tool_input)}`);
    }
  }
  return [...out.values()];
}

/** The worker binary as an absolute path (never a bare name: a cwd-first lookup would run a worker-written file). */
function resolveBin(envIn = process.env) {
  if (envIn.BUILDER_CREDIT_WORKER_BIN) {
    const b = envIn.BUILDER_CREDIT_WORKER_BIN;
    if (!path.isAbsolute(b) || !fs.existsSync(b)) throw new Error(`refused: BUILDER_CREDIT_WORKER_BIN must be an absolute path to an existing file (${b})`);
    return b;
  }
  for (const d of String(envIn.PATH || envIn.Path || '').split(path.delimiter).filter((p) => p && path.isAbsolute(p))) {
    const exe = path.join(d, process.platform === 'win32' ? 'claude.exe' : 'claude');
    if (fs.existsSync(exe)) return exe;
    const shimmed = path.join(d, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    if (fs.existsSync(path.join(d, 'claude.cmd')) && fs.existsSync(shimmed)) return shimmed;
  }
  throw new Error('refused: no claude executable on an absolute PATH entry');
}

module.exports = {
  NAME, API_KEY_VAR, KEY_SOURCE, CONFIG_GLOBS, DEFAULT_GUARD_DIR,
  settings, args, allowEntries, denyEntries, env, guardDirFaults, keySourceVerdict, streamCost, resultOf, resultLine, runSucceeded, errorTexts, denials, resolveBin,
};
