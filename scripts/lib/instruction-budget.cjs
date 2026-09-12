'use strict';
/**
 * The instruction budget — the root agent-instruction file stays under a line budget.
 *
 * WHY THIS EXISTS. Every seat loads the root instruction file, and every other rule in the pipeline depends on that
 * file being READ. A longer file costs context on every turn and lowers adherence to what it says. Without a gate it
 * grows back one working agreement at a time: in one adopting project the root file was 231 lines when this gate
 * landed, having crossed 200 without anyone noticing. Path-scoped rule files — loaded only when a matching path is
 * touched — are the overflow. The root file is not.
 *
 * THE RULE, fixed so a count means the same thing on every run:
 *   - lines = `text.split('\n').length`. A trailing newline counts as one more line; CRLF counts the same as LF.
 *   - FAIL when lines > maxLines.
 *   - FAIL when a listed file is missing: a budget over an absent file asserts nothing.
 *   - FAIL when no file is listed: a budget over nothing asserts nothing.
 *
 * Pure over (path, text | null) pairs; the script reads the files.
 */

const countLines = (text) => String(text).split('\n').length;

/**
 * @param {{ path: string, text: string | null }[]} entries  text null = the file does not exist
 * @param {number} maxLines
 * @returns {{ ok: boolean, rows: { path: string, lines: number | null, over: boolean }[], problems: string[] }}
 */
function judge(entries, maxLines) {
  const problems = [];
  if (!Number.isInteger(maxLines) || maxLines <= 0) problems.push(`maxLines must be a positive integer, got ${JSON.stringify(maxLines)}`);
  if (entries.length === 0) problems.push('no instruction file is listed — a budget over nothing asserts nothing');
  const rows = entries.map(({ path, text }) => {
    if (text === null || text === undefined) {
      problems.push(`${path} is missing — a budget over an absent file asserts nothing`);
      return { path, lines: null, over: false };
    }
    const lines = countLines(text);
    const over = lines > maxLines;
    if (over) problems.push(`${path} is ${lines} lines, over the ${maxLines}-line budget by ${lines - maxLines} — move a section to a path-scoped rule file (moved, not copied)`);
    return { path, lines, over };
  });
  return { ok: problems.length === 0, rows, problems };
}

module.exports = { countLines, judge };
