'use strict';
/**
 * Token accounting from OpenAI Codex CLI session transcripts (`features.costAccounting.reader === "codex"`).
 *
 * WHOSE LAYOUT THIS IS. The Codex CLI writes one "rollout" file per thread under
 * `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<timestamp>-<thread id>.jsonl` (`CODEX_HOME` defaults to `~/.codex`).
 * Every line is one JSON object with the envelope `{ timestamp, ordinal?, type, payload }`. The shapes read here were
 * verified against the `openai/codex` repository on 2026-11-17 (branch `main`, fetched file by file from
 * `https://raw.githubusercontent.com/openai/codex/main/<path>`):
 *
 *   - sessions directory and file name: `codex-rs/rollout/src/lib.rs` (`SESSIONS_SUBDIR`), `codex-rs/rollout/src/recorder.rs`
 *     (`YYYY/MM/DD`, `rollout-<timestamp>-<conversation_id>.jsonl`), `codex-rs/core/src/config/mod.rs` (`find_codex_home`)
 *   - line envelope: `RolloutLineRef` in `recorder.rs`; `RolloutItemWire` in `codex-rs/history/src/rollout_payload.rs`
 *     (`#[serde(tag = "type", rename_all = "snake_case")]`, every variant carries `payload`)
 *   - `type: "session_meta"` payload: `SessionMeta` / `SessionMetaLine` in `codex-rs/protocol/src/protocol.rs`
 *     (`id`, `timestamp`, `cwd`, `originator`, `cli_version`, `model_provider`, optional `agent_role`)
 *   - `type: "turn_context"` payload: `TurnContextItem` (`model`)
 *   - `type: "event_msg"`, `payload.type: "token_count"`: `TokenCountEvent { info: TokenUsageInfo | null, rate_limits:
 *     RateLimitSnapshot | null }`; `TokenUsageInfo { total_token_usage, last_token_usage, model_context_window }`;
 *     persisted in every history mode (`persisted_event_msg` in `codex-rs/rollout/src/policy.rs`)
 *   - `TokenUsage { input_tokens, cached_input_tokens, cache_write_input_tokens (default 0), output_tokens,
 *     reasoning_output_tokens, total_tokens }`. `cached_input_tokens` is PART OF `input_tokens` (`non_cached_input`
 *     in `impl TokenUsage`); `reasoning_output_tokens` is PART OF `output_tokens` (it maps the Responses API
 *     `output_tokens_details.reasoning_tokens`, `codex-rs/codex-api/src/sse/responses.rs`)
 *   - `type: "token_usage_record"` payload: `TokenUsageRecord { usage, turn_token_usage, thread_token_usage, response_id }`
 *
 * TWO LAYERS, ONE FILE.
 *   1. The RECORD layer: `parseLine(text, lineNo)` → one typed record or null; `records(text)` → every record of a
 *      file, in order. It keeps every kind it recognises and passes `payload.rate_limits` through RAW as `rateLimits`
 *      on each `token_count` record. Rate-limit reading (the accounts tool) lives HERE, on top of these records; it
 *      needs no second parser. Only the shapes verified above are parsed; anything else is an `unrecognised` record
 *      with its line number and a reason, never a guess.
 *   2. The COST layer: `sessionUsage(records, window)` and `collect(dir, window)` sum a session and a directory into
 *      the shape `cost-window` already consumes from `session-usage.cjs` (`perModel` rows that `pricing.cost()` reads).
 *
 * HOW USAGE IS SUMMED. `total_token_usage` is cumulative for the thread, so a session's usage is the sum of the
 * differences between consecutive `token_count` totals. A repeated total (a rate-limit refresh) adds zero; a resumed
 * session continues the sum; a total that DECREASES marks the whole session unmeasurable with the line number. Each
 * difference is attributed to the model of the latest `turn_context` before it, and to the event's timestamp for the
 * window. `last_token_usage` and `token_usage_record` are parsed but not summed: summing both would count a response
 * twice, and older Codex builds write no `token_usage_record` at all.
 *
 * WHAT IT PRICES. `inputTokens = input_tokens - cached_input_tokens`, `cacheReadTokens = cached_input_tokens`,
 * `cacheWriteTokens = cache_write_input_tokens`, `outputTokens = output_tokens` (reasoning included, not added again).
 * `pricing.cjs` ships no OpenAI rates (the published page could not be cited with model names on the day), so Codex
 * usage is UNPRICED unless `--rates <file>` names a table: tokens are reported, cost is never $0.
 *
 * Reads only; never writes a transcript. Every failure path returns EMPTY or says "unmeasurable", never zero.
 */
