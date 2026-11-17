'use strict';
/**
 * Branch sweep — one verdict per local branch, and a restorable removal (specs/repo-hygiene.spec.md, M18,
 * REQ-1802 to REQ-1805; decision D86).
 *
 *   MERGED  the tip is contained in `target` → removable
 *   STALE   not contained, last commit older than `staleDays` → reported, never removed
 *   KEEP    `target`, the current branch, a `keep` match, a branch checked out in any worktree, or a branch an
 *           orchestrator lane holds in LAUNCHED or STALLED (REQ-1805) — with the reason
 *
 * WHY report first, remove second (D86): a branch is cheap to keep and costly to lose. So `apply()` writes
 * `refs/builder/branches/<name>` at the tip BEFORE `git branch -d`, never `-D`: `-d` refuses a branch git does not
 * see as merged, and the ref restores the branch with one command the summary prints. Remote branches are listed
 * with the exact push command and the kit never runs a push (REQ-1804); with --apply only the remote-tracking
 * refs whose remote branch is gone are pruned (`git remote prune`), which touches nothing on the remote.
 *
 * `judge()` is pure: every git fact is passed in, so the verdicts are tested against fixtures without a repository.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SNAPSHOT_PREFIX = 'refs/builder/branches';
const DAY = 24 * 3600 * 1000;
const ACTIVE = ['LAUNCHED', 'STALLED']; // mirrors orch-state ACTIVE: a live worker session holds the lane and its branch

function git(repo, args) {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

/** Local branches with tip and last-commit time (ms). */
function listBranches(repo) {
  const r = git(repo, ['for-each-ref', '--format=%(refname:short)%09%(objectname)%09%(committerdate:unix)', 'refs/heads']);
  if (!r.ok) return [];
  return r.out.split(/\r?\n/).filter(Boolean).map((l) => {
    const [name, sha, unix] = l.split('\t');
    return { name, sha, committedAt: Number(unix) * 1000 };
  });
}

