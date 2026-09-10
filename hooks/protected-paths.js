#!/usr/bin/env node
/*
 * PreToolUse hook (Claude Code) — blocks agent edits to protected paths.
 *
 * "Guardrails by hook beat guardrails by goodwill": personas promise not to touch protected
 * paths (PIPELINE_PROFILE.md §4), but a hook makes the promise mechanical. Installed to
 * .claude/hooks/ by the unpack CLI; ENABLING it is a manual, deliberate step — add to
 * .claude/settings.json:
 *
 *   {
 *     "hooks": {
 *       "PreToolUse": [{
 *         "matcher": "Edit|Write|NotebookEdit",
 *         "hooks": [{ "type": "command", "command": "node .claude/hooks/protected-paths.js" }]
 *       }]
 *     }
 *   }
 *
 * Fill PROTECTED below from your PIPELINE_PROFILE.md §4 (the DISCOVERY step tells the agent to
 * do this for you). Prefixes are repo-root-relative, forward slashes.
 */
'use strict';

// ── FILL FROM PIPELINE_PROFILE.md §4 ────────────────────────────────────────
const PROTECTED = [
  // 'src/platform/',       // stable core — boundary events go to the human
  // 'docs/',               // read-only mirror — changes ride the run's handoff pack
];
// Paths that are protected but may be unlocked by an env grant (revert after merge):
const UNLOCK_ENV = 'BUILDER_UNLOCK'; // e.g. BUILDER_UNLOCK=platform lifts entries tagged below
const UNLOCKABLE = {
  // 'src/platform/': 'platform',
};
// ────────────────────────────────────────────────────────────────────────────

let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  let filePath = '';
  try {
    const j = JSON.parse(input);
    filePath = (j.tool_input && (j.tool_input.file_path || j.tool_input.notebook_path)) || '';
  } catch (_) { process.exit(0); } // malformed input → don't block
  if (!filePath) process.exit(0);

  const rel = filePath.replace(/\\/g, '/').replace(/^.*?:\//, '/');
  const grant = process.env[UNLOCK_ENV] || '';

  for (const prefix of PROTECTED) {
    const norm = prefix.replace(/\\/g, '/');
    if (!rel.includes(`/${norm}`) && !rel.startsWith(norm)) continue;
    if (UNLOCKABLE[norm] && grant.split(',').includes(UNLOCKABLE[norm])) process.exit(0);
    console.error(
      `BLOCKED: "${norm}" is a protected path (PIPELINE_PROFILE.md §4). ` +
      `This is a boundary event — stop and ask the human. ` +
      (UNLOCKABLE[norm] ? `(Unlockable via ${UNLOCK_ENV}=${UNLOCKABLE[norm]} — human grant only.)` : '')
    );
    process.exit(2); // exit 2 = deny the tool call, message shown to the agent
  }
  process.exit(0);
});