const { existsSync, readdirSync, readFileSync, statSync } = require('node:fs');
const { homedir } = require('node:os');
const { join } = require('node:path');

/** Same cap and reasoning as `transcript-usage.cjs`: a quiet truncation changes the answer; `scanCoverage` says when it bites. */
const DEFAULT_LIMIT = 250;

/** `--transcripts <dir>` wins; else `$CODEX_HOME/sessions`; else `~/.codex/sessions`. */
function sessionsDir(explicit = null, env = process.env) {
  if (explicit) return explicit;
  if (env.CODEX_HOME) return join(env.CODEX_HOME, 'sessions');
  return join(homedir(), '.codex', 'sessions');
}

const isRollout = (name) => name.startsWith('rollout-') && name.endsWith('.jsonl');

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && isRollout(e.name)) out.push(p);
  }
  return out;
}

/** Newest-first rollout files under `dir` (recursive: `YYYY/MM/DD`), capped. */
function jsonlFiles(dir, limit = DEFAULT_LIMIT) {
  if (!dir || !existsSync(dir)) return [];
  return walk(dir, [])
    .map((f) => ({ f, m: statSync(f).mtimeMs }))
    .sort((a, b) => b.m - a.m)
    .slice(0, limit)
    .map((x) => x.f);
}

function scanCoverage(dir, limit = DEFAULT_LIMIT) {
  const total = dir && existsSync(dir) ? walk(dir, []).length : 0;
  const scanned = Math.min(total, limit);
  return { total, scanned, truncated: scanned < total, limit };
}

/* ---------------------------------------------------------------- record layer */

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : null);

/**
 * Normalise a `TokenUsage` object. `input_tokens`, `cached_input_tokens` and `output_tokens` must be numbers (the
 * protocol marks them required); `cache_write_input_tokens` and `reasoning_output_tokens` default to 0 (the protocol
 * defaults the first; the second is required in the source but harmless when absent, since it is never summed alone).
 * @returns {{ usage: object|null, reason: string|null }}
 */
function usageOf(u) {
  if (!isObject(u)) return { usage: null, reason: 'usage is not an object' };
  for (const k of ['input_tokens', 'cached_input_tokens', 'output_tokens']) {
    if (typeof u[k] !== 'number' || !Number.isFinite(u[k])) return { usage: null, reason: `${k} is not a number` };
  }
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    usage: {
      inputTokens: u.input_tokens,
      cachedInputTokens: u.cached_input_tokens,
      cacheWriteInputTokens: n(u.cache_write_input_tokens),
      outputTokens: u.output_tokens,
      reasoningOutputTokens: n(u.reasoning_output_tokens),
      totalTokens: n(u.total_tokens),
    },
    reason: null,
  };
}

const unrecognised = (line, reason) => ({ kind: 'unrecognised', line, reason });

/**
 * One line → one typed record, or `null` for an empty line.
 * Kinds: `session_meta` · `turn_context` · `token_count` · `token_usage_record` · `other` (the envelope with a type
 * this reader does not use) · `unrecognised` (anything else, with a reason).
 */
