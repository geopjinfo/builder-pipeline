'use strict';
/**
 * Run sweep — old run folders and backups, listed with size and age, moved by rename into `<logs>/trash/<date>/`
 * with --apply (specs/repo-hygiene.spec.md, M18, REQ-1806; decision D86).
 *
 * Items: every entry directly under a configured root (default `.pipeline` and `logs/backups`), where the
 * orchestrator store `.pipeline/orchestrator` expands to its `runs/<run>` folders (its own files — claims, locks,
 * switches — are never items); the upgrade backups `.builder/backup-*`; and `PIPELINE_PROFILE.md.bak`.
 *
 *   SWEEP  newest file older than `keepDays`
 *   KEEP   younger than `keepDays`, or a run with a lane in LAUNCHED or STALLED (a live worker session)
 *
 * WHY rename, not delete (D86): a folder moved into the trash is restored by moving it back, and the summary
 * says where it went. This module holds no recursive delete at all — a test reads the source and fails on one.
 * Snapshot refs (`refs/orch/snapshots/<run>/…`) of runs whose lanes all merged are listed with the delete
 * command and never deleted: a ref is history, and history is a person's decision.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { newestMtime, treeBytes, human } = require('./worktree-sweep.cjs');

const DAY = 24 * 3600 * 1000;
const ACTIVE = ['LAUNCHED', 'STALLED'];
const ORCH_DIR = path.join('.pipeline', 'orchestrator');

const rel = (root, abs) => path.relative(root, abs).split(path.sep).join('/');

function statOrNull(p) {
  try {
    return fs.statSync(p);
  } catch (_) {
    return null;
  }
}
function children(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).map((e) => ({ name: e.name, dir: e.isDirectory(), path: path.join(dir, e.name) }));
  } catch (_) {
    return [];
  }
}

/** The lanes of a run folder that hold a live worker, from its state.json: [{ lane, status }]. */
function liveLanes(runDir) {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8'));
    return Object.entries(state.lanes || {}).filter(([, l]) => l && ACTIVE.includes(l.status)).map(([lane, l]) => ({ lane, status: l.status }));
  } catch (_) {
    return [];
  }
}
/** True when state.json exists and every lane is MERGED. */
function allMerged(runDir) {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(runDir, 'state.json'), 'utf8'));
    const lanes = Object.values(state.lanes || {});
    return lanes.length > 0 && lanes.every((l) => l && l.status === 'MERGED');
  } catch (_) {
    return false;
  }
}

/** The candidate paths under `root`: [{ abs, rel, kind, dir }]. */
function candidates(root, roots) {
  const out = [];
  const seen = new Set();
  const add = (abs, kind, dir) => {
    const r = rel(root, abs);
    if (seen.has(r)) return;
    seen.add(r);
    out.push({ abs, rel: r, kind, dir });
  };
  for (const r of roots) {
    const base = path.join(root, r);
    for (const c of children(base)) {
      if (rel(root, c.path) === ORCH_DIR.split(path.sep).join('/')) {
        for (const run of children(path.join(c.path, 'runs'))) if (run.dir) add(run.path, 'run', true);
        continue;
      }
      add(c.path, c.dir ? 'folder' : 'file', c.dir);
    }
  }
  for (const c of children(path.join(root, '.builder'))) if (c.dir && /^backup-/.test(c.name)) add(c.path, 'upgrade backup', true);
  const bak = path.join(root, 'PIPELINE_PROFILE.md.bak');
  if (statOrNull(bak)) add(bak, 'profile backup', false);
  return out;
}

/** Judge every candidate (REQ-1806). */
function scan({ root, roots, keepDays, now = Date.now() }) {
  return candidates(root, roots).map((c) => {
    const st = statOrNull(c.abs);
    // a folder is dated by its newest file (a folder's own mtime moves when anything inside is renamed); an empty
    // folder has no file to date it by, so its own mtime counts
    const newest = c.dir ? newestMtime(c.abs) || (st ? st.mtimeMs : 0) : st ? st.mtimeMs : 0;
    const ageDays = newest ? Math.max(0, Math.floor((now - newest) / DAY)) : 0;
    const bytes = c.dir ? treeBytes(c.abs) : st ? st.size : 0;
    const reasons = [];
    const live = c.kind === 'run' ? liveLanes(c.abs) : [];
    for (const l of live) reasons.push(`lane ${l.lane} is ${l.status}`);
    let verdict;
    if (live.length) verdict = 'KEEP';
    else if (ageDays > keepDays) {
      verdict = 'SWEEP';
      reasons.push(`${c.kind}, ${ageDays} d old, over keepDays ${keepDays}`);
    } else {
      verdict = 'KEEP';
      reasons.push(`${c.kind}, ${ageDays} d old (under keepDays ${keepDays})`);
    }
    return { ...c, verdict, ageDays, bytes, reasons };
  });
}

