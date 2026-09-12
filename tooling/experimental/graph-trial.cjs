'use strict';
/**
 * EXPERIMENTAL (`features.graphTrial`) — per-seat knowledge-index usage, read from the harness's transcripts.
 * See EXPERIMENTS.md, graph seat trial.
 *
 * WHY THE TRANSCRIPTS AND NOT THE SEATS. The trial is judged on numbers, never impressions. A seat that
 * reports its own index usage is reporting a number nobody checked: it can forget, round, or say "useful"
 * about a call it never made. The harness already wrote every tool call down. So each seat's calls are
 * counted from its transcript, and the seat's own return line
 * (`graph: <calls> calls, <useful> useful, <dead_end> dead-end`, or `graph: not used`) is shown beside
 * that count. When the two disagree, the disagreement is itself a finding: it says the seat's
 * useful / dead-end figures cannot be trusted either.
 *
 * WHY A CONTROL GROUP. Seats outside `graphTrial.seats` get no index instruction, so they should read 0.
 * A control seat that made calls means the instruction reached it by another route (the brief, the
 * profile, a copied prompt), and a comparison against that control would be measuring nothing. Flagged.
 *
 * WHAT COUNTS AS A CALL. A `Bash` tool_use whose command matches `graphTrial.callPattern` (capture group 1
 * is the subcommand). Every match in a command counts, so a chained `a && b` is two calls. Backslashes are
 * normalised to "/" first, so one pattern serves Windows and POSIX paths. Put in the pattern only the
 * subcommands the return line counts as calls: a write-back such as recording an outcome is not a question,
 * and leaving it out of the pattern keeps it out of the mismatch.
 *
 * Transcript format: Claude Code (a session `<id>.jsonl`, and `<id>/subagents/agent-*.jsonl` with an
 * `agent-*.meta.json` carrying `agentType`). Another harness writes none of these, and has nothing to read.
 *
 * Pure functions over transcript lines; `graph-trial-report.mjs` does the file reading.
 */

const RETURN_LINE = /graph:\s*(\d+)\s*calls?,\s*(\d+)\s*useful,\s*(\d+)\s*dead[-_ ]end/i;
const NOT_USED = /graph:\s*not used\b/i;
/** The subcommand name when `callPattern` has no capture group. */
const NO_SUBCOMMAND = '(call)';

const records = (lines) => {
  const out = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* a torn line — skip it, never guess */
    }
  }
  return out;
};

/** A global copy of the settings pattern, so every call in a chained command is found. */
function compileCallPattern(source) {
  const re = source instanceof RegExp ? source : new RegExp(String(source));
  return new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
}

/** Main-session lines minus the sidechain records (those belong to dispatched seats, not the orchestrator). */
function withoutSidechain(lines) {
  return lines.filter((line) => {
    try {
      return JSON.parse(line)?.isSidechain !== true;
    } catch {
      return true;
    }
  });
}

/** Every index subcommand a transcript's Bash calls ran, in order. */
function indexCalls(lines, pattern) {
  const re = compileCallPattern(pattern);
  const calls = [];
  for (const record of records(lines)) {
    const content = record?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const item of content) {
      if (item?.type !== 'tool_use' || item.name !== 'Bash') continue;
      const command = String(item.input?.command ?? '').replace(/\\/g, '/');
      for (const m of command.matchAll(re)) {
        if (m[0] === '') continue;
        calls.push(m[1] ?? NO_SUBCOMMAND);
      }
    }
  }
  return calls;
}

/** The seat's own outcome line from its LAST assistant text, or null when it wrote none. */
function claimedOutcome(lines) {
  let last = null;
  for (const record of records(lines)) {
    if (record?.type !== 'assistant') continue;
    const content = record.message?.content;
    if (!Array.isArray(content)) continue;
    const texts = content.filter((c) => c?.type === 'text').map((c) => c.text);
    if (texts.length) last = texts.join('\n');
  }
  if (last === null) return null;
  const m = RETURN_LINE.exec(last);
  if (m) return { calls: Number(m[1]), useful: Number(m[2]), deadEnd: Number(m[3]), notUsed: false };
  return NOT_USED.test(last) ? { calls: 0, useful: 0, deadEnd: 0, notUsed: true } : null;
}

/** One row per seat dispatch. */
function seatRow(seat, lines, pattern, trialSeats) {
  const list = indexCalls(lines, pattern);
  const bySubcommand = list.reduce((acc, c) => ({ ...acc, [c]: (acc[c] ?? 0) + 1 }), {});
  const claimed = claimedOutcome(lines);
  const group = trialSeats.includes(seat) ? 'trial' : 'control';
  return {
    seat,
    group,
    calls: list.length,
    bySubcommand,
    claimed,
    mismatch: claimed !== null && claimed.calls !== list.length,
    controlCalls: group === 'control' && list.length > 0,
  };
}

/** Totals per group. Useful / dead-end are the seats' claims — labelled as claimed wherever they print. */
function summarise(rows) {
  const of = (group) => {
    const rs = rows.filter((r) => r.group === group);
    return {
      dispatches: rs.length,
      calls: rs.reduce((s, r) => s + r.calls, 0),
      usefulClaimed: rs.reduce((s, r) => s + (r.claimed?.useful ?? 0), 0),
      deadEndClaimed: rs.reduce((s, r) => s + (r.claimed?.deadEnd ?? 0), 0),
      mismatches: rs.filter((r) => r.mismatch).length,
      noClaim: rs.filter((r) => r.claimed === null).length,
    };
  };
  return { trial: of('trial'), control: of('control'), flaggedControl: rows.filter((r) => r.controlCalls).length };
}

const says = (c) => (c === null ? '—' : c.notUsed ? 'not used' : `${c.calls} calls, ${c.useful} useful, ${c.deadEnd} dead-end`);

/** The markdown report: one table row per dispatch, then the trial and control summary lines. */
function renderMarkdown(rows) {
  const out = ['| Session | Seat | Group | Index calls | By subcommand | Seat says | Mismatch |', '|---|---|---|---|---|---|---|'];
  for (const r of rows) {
    const subs = Object.entries(r.bySubcommand).map(([k, v]) => `${k} ${v}`).join(', ') || '—';
    const group = r.controlCalls ? 'control — FLAG: should read 0' : r.group;
    out.push(`| ${String(r.session).slice(0, 8)} | ${r.seat} | ${group} | ${r.calls} | ${subs} | ${says(r.claimed)} | ${r.mismatch ? 'YES' : ''} |`);
  }
  const s = summarise(rows);
  out.push('');
  out.push(
    `trial seats: ${s.trial.dispatches} dispatch(es), ${s.trial.calls} index call(s) in the transcripts, ` +
      `${s.trial.usefulClaimed} useful / ${s.trial.deadEndClaimed} dead-end claimed, ${s.trial.mismatches} mismatch(es), ${s.trial.noClaim} with no return line`,
  );
  out.push(`control seats: ${s.control.dispatches} dispatch(es), ${s.control.calls} index call(s)${s.flaggedControl ? ` — FLAG: ${s.flaggedControl} control seat(s) made calls` : ''}`);
  return out.join('\n');
}

module.exports = { compileCallPattern, withoutSidechain, indexCalls, claimedOutcome, seatRow, summarise, renderMarkdown, RETURN_LINE, NOT_USED, NO_SUBCOMMAND };
