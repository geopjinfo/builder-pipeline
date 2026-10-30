#!/usr/bin/env node
/**
 * SessionStart hook (matcher `compact`) — point a compacted session back at the run files. CLAUDE CODE ONLY.
 *
 * After a compaction the session gets, as added context, the paths it must re-read before the next dispatch: each
 * run's `state.md` with its `Now:` line, the board and its first open phase, and the open `FIX-n` rows copied verbatim
 * (`scripts/lib/reanchor.cjs`). It reads files only and makes no model call. Feature off, no run in flight, or any
 * error → exit 0 with no output.
 *
 * The process loads its libraries only when they match HEAD (`hook-trust.cjs`) — a hook must not run code an agent
 * just wrote. Untrusted → the session gets the fixed re-read order (FALLBACK) without the run paths, and why.
 *
 * Arming: copy this and `hook-trust.cjs` to `.claude/hooks/`, then add a `SessionStart` entry with matcher `compact` running
 * `node .claude/hooks/reanchor-after-compact.cjs`. Arming is a person's deliberate act.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ACTIVE = ['on', 'unmeasured', 'experimental-on'];

const FALLBACK =
  'Context was compacted. Before the next dispatch, re-read in order — do not rebuild the run from the summary: ' +
  "each run's state.md, its board's phase:status block, then the open FIX rows.";

function trustLib() {
  for (const p of [path.join(__dirname, 'hook-trust.cjs'), path.join(__dirname, 'claude-code', 'hook-trust.cjs')]) if (fs.existsSync(p)) return require(p);
  throw new Error('hook-trust.cjs not found');
}

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
    const say = (text) => process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } }));
    if (input?.source && input.source !== 'compact') process.exit(0);
    const trust = trustLib();
    const profile = trust.load(root, __dirname, 'profile.cjs');
    const reanchor = profile.ok ? trust.load(root, __dirname, 'reanchor.cjs') : profile;
    if (!reanchor.ok) say(`${FALLBACK}
(reanchor hook did not load its code: ${reanchor.reason})`);
    else {
      const d = decide(input, profile.module.load(root).settings, { root, reanchor: reanchor.module });
      if (d.action === 'context') say(d.text);
    }
  } catch {
    /* never fail the session start */
  }
  process.exit(0);
}

module.exports = { decide };
