'use strict';
/**
 * The per-account lease — `accounts/<name>/lease.json` (plan M10, REQ-108; D32).
 *
 * WHY. A worker runs on one account at a time. While it runs, `accounts remove` and `accounts migrate` must not
 * change that account under it. The lease is one small JSON file `{ pid, startedAt, lane }` at `paths.leaseFile`;
 * the adapters (M6) acquire and release it, the CLI reads it. A lease whose process is gone is "stale": it is
 * reported and then ignored, so a crashed worker never blocks the owner. Liveness is `process.kill(pid, 0)`: ESRCH
 * means gone; EPERM means alive but not ours (still held).
 *
 * The file is written as temp + rename, so a reader never sees a half-written lease.
 */
const fs = require('fs');
const path = require('path');
const { paths } = require('./account-paths.cjs');

const file = (home, name) => paths(home, name).leaseFile;

/** The lease on `name`, or null when there is none or it cannot be read. */
function read(home, name) {
  try {
    const v = JSON.parse(fs.readFileSync(file(home, name), 'utf8'));
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

/** Does the lease's process still exist? `kill` is injectable for tests. */
function isLive(lease, kill = process.kill.bind(process)) {
  if (!lease || !Number.isInteger(lease.pid) || lease.pid <= 0) return false;
  try {
    kill(lease.pid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';
  }
}

/**
 * The lease state of `name`: `none` (no file), `live` (its process exists) or `stale` (file present, process gone
 * or file unreadable).
 * @returns {{ state: 'none' | 'live' | 'stale', lease: object | null }}
 */
function state(home, name, kill) {
  if (!fs.existsSync(file(home, name))) return { state: 'none', lease: null };
  const lease = read(home, name);
  return { state: isLive(lease, kill) ? 'live' : 'stale', lease };
}

/**
 * Hold the lease. Refuses (`{ ok: false, code: 'E_LEASE_HELD', reason }`) while a live lease exists; takes over a
 * stale one (`stale: true`).
 */
function acquire(home, name, { pid = process.pid, lane = null, now = new Date() } = {}, kill) {
  const cur = state(home, name, kill);
  if (cur.state === 'live') return { ok: false, code: 'E_LEASE_HELD', reason: `account "${name}" is in use by pid ${cur.lease.pid}${cur.lease.lane ? ` (lane ${cur.lease.lane})` : ''}` };
  const target = file(home, name);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const lease = { pid, startedAt: now.toISOString(), lane };
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(lease, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, target);
  return { ok: true, lease, stale: cur.state === 'stale' };
}

/** Drop the lease. True when a file was removed. */
function release(home, name) {
  try {
    fs.unlinkSync(file(home, name));
    return true;
  } catch {
    return false;
  }
}

module.exports = { read, isLive, state, acquire, release };
