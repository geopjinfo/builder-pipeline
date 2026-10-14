'use strict';
/**
 * Merge queue — one merge at a time into the target branch (features.orchestrator.target — the integration branch,
 * never the release branch unless the project says so), gates before each. Every lane — and so every hot file —
 * goes through it one by one, under a store-wide merge.lock.
 *
 * WHY one at a time: two lanes that each pass the gates on their own can fail together (a hot file both touched,
 * a migration order, a registry both appended). Merging one, then gating the next on top of it, is the only order
 * in which "green" means what it says.
 *
 * DIRECT mode (`integration: false`) — merge inside the target checkout:
 *   1. the checkout is on the target branch and clean, else refuse (touch nothing)
 *   2. dry conflict check (`git merge-tree --write-tree`, writes no ref and no work tree)
 *      conflict → lane STOPPED-CONFLICT + heads-up file; nothing is deleted or reset
 *   3. refresh: merge the target INTO the lane branch in the lane's own worktree (no rebase: history is never
 *      rewritten); a conflict there is aborted (`git merge --abort` restores the lane exactly) → heads-up
 *   4. gates in the lane worktree, exit code taken directly (never piped)
 *   5. `git merge --no-ff` into the target; claims released
 *
 * INTEGRATION mode (default) — no checkout of the target is touched:
 *   1. the merge is built on `orch/integration`: a --no-ff merge commit of the lane onto the target's CURRENT tip
 *      (git merge-tree + commit-tree); the integration ref moves by compare-and-swap. A conflict → heads-up
 *   2. gates run in a detached integration worktree checked out at that merge commit; directories in `linkDirs`
 *      (e.g. an installed dependency tree) are linked from the repo checkout first — refused when the tip changes a
 *      `linkGuard` file (a shared install would be the wrong one)
 *   3. green → the target moves by compare-and-swap `git update-ref refs/heads/<target> <new> <old>`; target moved
 *      meanwhile → refused, heads-up "target moved, rebuild integration", lane back in the queue
 *   4. a target checked out in a worktree is NEVER moved under it: the caller runs the printed
 *      `git -C "<wt>" merge --ff-only <sha>` there; the next `orch merge` sees it and records MERGED
 *
 * Every stop (heads-up, gates red, target moved) pins the lane with snapshot refs. Every git command here runs with
 * `-c core.hooksPath=<an empty temp dir>`: a hook a worker planted (or changed) never runs inside the merge. A lane
 * whose worktree holds a credit job not yet signed off is refused (orch-credit.cjs review hold).
 *
 * NEVER: reset, push, force, branch or worktree delete, history rewrite, dropping a lane's commits.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { withLock, runDir } = require('./orch-store.cjs');
const state = require('./orch-state.cjs');
const claims = require('./orch-claims.cjs');

let noHooksDir = null;
/** An empty directory made for this process; used as core.hooksPath so no hook can run. */
function emptyHooksDir() {
  if (!noHooksDir || !fs.existsSync(noHooksDir) || fs.readdirSync(noHooksDir).length) noHooksDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-nohooks-'));
  return noHooksDir;
}
const gitArgv = (args) => ['-c', `core.hooksPath=${emptyHooksDir()}`, ...args];
const git = (cwd, args) => {
  const r = spawnSync('git', gitArgv(args), { cwd, encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
};

function enqueue(root, runId, lane) {
  return state.update(root, runId, (s) => {
    const l = s.lanes[lane];
    if (!l) throw new Error(`no lane ${lane}`);
    if (l.status !== 'DONE') throw new Error(`lane ${lane} is ${l.status}; only a DONE lane is queued`);
    if (!s.mergeQueue.includes(lane)) s.mergeQueue.push(lane);
    l.status = 'QUEUED';
    l.timings.queuedAt = new Date().toISOString();
    return s.mergeQueue;
  }, { type: 'merge.enqueue', data: { lane } });
}

function headsUp(root, runId, lane, l, { stage, files, detail, next }) {
  const dir = path.join(runDir(root, runId), 'headsups');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${lane}.md`);
  const hot = files.filter((f) => (l.hotFiles || []).some((h) => h === f || f.startsWith(h.replace(/\*.*$/, ''))));
  fs.writeFileSync(file, [
    `# HEADS-UP — ${runId}/${lane} stopped at ${stage}`, '',
    `- Lane branch: \`${l.branch}\` — intact, nothing deleted, reset or force-pushed.`,
    `- Conflicting files: ${files.map((f) => `\`${f}\``).join(', ') || '(see detail)'}`,
    `- Hot files among them: ${hot.map((f) => `\`${f}\``).join(', ') || 'none'}`,
    `- Detail: ${detail}`, '',
    ...(next ? [next, ''] : [
      "Next (orchestrator): the lane worker merges the target into its branch in its own worktree and resolves the",
      "conflict keeping BOTH sides' planned work, re-runs the gates, then `orch enqueue` again. Tell the human.", '',
    ]),
  ].join('\n'));
  return file;
}

function stop(root, runId, lane, info) {
  const s = state.load(root, runId);
  const file = headsUp(root, runId, lane, s.lanes[lane], info);
  state.update(root, runId, (st) => {
    const x = st.lanes[lane];
    x.status = 'STOPPED-CONFLICT';
    x.conflictFiles = info.files;
    x.headsUp = file;
    x.timings.stoppedAt = new Date().toISOString();
    st.mergeQueue = st.mergeQueue.filter((q) => q !== lane);
  }, { type: 'merge.conflict', data: { lane, stage: info.stage, files: info.files, headsUp: file } });
  state.snapshotLane(root, runId, lane, `merge stopped at ${info.stage}`);
  return { ok: false, lane, stage: info.stage, files: info.files, headsUp: file };
}

/**
 * Merge the queue head. opts: { repo (the target checkout), gatesCmd, slotOk, logDir, integration,
 * integrationWorktree, linkDirs, linkGuard }. Returns { ok, lane, ... }. Throws only on a refusal that changed nothing.
 */
function mergeNext(root, runId, opts) {
  if (!opts.slotOk) throw new Error("refused: the gates need the machine's test slot — confirm nothing else is running tiers on this machine, then pass --slot-ok");
  if (!opts.gatesCmd) throw new Error('refused: no gates command — set features.orchestrator.gates or commands.tier, or pass --gates');
  return withLock(path.join(root, 'merge.lock'), () => {
    const s = state.load(root, runId);
    if (s.paused || fs.existsSync(state.pauseFile(root))) throw new Error('refused: run is paused');
    const lane = s.mergeQueue[0];
    if (!lane) return { ok: true, lane: null, note: 'queue empty' };
    const ctx = { root, runId, lane, l: s.lanes[lane], repo: opts.repo || s.repo, target: s.target };
    if (!ctx.target) throw new Error('refused: the run has no target branch (features.orchestrator.target)');
    const { mergeBlockers } = require('./orch-credit.cjs');
    const held = ctx.l && ctx.l.worktree && fs.existsSync(ctx.l.worktree) ? mergeBlockers(ctx.l.worktree) : [];
    if (held.length) {
      throw new Error(`refused: lane ${lane} holds credit job(s) not signed off — ${held.join('; ')}; read each diff, then orch credit-review <run> <task> --by <you> [--reject "<why>"] (a REJECTED job's changes must be reverted and marked --reverted)`);
    }
    return opts.integration === false ? mergeDirect(ctx, opts) : mergeIntegration(ctx, opts);
  }, { waitMs: 2000, staleMs: 6 * 60 * 60 * 1000 });
}

