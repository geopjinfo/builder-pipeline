'use strict';
/**
 * The CI half of the instruction fence (source repo: hardening board, gap G-C).
 *
 * The local PreToolUse hook blocks ACCIDENTAL writes to the instruction layer (CLAUDE.md,
 * AGENTS.md, .claude/**) and says at its own code site that it is not airtight — a determined
 * shell always wins. This is the airtight half, placed where airtight is possible: post-hoc, in
 * CI, over the DIFF. A change that touches the instruction layer must be DECLARED — some commit
 * in the range carries an `instructions-change:` trailer naming why. Detection where prevention
 * can't be total; the same split the hook's docblock promises ("CI remains the full enforcer").
 */
const INSTRUCTION_DIFF = /^(CLAUDE\.md|AGENTS\.md|\.claude\/(rules|agents|skills|hooks|settings[^/]*\.json))(\/|$)/;
const TRAILER = /^instructions-change:\s*\S+/m;

/** Pure verdict over (changed files, commit messages). */
function verdict({ changedFiles, commitMessages }) {
  const touched = changedFiles
    .map((file) => file.replace(/\\/g, '/'))
    .filter((file) => INSTRUCTION_DIFF.test(file));
  if (touched.length === 0) return { ok: true, reason: 'no instruction files in the diff' };
  const declared = commitMessages.some((message) => TRAILER.test(message));
  if (declared) return { ok: true, reason: `${touched.length} instruction file(s), declared` };
  return {
    ok: false,
    reason:
      `${touched.length} instruction file(s) changed with no "instructions-change:" trailer in any ` +
      `commit of the range:\n  ${touched.join('\n  ')}\n` +
      `Add a trailer line to a commit message, e.g. "instructions-change: tighten tester brief per D2".`,
  };
}

module.exports = { verdict, INSTRUCTION_DIFF, TRAILER };
