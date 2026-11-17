'use strict';
/**
 * Capacity governor — one more min() term in the lane-cap rule (plan M15, REQ-1501 to REQ-1516; D70 to D74, D83).
 *
 * The governor reads the host (memory, cores, load, disk), the accounts readiness record and the 429 record, and
 * writes ONE record, `<orch root>/capacity.json`, beside `ratelimit.json`. `nextActions`, `gate-launch --resume` and
 * the loop runner read the record as one more term in min(maxLanes, 429 cap, record lanes). Rules:
 *
 *   - it LOWERS only (D71): never above the planned maximum or BUILDER_ORCH_LANE_CAP; it refuses new launches and never
 *     signals a process
 *   - an unmeasured signal never binds and is said (D72): load is unmeasured on win32 (os.loadavg() is zero there),
 *     disk is unmeasured when the filesystem call fails; a missing reading is null, never 0
 *   - a drop applies at once; a rise applies by one lane after `riseAfterTicks` consecutive ticks that allow it
 *   - every line names the figure and its unit (REQ-1515), never only a ratio
 *   - a stale record (older than ttlSeconds) is ignored by its readers, and they say so (D74)
 *
 * `govern()` is pure: readings and policy in, { lanes, binding, caps, reasons } out. `tick()` wraps it with the files.
 * `perLaneMb` is a project fact in PIPELINE_PROFILE.md §16 (D73), measured by the loop runner's pass RSS (D83).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readJson, writeJsonAtomic, withLock } = require('./orch-store.cjs');
const ratelimit = require('./orch-ratelimit.cjs');
const accountsLib = require('./orch-accounts.cjs');
const registry = require('./accounts-registry.cjs');

const FEATURE = 'capacity';
const FILE = 'capacity.json';
const LOCK = 'capacity.lock';
const LEASE = 'capacity.lease.json';
const MB = 1024 * 1024;
/** The order the caps are judged in; the first smallest one is the binding signal. */
const SIGNALS = Object.freeze(['memory', 'cores', 'load', 'disk', 'accounts', 'rate-limit']);
const RECORD_FIELDS = Object.freeze(['lanes', 'plannedMax', 'binding', 'caps', 'reasons', 'at', 'ttlSeconds', 'tick']);

const round1 = (n) => Math.round(n * 10) / 10;
/** A size with its unit: 1536 → "1.5 GB", 900 → "900 MB" (REQ-1515). */
const fmtMb = (mb) => (mb >= 1024 ? `${round1(mb / 1024)} GB` : `${Math.round(mb)} MB`);
const unmeasured = (why) => ({ value: null, source: 'unmeasured', why });

/* --------------------------------------------------------------- readings ---- */

/**
 * The host readings, each with a source (REQ-1502). `io.os`, `io.platform`, `io.statfs` and `io.diskPath` are
 * injectable; nothing here throws — a failed reading is unmeasured.
 */
function readings(io = {}) {
  const o = io.os || os;
  const platform = io.platform || process.platform;
  const out = {};
  try {
    out.memory = { totalMb: o.totalmem() / MB, freeMb: o.freemem() / MB, source: 'os' };
  } catch (e) {
    out.memory = { totalMb: null, freeMb: null, source: 'unmeasured', why: `os.totalmem/freemem threw: ${e.message}` };
  }
  try {
    out.cores = { value: o.cpus().length, source: 'os' };
  } catch (e) {
    out.cores = unmeasured(`os.cpus threw: ${e.message}`);
  }
  if (platform === 'win32') out.load = unmeasured('os.loadavg() is 0 on win32');
  else {
    try {
      out.load = { value: o.loadavg()[0], source: 'os' };
    } catch (e) {
      out.load = unmeasured(`os.loadavg threw: ${e.message}`);
    }
  }
  const statfs = io.statfs || (typeof fs.statfsSync === 'function' ? fs.statfsSync : null);
  if (!statfs) out.disk = { freeMb: null, source: 'unmeasured', why: 'fs.statfsSync is not available on this Node' };
  else {
    try {
      const st = statfs(io.diskPath || process.cwd());
      out.disk = { freeMb: (Number(st.bavail) * Number(st.bsize)) / MB, source: 'statfs' };
    } catch (e) {
      out.disk = { freeMb: null, source: 'unmeasured', why: `statfs threw: ${e.message}` };
    }
  }
  return out;
}

/* ----------------------------------------------------------------- govern ---- */

/**
 * The account cap: accounts that are ready, free of LIMIT / BUDGET / AUTH and under softLimitPct or unmeasured
 * (REQ-1504). `accounts` is the registry's { name: account } map; `readiness` the record's `accounts` map.
 */
