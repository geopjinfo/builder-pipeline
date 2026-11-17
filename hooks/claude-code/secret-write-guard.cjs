#!/usr/bin/env node
/**
 * PreToolUse hook (matcher `Write|Edit|MultiEdit`) — a secret shape never lands in a file. CLAUDE CODE ONLY.
 * (REQ-1816; D88.)
 *
 * WHY. The pre-commit hook (hooks/secret-scan-precommit.sh) is the universal backstop, but it fires at commit time,
 * after the value sat in the working tree and in the session's context. Claude Code puts the content of a Write and
 * the new text of an Edit in the hook input, so the same shapes can refuse the write before it happens.
 *
 * THE RULE. While `features.secretScan` is on, the `content` of Write and the `new_string` of Edit (each edit of a
 * MultiEdit) is scanned with the outbound guard's SHAPES. A hit denies the write (exit 2) and names the kind, never
 * the text. A path covered by `features.secretScan.allow` (fixtures) passes. Off → pass.
 *
 * HOOK TRUST. The shapes and the profile loader are loaded through hook-trust.cjs: only code that matches HEAD runs.
 * An untrusted or missing library means this hook cannot judge; it passes and says so on stderr — the pre-commit
 * hook still holds. Arming is a person's deliberate act: the settings block is in adapters/claude-code.md.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const TOOLS = ['Write', 'Edit', 'MultiEdit'];

const norm = (p) => String(p ?? '').replace(/\\/g, '/');
function globToRegex(glob) {
  const g = norm(glob).replace(/^\.\//, '');
  const body = g.split('**').map((part) => part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')).join('.*');
  return new RegExp(g.includes('/') ? `^${body}$` : `(?:^|/)${body}$`);
}
const allowed = (rel, allow) => (allow || []).some((g) => globToRegex(g).test(rel) || globToRegex(`${String(g).replace(/\/$/, '')}/**`).test(rel));

/** The texts a tool call would write. */
function textsOf(input) {
  const t = input?.tool_input ?? {};
  if (input.tool_name === 'Write') return [String(t.content ?? '')];
  if (input.tool_name === 'Edit') return [String(t.new_string ?? '')];
  if (input.tool_name === 'MultiEdit') return (Array.isArray(t.edits) ? t.edits : []).map((e) => String(e?.new_string ?? ''));
  return [];
}

/**
 * @param {object} input     the hook input (`tool_name`, `tool_input`, `cwd`)
 * @param {object} settings  merged pipeline settings
 * @param {{ shapes: Array<[string, RegExp]>, root?: string }} opts
 * @returns {{ block: false, reason?: string } | { block: true, reason: string }}
 */
function decide(input, settings, { shapes, root = null } = {}) {
  if (!input || !TOOLS.includes(input.tool_name)) return { block: false };
  const f = settings?.features?.secretScan;
  if (!f || !['on', 'unmeasured', 'experimental-on'].includes(f.state)) return { block: false, reason: 'secretScan: not configured' };
  const raw = norm(input.tool_input?.file_path ?? '');
  let rel = raw;
  const base = root ? norm(root).replace(/\/$/, '') : null;
  if (base && rel.toLowerCase().startsWith(`${base.toLowerCase()}/`)) rel = rel.slice(base.length + 1);
  if (rel && allowed(rel, f.allow)) return { block: false, reason: 'allowed path' };
  const kinds = new Set();
  for (const text of textsOf(input)) {
    for (const line of text.split(/\r?\n/)) for (const [kind, re] of shapes) if (re.test(line)) kinds.add(kind);
  }
  if (!kinds.size) return { block: false };
  return {
    block: true,
    reason:
      `Blocked write to ${rel || '(no path)'}: the text carries a secret shape (${[...kinds].join(', ')}).\n` +
      '  Keep the value out of the file: read it from the environment or a 0600 file. A test fixture goes under a path in features.secretScan.allow (PIPELINE_PROFILE.md §16).',
  };
}

function trustLib() {
  for (const p of [path.join(__dirname, 'hook-trust.cjs'), path.join(__dirname, 'claude-code', 'hook-trust.cjs')]) if (fs.existsSync(p)) return require(p);
  throw new Error('hook-trust.cjs not found');
}

if (require.main === module) {
  let result = { block: false };
  try {
    const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
    const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
    const trust = trustLib();
    const guard = trust.load(root, __dirname, 'outbound-guard.cjs');
    const profile = trust.load(root, __dirname, 'profile.cjs');
    if (!guard.ok || !profile.ok) {
      process.stderr.write(`secret-write-guard: not run — ${(guard.ok ? profile : guard).reason}; the pre-commit secret scan still holds\n`);
      process.exit(0);
    }
    result = decide(input, profile.module.load(root).settings, { shapes: guard.module.SHAPES, root });
  } catch (_) {
    result = { block: false };
  }
  if (result.block) {
    process.stderr.write(`${result.reason}\n`);
    process.exit(2);
  }
  process.exit(0);
}

module.exports = { decide, TOOLS };
