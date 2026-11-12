'use strict';
/**
 * Worktree sweep — remove `git worktree`s whose work is provably finished.
 *
 * WHY THIS EXISTS. The playbook isolates concurrent writers in their own worktrees (a run, a gate batch, a FIX
 * lane, a mutation run). Nothing in a run removes its worktree — it must not: the merge has not happened when the
 * run ends. So unless whoever merges cleans up, the parent folder fills with dead checkouts, each holding gitignored
 * evidence (run logs, the run folder) that a hand-typed recursive delete would destroy. Worse, a worktree whose
 * `node_modules` is a junction to the primary's: a recursive delete walks through the junction and empties the
 * PRIMARY's `node_modules`. This removes only what is finished, and keeps what removal would lose.
 *
 *   KEEP  the primary checkout · the checkout the sweep runs from · a folder outside the configured name prefix
 *         · a reserved folder · a locked worktree · HEAD not contained in the target branch (unmerged commits)
 *         · any uncommitted or untracked change · a file touched within `idleHours` · a running process whose
 *         command line names it · a process check that cannot run (fail closed) · a hold reported by the
 *         optional `holdCommand`, or a hold command that fails (fail closed)
 *   SWEEP 1. copy its gitignored `backupDirs` to <primary>/<logs>/backups/worktrees-<date>/<name>/
 *         2. unlink a node_modules junction/symlink (never recurse through it)
 *         3. `git worktree remove <path>` WITHOUT --force: git itself refuses anything else it would lose; a
 *            folder left behind once the record is gone (a process holding a file) is FAIL at rmdir, never SWEPT
 *         then `git worktree prune`. The branch is never deleted — its commits stay, and a worktree can be re-added
 *         from it at any time.
 *   ORPHAN (listed only, with `prefix` set) a folder beside the primary whose name has the prefix, that
 *         `git worktree list` does not know and that holds no `.git` — a partial delete, an empty shell. It is
 *         reported with its size and never removed: deleting it is a recursive delete, which stays a human's call.
 *         A reserved name, a folder a process names, and a process check that cannot run are reported KEEP.
 *
 * Dry run unless `apply`. No recursive delete anywhere in this file.
 *
 * Settings (PIPELINE_PROFILE.md §16): features.worktreeSweep — see scripts/worktree-sweep.mjs.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const DEFAULT_BACKUP_DIRS = Object.freeze(['logs', '.pipeline']);
const IDLE_SKIP = /[\\/](node_modules|\.git)([\\/]|$)/;

const git = (cwd, args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
};
const key = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
const lstatOrNull = (p) => {
  try {
    return fs.lstatSync(p);
  } catch (_) {
    return null;
  }
};

/** `git worktree list --porcelain` of the repo at `repo`: [{ path, head, branch, locked, prunable }]. */
function listWorktrees(repo) {
  const out = [];
  let cur = null;
  for (const l of git(repo, ['worktree', 'list', '--porcelain']).out.split(/\r?\n/)) {
    if (l.startsWith('worktree ')) {
      cur = { path: path.resolve(l.slice(9)), head: null, branch: null, locked: false, prunable: false };
      out.push(cur);
    } else if (!cur) continue;
    else if (l.startsWith('HEAD ')) cur.head = l.slice(5);
    else if (l.startsWith('branch ')) cur.branch = l.slice(7).replace(/^refs\/heads\//, '');
    else if (l.startsWith('locked')) cur.locked = true;
    else if (l.startsWith('prunable')) cur.prunable = true;
  }
  return out;
}

/** The main worktree (git lists it first) — the primary checkout, whichever worktree the sweep runs from. */
const primaryOf = (repo) => (listWorktrees(repo)[0] || { path: repo }).path;

/** Newest mtime (ms) of any file under `dir`, node_modules and .git excluded; a link is never entered. */
function newestMtime(dir) {
  let newest = 0;
  const walk = (d) => {
    let ents;
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (IDLE_SKIP.test(p) || e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        walk(p);
        continue;
      }
      try {
        const m = fs.statSync(p).mtimeMs;
        if (m > newest) newest = m;
      } catch (_) {
        /* vanished */
      }
    }
  };
  walk(dir);
  return newest;
}

