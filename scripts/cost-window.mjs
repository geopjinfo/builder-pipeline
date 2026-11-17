#!/usr/bin/env node
/**
 * `npx builder run cost-window --since <iso> --until <iso> [--rates <pricing.cjs>] [--transcripts <dir>] [--json]`
 * (folder layout: node scripts/cost-window.mjs in place of npx builder run cost-window)
 *
 * Every token the harness recorded in a time window, by seat, priced at the current rate table — or at
 * another table passed with `--rates`, to compare like with like. It reads the transcripts directly: every
 * subagent dispatch whose first turn falls in the window, and every session's own (orchestrator) turns
 * inside the window. It is the instrument a later change is re-measured with.
 *
 * It counts EVERYTHING in the window, pipeline or not; narrow the window to one run to measure a run.
 * A dispatch whose model has no rate is counted as unpriced and SAID, never added as $0.
 *
 * HARNESS. `features.costAccounting.reader` picks the reader: `claude-code` reads the Claude Code project
 * transcripts (session-usage.cjs); `codex` reads Codex CLI rollout files (codex-usage.cjs) under
 * `--transcripts <dir>`, else `$CODEX_HOME/sessions`, else `~/.codex/sessions` — one session file is one dispatch,
 * its seat the session's `agent_role` or `codex-session`, and a file whose shape the reader does not know is
 * listed as `unmeasurable: <file>: <reason>`. Codex models have no shipped rate, so they are unpriced unless
 * `--rates` names a table. Any other reader value is refused by the profile loader; the "unmeasurable with this
 * harness" line stays as the last guard, exit 0.
 *
 * Exit codes: 0 report printed · 2 usage error or invalid profile.
 * The pure helpers below are exported for tests; the CLI runs only when this file is invoked directly.
 */
import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { runHint } = require('./lib/run-hint.cjs');

const TOKEN_KEYS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];

/** A subagent dispatch is in the window when its first turn is. */
export const dispatchInWindow = (summary, since, until) =>
  Boolean(summary) && summary.turns > 0 && Boolean(summary.firstTs) && summary.firstTs >= since && summary.firstTs <= until;

/**
 * Add one summary (the session-usage `sumTurns` shape) to its seat's row.
 * @param {Map<string, object>} seats
 * @param {string|null} seat
 * @param {{ turns: number, inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number }} summary
 * @param {number|null} cost  null = a model in the summary has no rate
 */
export function addSummary(seats, seat, summary, cost) {
  const name = seat ?? 'unknown';
  const row = seats.get(name) ?? { seat: name, dispatches: 0, turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0, unpriced: 0 };
  row.dispatches += 1;
  row.turns += summary.turns ?? 0;
  for (const k of TOKEN_KEYS) row[k] += summary[k] ?? 0;
  if (cost === null || cost === undefined) row.unpriced += 1;
  else row.cost += cost;
  seats.set(name, row);
  return seats;
}

/** Rows by cost, the total, and whether that total is partial (some dispatch unpriced). */
export function summarise(seats) {
  const rows = [...seats.values()].sort((a, b) => b.cost - a.cost);
  const total = rows.reduce((a, r) => a + r.cost, 0);
  const unpriced = rows.reduce((a, r) => a + r.unpriced, 0);
  return { rows, total, unpriced, partial: unpriced > 0 };
}

export function render({ rows, total, unpriced }, { since, until, rates, dir }) {
  const m = (n) => `${(n / 1e6).toFixed(1)}M`;
  const out = [
    `window ${since} → ${until} · rates ${rates ?? '—'}${dir ? ` · transcripts ${dir}` : ''}`,
    '| Seat | Dispatches | Turns | Output | Cache read | Cache write | Cost | Share |',
    '|---|---|---|---|---|---|---|---|',
  ];
  for (const r of rows) {
    out.push(
      `| ${r.seat} | ${r.dispatches} | ${r.turns} | ${m(r.outputTokens)} | ${m(r.cacheReadTokens)} | ${m(r.cacheWriteTokens)} | $${r.cost.toFixed(2)}${r.unpriced ? ` (+${r.unpriced} unpriced)` : ''} | ${total ? Math.round((100 * r.cost) / total) : 0}% |`,
    );
  }
  // A partial total presented as whole is a lie; say what it leaves out.
  out.push(unpriced ? `TOTAL $${total.toFixed(2)} — PARTIAL: ${unpriced} dispatch(es) unpriced` : `TOTAL $${total.toFixed(2)}`);
  return out.join('\n');
}

