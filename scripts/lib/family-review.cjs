'use strict';
/**
 * The second reader of another worker family — `features.familyReview` (plan M8, REQ-801, REQ-802, D6, D14).
 *
 * WHY. One controlled study found that a review by a model of another family raised the pass rate of one writer and
 * lowered it for the other; cost per task roughly doubled. So the kit ships the cross-family review as an experiment
 * with its measurement first (EXPERIMENTS.md §16), never as a default. The second reader never replaces the reviewer
 * seat: it reads the P4 findings as one more list and writes its own review file.
 *
 * THE RULE. A lane's second reader is the first registry account, in registry order, that
 *   - is not the writer's account,
 *   - has a worker `family` that is not the writer's family (both known),
 *   - has a `tier` at or above the writer's tier (TIERS order: free < mid < strong).
 * An account with no `tier` is unknown and never "at or above". A writer with no tier has no second reader. When no
 * account qualifies there is no second reader and the plan carries one reason line.
 *
 * OFF, NOTHING RUNS. `apply()` returns the plan it was given, the same object, when the feature is not active, so the
 * split output is byte-identical with the key absent (REQ-801). Pure: no filesystem, no clock.
 */

/** The ordered tiers an account may carry (`features.accounts.accounts.<name>.tier`). */
const TIERS = Object.freeze(['free', 'mid', 'strong']);
const ACTIVE = new Set(['on', 'unmeasured', 'experimental-on']);

/** The rank of a tier, or -1 for an unknown one (null, absent, or a value outside the list). */
const tierRank = (tier) => TIERS.indexOf(tier);
const active = (state) => ACTIVE.has(state);

const label = (a) => `${a.name} (family ${a.family || 'unknown'}, tier ${a.tier || 'unknown'})`;

/**
 * Pick the second reader for a writer.
 * @param {{ name: string, family?: string|null, tier?: string|null }} writer
 * @param {Array<{ name: string, family?: string|null, tier?: string|null }>} accounts  registry order
 * @returns {{ account: string|null, reason: string }}
 */
function secondReader(writer, accounts) {
  const w = writer || {};
  const wRank = tierRank(w.tier);
  if (wRank < 0) return { account: null, reason: `familyReview: no second reader — writer ${w.name || '(unnamed)'} has no tier` };
  const pick = (accounts || []).find((a) => a && a.name !== w.name && a.family && w.family && a.family !== w.family && tierRank(a.tier) >= wRank);
  if (!pick) return { account: null, reason: `familyReview: no second reader — no other-family account at or above tier ${w.tier}` };
  return { account: pick.name, reason: `familyReview: second reader ${label(pick)} for writer ${label(w)}` };
}

/**
 * Give every lane of a split result its second reader. `cfg` = `{ state, accounts, writer }`: the feature state, the
 * registry accounts in order, and the writer — an account name, or a function `(lane) => name` when lanes differ.
 * Inactive, or with no config: the same plan object, untouched.
 * @returns {object}  the plan with `familyReview: { writer, log }` and `lane.secondReader: { account, reason }`
 */
function apply(plan, cfg) {
  if (!cfg || !active(cfg.state) || !plan || !Array.isArray(plan.lanes)) return plan;
  const accounts = Array.isArray(cfg.accounts) ? cfg.accounts : [];
  const writerOf = (lane) => (typeof cfg.writer === 'function' ? cfg.writer(lane) : cfg.writer);
  const log = [];
  const lanes = plan.lanes.map((lane) => {
    const name = writerOf(lane);
    const writer = accounts.find((a) => a.name === name) || { name: name || '(no writer)', family: null, tier: null };
    const pick = secondReader(writer, accounts);
    log.push(`${lane.name}: ${pick.reason}`);
    return { ...lane, secondReader: pick };
  });
  return { ...plan, lanes, familyReview: { writer: typeof cfg.writer === 'function' ? null : cfg.writer || null, log } };
}

module.exports = { TIERS, tierRank, active, secondReader, apply };