/** branch → worktree path, for every branch checked out in any worktree of the repo. */
function checkedOutBranches(repo) {
  const map = new Map();
  const r = git(repo, ['worktree', 'list', '--porcelain']);
  if (!r.ok) return map;
  let cur = null;
  for (const l of r.out.split(/\r?\n/)) {
    if (l.startsWith('worktree ')) cur = l.slice(9);
    else if (l.startsWith('branch ') && cur) map.set(l.slice(7).replace(/^refs\/heads\//, ''), cur);
  }
  return map;
}

function currentBranch(repo) {
  const r = git(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  return r.ok ? r.out : null;
}

/** Does `target` contain `sha`? Fail closed: an error reads as "not contained", so nothing is marked MERGED by mistake. */
function isAncestor(repo, sha, target) {
  return git(repo, ['merge-base', '--is-ancestor', sha, target]).ok;
}

/**
 * branch → { run, lane, status } for every orchestrator lane in LAUNCHED or STALLED, read from
 * `<orchRoot>/runs/<run>/state.json` (REQ-1805). A missing root is an empty map.
 */
function heldBranches(orchRoot) {
  const held = new Map();
  let runs;
  try {
    runs = fs.readdirSync(path.join(orchRoot, 'runs'), { withFileTypes: true });
  } catch (_) {
    return held;
  }
  for (const d of runs) {
    if (!d.isDirectory()) continue;
    let state;
    try {
      state = JSON.parse(fs.readFileSync(path.join(orchRoot, 'runs', d.name, 'state.json'), 'utf8'));
    } catch (_) {
      continue;
    }
    for (const [lane, l] of Object.entries(state.lanes || {})) {
      if (l && l.branch && ACTIVE.includes(l.status)) held.set(l.branch, { run: d.name, lane, status: l.status });
    }
  }
  return held;
}

/** A `keep` entry matches a branch name exactly, or as a glob where `*` spans any characters. */
function keepMatch(name, patterns) {
  for (const p of patterns || []) {
    if (p === name) return p;
    if (p.includes('*')) {
      const re = new RegExp(`^${p.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
      if (re.test(name)) return p;
    }
  }
  return null;
}

const ageDaysOf = (committedAt, now) => Math.max(0, Math.floor((now - committedAt) / DAY));

/**
 * The verdicts (REQ-1802, REQ-1805). Pure: `isAncestor(sha)` answers "is this tip contained in target";
 * `checkedOut` is branch → worktree path; `held` is branch → { run, lane, status }.
 */
function judge({ branches, target, current, staleDays, keep = [], checkedOut = new Map(), isAncestor: contained, held = new Map(), now = Date.now() }) {
  return branches.map((b) => {
    const ageDays = ageDaysOf(b.committedAt, now);
    const reasons = [];
    if (b.name === target) reasons.push(`target ${target}`);
    if (b.name === current) reasons.push('current branch');
    const k = keepMatch(b.name, keep);
    if (k) reasons.push(`keep: ${k}`);
    if (checkedOut.has(b.name)) reasons.push(`checked out in ${checkedOut.get(b.name)}`);
    const h = held.get(b.name);
    if (h) reasons.push(`orchestrator run ${h.run} holds lane ${h.lane} (${h.status})`);
    if (reasons.length) return { ...b, verdict: 'KEEP', ageDays, reasons };
    if (contained(b.sha)) return { ...b, verdict: 'MERGED', ageDays, reasons: [`contained in ${target}`, `last commit ${ageDays} d ago`] };
    if (ageDays > staleDays) return { ...b, verdict: 'STALE', ageDays, reasons: [`not contained in ${target}`, `last commit ${ageDays} d ago, over staleDays ${staleDays}`] };
    return { ...b, verdict: 'KEEP', ageDays, reasons: [`not contained in ${target}, last commit ${ageDays} d ago (under staleDays ${staleDays})`] };
  });
}

/** Remote-tracking branches contained in `target`, each with the push command a person would run (REQ-1804). */
function remoteMerged(repo, target) {
  const r = git(repo, ['for-each-ref', '--format=%(refname:short)%09%(objectname)', 'refs/remotes']);
  if (!r.ok || !r.out) return [];
  const out = [];
  for (const l of r.out.split(/\r?\n/).filter(Boolean)) {
    const [full, sha] = l.split('\t');
    const slash = full.indexOf('/');
    if (slash < 0) continue;
    const remote = full.slice(0, slash);
    const name = full.slice(slash + 1);
    if (name === 'HEAD' || name === target) continue;
    if (!isAncestor(repo, sha, target)) continue;
    out.push({ remote, name, sha, command: `git push ${remote} --delete ${name}` });
  }
  return out;
}

/** The remotes of the repo. */
function remotes(repo) {
  const r = git(repo, ['remote']);
  return r.ok ? r.out.split(/\r?\n/).filter(Boolean) : [];
}

/** Remote-tracking refs whose remote branch is gone, from `git remote prune --dry-run`; `apply` prunes them. */
function pruneTracking(repo, remote, apply) {
  const dry = git(repo, ['remote', 'prune', '--dry-run', remote]);
  const gone = dry.ok ? dry.out.split(/\r?\n/).map((l) => (l.match(/\[would prune\]\s+(\S+)/) || [])[1]).filter(Boolean) : [];
  let pruned = false;
  if (apply && gone.length) pruned = git(repo, ['remote', 'prune', remote]).ok;
  return { remote, gone, pruned };
}

/** Snapshot ref, then `git branch -d` (never -D). Returns { ok, ref, error }. */
function removeOne(repo, item) {
  const ref = `${SNAPSHOT_PREFIX}/${item.name}`;
  const snap = git(repo, ['update-ref', ref, item.sha]);
  if (!snap.ok) return { ok: false, ref, error: `snapshot ref failed: ${snap.err}` };
  const del = git(repo, ['branch', '-d', item.name]);
  if (!del.ok) return { ok: false, ref, error: del.err || 'git branch -d failed' };
  return { ok: true, ref };
}

const restoreCommand = (name) => `git branch ${name} ${SNAPSHOT_PREFIX}/${name}`;

/**
 * The whole sweep: judge, report, remove with --apply, list remotes. `report(line)` receives every output line.
 * Returns { items, remotes, pruned, written, failed, summary }.
 */
function run({ repo, target, staleDays, keep = [], apply = false, remote = 'list', orchRoot = null, now = Date.now(), report = () => {} }) {
  const items = judge({
    branches: listBranches(repo),
    target,
    current: currentBranch(repo),
    staleDays,
    keep,
    checkedOut: checkedOutBranches(repo),
    isAncestor: (sha) => isAncestor(repo, sha, target),
    held: orchRoot ? heldBranches(orchRoot) : new Map(),
    now,
  });
  const width = Math.max(4, ...items.map((i) => i.name.length));
  for (const i of items) report(`${i.verdict.padEnd(6)} ${i.name.padEnd(width)}  ${i.reasons.join('; ')}`);
  const written = [];
  const failed = [];
  if (apply) {
    for (const i of items.filter((x) => x.verdict === 'MERGED')) {
      const r = removeOne(repo, i);
      if (r.ok) {
        written.push(r.ref);
        report(`removed ${i.name} — snapshot ${r.ref}; restore: ${restoreCommand(i.name)}`);
      } else {
        failed.push(i.name);
        report(`FAIL   ${i.name}: ${r.error}`);
      }
    }
  }
  let remoteItems = [];
  const pruned = [];
  if (remote === 'list') {
    remoteItems = remoteMerged(repo, target);
    for (const r of remoteItems) report(`REMOTE ${r.remote}/${r.name}  contained in ${target} — to delete it, run: ${r.command}`);
    for (const rem of remotes(repo)) {
      const p = pruneTracking(repo, rem, apply);
      for (const g of p.gone) report(`${p.pruned ? 'pruned ' : 'GONE   '}${g}  remote branch gone${p.pruned ? '' : ' — --apply prunes the tracking ref'}`);
      if (p.pruned) pruned.push(...p.gone);
    }
  }
  const count = (v) => items.filter((i) => i.verdict === v).length;
  const mode = apply ? 'applied' : 'dry run';
  const summary = `branch-sweep: ${items.length} branch(es) — ${count('MERGED')} MERGED, ${count('STALE')} STALE, ${count('KEEP')} KEEP; ${remoteItems.length} remote branch(es) listed, ${pruned.length} tracking ref(s) pruned (${mode}${apply ? `; ${written.length} removed, ${failed.length} failed` : '; add --apply to remove MERGED branches'})${written.length ? `; snapshot refs: ${written.join(', ')} — restore with ${SNAPSHOT_PREFIX.replace('refs/builder/branches', 'git branch <name> refs/builder/branches/<name>')}` : ''}`;
  return { items, remotes: remoteItems, pruned, written, failed, summary };
}

module.exports = { SNAPSHOT_PREFIX, ACTIVE, listBranches, checkedOutBranches, currentBranch, isAncestor, heldBranches, keepMatch, judge, remoteMerged, pruneTracking, removeOne, restoreCommand, run };
