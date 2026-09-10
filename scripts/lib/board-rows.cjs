/**
 * The board's row-id vocabulary — **one definition, imported by every board tool.**
 *
 * CommonJS on purpose: a project's architecture-test tier may only be able to reach `scripts/lib/**`
 * through `require`. An ESM copy would have meant a second copy — exactly the drift described below.
 * ESM callers default-import it: `import boardRows from './lib/board-rows.cjs'`.
 *
 * WHY THIS FILE EXISTS. In one adopting project, two board tools (the committed progress block and a
 * live cross-checkout view) each carried their own copy of this pattern, and they drifted: one had
 * been widened to the format actually in use, while the other still refused `IC-<n>` and `NR-<n>`
 * outright. The two then reported different totals for the same file — which is indistinguishable
 * from a stale board to anyone reading either number.
 *
 * It is the general shape of a value hand-copied into two places, where a divergence makes the answer
 * depend on which copy you read. A test asserting the two agree would not have helped — they can
 * agree and both be wrong. So the copies are gone instead.
 *
 * The vocabulary itself, and why each form is here:
 *   T<n>[a-z]  plan rows; the letter suffix is how a decision splits one row in place (`T2` -> `T2a`
 *              + `T2b`) without renumbering everything after it
 *   C<n>       candidate rows
 *   D<n>       decision rows
 *   D<n>-<a-z> a sub-lettered deferral row, where one registry id is closed by two or more
 *              separately-evidenced halves (one per assertion, each with its own proof). The parent
 *              `D<n>` form was already accepted; the halves were not, so they counted nowhere.
 *   FIX-<n>    loop-back rows, numbered
 *   FIX-<A-Z>  loop-back rows, lettered — a batch that used letters showed that a series which exists
 *              is part of the format whether or not the pattern was written to expect it
 *   IC-<n>     invariant candidates carried from a module digest
 *   NR-<n>     not-ruled rows
 *
 * A NOTE ON WIDENING THIS PATTERN, because it is a gate and widening a gate is how gates die: this
 * list may grow only when a series ALREADY EXISTS on a board and is cited elsewhere under that id
 * (renumbering it would then break the citation instead of fixing it). It must never grow to admit a
 * row somebody would rather not rename. The counter's own error message states the standard — "a row
 * that counts nowhere is worse than a row that counts wrong" — and the failure it exists to prevent is
 * a board reporting 100% over rows it silently skipped. A project whose own records schedule rows
 * under another series widens its copy deliberately, with that reasoning written beside the new form.
 */

/** A board row id, after `stripAnnotation`. */
const ROW_ID = /^(T\d+[a-z]?|C\d+|D\d+(?:-[a-z])?|FIX-(?:\d+|[A-Z])|IC-\d+|NR-\d+)$/;

/**
 * Ids carry a parenthetical in the board format — `T13 *(added by the plan)*`,
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
 * Observed in practice: a row reading `**DONE**` left a merged batch at 14/15 with no row visibly
 * outstanding. Emphasis is presentation; it must not change what the cell MEANS. The pattern is not
 * widened to accept asterisks — the cell is normalised before it is read, so there is one spelling
 * of DONE and not two.
 */
const normalizeStatus = (cell) => (cell ?? '').replace(/[*_`]/g, '').trim();

module.exports = { ROW_ID, stripAnnotation, isDecorativeCell, normalizeStatus };
