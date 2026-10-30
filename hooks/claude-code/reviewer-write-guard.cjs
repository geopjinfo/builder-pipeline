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
 * hook itself allows the call. A profile loader that differs from HEAD is not run (`hook-trust.cjs`): the guard
 * falls back to the default runs folder and still enforces. Arming is a person's deliberate act: copy this and
 * `hook-trust.cjs` to `.claude/hooks/` and add the
 * `PreToolUse` entry running `node .claude/hooks/reviewer-write-guard.cjs`.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const REVIEWER = 'module-reviewer';
const norm = (p) => path.posix.normalize(String(p ?? '').replace(/\\/g, '/'));
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Real path of `p` (may not exist yet: realpath of the deepest existing ancestor + the rest; a dangling link is followed). */
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
/** `p`'s real path relative to `root`'s real path (forward slashes); throws when undecidable. */
const realRel = (p, root) => path.relative(realTarget(root), realTarget(p)).replace(/\\/g, '/');

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
  if (target && !target.split('/').includes('..') && allowed.test(target)) {
    // The spelling is the review file; it must also LAND there. A link under the runs folder (a junction
    // `<runs>/k2` → module code) would otherwise carry the one write anywhere. Undecidable → refused.
    let landed = null;
    try { landed = realRel(path.resolve(root || process.cwd(), String(raw)), root || process.cwd()); } catch { landed = null; }
    if (landed !== null && !landed.split('/').includes('..') && allowed.test(landed)) return { block: false };
    target = `${target} (lands on ${landed ?? 'a path that cannot be resolved'})`;
  }

  return {
    block: true,
    reason:
      `Blocked write to ${target || '(no path)'} by ${REVIEWER}.\n` +
      `  The reviewer may write only ${runs}/<key>/review-pass<n>.md (its review, from the review template). Everything else is read-only for this seat.`,
  };
}

function trustLib() {
  for (const p of [path.join(__dirname, 'hook-trust.cjs'), path.join(__dirname, 'claude-code', 'hook-trust.cjs')]) if (fs.existsSync(p)) return require(p);
  throw new Error('hook-trust.cjs not found');
}

/** The profile loader, only when it matches HEAD (hook-trust.cjs); otherwise null, and the hook keeps its defaults. */
function loadProfile(root) {
  try {
    const r = trustLib().load(root, __dirname, 'profile.cjs');
    return r.ok ? r.module : null;
  } catch {
    return null; // no hook-trust.cjs either: same as untrusted
  }
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
