'use strict';
/**
 * EXAMPLE — a machine-wide tier lock. The interface it implements is in README.md beside this file.
 *
 * One tier at a time.
 *
 * WHY THIS EXISTS. In the project this came from, the integration and e2e configs share one global
 * setup — ONE PostgreSQL container and ONE template database per RUN. Two concurrent runs therefore fight over the same container and the same
 * template, and the loser fails on timeouts rather than on assertions, which reads as a regression
 * and is not one. Nothing prevented that before this file; it only stayed rare because a human runs
 * one tier at a time. An orchestrator dispatching background work does not.
 */
const nodeFs = require('node:fs');
const { dirname, join } = require('node:path');
const { tmpdir } = require('node:os');

/**
 * MACHINE-WIDE, not repo-relative — and that is the whole point.
 *
 * This was `logs/.tier.lock`, resolved against the CURRENT WORKING DIRECTORY. Every git worktree
 * therefore got its OWN lock file, so worktrees never contended and the lock did not serialize the
 * one arrangement it was written for: an orchestrator dispatching a builder per worktree.
 *
 * The contended resource is not the repo, it is the MACHINE — one Docker daemon, one PostgreSQL
 * container, one template database, as the note above says. A lock scoped more narrowly than the
 * resource it protects is not a weaker lock, it is an absent one; it just fails silently, as
 * timeouts in whichever run lost, which "reads as a regression and is not one".
 *
 * That was flagged as a plausible cause of intermittent integration failures, and was confirmed by
 * reading the path rather than by reproducing the race.
 *
 * Deliberately NOT keyed by repo path: two clones on one machine share the same Docker daemon and
 * would contend just as hard, so they should share the lock too.
 */
const DEFAULT_LOCK = join(tmpdir(), 'test-tier.lock');

class TierBusyError extends Error {}

/** `process.kill(pid, 0)` signals nothing; it only asks whether the pid is addressable. */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else — still alive.
    return error.code === 'EPERM';
  }
}

/**
 * Is the pid addressable AND is it plausibly still the process that took the lock?
 *
 * PID REUSE IS NOT HYPOTHETICAL — it has been OBSERVED. A tier run finished in the morning, the OS
 * later handed its pid to a browser started hours afterwards, and `isAlive(pid)` then answered
 * `true` for a run that was long over. Later tier invocations were refused as BUSY by a lock nobody
 * held.
 *
 * `isAlive` answers *"is this number addressable"*. The question the lock actually needs is
 * *"is that RUN still going"*, and the two diverge the moment the OS recycles the number. This
 * adds the cheap second fact: a holder whose lock is older than a full tier run's plausible
 * lifetime is treated as stale even if its pid now resolves. It is a CEILING, not a heuristic
 * about how long tiers take — set it to roughly twice your longest tier, so that a run genuinely
 * exceeding it has itself become the thing worth interrupting.
 *
 * The precise fix would compare the holder's process START TIME against `startedAt`, which needs a
 * per-platform call (`/proc/<pid>/stat`, `Get-Process -Id`) and a fallback for when it is
 * unavailable. Recorded rather than built: the ceiling closes the observed failure, and a lock
 * that needs an OS-specific probe to decide staleness is a lock with a second way to be wrong.
 */
const MAX_PLAUSIBLE_RUN_MS = 2 * 60 * 60 * 1000; // 2h — see above: a ceiling, not an estimate

function holderStillRunning(holder) {
  if (!isAlive(holder.pid)) return false;
  const startedAt = Date.parse(holder.startedAt ?? '');
  // A lock with no readable timestamp keeps the old behaviour: trust the pid. Refusing on an
  // unparseable field would turn a formatting change into an outage.
  if (Number.isNaN(startedAt)) return true;
  return Date.now() - startedAt < MAX_PLAUSIBLE_RUN_MS;
}

function busy(holder, lockPath) {
  if (!holder) {
    return new TierBusyError(
      `a concurrent run took the tier lock first (${lockPath}). ` +
        `RETRY FIRST — it may already be finished (see this file's header).`,
    );
  }
  return new TierBusyError(
    `tier "${holder.tier}" is already running (pid ${holder.pid}, since ${holder.startedAt}). ` +
      `RETRY FIRST — a pid can be REUSED, and a lock whose holder is long gone will say this (see this file's header). ` +
      `Wait for it, or delete ${lockPath} if you know it is stale.`,
  );
}

