'use strict';
/**
 * Snapshots — when a lane goes STALLED or FAILED, or a merge stops, the lane's work is pinned by refs so nothing
 * that happens next (a relaunch, a refresh, a hand fix) can lose it:
 *
 *   refs/orch/snapshots/<run>/<lane>/<stamp>       → the lane branch tip
 *   refs/orch/snapshots/<run>/<lane>/<stamp>-wip   → `git stash create` of a dirty lane worktree (tracked changes;
 *                                                    untracked files are not in a stash commit)
 *
 * <stamp> is compact UTC (20261013T221805Z); a second snapshot in the same second gets `-2`, `-3`, ….
 * `git stash create` writes a commit object only: it touches neither the worktree, nor the index content, nor the
 * stash list. Refs are created create-only (old value all zeros) and NEVER deleted or moved.
 */
const fs = require('fs');
const { spawnSync } = require('child_process');

const PREFIX = 'refs/orch/snapshots';
const ZERO_SHA = '0'.repeat(40);

const git = (cwd, args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
};

/** Compact UTC stamp: 2026-10-13T22:18:05.123Z → 20261013T221805Z. */
const stamp = (at = new Date()) => new Date(at).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

const exists = (repo, ref) => git(repo, ['rev-parse', '--verify', '-q', ref]).code === 0;

function freeName(repo, base) {
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
    if (!exists(repo, name) && !exists(repo, `${name}-wip`)) return name;
  }
}

function createRef(repo, ref, sha) {
  const r = git(repo, ['update-ref', ref, sha, ZERO_SHA]);
  if (r.code !== 0) throw new Error(`snapshot ref ${ref}: ${r.err}`);
  return ref;
}

/**
 * Pin a lane: its branch tip, and its worktree's uncommitted tracked work when dirty.
 * Returns { tip, wip?, sha, untrackedOnly? } or { skipped: reason } when there is nothing to pin.
 */
function snapshot({ repo, runId, lane, branch, worktree, at = new Date() }) {
  if (!repo || !branch) return { skipped: 'no repo or lane branch recorded' };
  const tip = git(repo, ['rev-parse', '--verify', '-q', `refs/heads/${branch}^{commit}`]);
  if (tip.code !== 0) return { skipped: `lane branch ${branch} not found` };
  const name = freeName(repo, `${PREFIX}/${runId}/${lane}/${stamp(at)}`);
  const out = { sha: tip.out, tip: createRef(repo, name, tip.out) };
  if (worktree && fs.existsSync(worktree) && git(worktree, ['status', '--porcelain']).out) {
    const w = git(worktree, ['stash', 'create', `orch snapshot ${runId}/${lane}`]);
    if (w.code === 0 && w.out) out.wip = createRef(repo, `${name}-wip`, w.out);
    else out.untrackedOnly = true;
  }
  return out;
}

/** Every snapshot ref (of one run, when given) as { ref, sha }. */
function list(repo, runId) {
  const r = git(repo, ['for-each-ref', '--format=%(refname) %(objectname)', runId ? `${PREFIX}/${runId}` : PREFIX]);
  if (r.code !== 0) throw new Error(`git for-each-ref: ${r.err}`);
  return r.out
    ? r.out.split(/\r?\n/).map((l) => {
        const [ref, sha] = l.split(' ');
        return { ref, sha };
      })
    : [];
}

module.exports = { snapshot, list, stamp, PREFIX };
