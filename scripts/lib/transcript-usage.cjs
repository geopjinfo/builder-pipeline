/**
 * Per-agent accounting the seats cannot self-report.
 *
 * WHAT THIS READS. Claude Code writes a session transcript per project under
 * `~/.claude/projects/<slug>/*.jsonl`. Every foreground `Agent` dispatch lands a `toolUseResult`
 * carrying `agentId`, `agentType`, `resolvedModel`, `status`, `totalDurationMs`, `totalTokens`,
 * `totalToolUseCount` and a full `usage` block. A background dispatch lands one with NO usage; for
 * those, the seat's own transcript is read instead (`session-usage.cjs`). That is the honest source
 * for the board's model / time / token / cost columns. Another harness writes none of these files,
 * and every seat then renders as unmeasured.
 *
 * WHY NOT ASK THE AGENTS. Because an agent reporting its own cost is reporting a number nobody
 * checked, and the failure mode is silent: a seat that forgets, rounds, or overstates produces a
 * board that looks accounted-for. The harness already wrote the truth down; this reads it.
 *
 * WHAT IT IS NOT. Not a hard input. The transcript belongs to the machine that ran the session, so
 * a fresh clone, another operator's checkout or a cron run will not have it. Every failure path
 * here returns EMPTY, never zero — the renderer prints an em-dash, and an em-dash is honest where a
 * `$0.00` would be a claim.
 *
 * It reads; it never writes. Nothing in this repo may modify a transcript.
 */
const { existsSync, readFileSync, readdirSync, statSync } = require('node:fs');
const { homedir } = require('node:os');
const { join } = require('node:path');
const sessionUsage = require('./session-usage.cjs');

/** The per-project transcript directory: `~/.claude/projects/<cwd with separators as dashes>`. */
function transcriptDir(cwd = process.cwd()) {
  const slug = cwd.replace(/[\\/:]/g, '-');
  return join(homedir(), '.claude', 'projects', slug);
}

/**
 * Newest-first transcript files, capped.
 *
 * WHY A CAP AT ALL. This directory grows without bound and gets large — in one adopting project, a
 * hundred files and hundreds of megabytes — and every caller reads every byte. The cap is a real
 * guard, not an oversight.
 *
 * WHY A LOW CAP IS THE WRONG NUMBER. An earlier default sat below the actual corpus, so dozens of
 * transcripts were dropped in silence and the runs they covered rendered an em-dash for model, wall
 * clock and cost — identical to the honest "no transcript here" case. A limit that quietly changes
 * the answer is worse than a slower read. The default sits well above a busy project's corpus, and
 * `scanCoverage()` reports the moment it does bite, so a truncated scan can say so instead of
 * looking merely empty.
 */
const DEFAULT_LIMIT = 250;

function jsonlFiles(dir, limit = DEFAULT_LIMIT) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => join(dir, f))
    .map((f) => ({ f, m: statSync(f).mtimeMs }))
    .sort((a, b) => b.m - a.m)
    .slice(0, limit)
    .map((x) => x.f);
}

/**
 * What a scan of this directory would actually cover. The renderer calls it so a partial scan is
 * stated rather than inferred from missing cells.
 *
 * @returns {{total: number, scanned: number, truncated: boolean, limit: number}}
 */
function scanCoverage(dir = transcriptDir(), limit = DEFAULT_LIMIT) {
  const total = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.jsonl')).length : 0;
  const scanned = Math.min(total, limit);
  return { total, scanned, truncated: scanned < total, limit };
}

const num = (v) => (typeof v === 'number' ? v : 0);

/**
 * Index every agent dispatch by `agentId`. A re-reported id keeps the LAST record: a dispatch is
 * reported once while running and again on completion, and the completed record is the true one.
 */
