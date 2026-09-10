/**
 * `.pipeline/<moduleKey>/run.jsonl` — the run log a pipeline run appends to as it happens.
 *
 * WHY APPEND-ONLY. The board's step timeline is the one thing no file in this repo held: the
 * markdown board tracks the SEATS, `state.md` tracks the orchestrator's cursor, and the sequence of
 * what actually happened lived only in the transcript — which is exactly what a compaction discards
 * or buries. So it is written down as it happens, one line per event, and never rewritten. A run
 * that dies mid-phase leaves a truthful partial log rather than a stale summary.
 *
 * WHY ONE WRITER. Only the orchestrator appends. A seat reports its files in its own final message
 * and the orchestrator logs them; a subagent that wrote its own accounting would be self-reporting
 * the very numbers the board exists to check (and the harness already records the honest ones —
 * see `transcript-usage.cjs`).
 *
 * FOLD RULES, and why each is a rule rather than a convenience:
 *   - a re-emitted `step` with the same id replaces the earlier one on render, but BOTH lines stay
 *     on disk: the render is a projection, the log is the evidence;
 *   - a `finding` is closed by a later `finding.close`, never by editing the line;
 *   - an unparseable line is COUNTED (`corrupt`), never skipped. A half-written line — a killed
 *     process, a full disk — is indistinguishable from "nothing happened" once it is dropped, and
 *     the board would under-report a run while looking complete.
 */
const { appendFileSync, existsSync, mkdirSync, readFileSync } = require('node:fs');
const { dirname } = require('node:path');

/**
 * The event's discriminator. `kind` is the name this reader is written around, but the corpus on
 * disk carries FOUR spellings — `kind`, `type`, `t` and `event` — because nothing ever asserted
 * one. Those runs happened whether or not the key matched, so all four are accepted: the log is the
 * evidence, the render is a projection, and an evidence file is never rewritten to make a
 * projection look right.
 *
 * The count is the point. One drifted key is a typo; four is a schema nobody was holding, which is
 * why `unrecognised` below is counted and surfaced rather than silently skipped — a fifth spelling
 * must announce itself instead of rendering an empty page.
 */
const kindOf = (event) => event.kind ?? event.type ?? event.t ?? event.event;

/**
 * Append one event. Stamps `ts` if the caller did not, so every event can be ordered and aged, and
 * normalises the discriminator to `kind` so newly written lines are canonical.
 */
function append(file, event) {
  const kind = kindOf(event);
  const stamped = { ts: new Date().toISOString(), ...event, ...(kind === undefined ? {} : { kind }) };
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(stamped)}\n`, 'utf8');
  return stamped;
}

/**
 * Read a run log into the shapes the renderer wants. A missing file is an empty run, not an error:
 * a board rendered on a fresh clone, or a historical board that predates this tooling, must still
 * render — with every accounting cell empty rather than zeroed.
 */
function read(file) {
  const out = {
    events: [],
    corrupt: 0,
    unrecognised: 0,
    run: null,
    steps: [],
    gates: [],
    findings: [],
    ceiling: [],
    files: [],
    end: null,
    lastEventAt: null,
  };
  if (!existsSync(file)) return out;

  const byStepId = new Map();
  const byFindingId = new Map();

  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (line.trim() === '') continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      out.corrupt += 1;
      continue;
    }
    out.events.push(event);
    if (event.ts && (!out.lastEventAt || event.ts > out.lastEventAt)) out.lastEventAt = event.ts;

    switch (kindOf(event)) {
      case 'run.start':
        out.run = event;
        break;
      case 'run.end':
        out.end = event;
        break;
      case 'step': {
        const key = event.id ?? `${out.steps.length}`;
        if (byStepId.has(key)) {
          Object.assign(byStepId.get(key), event);
        } else {
          const step = { ...event };
          byStepId.set(key, step);
          out.steps.push(step);
        }
        for (const f of event.files ?? []) out.files.push({ ...f, step: event.id, by: event.seat, at: event.ts });
        break;
      }
      case 'gate':
        out.gates.push(event);
        break;
      case 'finding': {
        const finding = { closedBy: null, ...event };
        byFindingId.set(event.id, finding);
        out.findings.push(finding);
        break;
      }
      case 'finding.close': {
        const finding = byFindingId.get(event.id);
        if (finding) finding.closedBy = event.closedBy ?? 'closed';
        break;
      }
      case 'ceiling':
        out.ceiling.push(event);
        break;
      default:
        /* A line that parsed as JSON but carries no kind this reader knows is COUNTED, for the
         * same reason `corrupt` is: silently dropping it makes schema drift indistinguishable from
         * "nothing happened". That is not hypothetical — every run log written between 2026-08-29
         * and 2026-09-07 stamped `type`/`t` instead of `kind` and fell through this branch, so ten
         * of eleven logs rendered an empty timeline under a green gate. */
        out.unrecognised += 1;
        break;
    }
  }

  /** A gate re-run supersedes the earlier result for the same gate; the earlier line still stands. */
  const latestGate = new Map();
  for (const g of out.gates) latestGate.set(g.gate, g);
  out.gatesLatest = [...latestGate.values()];

  return out;
}

/**
 * Which phases a CLOSED run never logged a step for.
 *
 * WHY. Observed in practice: one run recorded the plan, code, test and close-out phases and then
 * `run.end` with a MERGE-READY verdict, with no auditor, docs or review phase logged at all.
 * recorded `LOG-OPENED-LATE` against itself. Both closed clean. A run log that can end while whole
 * phases are unaccounted for is a record of a run that "went fine", which is the same shape as the
 * absent evidence this repo already refuses elsewhere: P6.5 must write `QA: skipped — <reason>`
 * rather than say nothing, and an open board row is a gate failure rather than a warning.
 *
 * The board's own `phase:status` block is the expectation — not the SKILL's table — because a SOLO
 * or FIX board legitimately runs a different set of phases, and the board states which.
 *
 * A phase that is `PLANNED` or `DROPPED` is not a gap: it never claimed to have happened. A phase
 * marked `DONE` with no step is exactly the claim this returns.
 *
 * @param {{phases?: {id?: string, phase?: string, status?: string}[]}} board parsed board
 * @param {{end: unknown, steps: {phase?: string, id?: string}[]}} log parsed run log
 * @returns {string[]} phase ids claimed done that the log never recorded a step for
 */
function closureGaps(board, log) {
  if (!log.end) return []; // an open run has not claimed anything yet
  const logged = new Set();
  for (const s of log.steps) {
    for (const v of [s.phase, s.id]) {
      const m = String(v ?? '').match(/^P[0-9]+(?:\.[0-9]+)?b?/i);
      if (m) logged.add(m[0].toUpperCase());
    }
  }
  /* A log whose steps carry no phase vocabulary at all (`STEP 0`, `STEP 1`, … — the convention the
   * first runs used) cannot be compared to a phase table. That is UNMATCHABLE, not missing, and
   * reporting it as a gap would flag every early run for a naming difference rather than a real
   * hole. Silence here is the honest answer; the T3 corpus test is what keeps the log readable. */
  if (logged.size === 0) return [];

  const gaps = [];
  for (const p of board.phases ?? []) {
    const status = String(p.status ?? '').toUpperCase();
    if (!/^(DONE|GREEN|PASS|MERGE-READY|COMPLETED)/.test(status)) continue;
    const m = String(p.phase ?? p.id ?? '').match(/^P[0-9]+(?:\.[0-9]+)?b?/i);
    if (m && !logged.has(m[0].toUpperCase())) gaps.push(m[0].toUpperCase());
  }
  return gaps;
}

module.exports = { append, read, closureGaps };
