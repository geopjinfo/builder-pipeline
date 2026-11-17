'use strict';
/**
 * Worker adapter — Codex (`worker: "codex"` in an account, plan M6, REQ-601 to REQ-604, D20, D26).
 *
 * Everything harness-specific about a headless Codex worker lives here, with the same exports as the Claude Code
 * adapter, so the runner and the credit lane treat the two alike.
 *
 *   start       `codex exec --json --output-schema <file> --sandbox <mode> -` with the prompt on stdin; `-o <file>`
 *               writes the last agent message (the verdict JSON). No turn cap or timeout flag exists: the runner
 *               (worker-runner.cjs) owns the pass timeout and the stall window (REQ-603).
 *   env         worker-env.cjs allowlist; CODEX_HOME is the account's config dir (REQ-601).
 *   key source  the CLI exposes no key source in its stream. The proof is `codex login status` before the launch:
 *               "Logged in using ChatGPT" for a subscription account, "Logged in using an API key" for an api-key
 *               account; a mismatch or "Not logged in" stops the job before any model call; text the kit cannot read
 *               is reported as unconfirmed, never as proved (REQ-602). KEY_SOURCE_PROOF names that state.
 *   verdict     the last agent message, parsed as the result schema (REQ-604; worker-verdict.cjs judges it).
 *   errors      classifyError → LIMIT | BUDGET | OVERLOAD | AUTH (worker-errors.cjs).
 *
 * Tests drive a stub binary through BUILDER_CODEX_WORKER_BIN (tests/fixtures/orch/stub-codex.cjs).
 */
const fs = require('fs');
const path = require('path');
const { childEnv } = require('./worker-env.cjs');
const { classifyError } = require('./worker-errors.cjs');

const NAME = 'codex';
const KEY_SOURCE_PROOF = 'unconfirmed';
const SANDBOXES = Object.freeze(['read-only', 'workspace-write']);
const DENIED_TEXT = /sandbox|denied|not permitted|approval (required|needed)|blocked/i;

/** The launch argv. The prompt arrives on stdin (`-`). */
function args({ schemaFile, sandbox = 'workspace-write', outFile = null, model = null } = {}) {
  if (typeof schemaFile !== 'string' || !schemaFile) throw new Error('codex adapter: schemaFile is required (--output-schema, REQ-604)');
  if (!SANDBOXES.includes(sandbox)) throw new Error(`codex adapter: sandbox must be one of ${SANDBOXES.join(' | ')} (never danger-full-access)`);
  const out = ['exec', '--json', '--output-schema', schemaFile, '--sandbox', sandbox];
  if (model) out.push('--model', model);
  if (outFile) out.push('-o', outFile);
  out.push('-');
  return out;
}

/** The child env: allowlist plus the account block, CODEX_HOME set (REQ-601). */
const env = (parent, { configDir, accountEnv = {} }) => childEnv(parent, { worker: NAME, configDir, accountEnv });

/**
 * The key-source proof from `codex login status` output.
 * @returns {{ source: 'chatgpt'|'api-key'|'none'|'unconfirmed', fault: string|null }}
 */
function preflightKeySource(statusText, pays) {
  const t = String(statusText || '');
  let source = 'unconfirmed';
  if (/not logged in/i.test(t)) source = 'none';
  else if (/logged in (using|with|via) (an? )?api[ -]?key/i.test(t)) source = 'api-key';
  else if (/logged in (using|with|via) chatgpt/i.test(t)) source = 'chatgpt';
  if (source === 'none') return { source, fault: 'codex is not logged in on this account — worker stopped before any model call (codex login)' };
  const want = pays === 'api-key' ? 'api-key' : pays === 'subscription' ? 'chatgpt' : null;
  if (want && source !== 'unconfirmed' && source !== want) return { source, fault: `codex login is ${source}, the account pays by ${pays} — worker stopped before any model call` };
  return { source, fault: null };
}

/** The stream carries no key source: the first event is enough to go on (the proof was taken before the launch). */
const keySourceVerdict = (events) => (events.length ? 'ok' : null);

const agentMessages = (events) => events.filter((e) => e && e.type === 'item.completed' && e.item && e.item.type === 'agent_message' && typeof e.item.text === 'string');
const failed = (events) => events.find((e) => e && (e.type === 'turn.failed' || e.type === 'error'));

/** The last agent message parsed as JSON (the verdict), else the text of `outFile`, else null. */
function verdict(events, outFile = null) {
  const msgs = agentMessages(events);
  const text = msgs.length ? msgs[msgs.length - 1].item.text : outFile && fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : null;
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

const resultOf = (events) => [...events].reverse().find((e) => e && e.type === 'turn.completed') || null;
const runSucceeded = (events, exitCode) => exitCode === 0 && !!resultOf(events) && !failed(events);
const errorTexts = (events, stderr = '') => [...events.filter((e) => e && (e.type === 'turn.failed' || e.type === 'error')).map((e) => JSON.stringify(e.error || e.message || e)), stderr].filter(Boolean);
/** Token usage of the run, or null; Codex prints no price, so the cost is unpriced here. */
function usage(events) {
  const r = resultOf(events);
  return r && r.usage ? r.usage : null;
}
const streamCost = () => null;

/** Every tool the sandbox or an approval refused. */
function denials(events) {
  const out = [];
  for (const e of events) {
    if (!e || e.type !== 'item.completed' || !e.item) continue;
    const it = e.item;
    const text = String(it.aggregated_output || it.output || it.error || '');
    if ((it.status === 'failed' || it.status === 'declined') && DENIED_TEXT.test(text)) out.push(`${it.type}: ${String(it.command || it.title || '?').slice(0, 160)}`);
  }
  return out;
}

/** The codex binary as an absolute path (never a bare name). */
function resolveBin(envIn = process.env) {
  if (envIn.BUILDER_CODEX_WORKER_BIN) {
    const b = envIn.BUILDER_CODEX_WORKER_BIN;
    if (!path.isAbsolute(b) || !fs.existsSync(b)) throw new Error(`refused: BUILDER_CODEX_WORKER_BIN must be an absolute path to an existing file (${b})`);
    return b;
  }
  for (const d of String(envIn.PATH || envIn.Path || '').split(path.delimiter).filter((p) => p && path.isAbsolute(p))) {
    const exe = path.join(d, process.platform === 'win32' ? 'codex.exe' : 'codex');
    if (fs.existsSync(exe)) return exe;
    const shimmed = path.join(d, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (fs.existsSync(path.join(d, 'codex.cmd')) && fs.existsSync(shimmed)) return shimmed;
  }
  throw new Error('refused: no codex executable on an absolute PATH entry');
}

module.exports = {
  NAME, KEY_SOURCE_PROOF, SANDBOXES,
  args, env, preflightKeySource, keySourceVerdict, verdict, resultOf, runSucceeded, errorTexts, usage, streamCost, denials, resolveBin, classifyError,
};
