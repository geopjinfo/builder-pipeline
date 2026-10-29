#!/usr/bin/env node
/**
 * PostToolUse hook (matcher `Edit|Write|MultiEdit`) — lint an instruction file the moment it is edited. CLAUDE CODE ONLY.
 *
 * When the edited file is one of `features.instructionLint.files`, this runs `scripts/instruction-lint.mjs --files <it>`.
 * A FAIL is returned to the agent as a blocking PostToolUse decision carrying the lint's lines, so the author fixes a
 * dead path or a bare line reference in the same turn instead of leaving it for the gate. Any other file, a PASS,
 * the feature off, or the script missing → exit 0 with no output.
 *
 * NEVER FAILS THE TOOL CALL. The edit has already happened; this only reports. Any error here exits 0 silently.
 *
 * Arming: copy to `.claude/hooks/`, then add a `PostToolUse` entry with matcher `Edit|Write|MultiEdit` running
 * `node .claude/hooks/instruction-lint-on-edit.cjs`. Arming is a person's deliberate act.
 */
'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/**
 * @param {object} input  the hook input (`tool_input.file_path`, `cwd`)
 * @param {{ root: string, run?: (root: string, rel: string) => { status: number | null, stdout: string } }} context
 * @returns {{ action: 'pass', reason: string } | { action: 'block', reason: string }}
 */
function decide(input, { root, run = defaultRun }) {
  const file = input?.tool_input?.file_path;
  if (!file) return { action: 'pass', reason: 'no file path' };
  const rel = path.relative(root, path.resolve(root, file)).replace(/\\/g, '/');
  if (rel.startsWith('..')) return { action: 'pass', reason: 'outside the project' };
  if (!fs.existsSync(path.join(root, 'scripts', 'instruction-lint.mjs'))) return { action: 'pass', reason: 'no lint script' };
  const r = run(root, rel);
  if (r.status !== 1) return { action: 'pass', reason: `lint exit ${r.status}` };
  return { action: 'block', reason: `instruction-lint failed for ${rel} — fix it in this turn:\n${r.stdout.trim()}` };
}

function defaultRun(root, rel) {
  return spawnSync(process.execPath, [path.join(root, 'scripts', 'instruction-lint.mjs'), '--files', rel], { cwd: root, encoding: 'utf8', timeout: 20000 });
}

if (require.main === module) {
  try {
    const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
    const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
    const d = decide(input, { root });
    if (d.action === 'block') process.stdout.write(JSON.stringify({ decision: 'block', reason: d.reason }));
  } catch {
    /* never fail the tool call */
  }
  process.exit(0);
}

module.exports = { decide };
