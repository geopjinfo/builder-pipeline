#!/usr/bin/env node
/**
 * SessionStart index refresh, and the merge trigger's runner. Optional; Claude Code only. Copied, never armed.
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
 * THE MERGE TRIGGER IS THIS SAME FILE. The post-merge block that `sync-hook.sh` installs runs
 * `node .claude/hooks/session-sync-hook.cjs --trigger merge` (after checking that this file and `hook-trust.cjs`
 * equal their blobs at HEAD). One implementation means the merge path gets the same folder check, interpreter
 * lookup, spawn flags and environment, instead of a shell line that starts whatever interpreter a file names.
 * With `--trigger merge` it prints nothing.
 *
 * WHAT IT WILL AND WILL NOT RUN. A hook runs outside the permission prompt, so it starts project code only when
 * that code is committed:
 *  - The scripts: EVERY entry of the folder holding autosync.py must be a plain file that is, byte for byte, the
 *    blob at HEAD (`hook-trust.cjs`, installed beside this hook), and no committed file may be missing. A package
 *    folder, an extension module, a sourceless .pyc, a link or a deleted script would each change what
 *    `import sync` loads, so any of them means no sync. Only `__pycache__` is skipped, because the spawn is told
 *    never to read it (below). No `hook-trust.cjs` next to this file: no sync.
 *  - The interpreter: INDEX_PYTHON, else the tool venv `uv tool dir` or pipx reports for INDEX_TOOL_VENV. Never
 *    a path recorded inside the index directory: that folder is git-ignored and an agent can write it. The tool
 *    lookups skip PATH entries inside the project (Windows would also try the current folder). None found: no sync.
 *  - The spawn: `-I` (no PYTHONPATH/PYTHONHOME/PYTHONSTARTUP, no user site, no current or script folder on
 *    sys.path; autosync.py puts its own folder first itself), `-B` plus a pycache prefix that does not exist, so no
 *    repository `.pyc` is ever read. PYTHON* is removed from the environment the children inherit, and
 *    NoDefaultCurrentDirectoryInExePath is set so no child on Windows takes a program from the current folder.
 *
 * Silent no-ops: INDEX_SYNC_SKIP set (an embed command runs with it, so an embed can never
 * re-trigger itself); no index on this machine; scripts that differ from HEAD; no interpreter found.
 *
 * Environment (the hook's own, which a session cannot change):
 *   INDEX_PYTHON            interpreter; else the INDEX_TOOL_VENV venv found through `uv tool dir`, then pipx
 *   INDEX_TOOL_VENV         the index tool's venv name under those tool dirs (default graphifyy)
 *   INDEX_OUT_DIR           index directory (default <project>/graphify-out)
 *   INDEX_AUTOSYNC_SCRIPT   path to autosync.py (default <project>/scripts/graphify/autosync.py)
 *
 * Arm it in .claude/settings.json (hooks are read at session start, so it fires from the next one):
 *
 *   {
 *     "hooks": {
 *       "SessionStart": [
 *         { "hooks": [ { "type": "command", "command": "node .claude/hooks/session-sync-hook.cjs" } ] }
 *       ]
 *     }
 *   }
 */
'use strict';
const { spawn, spawnSync } = require('child_process');
const { accessSync, constants, existsSync, readdirSync, readFileSync, realpathSync, statSync } = require('fs');
const { randomUUID } = require('crypto');
const { tmpdir } = require('os');
const path = require('path');

const given = process.argv.indexOf('--trigger') >= 0 ? process.argv[process.argv.indexOf('--trigger') + 1] : 'session';
const trigger = given === 'merge' ? 'merge' : 'session';

function cleanGitEnv() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k)));
  env.GIT_NO_REPLACE_OBJECTS = '1';
  return env;
}

/** A program from PATH as an absolute path, never from the current folder or any folder inside the project. */
function which(name, root) {
  let rootReal;
  try {
    rootReal = realpathSync(root);
  } catch {
    rootReal = path.resolve(root);
  }
  for (const dir of (process.env.PATH || process.env.Path || '').split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    for (const ext of process.platform === 'win32' ? ['.exe', '.cmd'] : ['']) {
      try {
        const real = realpathSync(path.join(dir, name + ext));
        const rel = path.relative(rootReal, real);
        if (!rel || (!rel.startsWith('..') && !path.isAbsolute(rel))) continue; // inside the project
        if (!statSync(real).isFile()) continue;
        if (process.platform !== 'win32') accessSync(real, constants.X_OK);
        return real;
      } catch {
        /* not here */
      }
    }
  }
  return null;
}