function mergeDirect({ root, runId, lane, l, repo, target }, opts) {
  const head = git(repo, ['symbolic-ref', '--short', 'HEAD']);
  if (head.out !== target) throw new Error(`refused: ${repo} is on "${head.out}", not ${target}`);
  if (git(repo, ['status', '--porcelain', '--untracked-files=no']).out) throw new Error(`refused: ${repo} has uncommitted changes`);

  state.setLane(root, runId, lane, { status: 'MERGING' });
  const dry = git(repo, ['merge-tree', '--write-tree', '--name-only', '--no-messages', target, l.branch]);
  if (dry.code === 1) return stop(root, runId, lane, { stage: 'dry-merge', files: dry.out.split(/\r?\n/).slice(1).filter(Boolean), detail: `git merge-tree ${target} ${l.branch} reports conflicts` });
  if (dry.code !== 0) throw new Error(`git merge-tree failed: ${dry.err}`);

  const wt = l.worktree;
  const tipBefore = git(wt, ['rev-parse', 'HEAD']).out;
  const refresh = git(wt, ['merge', '--no-ff', '--no-edit', target]);
  if (refresh.code !== 0) {
    const files = git(wt, ['diff', '--name-only', '--diff-filter=U']).out.split(/\r?\n/).filter(Boolean);
    git(wt, ['merge', '--abort']);
    return stop(root, runId, lane, { stage: 'refresh', files, detail: `merge of ${target} into ${l.branch} conflicted; aborted, lane back at ${tipBefore}` });
  }

  const g = runGates(root, runId, lane, wt, opts);
  if (g.exit !== 0) return gatesRed(root, runId, lane, g);

  const m = git(repo, ['merge', '--no-ff', '-m', `merge(${l.name}): ${l.rows.join(', ')} [orchestrator ${runId}]`, l.branch]);
  if (m.code !== 0) {
    const files = git(repo, ['diff', '--name-only', '--diff-filter=U']).out.split(/\r?\n/).filter(Boolean);
    git(repo, ['merge', '--abort']);
    return stop(root, runId, lane, { stage: 'merge', files, detail: 'final merge conflicted (target moved?); aborted' });
  }
  return merged(root, runId, lane, git(repo, ['rev-parse', 'HEAD']).out, g.log);
}

