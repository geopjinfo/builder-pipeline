'use strict';
/**
 * The run lease and `orch wait`.
 *
 * LEASE. A killed orchestrating session is replaced by a new one; a session that merely went quiet may still be
 * alive. Two live orchestrators on one run double-launch lanes and race the merge queue. runs/<run>/lease.json =
 * { holder, pid, takenAt, renewedAt, expiresAt, ttlSec }, written under the run's state lock (the same lock every
 * state write takes), so two orchestrators cannot both take it:
 *   - no lease, or an expired one → taken (an expired lease of ANOTHER holder is a takeover, logged as an event)
 *   - a live lease of the same holder → renewed
 *   - a live lease of another holder → refused (exit 3)
 * COMPATIBILITY RULE: the state-changing commands (claim, set, approve, enqueue, merge, notice) check the lease only
 * when given `--holder`; without it they behave as if no lease existed. It keeps two lease-aware orchestrators
 * apart; it does not fence a caller that never names itself.
 *
 * WAIT. Block until the run's events.jsonl grows (complete lines only) or the timeout passes — default and maximum
 * 110 s, so one wait always fits inside a single tool call. The model never sleep-loops.
 */
const fs = require('fs');
const path = require('path');
const { runDir, readJson, writeJsonAtomic, withLock } = require('./orch-store.cjs');
const state = require('./orch-state.cjs');

const WAIT_MAX_S = 110;
const DEFAULT_TTL_S = 300;

const leaseFile = (root, runId) => path.join(runDir(root, runId), 'lease.json');
const lockFile = (root, runId) => path.join(runDir(root, runId), 'state.lock');
const iso = (ms) => new Date(ms).toISOString();
const live = (l, now) => !!l && Date.parse(l.expiresAt) > now;

function validHolder(holder) {
  if (typeof holder !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/.test(holder)) throw new Error(`refused: bad --holder ${JSON.stringify(holder)} (letters, digits, . _ -)`);
  return holder;
}

const refusal = (runId, l) => new Error(`refused: run ${runId} is leased by ${l.holder} (pid ${l.pid}) until ${l.expiresAt}`);

/** Take or renew the lease for `holder`. Returns { kind: take|renew|takeover, lease, previous }. */
function take(root, runId, holder, { ttlSec = DEFAULT_TTL_S, now = Date.now(), pid = process.pid } = {}) {
  validHolder(holder);
  if (!(Number(ttlSec) > 0)) throw new Error('refused: --ttl <seconds> must be > 0');
  state.load(root, runId); // the run must exist
  return withLock(lockFile(root, runId), () => {
    const cur = readJson(leaseFile(root, runId), null);
    if (live(cur, now) && cur.holder !== holder) throw refusal(runId, cur);
    const kind = live(cur, now) ? 'renew' : cur && cur.holder !== holder ? 'takeover' : 'take';
    const lease = { holder, pid, takenAt: kind === 'renew' ? cur.takenAt : iso(now), renewedAt: iso(now), expiresAt: iso(now + Number(ttlSec) * 1000), ttlSec: Number(ttlSec) };
    writeJsonAtomic(leaseFile(root, runId), lease);
    const data = { holder, pid, expiresAt: lease.expiresAt, ...(kind === 'takeover' ? { from: cur.holder, fromPid: cur.pid, expiredAt: cur.expiresAt } : {}) };
    state.event(root, runId, `lease.${kind}`, data);
    return { kind, lease, previous: cur };
  });
}

/** Refuse when another holder holds a live lease. `holder` undefined = the compatibility rule: no check. */
function check(root, runId, holder, now = Date.now()) {
  if (holder === undefined) return null;
  validHolder(holder);
  const cur = readJson(leaseFile(root, runId), null);
  if (live(cur, now) && cur.holder !== holder) throw refusal(runId, cur);
  return cur;
}

/** The wait in seconds: the given value clamped to (0, 110]; default 110. */
function waitSeconds(v) {
  const n = Number(v);
  if (v === undefined || v === true || !Number.isFinite(n) || n <= 0) return WAIT_MAX_S;
  return Math.min(n, WAIT_MAX_S);
}

const sizeOf = (file) => {
  try {
    return fs.statSync(file).size;
  } catch (_) {
    return 0;
  }
};

/** Complete lines appended to `file` after byte `from`, and the offset just past the last one. */
function newLines(file, from) {
  const size = sizeOf(file);
  if (size <= from) return { lines: [], offset: from };
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(size - from);
    fs.readSync(fd, buf, 0, buf.length, from);
    const end = buf.lastIndexOf(0x0a);
    if (end < 0) return { lines: [], offset: from }; // a half-written line: wait for the rest
    return { lines: buf.subarray(0, end).toString('utf8').split(/\r?\n/).filter(Boolean), offset: from + end + 1 };
  } finally {
    fs.closeSync(fd);
  }
}

/** Wait for new events of a run. Resolves { timedOut, lines, offset, seconds }. `from` defaults to the current end. */
async function waitForEvents(root, runId, { timeout, from, pollMs = 200 } = {}) {
  state.load(root, runId);
  const file = path.join(runDir(root, runId), 'events.jsonl');
  const seconds = waitSeconds(timeout);
  const start = from === undefined ? sizeOf(file) : Number(from);
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const r = newLines(file, start);
    if (r.lines.length) return { timedOut: false, ...r, seconds };
    if (Date.now() >= deadline) return { timedOut: true, lines: [], offset: start, seconds };
    await new Promise((res) => setTimeout(res, Math.min(pollMs, Math.max(1, deadline - Date.now()))));
  }
}

module.exports = { take, check, waitSeconds, waitForEvents, newLines, leaseFile, WAIT_MAX_S, DEFAULT_TTL_S };