function main() {
  const argv = process.argv.slice(2);
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? null : argv[i + 1] ?? null;
  };
  const since = arg('--since');
  const until = arg('--until');
  if (!since || !until) {
    console.error(`usage: ${runHint('cost-window')} --since <iso> --until <iso> [--rates <pricing.cjs>] [--transcripts <dir>] [--json]`);
    process.exit(2);
  }
  const profile = require('./lib/profile.cjs');
  const { settings, errors } = profile.load(process.cwd());
  if (errors.length > 0) {
    console.error(`cost-window: the profile is invalid —\n  ${errors.join('\n  ')}`);
    process.exit(2);
  }
  const accounting = profile.feature(settings, 'costAccounting');
  if (!accounting.enabled) {
    console.log(accounting.line);
    process.exit(0);
  }
  if (accounting.config.reader === 'codex') return codexMain(argv, arg, since, until);
  if (accounting.config.reader !== 'claude-code') {
    console.log('cost window: unmeasurable with this harness');
    process.exit(0);
  }

  // Lazy: these readers know the Claude Code transcript layout and nothing above needs them.
  const su = require('./lib/session-usage.cjs');
  const { transcriptDir } = require('./lib/transcript-usage.cjs');
  const pricing = require(arg('--rates') ? resolve(arg('--rates')) : './lib/pricing.cjs');

  const dir = transcriptDir();
  const index = su.subagentIndex(dir);
  const seats = new Map();
  for (const [agentId] of index) {
    const s = su.subagentUsage(agentId, index);
    if (!dispatchInWindow(s, since, until)) continue;
    addSummary(seats, s.agentType, s, su.costOf(s, pricing));
  }
  for (const name of existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.jsonl')) : []) {
    const s = su.sumTurns(su.records(join(dir, name)), { sidechain: false, since, until });
    if (s.turns > 0) addSummary(seats, 'orchestrator', s, su.costOf(s, pricing));
  }
  const result = summarise(seats);
  if (argv.includes('--json')) console.log(JSON.stringify({ since, until, rates: pricing.version, ...result }, null, 2));
  else console.log(render(result, { since, until, rates: pricing.version, dir }));
}

/** The Codex CLI reader: every rollout file under the sessions directory, one dispatch each, priced per model. */
function codexMain(argv, arg, since, until) {
  const codex = require('./lib/codex-usage.cjs');
  const su = require('./lib/session-usage.cjs');
  const pricing = require(arg('--rates') ? resolve(arg('--rates')) : './lib/pricing.cjs');
  const dir = codex.sessionsDir(arg('--transcripts'));
  const { sessions, unmeasurable, coverage } = codex.collect(dir, { since, until });
  const seats = new Map();
  for (const s of sessions) {
    if (s.summary.turns === 0) continue;
    addSummary(seats, s.seat, s.summary, su.costOf(s.summary, pricing));
  }
  const result = summarise(seats);
  const notes = unmeasurable.map((u) => `unmeasurable: ${u.file}: ${u.reason}`);
  if (coverage.truncated) notes.push(`coverage: scanned ${coverage.scanned} of ${coverage.total} session files (cap ${coverage.limit}) — the window may be under-counted`);
  if (argv.includes('--json')) {
    console.log(JSON.stringify({ since, until, reader: 'codex', rates: pricing.version, transcripts: dir, ...result, unmeasurable, coverage }, null, 2));
    return;
  }
  for (const n of notes) console.log(n);
  console.log(render(result, { since, until, rates: pricing.version, dir }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