/** Snapshot refs of runs whose lanes all merged, each with the command that deletes it; nothing is deleted. */
function mergedSnapshotRefs(root, items) {
  const out = [];
  const runs = items.filter((i) => i.kind === 'run' && allMerged(i.abs));
  if (!runs.length) return out;
  const r = spawnSync('git', ['for-each-ref', '--format=%(refname)', 'refs/orch/snapshots'], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) return out;
  const names = new Set(runs.map((i) => path.basename(i.abs)));
  for (const ref of (r.stdout || '').split(/\r?\n/).filter(Boolean)) {
    const run = ref.split('/')[3];
    if (names.has(run)) out.push({ ref, run, command: `git update-ref -d ${ref}` });
  }
  return out;
}

/** The trash folder for today: <root>/<logs>/trash/<YYYY-MM-DD>/. */
const trashDir = (root, logsDir, now = Date.now()) => path.join(root, logsDir, 'trash', new Date(now).toISOString().slice(0, 10));

/** Move one SWEEP item into the trash by rename; the destination name keeps the relative path with `/` → `__`. */
function moveOne(root, item, trash) {
  fs.mkdirSync(trash, { recursive: true });
  let dest = path.join(trash, item.rel.replace(/\//g, '__'));
  let n = 1;
  while (statOrNull(dest)) dest = path.join(trash, `${item.rel.replace(/\//g, '__')}.${n++}`);
  try {
    fs.renameSync(item.abs, dest);
    return { ok: true, dest };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** The whole sweep. Returns { items, moved, failed, refs, summary }. */
function run({ root, roots, keepDays, logsDir = 'logs', apply = false, now = Date.now(), report = () => {} }) {
  const items = scan({ root, roots, keepDays, now });
  const width = Math.max(4, ...items.map((i) => i.rel.length));
  for (const i of items) report(`${i.verdict.padEnd(5)} ${i.rel.padEnd(width)}  ${human(i.bytes)}, ${i.reasons.join('; ')}`);
  const moved = [];
  const failed = [];
  const trash = trashDir(root, logsDir, now);
  if (apply) {
    for (const i of items.filter((x) => x.verdict === 'SWEEP')) {
      const r = moveOne(root, i, trash);
      if (r.ok) {
        moved.push({ from: i.rel, to: rel(root, r.dest) });
        report(`moved ${i.rel} → ${rel(root, r.dest)}`);
      } else {
        failed.push(i.rel);
        report(`FAIL  ${i.rel}: ${r.error}`);
      }
    }
  }
  const refs = mergedSnapshotRefs(root, items);
  for (const r of refs) report(`REF   ${r.ref}  run ${r.run} merged — to delete it, run: ${r.command}`);
  const sweep = items.filter((i) => i.verdict === 'SWEEP').length;
  const bytes = items.filter((i) => i.verdict === 'SWEEP').reduce((a, i) => a + i.bytes, 0);
  const summary = apply
    ? `run-sweep: ${items.length} item(s) — ${moved.length} moved into ${rel(root, trash)}/ (${human(bytes)}), ${failed.length} failed, ${items.length - sweep} KEEP; ${refs.length} snapshot ref(s) listed. Restore an item by moving it back.`
    : `run-sweep: ${items.length} item(s) — ${sweep} SWEEP (${human(bytes)}), ${items.length - sweep} KEEP; ${refs.length} snapshot ref(s) listed (dry run: nothing is moved; add --apply to move SWEEP items into ${rel(root, trash)}/)`;
  return { items, moved, failed, refs, summary };
}

module.exports = { ACTIVE, candidates, liveLanes, allMerged, scan, mergedSnapshotRefs, trashDir, moveOne, run };
