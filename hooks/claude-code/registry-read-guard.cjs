#!/usr/bin/env node
/**
 * PreToolUse hook (matcher `Read`) — a pipeline seat reads registry ROWS, not the registry. CLAUDE CODE ONLY.
 *
 * WHY. The deferred-work registry (`paths.registry`) grows for the life of a project, and a seat that reads
 * it whole pays for every byte again on each later turn of its dispatch. In one adopting project a single
 * builder dispatch read a registry of several hundred KB dozens of times. `node scripts/ledger-row.mjs
 * registry <ID>` prints just the row, with its section and its real header — everything the seat needed.
 *
 * WHO IS BLOCKED. Only the agent types listed in `features.registryGuard.seats`. Claude Code puts the
 * dispatching subagent's `agent_type` in the hook input; the orchestrator (main session) carries none and is
 * never blocked, nor is any agent type not on the list. Every Read of the file is refused, including a
 * ranged one: a ranged read still has no header and no section, which is what the row reader adds.
 * Feature off → the hook allows everything, silently.
 *
 * Other harnesses: no pre-read hook — the seat instruction ("read rows through ledger-row.mjs") is the only
 * guard there.
 *
 * Protocol: stdin JSON; exit 2 with the reason on stderr blocks the call; exit 0 allows it. Any failure in
 * the hook itself allows the call — a guard that crashes a session is worse than the read it prevents.
 *
 * Arming: copy to `.claude/hooks/`, then add a `PreToolUse` entry with matcher `Read` running
 * `node .claude/hooks/registry-read-guard.cjs`. Arming is a person's deliberate act.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const norm = (p) => path.posix.normalize(String(p ?? '').replace(/\\/g, '/'));

/**
 * @param {object} input     the hook input (`tool_name`, `tool_input`, `agent_type`, …)
 * @param {object} settings  merged pipeline settings (`profile.load().settings`)
 * @returns {{ block: false } | { block: true, reason: string }}
 */
function decide(input, settings) {
  if (!input || input.tool_name !== 'Read' || !input.agent_type) return { block: false };
  const guard = { state: 'off', seats: [], ...(settings?.features?.registryGuard ?? {}) };
  if (!['on', 'unmeasured', 'experimental-on'].includes(guard.state)) return { block: false };
  const seats = Array.isArray(guard.seats) ? guard.seats : [];
  if (!seats.includes(input.agent_type)) return { block: false };

  const registry = norm(settings?.paths?.registry ?? '').replace(/^\.\//, '');
  const target = norm(input.tool_input?.file_path);
  if (!registry || registry === '.' || !target) return { block: false };
  // Case-insensitive: on a case-insensitive filesystem a different spelling reads the same file.
  const t = target.toLowerCase();
  const r = registry.toLowerCase();
  if (t !== r && !t.endsWith(`/${r}`)) return { block: false };

  return {
    block: true,
    reason:
      `Blocked Read of ${target} by ${input.agent_type}.\n` +
      `  Read the rows you need instead: node scripts/ledger-row.mjs registry <ID> [<ID> …] (section + header + row).\n` +
      `  The whole registry is re-paid on every later turn of this dispatch.`,
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
    if (profile) result = decide(input, profile.load(root).settings);
  } catch {
    result = { block: false };
  }
  if (result.block) {
    process.stderr.write(`${result.reason}\n`);
    process.exit(2);
  }
  process.exit(0);
}

module.exports = { decide };