function accountCap({ on, accounts = {}, readiness = {}, softLimitPct = 80, at = Date.now() }) {
  if (!on) return { lanes: null, source: 'unmeasured', line: 'accounts: features.accounts is off — does not bind' };
  const names = Object.keys(accounts);
  if (!names.length) return { lanes: null, source: 'unmeasured', line: 'accounts: no account in the registry — does not bind' };
  const notes = [];
  let free = 0;
  for (const name of names) {
    const entry = readiness[name];
    const r = accountsLib.readinessOf(entry, at);
    if (r.blocked) {
      notes.push(`${name}: ${r.why}`);
      continue;
    }
    const pct = entry && entry.usage && typeof entry.usage.pct === 'number' ? entry.usage.pct : null;
    if (pct !== null && pct >= softLimitPct) {
      notes.push(`${name}: ${pct} % used, at or over the soft limit of ${softLimitPct} %`);
      continue;
    }
    free += 1;
  }
  return { lanes: free, source: 'readiness', line: `accounts: ${free} of ${names.length} placeable${notes.length ? ` (${notes.join('; ')})` : ''} → ${free} lane(s)` };
}

/**
 * Pure: lanes = min(plannedMax, every measured cap); an unmeasured signal never binds; lanes may be 0 (REQ-1503).
 * `prev` is the previous record (rise damping, REQ-1506); `extra` carries the accounts and the 429 inputs.
 * @returns {{ lanes: number, computed: number, binding: string, caps: object, reasons: string[], riseTicks: number }}
 */
function govern(r, policy, plannedMax, prev = null, extra = {}) {
  const p = { ...DEFAULTS, ...(policy || {}) };
  const planned = Math.max(0, Math.floor(Number(plannedMax) || 0));
  const caps = {};
  const reasons = [];
  const cap = (name, lanes, line) => {
    caps[name] = { lanes, source: lanes === null ? 'unmeasured' : 'measured' };
    reasons.push(line);
  };
  const mem = r.memory || {};
  if (mem.source === 'unmeasured' || typeof mem.freeMb !== 'number') cap('memory', null, `memory: unmeasured (${mem.why || 'no reading'}) — does not bind`);
  else if (!(Number(p.perLaneMb) > 0)) cap('memory', null, 'memory: perLaneMb is not set — does not bind (set features.capacity.perLaneMb)');
  else {
    const usable = mem.freeMb - p.minFreeMb;
    const lanes = usable <= 0 ? 0 : Math.floor(usable / p.perLaneMb);
    cap('memory', lanes, `memory: ${fmtMb(mem.freeMb)} free of ${fmtMb(mem.totalMb)}, ${fmtMb(p.perLaneMb)} per lane, ${fmtMb(p.minFreeMb)} kept free → ${lanes} lane(s)`);
  }
  const cores = r.cores || {};
  if (cores.source === 'unmeasured' || typeof cores.value !== 'number') cap('cores', null, `cores: unmeasured (${cores.why || 'no reading'}) — does not bind`);
  else {
    const lanes = Math.max(0, cores.value - p.reserveCores);
    cap('cores', lanes, `cores: ${cores.value} cores, ${p.reserveCores} reserved → ${lanes} lane(s)`);
  }
  const load = r.load || {};
  if (load.source === 'unmeasured' || typeof load.value !== 'number' || typeof cores.value !== 'number') cap('load', null, `load: unmeasured (${load.why || 'no reading'}) — does not bind`);
  else {
    const lanes = Math.max(0, Math.floor(cores.value * p.maxLoadPerCore - load.value));
    cap('load', lanes, `load: ${round1(load.value)} (1 min) on ${cores.value} cores, max ${p.maxLoadPerCore} per core → ${lanes} lane(s)`);
  }
  const disk = r.disk || {};
  if (disk.source === 'unmeasured' || typeof disk.freeMb !== 'number') cap('disk', null, `disk: unmeasured (${disk.why || 'no reading'}) — does not bind`);
  else if (disk.freeMb < p.minDiskMb) cap('disk', 0, `disk: ${fmtMb(disk.freeMb)} free, ${fmtMb(p.minDiskMb)} needed → 0 lanes`);
  else cap('disk', null, `disk: ${fmtMb(disk.freeMb)} free, ${fmtMb(p.minDiskMb)} needed — no cap`);
  const acc = accountCap({ at: extra.at, ...(extra.accounts || { on: false }) });
  cap('accounts', acc.lanes, acc.line);
  const rl = ratelimit.laneCap(extra.ratelimit || null, extra.at || Date.now());
  if (!rl) cap('rate-limit', null, 'rate-limit: no 429 on record — does not bind');
  else if (rl.holdUntil) cap('rate-limit', 0, `rate-limit: 429 back-off until ${rl.holdUntil} → 0 lanes`);
  else cap('rate-limit', rl.lanes, `rate-limit: ${rl.lanes} lane(s) after a 429 — one more per clean finish`);

  let computed = planned;
  let binding = 'none';
  for (const name of SIGNALS) {
    const c = caps[name];
    if (c.lanes !== null && c.lanes < computed) {
      computed = c.lanes;
      binding = name;
    }
  }
  // REQ-1506: a drop applies at once; a rise by one lane after riseAfterTicks consecutive ticks that allow it
  let lanes = computed;
  let riseTicks = 0;
  if (prev && typeof prev.lanes === 'number') {
    if (computed > prev.lanes) {
      riseTicks = (prev.riseTicks || 0) + 1;
      if (riseTicks >= p.riseAfterTicks) {
        lanes = prev.lanes + 1;
        riseTicks = 0;
        reasons.push(`rise: ${prev.lanes} → ${lanes} lane(s) after ${p.riseAfterTicks} ticks that allowed ${computed}`);
      } else {
        lanes = prev.lanes;
        reasons.push(`rise: held at ${lanes} lane(s), tick ${riseTicks} of ${p.riseAfterTicks} that allow ${computed}`);
      }
    } else if (computed < prev.lanes) reasons.push(`drop: ${prev.lanes} → ${computed} lane(s) at once (${binding})`);
  }
  if (lanes < planned) reasons.unshift(`CAPACITY: lanes capped at ${lanes} of ${planned} — ${lanes < computed ? 'rise damping' : binding}`);
  else reasons.unshift(`CAPACITY: ${planned} lane(s) as planned — no signal binds`);
  return { lanes, computed, binding: lanes < planned ? (lanes < computed ? 'rise-damping' : binding) : 'none', caps, reasons, riseTicks };
}