function parseLine(text, line = 1) {
  if (text === undefined || text === null || text.trim() === '') return null;
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return unrecognised(line, 'not JSON');
  }
  if (!isObject(obj)) return unrecognised(line, 'not a JSON object');
  const timestamp = str(obj.timestamp);
  const type = str(obj.type);
  if (!timestamp || !type) return unrecognised(line, 'no { timestamp, type } envelope');
  const payload = isObject(obj.payload) ? obj.payload : null;
  switch (type) {
    case 'session_meta': {
      if (!payload) return unrecognised(line, 'session_meta without a payload object');
      return {
        kind: 'session_meta',
        line,
        timestamp,
        sessionId: str(payload.id),
        cwd: str(payload.cwd),
        originator: str(payload.originator),
        cliVersion: str(payload.cli_version),
        modelProvider: str(payload.model_provider),
        agentRole: str(payload.agent_role) ?? str(payload.agent_type),
        payload,
      };
    }
    case 'turn_context': {
      if (!payload || !str(payload.model)) return unrecognised(line, 'turn_context without a model');
      return { kind: 'turn_context', line, timestamp, model: payload.model, payload };
    }
    case 'event_msg': {
      if (!payload || !str(payload.type)) return unrecognised(line, 'event_msg without a payload type');
      if (payload.type !== 'token_count') return { kind: 'other', line, timestamp, type: `${payload.type}` };
      const info = payload.info;
      if (info === null || info === undefined) {
        // The protocol allows `info: null` (a rate-limit-only event). It carries no usage; the cost layer skips it.
        return { kind: 'token_count', line, timestamp, total: null, last: null, contextWindow: null, rateLimits: payload.rate_limits ?? null };
      }
      if (!isObject(info)) return unrecognised(line, 'token_count.info is not an object');
      const total = usageOf(info.total_token_usage);
      if (!total.usage) return unrecognised(line, `token_count.info.total_token_usage: ${total.reason}`);
      const last = usageOf(info.last_token_usage);
      return {
        kind: 'token_count',
        line,
        timestamp,
        total: total.usage,
        last: last.usage,
        contextWindow: typeof info.model_context_window === 'number' ? info.model_context_window : null,
        rateLimits: payload.rate_limits ?? null,
      };
    }
    case 'token_usage_record': {
      if (!payload) return unrecognised(line, 'token_usage_record without a payload object');
      const usage = usageOf(payload.usage);
      if (!usage.usage) return unrecognised(line, `token_usage_record.usage: ${usage.reason}`);
      return {
        kind: 'token_usage_record',
        line,
        timestamp,
        usage: usage.usage,
        turnUsage: usageOf(payload.turn_token_usage).usage,
        threadUsage: usageOf(payload.thread_token_usage).usage,
        responseId: str(payload.response_id),
      };
    }
    default:
      return { kind: 'other', line, timestamp, type };
  }
}

/**
 * Every record of a file, in order. A non-JSON LAST line is `torn` (a live session is still writing it) and is
 * reported as such; a non-JSON line anywhere else is `unrecognised`.
 */
function records(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const out = [];
  lines.forEach((l, i) => {
    const r = parseLine(l, i + 1);
    if (!r) return;
    if (r.kind === 'unrecognised' && r.reason === 'not JSON' && i === lines.length - 1) out.push({ kind: 'torn', line: i + 1 });
    else out.push(r);
  });
  return out;
}

/* ---------------------------------------------------------------- cost layer */

const inWindow = (ts, since, until) => (!since || ts >= since) && (!until || ts <= until);

/**
 * Sum one session: deltas of the cumulative `token_count` totals, per model, inside an optional window.
 * The result carries the `sumTurns` fields `cost-window` and `pricing.cost()` read, plus `measurable` / `reason`.
 */