function merged(root, runId, lane, sha, log) {
  state.update(root, runId, (st) => {
    const x = st.lanes[lane];
    x.status = 'MERGED';
    x.mergeSha = sha;
    x.gatesLog = log;
    x.timings.mergedAt = new Date().toISOString();
    delete x.ffPending;
    st.mergeQueue = st.mergeQueue.filter((q) => q !== lane);
  }, { type: 'merge.done', data: { lane, sha, log } });
  claims.release(root, { runId, lane });
  return { ok: true, lane, sha, log };
}

/** Gates in `cwd`, exit code taken directly (never piped); the full output goes to a log file. */
function runGates(root, runId, lane, cwd, opts) {
  const logDir = opts.logDir || path.join(runDir(root, runId), 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const log = path.join(logDir, `gates-${lane}-${Date.now()}.log`);
  const g = spawnSync(opts.gatesCmd, { cwd, shell: true, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  fs.writeFileSync(log, `$ ${opts.gatesCmd}\nexit ${g.status}\n${g.stdout || ''}\n${g.stderr || ''}`);
  return { exit: g.status, log };
}

function gatesRed(root, runId, lane, g) {
  state.update(root, runId, (st) => {
    st.lanes[lane].status = 'FAILED';
    st.lanes[lane].gatesLog = g.log;
    st.mergeQueue = st.mergeQueue.filter((q) => q !== lane);
  }, { type: 'merge.gates-red', data: { lane, exit: g.exit, log: g.log } });
  state.snapshotLane(root, runId, lane, `gates red (exit ${g.exit})`);
  return { ok: false, lane, stage: 'gates', exit: g.exit, log: g.log };
}

// ------------------------------------------------------------------------------------- integration mode
const INTEGRATION_BRANCH = 'orch/integration';
const ZERO_SHA = '0'.repeat(40);
const refSha = (repo, ref) => {
  const r = git(repo, ['rev-parse', '--verify', '-q', `${ref}^{commit}`]);
  return r.code === 0 ? r.out : null;
};
const isAncestor = (repo, a, b) => git(repo, ['merge-base', '--is-ancestor', a, b]).code === 0;

/** The worktree that has `branch` checked out (`git worktree list --porcelain`), or null. */
function worktreeOf(repo, branch) {
  const list = git(repo, ['worktree', 'list', '--porcelain']).out;
  for (const block of list.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/);
    const wt = lines.find((x) => x.startsWith('worktree '));
    if (wt && lines.includes(`branch refs/heads/${branch}`)) return path.resolve(wt.slice('worktree '.length));
  }
  return null;
}

function buildIntegration(repo, base, l, runId) {
  const laneTip = refSha(repo, `refs/heads/${l.branch}`);
  if (!laneTip) throw new Error(`refused: lane branch ${l.branch} not found`);
  const dry = git(repo, ['merge-tree', '--write-tree', '--name-only', '--no-messages', base, laneTip]);
  if (dry.code === 1) return { files: dry.out.split(/\r?\n/).slice(1).filter(Boolean) };
  if (dry.code !== 0) throw new Error(`git merge-tree failed: ${dry.err}`);
  const tree = dry.out.split(/\r?\n/)[0];
  const c = git(repo, ['commit-tree', tree, '-p', base, '-p', laneTip, '-m', `merge(${l.name}): ${l.rows.join(', ')} [orchestrator ${runId}]`]);
  if (c.code !== 0) throw new Error(`git commit-tree failed: ${c.err}`);
  const old = refSha(repo, `refs/heads/${INTEGRATION_BRANCH}`);
  const u = git(repo, ['update-ref', `refs/heads/${INTEGRATION_BRANCH}`, c.out, old || ZERO_SHA]);
  if (u.code !== 0) throw new Error(`refused: ${INTEGRATION_BRANCH} moved while it was being rebuilt: ${u.err}`);
  return { sha: c.out, previous: old };
}

function checkoutIntegration(repo, wt, sha) {
  const r = fs.existsSync(wt) ? git(wt, ['checkout', '-q', '--detach', sha]) : git(repo, ['worktree', 'add', '-q', '--detach', wt, sha]);
  if (r.code !== 0) throw new Error(`refused: integration worktree ${wt} cannot check out ${sha}: ${r.err}`);
}

/**
 * The integration worktree's linked directories, before its gates. For each name in `linkDirs`:
 *   present — `<wt>/<name>` is a real directory (someone installed there): used as is, never entered;
 *   linked  — it was missing: a junction (Windows; a 'dir' symlink elsewhere) to the repo checkout's own.
 * A shared directory is only right when the tip changes none of `linkGuard` against the repo checkout's HEAD (a
 * changed dependency manifest or generated-client schema needs its own install): otherwise linking — or reusing an
 * existing link — is refused, and the lane stays QUEUED. Never deletes, replaces or recurses into a directory.
 * Returns the one line per directory that the merge prints.
 */
function provisionLinks(repo, wt, sha, { linkDirs = [], linkGuard = [] } = {}) {
  const lines = [];
  for (const name of linkDirs) {
    const link = path.join(wt, name);
    let st = null;
    try {
      st = fs.lstatSync(link);
    } catch (_) {
      /* missing */
    }
    if (st && !st.isSymbolicLink()) {
      lines.push(`deps: present ${link} (own install, used as is)`);
      continue;
    }
    if (linkGuard.length) {
      const d = git(repo, ['diff', '--quiet', 'HEAD', sha, '--', ...linkGuard]);
      if (d.code === 1) throw new Error(`refused: the integration tip ${sha} changes ${linkGuard.join(', ')} against ${repo} HEAD — a linked ${name} would be the wrong one; install it in ${wt}, then orch merge again`);
      if (d.code !== 0) throw new Error(`refused: cannot compare ${linkGuard.join(', ')} at ${sha} with ${repo} HEAD: ${d.err}`);
    }
    if (st) {
      lines.push(`deps: present ${link} → ${fs.readlinkSync(link)} (existing link, guard files unchanged)`);
      continue;
    }
    const source = path.join(path.resolve(repo), name);
    if (!fs.existsSync(source)) throw new Error(`refused: ${source} does not exist, nothing to link — install it in ${repo} or in ${wt}`);
    const target = fs.realpathSync(source);
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    lines.push(`deps: linked ${link} → ${target}`);
  }
  return lines;
}

function targetMoved(root, runId, lane, l, { target, expected, now }) {
  const file = headsUp(root, runId, lane, l, {
    stage: 'cas',
    files: [],
    detail: `target moved, rebuild integration — ${target} was ${expected} when the integration was built, now ${now || '(missing)'}`,
    next: 'Next (orchestrator): nothing changed on the target. Run `orch merge` again: the integration is rebuilt on the new target tip and the gates re-run.',
  });
  state.update(root, runId, (st) => {
    const x = st.lanes[lane];
    x.status = 'QUEUED';
    x.headsUp = file;
    delete x.ffPending;
  }, { type: 'merge.target-moved', data: { lane, target, expected, now, headsUp: file } });
  state.snapshotLane(root, runId, lane, 'merge stopped: target moved');
  return { ok: false, lane, stage: 'cas', files: [], headsUp: file };
}

function resumeFf({ root, runId, lane, l, repo, target }) {
  const p = l.ffPending;
  const now = refSha(repo, `refs/heads/${target}`);
  if (now && (now === p.sha || isAncestor(repo, p.sha, now))) return merged(root, runId, lane, p.sha, p.log);
  if (now === p.expectedOld) return { ok: false, lane, stage: 'ff-needed', sha: p.sha, command: p.command, worktree: p.worktree };
  return targetMoved(root, runId, lane, l, { target, expected: p.expectedOld, now });
}

function mergeIntegration(ctx, opts) {
  const { root, runId, lane, l, repo, target } = ctx;
  if (l.status === 'MERGING' && l.ffPending) return resumeFf(ctx);
  const base = refSha(repo, `refs/heads/${target}`);
  if (!base) throw new Error(`refused: target branch ${target} not found in ${repo}`);

  const built = buildIntegration(repo, base, l, runId);
  if (built.files) {
    state.setLane(root, runId, lane, { status: 'MERGING' });
    return stop(root, runId, lane, { stage: 'dry-merge', files: built.files, detail: `git merge-tree ${target} ${l.branch} reports conflicts` });
  }
  const resolved = path.resolve(repo);
  const wt = opts.integrationWorktree || path.join(path.dirname(resolved), `${path.basename(resolved)}-orch-integration`);
  checkoutIntegration(repo, wt, built.sha);
  const deps = provisionLinks(repo, wt, built.sha, opts); // throws (lane still QUEUED, target untouched) on a guard change
  state.setLane(root, runId, lane, { status: 'MERGING', integrationSha: built.sha, integrationBase: base, integrationDeps: deps });
  const withDeps = (r) => ({ ...r, deps });

  const g = runGates(root, runId, lane, wt, opts);
  if (g.exit !== 0) return withDeps(gatesRed(root, runId, lane, g));

  const checkedOut = worktreeOf(repo, target);
  if (checkedOut) {
    const now = refSha(repo, `refs/heads/${target}`);
    if (now !== base) return withDeps(targetMoved(root, runId, lane, l, { target, expected: base, now }));
    const command = `git -C "${checkedOut}" merge --ff-only ${built.sha}`;
    state.update(root, runId, (st) => {
      st.lanes[lane].ffPending = { sha: built.sha, expectedOld: base, worktree: checkedOut, command, log: g.log };
    }, { type: 'merge.ff-needed', data: { lane, sha: built.sha, worktree: checkedOut } });
    return withDeps({ ok: false, lane, stage: 'ff-needed', sha: built.sha, command, worktree: checkedOut, log: g.log });
  }
  const cas = git(repo, ['update-ref', `refs/heads/${target}`, built.sha, base]);
  if (cas.code !== 0) return withDeps(targetMoved(root, runId, lane, l, { target, expected: base, now: refSha(repo, `refs/heads/${target}`) }));
  return withDeps(merged(root, runId, lane, built.sha, g.log));
}

module.exports = { enqueue, mergeNext, worktreeOf, gitArgv, emptyHooksDir, provisionLinks, INTEGRATION_BRANCH };