const DEFAULTS = Object.freeze({ perLaneMb: null, reserveCores: 2, maxLoadPerCore: 1.0, minFreeMb: 1024, minDiskMb: 2048, intervalSeconds: 60, ttlSeconds: 180, riseAfterTicks: 3, holdMaxMinutes: 60, explainAfterTicks: 10 });

/* ----------------------------------------------------------------- record ---- */

const file = (root) => path.join(root, FILE);
const leaseFile = (root) => path.join(root, LEASE);

/** The planned maximum: BUILDER_ORCH_LANE_CAP (1–16) wins over features.orchestrator.maxLanes (REQ-1508). */
function plannedMaxOf(settings, env = process.env) {
  const n = Number(env.BUILDER_ORCH_LANE_CAP);
  if (Number.isInteger(n) && n >= 1 && n <= 16) return n;
  const o = (settings && settings.features && settings.features.orchestrator) || {};
  return Number.isInteger(o.maxLanes) && o.maxLanes > 0 ? o.maxLanes : 2;
}

/**
 * One tick: read, govern, write the record under its lock (REQ-1507, REQ-1513). `io`: os, platform, statfs, env,
 * now, readiness (injected record), refresh (false = never run the probes), ratelimit (injected record).
 */
function tick(root, settings, io = {}) {
  const policy = { ...DEFAULTS, ...((settings.features || {})[FEATURE] || {}) };
  const at = typeof io.now === 'number' ? io.now : Date.now();
  const env = io.env || process.env;
  const on = registry.accountsOn(settings);
  let readiness = io.readiness;
  if (readiness === undefined) {
    if (on && io.refresh !== false) {
      try {
        accountsLib.refresh(root, settings, { env, now: at });
      } catch (_) {
        /* the readiness record stays as it was; the account term reads what is on disk */
      }
    }
    readiness = accountsLib.load(root).accounts;
  }
  const accountsCfg = (settings.features && settings.features.accounts) || {};
  const extra = {
    at,
    accounts: { on, accounts: accountsCfg.accounts || {}, readiness, softLimitPct: accountsCfg.softLimitPct ?? registry.FEATURE_DEFAULTS.softLimitPct },
    ratelimit: io.ratelimit === undefined ? ratelimit.load(root) : io.ratelimit,
  };
  const planned = plannedMaxOf(settings, env);
  fs.mkdirSync(root, { recursive: true });
  return withLock(path.join(root, LOCK), () => {
    const prev = readJson(file(root), null);
    const g = govern(readings(io), policy, planned, prev, extra);
    const record = { lanes: g.lanes, plannedMax: planned, binding: g.binding, caps: g.caps, reasons: g.reasons, at: new Date(at).toISOString(), ttlSeconds: policy.ttlSeconds, tick: ((prev && prev.tick) || 0) + 1, riseTicks: g.riseTicks };
    writeJsonAtomic(file(root), record);
    return record;
  });
}

