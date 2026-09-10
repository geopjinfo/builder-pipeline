'use strict';
/**
 * The fix-of-fix rate over the task boards.
 *
 * A FIX row that repairs an EARLIER FIX row is a loop the first fix did not close. The narrow FIX lane is kept only
 * if this rate does not rise, so the rate is a command with a fixed rule, and later runs are compared against THIS
 * rule's baseline — never against a count someone once made by reading the rows.
 *
 * THE RULE. A row counts when it names another `FIX-n` of the same board AND a repair cue sits within 80 characters
 * of that name (`FIX-2's fix was incomplete`, `re-opens FIX-4`, `FIX-1 regressed`). A bare mention — "same shape as
 * FIX-1", "see FIX-3" — is a cross-reference, not a loop. In one adopting project the first version counted every
 * mention and read nearly double the hand count; a mention is not a repair.
 *
 * The rule is fixed on purpose: a rate whose rule moves between runs measures the rule, not the lane.
 */

const CUE = /re-?open|regress|incomplete|wrong|understat|overstat|correct|revert|broke|broken|still|again|missed|miss(?:es|ing)|stale|second time|not (?:fixed|closed|enough)|did not|didn't|reintroduc|undid|partial/i;

/** Every FIX row of a board: its id (`FIX-3a`) and the base it belongs to (`FIX-3`). */
function fixRows(markdown) {
  const rows = [];
  for (const line of markdown.split(/\r?\n/)) {
    const m = /^\|\s*\**`?(FIX-(\d+)[a-z]?)`?\**\s*\|/.exec(line);
    if (m) rows.push({ id: m[1], base: `FIX-${m[2]}`, text: line });
  }
  return rows;
}

/** Does this row repair another FIX row of the same board? A row's own base (`FIX-3a` naming `FIX-3`) is not a loop. */
function repairs(row, ids) {
  const body = row.text.slice(row.text.indexOf(row.id) + row.id.length);
  for (const m of body.matchAll(/\bFIX-(\d+)\b/g)) {
    const named = `FIX-${m[1]}`;
    if (named === row.base || !ids.has(named)) continue;
    const window = body.slice(Math.max(0, m.index - 80), m.index + m[0].length + 80);
    if (CUE.test(window)) return true;
  }
  return false;
}

/** @returns {{ total: number, fixOfFix: number, ids: string[] }} */
function fixOfFix(markdown) {
  const rows = fixRows(markdown);
  const ids = new Set(rows.map((r) => r.base));
  const offenders = rows.filter((r) => repairs(r, ids));
  return { total: rows.length, fixOfFix: offenders.length, ids: offenders.map((r) => r.id) };
}

module.exports = { fixRows, fixOfFix, CUE };
