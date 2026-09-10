/**
 * The board's row-id vocabulary — **one definition, imported by every board tool.**
 *
 * CommonJS on purpose (2026-08-28): the architecture tier is the only tier that can reach
 * `scripts/lib/**`, and it requires CJS. An ESM copy would have meant a second copy — exactly the
 * drift described below. ESM callers default-import it: `import boardRows from './lib/board-rows.cjs'`.
 *
 * WHY THIS FILE EXISTS. `board-progress.mjs` and `board-progress-live.mjs` each carried their own
 * copy of this pattern, and on 2026-08-26 they had drifted: the committed-block tool had been
 * widened to the format actually in use, while the live tool still refused `IC-<n>` and `NR-<n>`
 * outright. The two then reported different totals for the same file — 198/216 against 189/206 —
 * which is indistinguishable from a stale board to anyone reading either number.
 *
 * That is the same shape CP3 B22 spent a batch removing for the multipart byte ceiling: a value
 * hand-copied into two places, where a divergence makes the answer depend on which copy you read.
 * A test asserting the two agree would not have helped — they can agree and both be wrong. So the
 * copies are gone instead.
 *
 * The vocabulary itself, and why each form is here:
 *   T<n>[a-z]  plan rows; the letter suffix is how a ruling splits one row in place (`T2` -> `T2a`
 *              + `T2b`) without renumbering everything after it
 *   C<n>       candidate rows
 *   D<n>       decision rows
 *   FIX-<n>    loop-back rows, numbered
 *   FIX-<A-Z>  loop-back rows, lettered — B2 used letters, and a series that exists is part of the
 *              format whether or not the pattern was written to expect it
 *   IC-<n>     invariant candidates carried from a module digest
 *   NR-<n>     not-ruled rows
 */

/** A board row id, after `stripAnnotation`. */
const ROW_ID = /^(T\d+[a-z]?|C\d+|D\d+|FIX-(?:\d+|[A-Z])|IC-\d+|NR-\d+)$/;

/**
 * Ids carry a parenthetical in the house format — `T13 *(added by the plan)*`,
 * `NR-3 *(pin fired, now closed)*` — saying WHY the row exists without renumbering anything.
 * It is annotation, not identity, so strip it before matching.
 */
const stripAnnotation = (cell) => cell.replace(/\s*\*\(.*?\)\*\s*$/, '').trim();

/**
 * Is this first cell decorative rather than a row that failed to match? Separators and bold labels
 * are not rows; anything else with content is almost certainly a real row under a wrong name, and
 * the caller should say so rather than skip it silently.
 */
const isDecorativeCell = (cell) => {
  const first = (cell ?? '').trim();
  return first === '' || /^[-: ]*$/.test(first) || first.startsWith('**');
};

/**
 * Strip markdown emphasis from a STATUS cell before matching it.
 *
 * Statuses are matched with an anchored pattern (`^(DONE|DROPPED|DEFERRED→)`), so a cell written
 * as `**DONE**` — which renders identically to a human and is how an author emphasises a closure —
 * fails to match and the row lands in the denominator while never reaching the numerator.
 *
 * Found 2026-08-26: B3's `NR-3` row read `**DONE**`, so a merged batch showed 14/15 with no row
 * visibly outstanding. Emphasis is presentation; it must not change what the cell MEANS. The
 * pattern is not widened to accept asterisks — the cell is normalised before it is read, so there
 * is one spelling of DONE and not two.
 */
const normalizeStatus = (cell) => (cell ?? '').replace(/[*_`]/g, '').trim();

module.exports = { ROW_ID, stripAnnotation, isDecorativeCell, normalizeStatus };
