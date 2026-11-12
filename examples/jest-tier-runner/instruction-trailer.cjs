'use strict';
/**
 * EXAMPLE — the CI half of an instruction fence, for a repo whose agent instructions live in
 * CLAUDE.md, AGENTS.md and `.claude/`. Change `INSTRUCTION_DIFF` to your own instruction-file paths.
 *
 * A local tool-call hook (for example a Claude Code PreToolUse hook) blocks ACCIDENTAL writes to the
 * instruction layer, and it is not airtight — a determined shell always wins. This is the airtight
 * half, placed where airtight is possible: post-hoc, in CI, over the DIFF. A change that touches the
 * instruction layer must be DECLARED — some commit in the range carries an `instructions-change:`
 * trailer naming why. Detection where prevention can't be total; the local hook catches mistakes,
 * CI remains the full enforcer.
 *
 * THIS FILE IS IN THE SET IT DEFINES. Unfenced, one edit could empty the pattern, and the check — which runs the
 * branch's own copy of this file — would then certify its own removal. So the installed path of this file
 * (`scripts/lib/instruction-trailer.cjs`, per the README) is part of `INSTRUCTION_DIFF`: a change to the definition is
 * an instruction change and must be declared like one. If you install it elsewhere, change that alternative too.
 *
 * A TRACKED GIT-HOOKS FOLDER IS IN THE SET TOO. `.githooks/` (or whatever `core.hooksPath` names) decides what runs
 * unattended on every commit and merge, outside any permission prompt, so changing it changes what the agents' work
 * sets off. Add any script a hook executes by path as well (that one file, not its whole folder). Each entry ends at
 * the shared `(\/|$)`, so a near-miss such as `.githooksx/` stays outside.
 */
const INSTRUCTION_DIFF = /^(CLAUDE\.md|AGENTS\.md|\.claude\/(rules|agents|skills|hooks|settings[^/]*\.json)|scripts\/lib\/instruction-trailer\.cjs|\.githooks)(\/|$)/;
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
      `Add a trailer line to a commit message, e.g. "instructions-change: tighten the tester brief".`,
  };
}

module.exports = { verdict, INSTRUCTION_DIFF, TRAILER };
