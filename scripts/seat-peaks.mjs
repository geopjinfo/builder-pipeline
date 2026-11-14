#!/usr/bin/env node
/**
 * `npx builder run seat-peaks [--since <iso>] [--until <iso>] [--seat <agentType>] [--json]`
 * (folder layout: node scripts/seat-peaks.mjs in place of npx builder run seat-peaks)
 *
 * Per-dispatch PEAK context by seat — the largest single turn's prompt (input + cache read + cache write)
 * each dispatch reached, with turns and cost. It is the measurement behind batching a seat's work: a turn
 * is billed on everything already in the window, so a dispatch that climbs to a very large context pays
 * for it again on every turn after. Batch size (`features.builderBatch.rows`) is unmeasured until this is
 * compared before and after.
 *
 * HARNESS. Reads Claude Code transcripts only (`features.costAccounting.reader === "claude-code"`): one
 * transcript per subagent dispatch, with its agent type beside it. Other harnesses write no per-dispatch
 * usage this can read — the script says "unmeasurable with this harness" and exits 0.
 *
 * Exit codes: 0 report printed (an empty window is an empty table, not an error) · 2 invalid profile.
 * The pure helpers below are exported for tests; the CLI runs only when this file is invoked directly.
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

/** The prompt a turn was billed on. */
export const promptTokens = (u = {}) => (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);

/**
 * One dispatch's assistant turns, de-duplicated by message id (a message is written as several lines
 * carrying the same usage — summing lines would count one turn many times), oldest first.
 */
export function dispatchTurns(records) {
  const turns = new Map();
  for (const r of records ?? []) {
    if (r?.type !== 'assistant' || !r.message?.model || r.message.model === '<synthetic>') continue;
    turns.set(r.message.id ?? r.uuid, r);
  }
  return [...turns.values()].sort((a, b) => String(a.timestamp ?? '').localeCompare(String(b.timestamp ?? '')));
}

/** @returns {{ peak: number, turns: number, firstTs: string|null } | null} null when the dispatch has no turns */
export function dispatchPeak(records) {
  const list = dispatchTurns(records);
  if (list.length === 0) return null;
  return { peak: Math.max(...list.map((t) => promptTokens(t.message.usage ?? {}))), turns: list.length, firstTs: list[0].timestamp ?? null };
}

/** A dispatch belongs to the window when its FIRST turn falls inside it. */
export const inWindow = (firstTs, since, until) => Boolean(firstTs) && (!since || firstTs >= since) && (!until || firstTs <= until);

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];

/**
 * @param {{ seat: string|null, peak: number, turns: number, cost: number|null }[]} dispatches
 * @returns {{ seat, dispatches, medianPeak, p90Peak, maxPeak, turnsPerDispatch, cost, unpriced }[]} largest max peak first
 */
export function aggregate(dispatches) {
  const bySeat = new Map();
  for (const d of dispatches) {
    const seat = d.seat ?? 'unknown';
    const row = bySeat.get(seat) ?? { seat, peaks: [], turns: 0, cost: 0, unpriced: 0 };
    row.peaks.push(d.peak);
    row.turns += d.turns;
    if (d.cost === null || d.cost === undefined) row.unpriced += 1;
    else row.cost += d.cost;
    bySeat.set(seat, row);
  }
  return [...bySeat.values()]
    .map((r) => {
      const peaks = [...r.peaks].sort((a, b) => a - b);
      return {
        seat: r.seat,
        dispatches: peaks.length,
        medianPeak: percentile(peaks, 0.5),
        p90Peak: percentile(peaks, 0.9),
        maxPeak: peaks[peaks.length - 1],
        turnsPerDispatch: Math.round(r.turns / peaks.length),
        cost: r.cost,
        unpriced: r.unpriced,
      };
    })
    .sort((a, b) => b.maxPeak - a.maxPeak);
}

/** A markdown table; a seat with an unpriced dispatch says so rather than showing a smaller sum as whole. */
export function render(rows, { since, until, rates }) {
  const k = (n) => `${Math.round(n / 1000)}k`;
  const out = [
    `window ${since ?? 'start'} → ${until ?? 'now'} · rates ${rates ?? '—'}`,
    '| Seat | Dispatches | Median peak | p90 peak | Max peak | Turns/dispatch | Cost |',
    '|---|---|---|---|---|---|---|',
  ];
  for (const r of rows) {
    out.push(`| ${r.seat} | ${r.dispatches} | ${k(r.medianPeak)} | ${k(r.p90Peak)} | ${k(r.maxPeak)} | ${r.turnsPerDispatch} | $${r.cost.toFixed(2)}${r.unpriced ? ` (+${r.unpriced} unpriced)` : ''} |`);
  }
  return out.join('\n');
}

function main() {
  const argv = process.argv.slice(2);
  const arg = (n) => {
    const i = argv.indexOf(n);
    return i === -1 ? null : argv[i + 1] ?? null;
  };
  const profile = require('./lib/profile.cjs');
  const { settings, errors } = profile.load(process.cwd());
  if (errors.length > 0) {
    console.error(`seat-peaks: the profile is invalid —\n  ${errors.join('\n  ')}`);
    process.exit(2);
  }
  const accounting = profile.feature(settings, 'costAccounting');
  if (!accounting.enabled) {
    console.log(accounting.line);
    process.exit(0);
  }
  if (accounting.config.reader !== 'claude-code') {
    console.log('seat peaks: unmeasurable with this harness');
    process.exit(0);
  }

  // Lazy: these readers know the Claude Code transcript layout and nothing above needs them.
  const su = require('./lib/session-usage.cjs');
  const pricing = require('./lib/pricing.cjs');
  const { transcriptDir } = require('./lib/transcript-usage.cjs');

  const since = arg('--since');
  const until = arg('--until');
  const onlySeat = arg('--seat');
  const dispatches = [];
  for (const [, hit] of su.subagentIndex(transcriptDir())) {
    if (onlySeat && hit.agentType !== onlySeat) continue;
    const records = su.records(hit.file);
    const p = dispatchPeak(records);
    if (!p || !inWindow(p.firstTs, since, until)) continue;
    dispatches.push({ seat: hit.agentType, peak: p.peak, turns: p.turns, cost: su.costOf(su.sumTurns(records), pricing) });
  }
  const rows = aggregate(dispatches);
  if (argv.includes('--json')) console.log(JSON.stringify({ since, until, rates: pricing.version, rows }, null, 2));
  else console.log(render(rows, { since, until, rates: pricing.version }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
