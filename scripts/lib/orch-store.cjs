'use strict';
/**
 * Batch orchestrator store — where a run's state lives and how it is written safely (feature `orchestrator`).
 *
 * Root: `<primary checkout>/.pipeline/orchestrator/` (gitignored with the rest of `.pipeline/`), found through the
 * git common dir, so every worktree of the repo resolves the SAME root. `BUILDER_ORCH_DIR` overrides it (tests,
 * scratch runs).
 *
 *   claims.json                 file claims of every live lane, across all runs (orch-claims.cjs)
 *   PAUSE                       present = every run is paused (one command halts all lanes)
 *   merge.lock                  one merge at a time, machine-wide (orch-merge.cjs)
 *   ratelimit.json              the one global 429 record (orch-ratelimit.cjs)
 *   tests.json · workers.json   the runtime switches (orch-preflight.cjs, orch-credit.cjs)
 *   runs/<run>/state.json       the run: lanes, seat, branch, level, status, timings
 *   runs/<run>/events.jsonl     append-only log of every transition
 *   runs/<run>/{lanes.json,briefs/,results/,headsups/,logs/,lease.json}
 *
 * WHY atomic writes under a lock with stale takeover: the orchestrating session can be killed at any point (a
 * crash, a compaction, a closed window). A half-written state file would lose every lane's status; a lock left
 * behind by a dead process would block the next session forever. So every write is tmp + rename under an O_EXCL
 * lock, and a lock older than `staleMs` is taken over.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/** The primary checkout of the repo `cwd` is in (the parent of the git common dir). */
function primaryRoot(cwd = process.cwd()) {
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, encoding: 'utf8' }).trim();
  return path.dirname(common);
}

function orchRoot(env = process.env, cwd = process.cwd()) {
  if (env.BUILDER_ORCH_DIR) return path.resolve(env.BUILDER_ORCH_DIR);
  return path.join(primaryRoot(cwd), '.pipeline', 'orchestrator');
}

const RUN_ID = /^[a-z0-9][a-z0-9-]{1,40}$/;

function runDir(root, runId) {
  if (!RUN_ID.test(String(runId))) throw new Error(`bad run id ${JSON.stringify(runId)} (lowercase, digits, '-'; 2-41 chars)`);
  return path.join(root, 'runs', runId);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw e;
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Run `fn` holding `lockFile`. A lock older than `staleMs` is taken over (its holder was killed). */
function withLock(lockFile, fn, { waitMs = 15000, staleMs = Number(process.env.BUILDER_ORCH_STALE_MS) || 60000 } = {}) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const until = Date.now() + waitMs;
  for (;;) {
    try {
      const fd = fs.openSync(lockFile, 'wx');
      fs.writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
      fs.closeSync(fd);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let age = 0;
      try {
        age = Date.now() - fs.statSync(lockFile).mtimeMs;
      } catch (_) {
        continue; // released between our open and our stat
      }
      if (age > staleMs) {
        try {
          fs.unlinkSync(lockFile);
        } catch (_) {
          /* another process took it over first */
        }
        continue;
      }
      if (Date.now() > until) {
        const err = new Error(`lock busy: ${lockFile}`);
        err.code = 'LOCK_BUSY';
        throw err;
      }
      sleep(100);
    }
  }
  try {
    return fn();
  } finally {
    try {
      fs.unlinkSync(lockFile);
    } catch (_) {
      /* already gone */
    }
  }
}

module.exports = { primaryRoot, orchRoot, runDir, readJson, writeJsonAtomic, withLock, RUN_ID };