function sessionUsage(recs, { since = null, until = null } = {}) {
  const perModel = {};
  let model = null;
  let prev = null;
  let firstTs = null;
  let lastTs = null;
  let turns = 0;
  let reasoning = 0;
  let unrec = 0;
  let meta = null;
  for (const r of recs) {
    if (r.kind === 'unrecognised') unrec += 1;
    if (r.kind === 'session_meta' && !meta) meta = r;
    if (r.kind === 'turn_context') model = r.model;
    if (r.kind !== 'token_count' || !r.total) continue;
    const t = r.total;
    const base = prev ?? { inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 };
    const d = {
      input: t.inputTokens - base.inputTokens,
      cached: t.cachedInputTokens - base.cachedInputTokens,
      cacheWrite: t.cacheWriteInputTokens - base.cacheWriteInputTokens,
      output: t.outputTokens - base.outputTokens,
      reasoning: t.reasoningOutputTokens - base.reasoningOutputTokens,
    };
    if (Object.values(d).some((v) => v < 0)) {
      return { measurable: false, reason: `total token usage decreases at line ${r.line} (a cumulative total cannot fall; the file is not a sum this reader can trust)`, seat: seatOf(meta), sessionId: meta?.sessionId ?? null, turns: 0, perModel: [] };
    }
    prev = t;
    if (!inWindow(r.timestamp, since, until)) continue;
    if (d.input === 0 && d.output === 0 && d.cacheWrite === 0) continue; // a repeated total: no new response
    const m = (perModel[model ?? 'unknown'] ??= { model: model ?? 'unknown', turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, promptTokens: 0 });
    m.turns += 1;
    m.inputTokens += d.input - d.cached;
    m.cacheReadTokens += d.cached;
    m.cacheWriteTokens += d.cacheWrite;
    m.outputTokens += d.output;
    m.promptTokens += d.input;
    reasoning += d.reasoning;
    turns += 1;
    if (!firstTs || r.timestamp < firstTs) firstTs = r.timestamp;
    if (!lastTs || r.timestamp > lastTs) lastTs = r.timestamp;
  }
  const models = Object.values(perModel);
  const sum = (k) => models.reduce((a, m) => a + m[k], 0);
  const dominant = [...models].sort((a, b) => b.turns - a.turns)[0]?.model ?? null;
  return {
    measurable: true,
    reason: null,
    seat: seatOf(meta),
    sessionId: meta?.sessionId ?? null,
    turns,
    model: dominant,
    perModel: models,
    inputTokens: sum('inputTokens'),
    outputTokens: sum('outputTokens'),
    cacheReadTokens: sum('cacheReadTokens'),
    cacheWriteTokens: sum('cacheWriteTokens'),
    promptTokens: sum('promptTokens'),
    reasoningTokens: reasoning,
    unrecognised: unrec,
    firstTs,
    lastTs,
    durationMs: firstTs && lastTs ? Date.parse(lastTs) - Date.parse(firstTs) : 0,
  };
}

/** Codex writes no `agentType`; `agent_role` names a sub-agent's role when there is one. One session = one dispatch. */
const seatOf = (meta) => meta?.agentRole ?? 'codex-session';

/**
 * Every session under `dir`, summed inside the window.
 * @returns {{ sessions: {file, sessionId, seat, summary}[], unmeasurable: {file, reason}[], coverage: object }}
 */
function collect(dir, { since = null, until = null, limit = DEFAULT_LIMIT } = {}) {
  const sessions = [];
  const unmeasurable = [];
  for (const file of jsonlFiles(dir, limit)) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch (e) {
      unmeasurable.push({ file, reason: `unreadable: ${e.message}` });
      continue;
    }
    const summary = sessionUsage(records(text), { since, until });
    if (!summary.measurable) {
      unmeasurable.push({ file, reason: summary.reason });
      continue;
    }
    sessions.push({ file, sessionId: summary.sessionId, seat: summary.seat, summary });
  }
  return { sessions, unmeasurable, coverage: scanCoverage(dir, limit) };
}

module.exports = { DEFAULT_LIMIT, sessionsDir, jsonlFiles, scanCoverage, usageOf, parseLine, records, sessionUsage, collect };
