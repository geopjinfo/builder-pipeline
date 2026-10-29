'use strict';
/**
 * Token accounting from the transcripts themselves — every seat, background or not, and the
 * orchestrator's own turns.
 *
 * WHOSE LAYOUT THIS IS. The directory layout and record shapes read here are **Claude Code's**: a
 * per-project transcript directory holding `<sessionId>.jsonl`, and beside it
 * `<sessionId>/subagents/agent-<agentId>.jsonl` (+ `.meta.json`). Another harness writes no such
 * files, so every reader here returns EMPTY there and the board renders the seat as **unmeasured**
 * (an em-dash) — never as a zero. Supporting another harness means another reader with the same
 * return shapes, not a change to the renderer.
 *
 * WHY THIS EXISTS. `transcript-usage.collect()` reads the `toolUseResult` an `Agent` dispatch lands in
 * the orchestrator's transcript. A BACKGROUND dispatch lands one with no usage at all — its keys are
 * `isAsync, status, agentId, description, resolvedModel, prompt, outputFile, canReadOutputFile` — and
 * a pipeline that runs its auditors in parallel dispatches them in the background. Read that way, in
 * one adopting project, the board summed to a small fraction of what the run measured from its
 * transcripts: the seats that ran in parallel were simply not in the sum, and neither was the
 * orchestrator — one of the largest seats of all.
 *
 * WHERE THE TRUTH IS. Every subagent writes its own transcript (plus `.meta.json` with its
 * `agentType`), and every assistant message in it carries `usage`. A message is written as several
 * lines (one per content block) repeating the SAME usage, so turns are de-duplicated by `message.id`
 * — in one probe 58 lines were 12 messages, and summing lines would have counted one turn up to 14
 * times. The orchestrator's turns are the non-sidechain assistant messages of the session transcript,
 * de-duplicated the same way.
 *
 * Reads only; never writes a transcript. Every failure path returns EMPTY, never zero.
 */
const { existsSync, readdirSync, readFileSync } = require('node:fs');
const { join } = require('node:path');

const num = (v) => (typeof v === 'number' ? v : 0);

function records(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* a torn last line while the session is live */
    }
  }
  return out;
}

/**
 * Sum assistant turns, de-duplicated by message id (the LAST line of a message wins).
 * @param {object[]} recs
 * @param {{ sidechain?: boolean|null, since?: string|null, until?: string|null }} filter
 *   `sidechain: false` = orchestrator turns only; `null` = every assistant turn in the file.
 */
function sumTurns(recs, { sidechain = null, since = null, until = null } = {}) {
  const byId = new Map();
  let firstTs = null;
  let lastTs = null;
  for (const r of recs) {
    if (r.type !== 'assistant' || !r.message) continue;
    if (sidechain !== null && Boolean(r.isSidechain) !== sidechain) continue;
    if (since && r.timestamp && r.timestamp < since) continue;
    if (until && r.timestamp && r.timestamp > until) continue;
    const model = r.message.model;
    if (!model || model === '<synthetic>') continue;
    byId.set(r.message.id ?? r.uuid, { model, usage: r.message.usage ?? {} });
    if (r.timestamp) {
      if (!firstTs || r.timestamp < firstTs) firstTs = r.timestamp;
      if (!lastTs || r.timestamp > lastTs) lastTs = r.timestamp;
    }
  }
  const perModel = {};
  for (const { model, usage: u } of byId.values()) {
    const m = (perModel[model] ??= {
      model,
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
    });
    m.turns += 1;
    m.inputTokens += num(u.input_tokens);
    m.outputTokens += num(u.output_tokens);
    m.cacheReadTokens += num(u.cache_read_input_tokens);
    m.cacheWriteTokens += num(u.cache_creation_input_tokens);
    m.cacheWrite5mTokens += num(u.cache_creation?.ephemeral_5m_input_tokens);
    m.cacheWrite1hTokens += num(u.cache_creation?.ephemeral_1h_input_tokens);
  }
  const models = Object.values(perModel);
  const sum = (k) => models.reduce((a, m) => a + m[k], 0);
  const dominant = models.sort((a, b) => b.turns - a.turns)[0]?.model ?? null;
  return {
    turns: byId.size,
    model: dominant,
    perModel: models,
    inputTokens: sum('inputTokens'),
    outputTokens: sum('outputTokens'),
    cacheReadTokens: sum('cacheReadTokens'),
    cacheWriteTokens: sum('cacheWriteTokens'),
    cacheWrite5mTokens: sum('cacheWrite5mTokens'),
    cacheWrite1hTokens: sum('cacheWrite1hTokens'),
    firstTs,
    lastTs,
    durationMs: firstTs && lastTs ? Date.parse(lastTs) - Date.parse(firstTs) : 0,
  };
}

/** Cost of a `sumTurns` result, model by model; `null` if any model is unpriced. */
function costOf(summary, pricing) {
  let total = 0;
  for (const m of summary.perModel) {
    const c = pricing.cost(m.model, m);
    if (c === null) return null;
    total += c;
  }
  return total;
}

/** `agentId → { file, sessionId, agentType }` across every session directory of a project. */
function subagentIndex(projectDir) {
  const index = new Map();
  if (!existsSync(projectDir)) return index;
  for (const entry of readdirSync(projectDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(projectDir, entry.name, 'subagents');
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const m = /^agent-(.+)\.jsonl$/.exec(name);
      if (!m) continue;
      let agentType = null;
      try {
        agentType = JSON.parse(readFileSync(join(dir, `agent-${m[1]}.meta.json`), 'utf8')).agentType ?? null;
      } catch {
        /* no meta — keep the row, type unknown */
      }
      // A resumed or forked session copies the parent's subagent transcripts without their meta files.
      // The same agent id then appears twice, and the copy must not erase the type the original recorded.
      agentType ??= index.get(m[1])?.agentType ?? null;
      index.set(m[1], { file: join(dir, name), sessionId: entry.name, agentType });
    }
  }
  return index;
}

/** One seat dispatch, from its own transcript. `null` when the file is not on this machine. */
function subagentUsage(agentId, index) {
  const hit = index.get(agentId);
  if (!hit) return null;
  return { agentId, agentType: hit.agentType, sessionId: hit.sessionId, ...sumTurns(records(hit.file)) };
}

/** The orchestrator's own turns in the named sessions, inside an optional window. */
function orchestratorUsage(projectDir, sessionIds, since = null, until = null) {
  const recs = [];
  for (const id of sessionIds) recs.push(...records(join(projectDir, `${id}.jsonl`)));
  return sumTurns(recs, { sidechain: false, since, until });
}

module.exports = { sumTurns, costOf, subagentIndex, subagentUsage, orchestratorUsage, records };
