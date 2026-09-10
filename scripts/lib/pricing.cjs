/**
 * Derived cost — and it says "derived" on the board, every time.
 *
 * WHY A LOCAL TABLE. The board must build offline, so there is no rate lookup and no network. The rates below are typed by hand, which means they can go stale — so the
 * table carries a VERSION and the board prints it next to the total. A cost figure whose rate table
 * is unlabelled invites being read as a bill; a labelled one invites being checked.
 *
 * WHY `null` AND NOT `0`. A model the table does not name has no derivable cost. Returning zero
 * would spend the reader's trust on a number nobody computed — the row shows its tokens and an
 * em-dash in the cost cell instead. Same rule as everywhere else on this board: absence renders as
 * absence.
 *
 * Rates are USD per million tokens. Update the table AND the version together — a rate change under
 * an unchanged version is indistinguishable from no change at all.
 */
const VERSION = '2026-08-28';

/** USD per 1M tokens. `cacheRead` is the discounted read of an already-cached prefix. */
const RATES = {
  'claude-opus-5': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  'claude-opus-4-8': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  'claude-sonnet-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-fable-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

const PER_M = 1_000_000;

/**
 * Cost of one usage record, or `null` when the model is not in the table.
 * `usage` fields are the ones `transcript-usage.cjs` produces; missing ones count as zero tokens,
 * which is a statement about the tokens, not about the price.
 */
function cost(model, usage = {}) {
  const rate = RATES[model];
  if (!rate) return null;
  const t = (v) => (typeof v === 'number' ? v : 0);
  return (
    (t(usage.inputTokens) * rate.input +
      t(usage.outputTokens) * rate.output +
      t(usage.cacheReadTokens) * rate.cacheRead +
      t(usage.cacheWriteTokens) * rate.cacheWrite) /
    PER_M
  );
}

/** Sum a set of usage records. Returns `null` if ANY row is unpriced — a partial total is a lie. */
function total(rows) {
  let sum = 0;
  for (const row of rows) {
    const c = cost(row.model, row);
    if (c === null) return null;
    sum += c;
  }
  return sum;
}

module.exports = { cost, total, version: VERSION, rates: RATES };
