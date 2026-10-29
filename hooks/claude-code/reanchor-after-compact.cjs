#!/usr/bin/env node
/**
 * SessionStart hook (matcher `compact`) — point a compacted session back at the run files. CLAUDE CODE ONLY.
 *
 * After a compaction the session gets, as added context, the paths it must re-read before the next dispatch: each
 * run's `state.md` with its `Now:` line, the board and its first open phase, and the open `FIX-n` rows copied verbatim
 * (`scripts/lib/reanchor.cjs`). It reads files only and makes no model call. Feature off, no run in flight, or any
 * error → exit 0 with no output.
 *
 * Arming: copy to `.claude/hooks/`, then add a `SessionStart` entry with matcher `compact` running
 * `node .claude/hooks/reanchor-after-compact.cjs`. Arming is a person's deliberate act.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ACTIVE = ['on', 'unmeasured', 'experimental-on'];

function lib(root, name) {
  for (const candidate of [path.join(root, 'scripts', 'lib', name), path.join(__dirname, '..', '..', 'scripts', 'lib', name)]) {
    if (fs.existsSync(candidate)) return require(candidate);
  }
  throw new Error(`reanchor-after-compact: ${name} not found`);
}

/**
 * @param {object} input     the hook input (`hook_event_name`, `source`)
 * @param {object} settings  merged pipeline settings
 * @param {{ root: string, reanchor?: object }} context
 * @returns {{ action: 'pass', reason: string } | { action: 'context', text: string }}
 */
function decide(input, settings, { root, reanchor = null }) {
  if (input?.source && input.source !== 'compact') return { action: 'pass', reason: `session start: ${input.source}` };
  const state = settings?.features?.reanchor?.state ?? 'off';
  if (!ACTIVE.includes(state)) return { action: 'pass', reason: 'reanchor: not configured' };
  const { collect, render } = reanchor ?? lib(root, 'reanchor.cjs');
  const text = render(collect({ root, settings }));
  return text ? { action: 'context', text } : { action: 'pass', reason: 'no run in flight' };
}

if (require.main === module) {
  try {
    const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
    const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
    const { settings } = lib(root, 'profile.cjs').load(root);
    const d = decide(input, settings, { root });
    if (d.action === 'context') {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: d.text } }));
    }
  } catch {
    /* never fail the session start */
  }
  process.exit(0);
}

module.exports = { decide };