function collect(dir = transcriptDir()) {
  const map = new Map();
  for (const file of jsonlFiles(dir)) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      if (line === '' || !line.includes('agentId')) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      const r = record.toolUseResult;
      if (!r || typeof r !== 'object' || !r.agentId) continue;
      const u = r.usage ?? {};
      map.set(r.agentId, {
        agentId: r.agentId,
        agentType: r.agentType ?? null,
        model: r.resolvedModel ?? null,
        status: r.status ?? null,
        durationMs: num(r.totalDurationMs),
        totalTokens: num(r.totalTokens),
        toolUseCount: num(r.totalToolUseCount),
        inputTokens: num(u.input_tokens),
        outputTokens: num(u.output_tokens),
        cacheReadTokens: num(u.cache_read_input_tokens),
        cacheWriteTokens: num(u.cache_creation_input_tokens),
        cacheWrite5mTokens: num(u.cache_creation?.ephemeral_5m_input_tokens),
        cacheWrite1hTokens: num(u.cache_creation?.ephemeral_1h_input_tokens),
        hasUsage: Boolean(r.usage),
        source: 'dispatch-result',
        at: record.timestamp ?? null,
      });
    }
  }

  /**
   * The seat's OWN transcript wins over the dispatch result. A background dispatch lands a
   * `toolUseResult` with no usage (`isAsync: true`), and a pipeline that runs its auditors in
   * parallel dispatches them that way; read as zeros, those seats became `$0.00` — a measurement
   * nobody took, and in one adopting project the reason a board summed to a small fraction of what
   * the run really cost. `subagents/agent-<id>.jsonl` holds every turn with its usage.
   *
   * No transcript file AND no usage in the result ⇒ `unmeasured`: the renderer prints an em-dash.
   */
  const index = sessionUsage.subagentIndex(dir);
  for (const [agentId, row] of map) {
    const own = sessionUsage.subagentUsage(agentId, index);
    if (own && own.turns > 0) {
      Object.assign(row, {
        agentType: row.agentType ?? own.agentType,
        model: row.model ?? own.model,
        durationMs: row.durationMs || own.durationMs,
        inputTokens: own.inputTokens,
        outputTokens: own.outputTokens,
        cacheReadTokens: own.cacheReadTokens,
        cacheWriteTokens: own.cacheWriteTokens,
        cacheWrite5mTokens: own.cacheWrite5mTokens,
        cacheWrite1hTokens: own.cacheWrite1hTokens,
        perModel: own.perModel,
        sessionId: own.sessionId,
        source: 'subagent-transcript',
      });
    } else if (!row.hasUsage) {
      row.unmeasured = true;
    }
  }
  return map;
}

/**
 * The orchestrator's own turns for a run: the non-sidechain turns of the sessions that dispatched the
 * run's seats, inside the run window. Scoping by session matters — other lanes work in the same
 * project directory at the same time, and a window-only filter would bill their turns to this run.
 */
function orchestratorUsage(sessionIds, sinceIso = null, untilIso = null, dir = transcriptDir()) {
  if (!sessionIds || sessionIds.length === 0) return null;
  const summary = sessionUsage.orchestratorUsage(dir, sessionIds, sinceIso, untilIso);
  return summary.turns > 0 ? summary : null;
}

/**
 * The model the ORCHESTRATOR ran on — the one seat `collect()` above can never see.
 *
 * WHY IT NEEDS ITS OWN READER. `collect()` keeps only records carrying `toolUseResult.agentId`,
 * which exist for subagent dispatches and nothing else. The orchestrator is not a subagent: it is
 * the session itself, so it has no agent file, no frontmatter, and no dispatch record. That blind
 * spot is not academic: in one adopting project the orchestrator was set to one model session-level,
 * and a run of pipeline builds then ran on a different model without one file in the repo being
 * able to say so.
 *
 * WHAT IT READS. Assistant turns in the project transcript that are NOT sidechain (a sidechain turn
 * belongs to a subagent), tallied by `message.model`. A session may legitimately span models — the
 * operator can switch mid-run — so the tally is returned, not a single answer, and the caller
 * decides what to say about a mixed run.
 *
 * @returns {{models: Record<string, number>, dominant: string|null, turns: number}}
 *   EMPTY (`{}`/`null`/0) when no transcript exists — a fresh clone, another operator's checkout, a
 *   CI run. Empty is honest; a fabricated model id would be a claim.
 */
function orchestratorModel(dir = transcriptDir(), sinceIso = null) {
  const models = {};
  let turns = 0;
  for (const file of jsonlFiles(dir)) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      if (line === '' || !line.includes('"model"')) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (record.type !== 'assistant' || record.isSidechain) continue;
      const model = record.message && record.message.model;
      if (!model || model === '<synthetic>') continue;
      if (sinceIso && record.timestamp && record.timestamp < sinceIso) continue;
      models[model] = (models[model] ?? 0) + 1;
      turns += 1;
    }
  }
  const dominant = Object.entries(models).sort((a, b) => b[1] - a[1])[0];
  return { models, dominant: dominant ? dominant[0] : null, turns };
}

module.exports = { collect, transcriptDir, orchestratorModel, orchestratorUsage, scanCoverage };
