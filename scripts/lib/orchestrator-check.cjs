'use strict';
/**
 * Is this pipeline session on the orchestrator model the profile declares (`models.orchestrator`)?
 *
 * WHY. A session-level model setting is invisible once a run starts. In one adopting project the
 * orchestrator was declared on one model and ran for several whole runs on another, with the choice
 * recorded as done the entire time. The rendered board reports a divergence AFTER a run; this check
 * runs before the first dispatch, when switching still costs nothing.
 *
 * IT WARNS, NEVER REFUSES. Which model orchestrates is the operator's choice — it may simply not be
 * invisible. A divergence exits 5 and says how to switch or how to record that the run proceeds anyway.
 *
 * NO TURNS IS NOT A PASS. A session with no readable assistant turns (a fresh session, a missing
 * transcript) is UNMEASURED, and says so — never "as declared".
 *
 * Pure: records in, verdict out. The CLI (`scripts/orchestrator-check.mjs`) does the reading.
 */

const EXIT = Object.freeze({ OK: 0, WARN: 5 });
const RECENT_TURNS = 40;

/** A context-window or variant suffix (`some-model[1m]`) names the same model. */
const base = (model) => String(model ?? '').replace(/\[[^\]]*\]$/, '');

/**
 * The session's recent orchestrator turns, from transcript records. Only non-sidechain assistant turns
 * count, each message once (a message is written as several lines), and only the last `recent` of them —
 * so an earlier mid-session model switch is honoured.
 *
 * @param {object[]} records  parsed transcript lines
 * @param {number} [recent]
 * @returns {{ models: Record<string, number>, dominant: string|null, turns: number }}
 */
function observe(records, recent = RECENT_TURNS) {
  const turns = [];
  const seen = new Set();
  for (const r of records ?? []) {
    const model = r?.message?.model;
    if (r?.type !== 'assistant' || r.isSidechain || !model || model === '<synthetic>') continue;
    const id = r.message.id ?? r.uuid;
    if (id !== undefined && seen.has(id)) continue;
    if (id !== undefined) seen.add(id);
    turns.push(model);
  }
  const window = turns.slice(-Math.max(1, recent));
  const models = {};
  for (const m of window) models[m] = (models[m] ?? 0) + 1;
  const dominant = Object.entries(models).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return { models, dominant, turns: window.length };
}

/**
 * @param {{ declared: string|null, observed: { dominant: string|null, turns: number } | null, measurable?: boolean }} input
 *   `measurable: false` — the harness writes no transcript this check can read; `reason` says which reader and why.
 * @returns {{ code: number, warn: boolean, state: string, line: string }}
 */
function verdict({ declared, observed, measurable = true, reason = null }) {
  if (!declared) {
    return { code: EXIT.OK, warn: false, state: 'undeclared', line: 'orchestrator model: none declared in models.orchestrator — nothing to check' };
  }
  if (!measurable) {
    return { code: EXIT.OK, warn: false, state: 'unmeasurable', line: `orchestrator model: unmeasurable with this harness${reason ? ` (${reason})` : ''}` };
  }
  if (!observed || !observed.dominant || !observed.turns) {
    return {
      code: EXIT.OK,
      warn: false,
      state: 'unmeasured',
      line: `orchestrator model: declared ${declared}; no transcript turns to compare (unmeasured, not a pass)`,
    };
  }
  if (base(observed.dominant) === base(declared)) {
    return { code: EXIT.OK, warn: false, state: 'as-declared', line: `orchestrator model: ${observed.dominant} — as declared (${observed.turns} recent turns)` };
  }
  return {
    code: EXIT.WARN,
    warn: true,
    state: 'diverged',
    line:
      `WARNING orchestrator model: this session runs ${observed.dominant}, the profile declares ${declared}. ` +
      `Switch the session to ${declared} before step 0, or record in the run state that this run proceeds on ${observed.dominant}.`,
  };
}

module.exports = { EXIT, RECENT_TURNS, base, observe, verdict };
