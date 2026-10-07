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
 *         "hooks": [{ "type": "command", "command": "node .claude/hooks/protected-paths.cjs" }]
 *       }]
 *     }
 *   }
 *
 * Fill PROTECTED below from your PIPELINE_PROFILE.md §4 (the DISCOVERY step tells the agent to
 * do this for you). Prefixes are repo-root-relative, forward slashes.
 */
'use strict';
const fs = require('fs');
const path = require('path');

/**
 * Real path of `p` (which may not exist yet): realpath of the deepest EXISTING ancestor, plus the rest; a
 * dangling link is followed by its text (a write may create what it names), up to 8 hops. Returns the path
 * relative to the project's real root (forward slashes), or null when it lies outside the project.
 * Throws when it cannot be decided (EACCES, EPERM, a link loop).
 */
function realTarget(p, hops = 0) {
  const tail = [];
  for (let head = path.resolve(p); ;) {
    const st = fs.lstatSync(head, { throwIfNoEntry: false });
    if (st) {
      try { return path.join(fs.realpathSync.native(head), ...tail); } catch (e) {
        if (!st.isSymbolicLink() || (e.code !== 'ENOENT' && e.code !== 'ENOTDIR')) throw e;
        if (hops >= 8) throw Object.assign(new Error('link loop'), { code: 'ELOOP' });
        return realTarget(path.join(path.resolve(path.dirname(head), fs.readlinkSync(head)), ...tail), hops + 1);
      }
    }
    const up = path.dirname(head);
    if (up === head) return path.resolve(p);
    tail.unshift(path.basename(head));
    head = up;
  }
}
function realRel(p) {
  const root = realTarget(process.env.CLAUDE_PROJECT_DIR || process.cwd());
  const rel = path.relative(root, realTarget(p));
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.replace(/\\/g, '/');
}

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

  // A RUN of separators is one separator: a doubled backslash or slash must not hide a protected prefix.
  const rel = filePath.replace(/[\\/]+/g, '/').replace(/^.*?:\//, '/');
  const grant = process.env[UNLOCK_ENV] || '';
  // A link (junction, symlink) OUTSIDE the project that points INTO a protected folder has no protected
  // prefix in its spelling. So the write is also judged by where it LANDS: the real path, relative to the
  // project's real root. A path that cannot be resolved fails CLOSED when its spelling is protected.
  let real = null;
  let unresolved = null;
  try { real = realRel(filePath); } catch (e) { unresolved = e.code || e.message; }

  for (const prefix of PROTECTED) {
    const norm = prefix.replace(/[\\/]+/g, '/');
    const spelled = rel.includes(`/${norm}`) || rel.startsWith(norm);
    const lands = real !== null && real.startsWith(norm);
    if (!spelled && !lands) continue;
    if (unresolved && spelled && !UNLOCKABLE[norm]) {
      console.error(`BLOCKED: "${norm}" is a protected path and ${filePath} cannot be resolved (${unresolved}); this fails closed.`);
      process.exit(2);
    }
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
