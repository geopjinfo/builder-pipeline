'use strict';
/**
 * Summarise a mutation-testing report for the pipeline's mutation step.
 *
 * THE FORMAT. The open mutation-testing-report JSON schema: `{ files: { <path>: { source, mutants: [{
 * status, mutatorName, replacement, location: { start: { line } } }] } } }`. Stryker (JS/TS, and its .NET
 * and Scala siblings) writes it; other tools can, or can be mapped onto it.
 *
 * THE SCORE is the schema's mutation score: detected (`Killed`, `Timeout`) over valid (detected +
 * `Survived` + `NoCoverage`). `CompileError`, `RuntimeError`, `Ignored` and `Pending` leave the score — a
 * mutant that cannot compile can never ship. A report with no valid mutant has NO score, not 0%.
 *
 * SURVIVORS ARE SPLIT, BY A LINE-TEXT RULE, into:
 *   payload  the mutated source line matches `features.mutation.payloadPattern` — for example the lines
 *            that build an error body's detail text or a validation rule token. In one adopting project
 *            most undetected mutants only emptied an error payload while branch logic was well tested;
 *            one assertion on the payload kills them, and it is still a real gap if a client reads it.
 *   logic    everything else. Each is a tester row with the assertion the survivor names.
 * With no pattern, every survivor is logic. The rule sorts the list; it never excuses a survivor, and it
 * errs toward logic (a payload built across several lines matches nothing) — more tester rows, never a
 * survivor waved through.
 */

const DETECTED = new Set(['Killed', 'Timeout']);
const UNDETECTED = new Set(['Survived', 'NoCoverage']);

/**
 * @param {object} report  a parsed mutation-testing report
 * @param {{ payloadPattern?: string|RegExp|null }} [options]
 */
function summarise(report, { payloadPattern = null } = {}) {
  const payload = payloadPattern ? (payloadPattern instanceof RegExp ? payloadPattern : new RegExp(payloadPattern)) : null;
  let detected = 0;
  let undetected = 0;
  let invalid = 0;
  const survivors = [];
  for (const [file, entry] of Object.entries(report?.files ?? {})) {
    const lines = String(entry?.source ?? '').split(/\r?\n/);
    for (const m of entry?.mutants ?? []) {
      if (DETECTED.has(m.status)) detected += 1;
      else if (UNDETECTED.has(m.status)) {
        undetected += 1;
        const line = m.location?.start?.line ?? 0;
        survivors.push({
          file,
          line,
          mutator: m.mutatorName ?? null,
          replacement: m.replacement ?? null,
          status: m.status,
          kind: payload && payload.test(lines[line - 1] ?? '') ? 'payload' : 'logic',
        });
      } else invalid += 1;
    }
  }
  const valid = detected + undetected;
  return {
    score: valid === 0 ? null : Math.round((10000 * detected) / valid) / 100,
    detected,
    undetected,
    invalid,
    payload: survivors.filter((s) => s.kind === 'payload').length,
    logic: survivors.filter((s) => s.kind === 'logic').length,
    survivors,
  };
}

/** The lines the step prints and the board records. */
function lines(summary, { target, reportPath, payloadPattern = null }) {
  const s = summary;
  const out = [
    `mutation: ${target} score ${s.score === null ? '— (no valid mutant)' : `${s.score}%`} · ${s.detected} detected · ${s.undetected} undetected ` +
      `(${s.logic} logic, ${s.payload} payload${payloadPattern ? '' : ' — no payloadPattern, every survivor is logic'}) · ${s.invalid} invalid · report ${reportPath}`,
  ];
  for (const v of s.survivors.filter((x) => x.kind === 'logic')) out.push(`  LOGIC   ${v.file}:${v.line} ${v.mutator} → ${JSON.stringify(v.replacement)}`);
  if (s.payload > 0) out.push(`  PAYLOAD ${s.payload} survivor(s) on payload lines — one tester row: assert the payload the client reads`);
  return out;
}

module.exports = { summarise, lines, DETECTED, UNDETECTED };
