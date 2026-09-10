/**
 * Per-agent accounting the seats cannot self-report.
 *
 * WHAT THIS READS. Claude Code writes a session transcript per project under
 * `~/.claude/projects/<slug>/*.jsonl`. Probed on 2026-08-28: every `Agent` dispatch lands a
 * `toolUseResult` carrying `agentId`, `agentType`, `resolvedModel`, `status`, `totalDurationMs`,
 * `totalTokens`, `totalToolUseCount` and a full `usage` block. That is the honest source for the
 * board's model / time / token / cost columns.
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

/** The per-project transcript directory: `~/.claude/projects/<cwd with separators as dashes>`. */
function transcriptDir(cwd = process.cwd()) {
  const slug = cwd.replace(/[\\/:]/g, '-');
  return join(homedir(), '.claude', 'projects', slug);
}

/**
 * Newest-first transcript files, capped.
 *
 * WHY A CAP AT ALL. This directory grows without bound and is large — 101 files / 298 MB when this
 * was last measured — and every caller reads every byte. The cap is a real guard, not an oversight.
 *
 * WHY 60 WAS THE WRONG NUMBER. It sat below the actual corpus, so 41 transcripts were dropped in
 * silence and the runs they covered rendered an em-dash for model, wall clock and cost — identical
 * to the honest "no transcript here" case. A limit that quietly changes the answer is worse than a
 * slower read. The default now sits above the corpus with headroom, and `scanCoverage()` reports
 * the moment it does bite, so a truncated scan can say so instead of looking merely empty.
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
        at: record.timestamp ?? null,
      });
    }
  }
  return map;
}

/**
 * The model the ORCHESTRATOR ran on — the one seat `collect()` above can never see.
 *
 * WHY IT NEEDS ITS OWN READER. `collect()` keeps only records carrying `toolUseResult.agentId`,
 * which exist for subagent dispatches and nothing else. The orchestrator is not a subagent: it is
 * the session itself, so it has no agent file, no frontmatter, and no dispatch record. That blind
 * spot is not academic: a project that rules the orchestrator onto one model session-level, with
 * eight pipeline runs then ran on Opus without one file in the repo being able to say so.
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

module.exports = { collect, transcriptDir, orchestratorModel, scanCoverage };
