#!/usr/bin/env node
/**
 * SessionStart index refresh. Optional; Claude Code only. Copied, never armed.
 *
 * WHY. Code and docs refresh on the same triggers: a merge hook, session start, and the pipeline's
 * P1 gate. This is the session-start one. It exists because docs can land in the tree with no commit
 * and no merge (copied in from another workspace, generated locally), so no git event marks them;
 * a content-hash sync when a session opens is what catches that drop before a seat queries the index.
 *
 * It never blocks and never fails the session: it spawns `autosync.py --trigger session` DETACHED,
 * under the same lock and the same auto-embed limit as every other trigger, and exits 0 at once.
 * The only thing it ever says is the PREVIOUS run's status, and only when that run left docs above
 * the limit: that spend is a person's decision, and the session is where a person is.
 *
 * Silent no-ops: INDEX_SYNC_SKIP set (an embed command runs with it, so an embed can never
 * re-trigger itself); no index on this machine; no Python interpreter known.
 *
 * Environment:
 *   INDEX_PYTHON            interpreter; else the path recorded in <index dir>/.graphify_python
 *   INDEX_OUT_DIR           index directory (default <project>/graphify-out)
 *   INDEX_AUTOSYNC_SCRIPT   path to autosync.py (default <project>/scripts/graphify/autosync.py)
 *
 * Arm it in .claude/settings.json (hooks are read at session start, so it fires from the next one):
 *
 *   {
 *     "hooks": {
 *       "SessionStart": [
 *         { "hooks": [ { "type": "command", "command": "node .claude/hooks/session-sync-hook.js" } ] }
 *       ]
 *     }
 *   }
 */
'use strict';
const { spawn } = require('child_process');
const { existsSync, readFileSync } = require('fs');
const path = require('path');

function main() {
  if (process.env.INDEX_SYNC_SKIP) return;

  const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const out = process.env.INDEX_OUT_DIR ? path.resolve(process.env.INDEX_OUT_DIR) : path.join(root, 'graphify-out');
  if (!existsSync(path.join(out, 'graph.json'))) return;

  let python = (process.env.INDEX_PYTHON || '').trim();
  if (!python) {
    try {
      // PowerShell writes a BOM; strip it and any CR/LF.
      python = readFileSync(path.join(out, '.graphify_python'), 'utf8').replace(/^\uFEFF/, '').trim();
    } catch {
      return;
    }
  }
  if (!python) return;

  const script = process.env.INDEX_AUTOSYNC_SCRIPT
    ? path.resolve(root, process.env.INDEX_AUTOSYNC_SCRIPT)
    : path.join(root, 'scripts', 'graphify', 'autosync.py');
  if (!existsSync(script)) return;

  // Read BEFORE spawning: the run starting now may overwrite it.
  let previous = null;
  try {
    previous = JSON.parse(readFileSync(path.join(out, '.autosync-status.json'), 'utf8'));
  } catch {
    /* first run on this machine */
  }

  try {
    const child = spawn(python, [script, '--trigger', 'session'], {
      cwd: root,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', INDEX_OUT_DIR: out },
    });
    child.on('error', () => {});
    child.unref();
  } catch {
    return;
  }

  if (previous && previous.decision === 'over-limit' && Number(previous.pendingDocs) > 0) {
    const kb = Math.round(Number(previous.pendingBytes) / 1024);
    const limit = Math.round(Number(previous.limitBytes) / 1024);
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext:
            `Index: ${previous.pendingDocs} doc(s), ${kb} KB, are pending embedding, above the ${limit} KB automatic ` +
            'limit, so embedding them is a person\'s call (it spends tokens). The index check command shows them; ' +
            `a manual run with INDEX_AUTO_LIMIT_KB raised (autosync.py --trigger manual) embeds them. Code is synced automatically.`,
        },
      }) + '\n',
    );
  }
}

try {
  main();
} catch {
  /* never fail the session */
}
process.exit(0);
