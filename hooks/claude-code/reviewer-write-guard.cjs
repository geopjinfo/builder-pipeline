#!/usr/bin/env node
/**
 * PreToolUse hook (matcher `Write|Edit|MultiEdit|NotebookEdit`) — the reviewer writes ONE file. CLAUDE CODE ONLY.
 *
 * WHY. The final reviewer is a read-only seat that must still leave its verdict on disk, so it holds a write
 * tool. A grant stated only in the brief is a promise; a reviewer that can write anywhere is not read-only,
 * and a "small fix while reviewing" is exactly the edit nobody reviews. Claude Code puts the dispatching
 * subagent's `agent_type` in the hook input, so the grant is enforced here instead of trusted.
 *
 * THE RULE. agent_type `module-reviewer` may write only `<paths.runs>/<key>/review-pass<n>.md` (its review
 * pass, from the review template). Every other path is refused. Other agent types, and the orchestrator
 * (no agent_type), are not this hook's business.
 *
 * WHAT IT CANNOT SEE. Only the file-writing tools route through this matcher. A shell command that writes a
 * file does not — pair it with a read-only phase diff check (`git status --porcelain` empty after the phase).
 *
 * Other harnesses: no pre-write hook — the phase diff check is the guard there.
 *
 * Protocol: stdin JSON; exit 2 with the reason on stderr blocks the call; exit 0 allows it. A failure in the
 * hook itself allows the call. Arming is a person's deliberate act: copy to `.claude/hooks/` and add the
 * `PreToolUse` entry running `node .claude/hooks/reviewer-write-guard.cjs`.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const REVIEWER = 'module-reviewer';
const norm = (p) => path.posix.normalize(String(p ?? '').replace(/\\/g, '/'));
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * @param {object} input     the hook input (`tool_name`, `tool_input`, `agent_type`, `cwd`, …)
 * @param {object} settings  merged pipeline settings
 * @param {{ root?: string }} [options]  project root, to relativise an absolute target
 * @returns {{ block: false } | { block: true, reason: string }}
 */
function decide(input, settings, { root = null } = {}) {
  if (!input || input.agent_type !== REVIEWER) return { block: false };
  if (!['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(input.tool_name)) return { block: false };

  const raw = input.tool_input?.file_path ?? input.tool_input?.notebook_path ?? input.tool_input?.path ?? '';
  let target = norm(raw);
  const base = root ? norm(root).replace(/\/$/, '') : null;
  if (base && target.toLowerCase().startsWith(`${base.toLowerCase()}/`)) target = target.slice(base.length + 1);

  const runs = norm(settings?.paths?.runs ?? '.pipeline').replace(/^\.\//, '').replace(/\/$/, '');
  const allowed = new RegExp(`(?:^|/)${escape(runs)}/(?!\\.\\.?/)[^/]+/review-pass\\d+\\.md$`, 'i');
  if (target && !target.split('/').includes('..') && allowed.test(target)) return { block: false };

  return {
    block: true,
    reason:
      `Blocked write to ${target || '(no path)'} by ${REVIEWER}.\n` +
      `  The reviewer may write only ${runs}/<key>/review-pass<n>.md (its review, from the review template). Everything else is read-only for this seat.`,
  };
}

function loadProfile(root) {
  for (const candidate of [path.join(root, 'scripts', 'lib', 'profile.cjs'), path.join(__dirname, '..', '..', 'scripts', 'lib', 'profile.cjs')]) {
    if (fs.existsSync(candidate)) return require(candidate);
  }
  return null;
}

if (require.main === module) {
  let result = { block: false };
  try {
    const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
    const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
    const profile = loadProfile(root);
    const settings = profile ? profile.load(root).settings : { paths: { runs: '.pipeline' } };
    result = decide(input, settings, { root });
  } catch {
    result = { block: false };
  }
  if (result.block) {
    process.stderr.write(`${result.reason}\n`);
    process.exit(2);
  }
  process.exit(0);
}

module.exports = { decide, REVIEWER };
