/**
 * Derived cost — and it says "derived" on the board, every time.
 *
 * WHY A LOCAL TABLE. The board must build offline, so there is no rate lookup and no network. The
 * rates below are typed by hand, which means they can go stale — so the table carries a VERSION and
 * the board prints it next to the total. A cost figure whose rate table is unlabelled invites being
 * read as a bill; a labelled one invites being checked.
 *
 * WHY `null` AND NOT `0`. A model the table does not name has no derivable cost. Returning zero
 * would spend the reader's trust on a number nobody computed — the row shows its tokens and an
 * em-dash in the cost cell instead. Same rule as everywhere else on this board: absence renders as
 * absence.
 *
 * A HAND-TYPED TABLE GOES STALE — VERSION IT, AND CHECK IT. One adopting project found its table off
 * by roughly 3× when it was finally checked against the vendor's published rates: models typed at an
 * older generation's prices, one model priced as another. Every cost the board had derived inherited
 * the error, and nothing on the page looked wrong. So the rates below are copied from the published
 * table on VERSION, and the version is what a reader compares against the vendor's current page.
 *
 * TWO CACHE-WRITE RATES. Cache writes bill at 1.25× input for the 5-minute TTL and 2× input for the
 * 1-hour TTL, and the transcript records which (`cache_creation.ephemeral_5m_input_tokens` /
 * `ephemeral_1h_input_tokens`), so both are priced. A write with no split recorded is priced at the
 * 5-minute rate — the cheaper assumption, stated here rather than hidden.
 *
 * Rates are USD per million tokens. Update the table AND the version together — a rate change under
 * an unchanged version is indistinguishable from no change at all.
 */
const VERSION = '2026-10-29';

/** USD per 1M tokens, verbatim from the published table on VERSION. `cacheRead` is the discounted read of a cached prefix. */
const RATES = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25, cacheWrite5m: 12.5, cacheWrite1h: 20 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 },
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1, cacheWrite5m: 12.5, cacheWrite1h: 20 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2 },
};
// Dated aliases the harness reports for the same model.
RATES['claude-haiku-4-5-20251001'] = RATES['claude-haiku-4-5'];
// Back-compatible single cache-write rate for any caller that reads `rates` directly.
for (const rate of Object.values(RATES)) rate.cacheWrite = rate.cacheWrite5m;

const PER_M = 1_000_000;

/** A transcript model id may carry a context-window suffix (`claude-opus-5[1m]`); price the base id. */
const baseModel = (model) => (typeof model === 'string' ? model.replace(/\[[^\]]*\]$/, '') : model);

/**
 * Cost of one usage record, or `null` when the model is not in the table.
 * `usage` fields: inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens and — when the source
 * recorded the TTL split — cacheWrite5mTokens / cacheWrite1hTokens (the fields `transcript-usage.cjs`
 * and `session-usage.cjs` produce). Missing fields count as zero tokens, which is a statement about
 * the tokens, not about the price.
 */
function cost(model, usage = {}) {
  const rate = RATES[baseModel(model)];
  if (!rate) return null;
  const t = (v) => (typeof v === 'number' ? v : 0);
  const split5m = t(usage.cacheWrite5mTokens);
  const split1h = t(usage.cacheWrite1hTokens);
  const unsplit = Math.max(0, t(usage.cacheWriteTokens) - split5m - split1h);
  return (
    (t(usage.inputTokens) * rate.input +
      t(usage.outputTokens) * rate.output +
      t(usage.cacheReadTokens) * rate.cacheRead +
      (split5m + unsplit) * rate.cacheWrite5m +
      split1h * rate.cacheWrite1h) /
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

module.exports = { cost, total, version: VERSION, rates: RATES, baseModel };