/**
 * The record a reader trusts at `at`: { record, stale, line }. null when there is no record. A record older than its
 * ttlSeconds is stale: the planned cap applies and `line` says so (REQ-1507).
 */
function read(root, at = Date.now()) {
  const record = readJson(file(root), null);
  if (!record || typeof record.lanes !== 'number') return null;
  const ttl = Number(record.ttlSeconds) > 0 ? Number(record.ttlSeconds) : DEFAULTS.ttlSeconds;
  const age = Math.round((at - Date.parse(record.at)) / 1000);
  if (!Number.isFinite(age) || age > ttl) return { record, stale: true, line: `CAPACITY: record from ${record.at} is ${Number.isFinite(age) ? `${age} s` : 'an unknown time'} old, over its ttl of ${ttl} s — ignored; the planned cap applies` };
  return { record, stale: false, line: record.lanes < record.plannedMax ? `CAPACITY: lanes capped at ${record.lanes} of ${record.plannedMax} — ${record.binding}` : null };
}

/** The lane cap the readers apply: { lanes, line } with lanes = the record's (fresh) or null (none or stale). */
function laneCap(root, at = Date.now()) {
  const r = read(root, at);
  if (!r) return { lanes: null, line: null };
  if (r.stale) return { lanes: null, line: r.line };
  return { lanes: r.record.lanes, line: r.line, binding: r.record.binding };
}

/** `orch status` line (REQ-1511). */
function statusLine(root, at = Date.now()) {
  const r = read(root, at);
  if (!r) return 'capacity: no record (run capacity --watch writes one)';
  return `capacity: ${r.record.lanes} of ${r.record.plannedMax} lane(s) · binding ${r.record.binding} · tick ${r.record.tick} at ${r.record.at}${r.stale ? ' · STALE — ignored' : ''}`;
}

/** The table `run capacity --once` prints. */
function table(record) {
  const lines = [`capacity: ${record.lanes} of ${record.plannedMax} lane(s) — binding: ${record.binding} (tick ${record.tick}, ${record.at}, ttl ${record.ttlSeconds} s)`];
  for (const l of record.reasons.filter((x) => !x.startsWith('CAPACITY:'))) lines.push(`  ${l}`);
  return lines;
}

/* ------------------------------------------------------------------ lease ---- */

/** Is the pid alive? `kill(pid, 0)` throws ESRCH for a dead one; EPERM means alive but foreign. */
function pidAlive(pid, io = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    (io.kill || process.kill)(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';
  }
}

/** Take the watcher lease: { ok: true } or { ok: false, pid } while another live watcher holds it (REQ-1510). */
function takeLease(root, io = {}) {
  const pid = io.pid || process.pid;
  fs.mkdirSync(root, { recursive: true });
  return withLock(path.join(root, LOCK), () => {
    const cur = readJson(leaseFile(root), null);
    if (cur && cur.pid !== pid && pidAlive(cur.pid, io)) return { ok: false, pid: cur.pid, since: cur.at };
    writeJsonAtomic(leaseFile(root), { pid, at: new Date(typeof io.now === 'number' ? io.now : Date.now()).toISOString() });
    return { ok: true, pid, takenOver: !!cur };
  });
}

function releaseLease(root, io = {}) {
  const pid = io.pid || process.pid;
  const cur = readJson(leaseFile(root), null);
  if (cur && cur.pid === pid) {
    try {
      fs.unlinkSync(leaseFile(root));
    } catch (_) {
      /* gone already */
    }
  }
}

/* --------------------------------------------------------------- pass RSS ---- */

/**
 * The peak RSS of a pid in MB, sampled with `ps -o rss= -p <pid>` (kB) on Unix; null (unmeasured) on win32 or when
 * ps fails (REQ-1516, D83). `io.ps(pid)` is injectable and returns the ps text.
 */
function rssMb(pid, io = {}) {
  const platform = io.platform || process.platform;
  if (platform === 'win32') return null;
  try {
    const text = io.ps ? io.ps(pid) : require('node:child_process').spawnSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000 }).stdout;
    const kb = Number(String(text || '').trim().split(/\s+/)[0]);
    return Number.isFinite(kb) && kb > 0 ? Math.round(kb / 1024) : null;
  } catch (_) {
    return null;
  }
}

module.exports = { FEATURE, FILE, LEASE, DEFAULTS, SIGNALS, RECORD_FIELDS, fmtMb, readings, accountCap, govern, plannedMaxOf, tick, read, laneCap, statusLine, table, file, leaseFile, pidAlive, takeLease, releaseLease, rssMb };