/** The raw lock body, or `undefined` if the file is gone. */
function readBody(fs, lockPath) {
  try {
    return fs.readFileSync(lockPath, 'utf8');
  } catch {
    return undefined;
  }
}

function parseHolder(body) {
  if (body === undefined) return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return undefined; // a corrupt lock is a dead lock
  }
}

function readHolder(fs, lockPath) {
  return parseHolder(readBody(fs, lockPath));
}

/** O_EXCL create: `true` if this call made the file, `false` if one already existed. */
function tryCreate(fs, lockPath, body) {
  try {
    fs.writeFileSync(lockPath, body, { flag: 'wx' });
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
}

/**
 * Remove the lock we judged stale WITHOUT deleting one somebody took in
 * the meantime. A bare rmSync cannot tell: two reclaimers judge the same stale file, the first
 * replaces it with a live lock, and the second's rmSync deletes that live lock. Instead the file is
 * RENAMED aside (atomic — only one reclaimer gets any given file) and its body compared with the
 * body we judged: the same → it was the stale lock, delete it (`true`, go create); different → it is
 * someone's live lock, put it back with an exclusive create and report busy (`false`). If the path
 * was re-taken while it was aside, the restore fails and we are busy all the same — the displaced
 * holder then no longer owns the path (its `release` leaves it, below); that narrow window is not
 * closed here. A lock that vanished before the rename needs no reclaim (`true`). Windows sharing
 * errors on the rename (EPERM/EBUSY/EACCES) mean someone has the file open → busy.
 */
function reclaimStale(fs, lockPath, judgedBody) {
  const aside = `${lockPath}.stale.${process.pid}.${Date.now()}`;
  try {
    fs.renameSync(lockPath, aside);
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    if (['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) return false;
    throw error;
  }
  const moved = readBody(fs, aside);
  if (moved === judgedBody) {
    fs.rmSync(aside, { force: true });
    return true;
  }
  if (moved !== undefined) tryCreate(fs, lockPath, moved); // restore; EEXIST → re-taken → busy anyway
  fs.rmSync(aside, { force: true });
  return false;
}

/**
 * The create is ATOMIC (`wx` / O_EXCL), not
 * check-then-write. On EEXIST the holder is re-read — live → busy; stale → `reclaimStale` renames it
 * aside and deletes it only if it is still the body we judged stale, then ONE more `wx` create; a
 * second EEXIST (or a reclaim that found a live lock) → busy. `release()` removes the lock only if
 * its body still names this holder (pid + startedAt) — a read-then-remove, so not atomic, but it no
 * longer deletes a lock another run took over. `fs` is injectable so a race test can interleave
 * two acquirers (inject a `renameSync`/`writeFileSync` that runs the rival between the calls).
 */
function acquire(tier, { lockPath = DEFAULT_LOCK, fs = nodeFs } = {}) {
  fs.mkdirSync(dirname(lockPath), { recursive: true });
  const me = { tier, pid: process.pid, startedAt: new Date().toISOString() };
  const body = JSON.stringify(me);
  const held = {
    release: () => {
      const current = readHolder(fs, lockPath);
      if (current && current.pid === me.pid && current.startedAt === me.startedAt) {
        fs.rmSync(lockPath, { force: true });
      }
    },
  };
  if (tryCreate(fs, lockPath, body)) return held;
  const judgedBody = readBody(fs, lockPath);
  const holder = parseHolder(judgedBody);
  if (holder && holderStillRunning(holder)) throw busy(holder, lockPath);
  // A lock whose process is gone must be reclaimable, or one killed run deadlocks the repo.
  if (judgedBody !== undefined && !reclaimStale(fs, lockPath, judgedBody)) {
    throw busy(readHolder(fs, lockPath), lockPath);
  }
  if (tryCreate(fs, lockPath, body)) return held;
  throw busy(readHolder(fs, lockPath), lockPath);
}

module.exports = { holderStillRunning, MAX_PLAUSIBLE_RUN_MS, acquire, TierBusyError, DEFAULT_LOCK };