/** Trust the whole script folder, not just its *.py: Python also loads packages, extension modules and sourceless .pyc. */
function folderTrusted(root, dir) {
  const trustFile = path.join(__dirname, 'hook-trust.cjs');
  if (!existsSync(trustFile)) return false;
  const trust = require(trustFile);
  const entries = readdirSync(dir, { withFileTypes: true }).filter((e) => e.name !== '__pycache__');
  if (!entries.length || !entries.every((e) => e.isFile())) return false; // a folder, a link, a junction: refused
  const git = which('git', root);
  if (!git) return false;
  const top = spawnSync(git, ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=', '-C', dir, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8', timeout: 5000, windowsHide: true, env: cleanGitEnv(),
  });
  if (top.status !== 0 || !top.stdout.trim()) return false;
  const repo = realpathSync(top.stdout.trim());
  const relDir = path.relative(repo, realpathSync(dir)).split(path.sep).join('/');
  if (!relDir || relDir.startsWith('..')) return false;
  const listed = spawnSync(git, ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=', '-C', repo, 'ls-tree', '-z', '--name-only', 'HEAD', '--', `${relDir}/`], {
    encoding: 'utf8', timeout: 5000, windowsHide: true, env: cleanGitEnv(),
  });
  if (listed.status !== 0) return false;
  const head = listed.stdout.split('\0').filter(Boolean).sort();
  const disk = entries.map((e) => `${relDir}/${e.name}`).sort();
  if (!head.length || head.join('\n') !== disk.join('\n')) return false; // an extra file, or a committed one missing
  return trust.verify(entries.map((e) => path.join(dir, e.name)), { base: root }).ok;
}

/** The index tool's own venv interpreter, found through the tool managers. Null when there is none. */
function toolPython(root) {
  const fromEnv = (process.env.INDEX_PYTHON || '').trim();
  if (fromEnv) return fromEnv;
  const venv = (process.env.INDEX_TOOL_VENV || 'graphifyy').trim();
  const rel = process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python'];
  for (const [tool, args] of [['uv', ['tool', 'dir']], ['pipx', ['environment', '--value', 'PIPX_LOCAL_VENVS']]]) {
    try {
      const exe = which(tool, root);
      if (!exe) continue;
      const r = spawnSync(exe, args, { encoding: 'utf8', timeout: 10000, windowsHide: true, cwd: tmpdir() });
      const dir = r.status === 0 ? r.stdout.trim() : '';
      if (!dir) continue;
      const py = path.join(dir, venv, ...rel);
      if (existsSync(py)) return py;
    } catch {
      /* try the next tool */
    }
  }
  return null;
}

function main() {
  if (process.env.INDEX_SYNC_SKIP) return;

  const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const out = process.env.INDEX_OUT_DIR ? path.resolve(process.env.INDEX_OUT_DIR) : path.join(root, 'graphify-out');
  if (!existsSync(path.join(out, 'graph.json'))) return;

  // Read BEFORE spawning: the run starting now may overwrite it.
  let previous = null;
  try {
    previous = JSON.parse(readFileSync(path.join(out, '.autosync-status.json'), 'utf8'));
  } catch {
    /* first run on this machine */
  }

  const script = process.env.INDEX_AUTOSYNC_SCRIPT
    ? path.resolve(root, process.env.INDEX_AUTOSYNC_SCRIPT)
    : path.join(root, 'scripts', 'graphify', 'autosync.py');

  try {
    if (!existsSync(script)) throw new Error('no autosync script');
    if (!folderTrusted(root, path.dirname(script))) throw new Error('index scripts differ from HEAD');
    const python = toolPython(root);
    if (!python) throw new Error('no interpreter');
    // A prefix that does not exist (and -B, so nothing creates it): the repository's __pycache__ is never read.
    const pycache = path.join(tmpdir(), `index-pyc-${randomUUID()}`);
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^PYTHON/i.test(k)));
    Object.assign(env, {
      PYTHONIOENCODING: 'utf-8',
      PYTHONSAFEPATH: '1', // children (`python -m <tool>`) must not put the project folder first on sys.path
      PYTHONPYCACHEPREFIX: pycache,
      PYTHONDONTWRITEBYTECODE: '1',
      NoDefaultCurrentDirectoryInExePath: '1',
      INDEX_OUT_DIR: out,
    });
    const child = spawn(python, ['-I', '-B', '-X', `pycache_prefix=${pycache}`, script, '--trigger', trigger], {
      cwd: root,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env,
    });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* untrusted or unresolved: no sync; the session carries on */
  }

  if (trigger === 'session' && previous && previous.decision === 'over-limit' && Number(previous.pendingDocs) > 0) {
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