/** Total bytes of regular files under `dir`; a link is never entered. */
function treeBytes(dir) {
  let total = 0;
  const walk = (d) => {
    let ents;
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(p);
      else {
        const st = lstatOrNull(p);
        if (st) total += st.size;
      }
    }
  };
  walk(dir);
  return total;
}

const human = (b) => {
  if (b < 1024) return `${b} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = b / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
};

/** True when a process command line names folder `p` (its full path, or `\\name` / `/name`). */
function processNames(procLines, p, name) {
  const lower = p.toLowerCase();
  const n = name.toLowerCase();
  return procLines.some((l) => {
    const s = l.toLowerCase();
    return s.includes(lower) || s.includes(`\\${n}`) || s.includes(`/${n}`);
  });
}

/** Command lines of running processes (win32: CIM via PowerShell; else ps). null = the check could not run. */
function processCommandLines() {
  const r =
    process.platform === 'win32'
      ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { $_.CommandLine }'], {
          encoding: 'utf8',
          windowsHide: true,
          maxBuffer: 64 * 1024 * 1024,
        })
      : spawnSync('ps', ['-eo', 'args'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 || !r.stdout) return null;
  return r.stdout.split(/\r?\n/).filter(Boolean);
}

/**
 * The optional project hold check. `holdCommand` contains `{path}` (replaced by the worktree's absolute path, quoted)
 * and runs through the shell: exit 0 = nothing holds it · exit 1 = held, stdout's first line is the reason · any
 * other exit = the check failed, which holds the worktree too (fail closed). Use it for state the sweep cannot know
 * about — a queued job that will run in that worktree, a review still waiting on its output.
 */
function defaultHoldRunner(holdCommand, wtPath) {
  const cmd = holdCommand.split('{path}').join(JSON.stringify(wtPath));
  const r = spawnSync(cmd, { shell: true, encoding: 'utf8', windowsHide: true });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

function holdReasons(holdCommand, wtPath, runHold) {
  if (!holdCommand) return [];
  const r = runHold(holdCommand, wtPath);
  if (r.code === 0) return [];
  if (r.code === 1) return [`held: ${(r.out.split(/\r?\n/)[0] || 'hold command reported a hold').trim()}`];
  return [`hold check failed (exit ${r.code})`];
}

/**
 * Judge every worktree of `repo`. Returns [{ path, name, branch, verdict: 'SWEEP'|'KEEP', reasons[] }].
 * `procLines` (processCommandLines() result), `now` (ms) and `runHold` are injectable for tests.
 */
function plan({
  repo,
  target,
  idleHours = 6,
  prefix = null,
  reserved = [],
  holdCommand = null,
  procLines = processCommandLines(),
  runHold = defaultHoldRunner,
  now = Date.now(),
  cwd = process.cwd(),
}) {
  if (!target) throw new Error('worktree-sweep: a target branch is required');
  const primary = key(primaryOf(repo));
  const here = key(git(cwd, ['rev-parse', '--show-toplevel']).out || cwd);
  const res = new Set(reserved.map((r) => r.toLowerCase()));
  return listWorktrees(repo).map((w) => {
    const name = path.basename(w.path);
    const reasons = [];
    if (key(w.path) === primary) reasons.push('primary checkout');
    else if (key(w.path) === here) reasons.push('the checkout this sweep runs from');
    else if (prefix && !name.toLowerCase().startsWith(prefix.toLowerCase())) reasons.push(`name outside the sweep prefix "${prefix}"`);
    else if (!fs.existsSync(w.path)) reasons.push('folder missing (prune will drop its record)');
    else {
      if (res.has(name.toLowerCase())) reasons.push('reserved folder');
      if (w.locked) reasons.push('locked');
      if (!w.head || git(repo, ['merge-base', '--is-ancestor', w.head, target]).code !== 0) {
        const ahead = w.head ? git(repo, ['rev-list', '--count', `${target}..${w.head}`]).out : '?';
        reasons.push(`not merged into ${target} (${ahead} commit(s) ahead)`);
      }
      const st = git(w.path, ['status', '--porcelain', '--untracked-files=normal']);
      if (st.code !== 0) reasons.push('git status failed');
      else if (st.out) reasons.push(`${st.out.split(/\r?\n/).length} uncommitted/untracked change(s)`);
      reasons.push(...holdReasons(holdCommand, w.path, runHold));
      const newest = newestMtime(w.path);
      if (newest && now - newest < idleHours * 3600 * 1000) {
        reasons.push(`touched ${Math.round((now - newest) / 60000)} min ago (idle threshold ${idleHours} h)`);
      }
      if (procLines === null) reasons.push('process check could not run');
      else if (processNames(procLines, w.path, name)) reasons.push('a running process names it');
    }
    return { path: w.path, name, branch: w.branch || '(detached)', verdict: reasons.length ? 'KEEP' : 'SWEEP', reasons };
  });
}

/**
 * Folders beside the primary whose name has `prefix`, that `git worktree list` does not know and that hold no
 * `.git`. Returns [{ path, name, bytes, verdict: 'ORPHAN'|'KEEP', reasons[] }]. Without a prefix there is no way to
 * tell a dead checkout from any other sibling folder, so nothing is listed. Links are never listed or entered.
 */
function orphans({ repo, prefix = null, reserved = [], procLines = processCommandLines() }) {
  if (!prefix) return [];
  const parent = path.dirname(primaryOf(repo));
  const registered = new Set(listWorktrees(repo).map((w) => key(w.path)));
  const res = new Set(reserved.map((r) => r.toLowerCase()));
  let ents = [];
  try {
    ents = fs.readdirSync(parent, { withFileTypes: true });
  } catch (_) {
    return [];
  }
  const out = [];
  for (const e of ents) {
    if (!e.name.toLowerCase().startsWith(prefix.toLowerCase()) || e.isSymbolicLink() || !e.isDirectory()) continue;
    const p = path.join(parent, e.name);
    if (registered.has(key(p)) || lstatOrNull(path.join(p, '.git'))) continue;
    const reasons = [];
    if (res.has(e.name.toLowerCase())) reasons.push('reserved folder');
    if (procLines === null) reasons.push('process check could not run');
    else if (processNames(procLines, p, e.name)) reasons.push('a running process names it');
    out.push({ path: p, name: e.name, bytes: treeBytes(p), verdict: reasons.length ? 'KEEP' : 'ORPHAN', reasons });
  }
  return out;
}

/**
 * What a `git worktree remove` result means once the record and the folder are checked: both gone = ok; the folder
 * left behind (record gone, or git says it could not delete) = FAIL at rmdir, a process holding a file; else FAIL at
 * remove. A zero exit alone is not the proof: the folder is.
 */
const RMDIR_ERR = /failed to delete|directory not empty|permission denied|being used by another process|resource busy/i;
function removalOutcome(r, { listed, exists }) {
  if (!listed && !exists) return { ok: true };
  const msg = r.err || r.out || '';
  if (exists && (!listed || RMDIR_ERR.test(msg))) {
    return { ok: false, step: 'rmdir', detail: `folder still present after its worktree record was removed (a process may hold it)${msg ? `: ${msg}` : ''}` };
  }
  return { ok: false, step: 'remove', detail: msg || `exit ${r.code}` };
}

/** Copy dir → dst (files and dirs; links are not followed). */
function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) copyTree(s, d);
    else fs.copyFileSync(s, d);
  }
}

/** Remove one SWEEP worktree: back up, unlink a node_modules link, `git worktree remove` (no force). */
function sweepOne(repo, item, { backupRoot, backupDirs = DEFAULT_BACKUP_DIRS }) {
  const dst = path.join(backupRoot, item.name);
  for (const sub of backupDirs) {
    const src = path.join(item.path, sub);
    if (!fs.existsSync(src)) continue;
    try {
      copyTree(src, path.join(dst, sub));
    } catch (e) {
      return { ok: false, step: 'backup', detail: `${sub}: ${e.message}` };
    }
  }
  const nm = path.join(item.path, 'node_modules');
  let lst = null;
  try {
    lst = fs.lstatSync(nm);
  } catch (_) {
    /* none */
  }
  if (lst && lst.isSymbolicLink()) {
    try {
      fs.unlinkSync(nm);
    } catch (e) {
      return { ok: false, step: 'junction', detail: e.message };
    }
    let still = false;
    try {
      fs.lstatSync(nm);
      still = true;
    } catch (_) {
      /* gone */
    }
    if (still) return { ok: false, step: 'junction', detail: 'node_modules link still present' };
  }
  const r = git(repo, ['worktree', 'remove', item.path]);
  const o = removalOutcome(r, { listed: listWorktrees(repo).some((w) => key(w.path) === key(item.path)), exists: fs.existsSync(item.path) });
  if (!o.ok) return o;
  return { ok: true, step: 'removed', detail: fs.existsSync(dst) ? `backup ${dst}` : 'nothing to back up' };
}

/** Plan, then (apply) sweep every SWEEP item and prune. `report(line)` gets one line per worktree. */
function run({
  repo,
  apply = false,
  target,
  idleHours,
  prefix,
  reserved,
  holdCommand,
  backupDirs = DEFAULT_BACKUP_DIRS,
  logsDir = 'logs',
  procLines,
  runHold,
  now,
  cwd,
  report = () => {},
  date = new Date().toISOString().slice(0, 10),
}) {
  const procs = procLines === undefined ? processCommandLines() : procLines;
  const items = plan({ repo, target, idleHours, prefix, reserved, holdCommand, procLines: procs, runHold, now, cwd });
  const primary = primaryOf(repo);
  const backupRoot = path.join(primary, logsDir, 'backups', `worktrees-${date}`);
  const nmPrimary = path.join(primary, 'node_modules');
  const count = () => {
    try {
      return fs.readdirSync(nmPrimary).length;
    } catch (_) {
      return null;
    }
  };
  const nmBefore = count();
  const out = { swept: [], kept: [], failed: [], orphans: [], nmBefore, nmAfter: null, apply };
  for (const it of items) {
    if (it.verdict === 'KEEP') {
      out.kept.push(it);
      report(`KEEP  ${it.name} [${it.branch}] — ${it.reasons.join('; ')}`);
      continue;
    }
    if (!apply) {
      out.swept.push(it);
      report(`SWEEP ${it.name} [${it.branch}] — merged, clean, idle (dry run: nothing removed)`);
      continue;
    }
    const r = sweepOne(repo, it, { backupRoot, backupDirs });
    if (r.ok) {
      out.swept.push(it);
      report(`SWEPT ${it.name} [${it.branch}] — ${r.detail}; branch kept`);
    } else {
      out.failed.push({ ...it, ...r });
      report(`FAIL  ${it.name} at ${r.step} — ${r.detail}`);
    }
  }
  if (apply) git(repo, ['worktree', 'prune']);
  const failedHere = new Set(out.failed.map((x) => key(x.path)));
  for (const o of orphans({ repo, prefix, reserved, procLines: procs })) {
    if (failedHere.has(key(o.path))) continue; // a removal that failed this run is reported once, as that FAIL
    if (o.verdict === 'KEEP') {
      report(`KEEP  ${o.name} — unregistered folder, ${human(o.bytes)}; ${o.reasons.join('; ')}`);
      continue;
    }
    out.orphans.push(o);
    report(`ORPHAN ${o.name} — ${human(o.bytes)}, not in \`git worktree list\`, no .git (listed only: deleting it is a human's call)`);
  }
  out.nmAfter = count();
  if (apply && nmBefore !== null && out.nmAfter !== nmBefore) report(`ALERT primary node_modules changed: ${nmBefore} → ${out.nmAfter} entries`);
  out.summary =
    `worktree-sweep: ${apply ? 'removed' : 'would remove'} ${out.swept.length}, kept ${out.kept.length}` +
    `${out.failed.length ? `, FAILED ${out.failed.length}` : ''}` +
    `${apply ? ` · backups in ${backupRoot}` : ' · dry run (add --apply to remove)'}` +
    `${out.orphans.length ? ` · orphans: ${out.orphans.length} (${human(out.orphans.reduce((s, o) => s + o.bytes, 0))}), listed only` : ''}`;
  return out;
}

module.exports = { DEFAULT_BACKUP_DIRS, listWorktrees, primaryOf, newestMtime, treeBytes, processCommandLines, plan, orphans, removalOutcome, sweepOne, run };
