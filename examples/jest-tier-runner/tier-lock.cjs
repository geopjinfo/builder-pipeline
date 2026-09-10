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
const { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
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

function acquire(tier, { lockPath = DEFAULT_LOCK } = {}) {
  mkdirSync(dirname(lockPath), { recursive: true });
  if (existsSync(lockPath)) {
    let holder;
    try {
      holder = JSON.parse(readFileSync(lockPath, 'utf8'));
    } catch {
      holder = undefined; // a corrupt lock is a dead lock
    }
    if (holder && holderStillRunning(holder)) {
      throw new TierBusyError(
        `tier "${holder.tier}" is already running (pid ${holder.pid}, since ${holder.startedAt}). ` +
          `RETRY FIRST — a pid can be REUSED, and a lock whose holder is long gone will say this (see this file's header). ` +
          `Wait for it, or delete ${lockPath} if you know it is stale.`,
      );
    }
    // A lock whose process is gone must be reclaimable, or one killed run deadlocks the repo.
    rmSync(lockPath, { force: true });
  }
  writeFileSync(lockPath, JSON.stringify({ tier, pid: process.pid, startedAt: new Date().toISOString() }));
  return { release: () => rmSync(lockPath, { force: true }) };
}

module.exports = { holderStillRunning, MAX_PLAUSIBLE_RUN_MS, acquire, TierBusyError, DEFAULT_LOCK };
