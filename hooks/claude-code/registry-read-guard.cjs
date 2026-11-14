#!/usr/bin/env node
/**
 * PreToolUse hook (matcher `Read`) — a pipeline seat reads registry ROWS, not the registry. CLAUDE CODE ONLY.
 *
 * WHY. The deferred-work registry (`paths.registry`) grows for the life of a project, and a seat that reads
 * it whole pays for every byte again on each later turn of its dispatch. In one adopting project a single
 * builder dispatch read a registry of several hundred KB dozens of times. `npx builder run ledger-row
 * registry <ID>` prints just the row, with its section and its real header — everything the seat needed.
 * (folder layout: node scripts/ledger-row.mjs in place of npx builder run ledger-row)
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
 * the hook itself allows the call — a guard that crashes a session is worse than the read it prevents. So does a
 * profile loader that differs from HEAD (`hook-trust.cjs`): the hook never runs code an agent just wrote. Either way a
 * subagent's Read it lets through unjudged gets one stderr line saying why (`registry-read-guard: not judging …`).
 *
 * Arming: copy this and `hook-trust.cjs` to `.claude/hooks/`, then add a `PreToolUse` entry with matcher `Read` running
 * `node .claude/hooks/registry-read-guard.cjs`. Arming is a person's deliberate act.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

/** When the kit's run-hint.cjs cannot be loaded (untrusted, missing): name the script, not a layout. */
const FALLBACK_LEDGER_ROW = 'ledger-row';

const norm = (p) => path.posix.normalize(String(p ?? '').replace(/\\/g, '/'));

/**
 * @param {object} input     the hook input (`tool_name`, `tool_input`, `agent_type`, …)
 * @param {object} settings  merged pipeline settings (`profile.load().settings`)
 * @returns {{ block: false } | { block: true, reason: string }}
 */
function decide(input, settings, { ledgerRow = FALLBACK_LEDGER_ROW } = {}) {
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
      `  Read the rows you need instead: ${ledgerRow} registry <ID> [<ID> …] (section + header + row).\n` +
      `  The whole registry is re-paid on every later turn of this dispatch.`,
  };
}

function trustLib() {
  for (const p of [path.join(__dirname, 'hook-trust.cjs'), path.join(__dirname, 'claude-code', 'hook-trust.cjs')]) if (fs.existsSync(p)) return require(p);
  throw new Error('hook-trust.cjs not found');
}

/** The profile loader, only when it matches HEAD (hook-trust.cjs); otherwise why not, and the hook keeps its defaults. */
function loadProfile(root) {
  try {
    const r = trustLib().load(root, __dirname, 'profile.cjs');
    return r.ok ? { profile: r.module } : { profile: null, why: r.reason };
  } catch (e) {
    return { profile: null, why: e && e.message ? e.message : 'hook-trust.cjs could not be loaded' }; // same as untrusted
  }
}

/** A read the guard could have judged (a subagent's Read) but will not: one stderr line saying why, then allow. */
const notJudging = (input, why) => {
  if (input && input.tool_name === 'Read' && input.agent_type) process.stderr.write(`registry-read-guard: not judging this read — ${String(why).replace(/\s+/g, ' ')}\n`);
};

/**
 * How this project runs ledger-row, from the kit's run-hint.cjs (the one place a run command is spelled): the copy
 * vendored into kit/ beside this file (package layout), else the project's scripts/ copy (folder layout) — loaded like any
 * hook code, only when it matches HEAD, never from node_modules.
 */
function ledgerRowCommand(root) {
  try {
    const r = trustLib().load(root, __dirname, 'run-hint.cjs');
    return r.ok ? r.module.runHint('ledger-row') : FALLBACK_LEDGER_ROW;
  } catch {
    return FALLBACK_LEDGER_ROW;
  }
}

if (require.main === module) {
  let result = { block: false };
  let input = null;
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
    const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
    const { profile, why } = loadProfile(root);
    if (profile) result = decide(input, profile.load(root).settings, { ledgerRow: ledgerRowCommand(root) });
    else notJudging(input, why);
  } catch (e) {
    result = { block: false };
    notJudging(input, `the hook failed (${e && e.message ? e.message : e})`);
  }
  if (result.block) {
    process.stderr.write(`${result.reason}\n`);
    process.exit(2);
  }
  process.exit(0);
}

module.exports = { decide };
