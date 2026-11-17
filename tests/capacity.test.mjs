/**
 * M15 — the capacity governor library (REQ-1502 to REQ-1507, REQ-1513, REQ-1515, REQ-1516; D71 to D74, D83):
 * pure govern() over injected readings, the record file, the lease and the RSS sampler. No model, no network.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { tmp } from './fixtures/orch/rig.mjs';

const require = createRequire(import.meta.url);
const cap = require('../scripts/lib/capacity.cjs');

const GB = 1024;
const host = (over = {}) => ({ memory: { totalMb: 16 * GB, freeMb: 2.9 * GB, source: 'os' }, cores: { value: 8, source: 'os' }, load: { value: 1.0, source: 'os' }, disk: { freeMb: 50 * GB, source: 'statfs' }, ...over });
const policy = { perLaneMb: 1500, minFreeMb: 1024, reserveCores: 2, maxLoadPerCore: 1.0, minDiskMb: 2048, riseAfterTicks: 3 };
const fakeOs = (over = {}) => ({ totalmem: () => 16 * GB * 1024 * 1024, freemem: () => 8 * GB * 1024 * 1024, cpus: () => Array(8).fill({}), loadavg: () => [0.5, 0.5, 0.5], ...over });

describe('REQ-1502 — readings carry a source; a missing reading is null, never 0', () => {
  test('red: load is unmeasured on win32 (AC-1502a)', () => {
    const r = cap.readings({ os: fakeOs(), platform: 'win32', statfs: () => ({ bavail: 1000000, bsize: 4096 }) });
    assert.equal(r.load.source, 'unmeasured');
    assert.equal(r.load.value, null);
    assert.equal(r.memory.source, 'os');
    assert.equal(r.cores.value, 8);
  });
  test('red: a throwing statfs leaves disk unmeasured and the run continues (AC-1502b)', () => {
    const r = cap.readings({ os: fakeOs(), platform: 'linux', statfs: () => { throw new Error('ENOSYS'); } });
    assert.equal(r.disk.source, 'unmeasured');
    assert.equal(r.disk.freeMb, null);
    assert.equal(r.load.value, 0.5);
  });
});

describe('REQ-1503 — govern is the minimum of plannedMax and every measured cap', () => {
  test('red: 16 GB total, 2.9 GB free, 1500 MB per lane, 8 cores, planned 4 → 1 lane, binding memory (AC-1503a)', () => {
    const g = cap.govern(host(), policy, 4);
    assert.equal(g.lanes, 1);
    assert.equal(g.binding, 'memory');
    assert.equal(g.caps.memory.lanes, 1);
    assert.equal(g.caps.cores.lanes, 6);
  });
  test('red: free memory under minFreeMb → 0 lanes with the reason (AC-1503b)', () => {
    const g = cap.govern(host({ memory: { totalMb: 16 * GB, freeMb: 900, source: 'os' } }), policy, 4);
    assert.equal(g.lanes, 0);
    assert.equal(g.binding, 'memory');
    assert.match(g.reasons.join('\n'), /memory: 900 MB free .* → 0 lane/);
  });
  test('red: an unmeasured signal never binds — load unmeasured, everything else above planned → planned, binding none (AC-1503c)', () => {
    const g = cap.govern(host({ memory: { totalMb: 64 * GB, freeMb: 40 * GB, source: 'os' }, load: { value: null, source: 'unmeasured', why: 'win32' } }), policy, 4);
    assert.equal(g.lanes, 4);
    assert.equal(g.binding, 'none');
    assert.equal(g.caps.load.lanes, null);
    assert.match(g.reasons.join('\n'), /load: unmeasured \(win32\) — does not bind/);
  });
});

describe('REQ-1504 — the account cap counts placeable accounts', () => {
  const accounts = { a1: { worker: 'claude-code' }, a2: { worker: 'codex' }, a3: { worker: 'claude-code' } };
  test('red: ready 62 %, ready unmeasured, LIMIT until later → cap 2, the LIMIT account named (AC-1504a)', () => {
    const at = Date.parse('2026-11-17T12:00:00Z');
    const readiness = {
      a1: { state: 'ready', usage: { pct: 62 } },
      a2: { state: 'ready', usage: null },
      a3: { state: 'ready', error: { kind: 'LIMIT', until: '2026-11-17T14:00:00Z' } },
    };
    const g = cap.govern(host({ memory: { totalMb: 64 * GB, freeMb: 40 * GB, source: 'os' } }), policy, 4, null, { at, accounts: { on: true, accounts, readiness, softLimitPct: 80 } });
    assert.equal(g.caps.accounts.lanes, 2);
    assert.equal(g.lanes, 2);
    assert.equal(g.binding, 'accounts');
    assert.match(g.reasons.join('\n'), /a3: LIMIT until 2026-11-17T14:00:00Z/);
  });
  test('red: an account at the soft limit is not placeable and says its percentage', () => {
    const a = cap.accountCap({ on: true, accounts: { x: {} }, readiness: { x: { state: 'ready', usage: { pct: 80 } } }, softLimitPct: 80 });
    assert.equal(a.lanes, 0);
    assert.match(a.line, /x: 80 % used, at or over the soft limit of 80 %/);
  });
  test('red: accounts off → no account cap and one reason line (AC-1504b)', () => {
    const g = cap.govern(host(), policy, 4, null, { accounts: { on: false } });
    assert.equal(g.caps.accounts.lanes, null);
    assert.equal(g.reasons.filter((l) => /^accounts: features\.accounts is off — does not bind$/.test(l)).length, 1);
  });
});

describe('REQ-1505 — the 429 record is one term', () => {
  test('red: a record in hold → 0 lanes, binding rate-limit (AC-1505a)', () => {
    const at = Date.parse('2026-11-17T12:00:00Z');
    const g = cap.govern(host(), policy, 4, null, { at, ratelimit: { plannedMax: 4, lanes: 2, consecutive429: 1, until: '2026-11-17T12:05:00Z' } });
    assert.equal(g.lanes, 0);
    assert.equal(g.binding, 'rate-limit');
    assert.match(g.reasons.join('\n'), /rate-limit: 429 back-off until 2026-11-17T12:05:00Z → 0 lanes/);
  });
  test('after the hold the 429 lane count is the term', () => {
    const at = Date.parse('2026-11-17T12:10:00Z');
    const g = cap.govern(host({ memory: { totalMb: 64 * GB, freeMb: 40 * GB, source: 'os' } }), policy, 4, null, { at, ratelimit: { plannedMax: 4, lanes: 2, consecutive429: 1, until: '2026-11-17T12:05:00Z' } });
    assert.equal(g.lanes, 2);
    assert.equal(g.binding, 'rate-limit');
  });
});

describe('REQ-1506 — a drop applies at once, a rise by one lane after riseAfterTicks ticks', () => {
  const roomy = host({ memory: { totalMb: 64 * GB, freeMb: 40 * GB, source: 'os' } });
  test('red: previous 1 lane, three ticks that compute 3 → 1, 1, 2 (AC-1506a)', () => {
    let prev = { lanes: 1, riseTicks: 0 };
    const seen = [];
    for (let i = 0; i < 3; i++) {
      const g = cap.govern(roomy, policy, 3, prev);
      seen.push(g.lanes);
      prev = { lanes: g.lanes, riseTicks: g.riseTicks };
    }
    assert.deepEqual(seen, [1, 1, 2]);
    assert.match(cap.govern(roomy, policy, 3, { lanes: 1, riseTicks: 0 }).reasons.join('\n'), /rise: held at 1 lane\(s\), tick 1 of 3 that allow 3/);
  });
  test('red: previous 2 lanes and a tick that computes 0 → 0 at once (AC-1506b)', () => {
    const g = cap.govern(host({ memory: { totalMb: 16 * GB, freeMb: 500, source: 'os' } }), policy, 3, { lanes: 2, riseTicks: 2 });
    assert.equal(g.lanes, 0);
    assert.equal(g.riseTicks, 0);
    assert.match(g.reasons.join('\n'), /drop: 2 → 0 lane\(s\) at once \(memory\)/);
  });
});

describe('REQ-1507, REQ-1513 — the record file', () => {
  const settings = (over = {}) => ({ features: { orchestrator: { state: 'on', maxLanes: 3 }, capacity: { state: 'on', perLaneMb: 1500, ttlSeconds: 180 }, ...over } });
  test('red: a tick writes capacity.json with the eight fields, atomically, and nothing else; process.kill is never called (AC-1507b, AC-1513a)', () => {
    const root = tmp('cap');
    const killed = [];
    const io = { os: fakeOs(), platform: 'linux', statfs: () => ({ bavail: 10000000, bsize: 4096 }), env: {}, now: Date.parse('2026-11-17T12:00:00Z'), readiness: {}, ratelimit: null, kill: (pid) => killed.push(pid) };
    const rec = cap.tick(root, settings(), io);
    for (const f of cap.RECORD_FIELDS) assert.ok(f in rec, `record has ${f}`);
    assert.equal(rec.lanes, 3);
    assert.equal(rec.tick, 1);
    assert.equal(rec.at, '2026-11-17T12:00:00.000Z');
    assert.deepEqual(readdirSync(root).filter((f) => !f.endsWith('.lock')).sort(), ['capacity.json']);
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'capacity.json'), 'utf8')).lanes, 3);
    assert.deepEqual(killed, []);
    assert.equal(cap.tick(root, settings(), io).tick, 2);
  });
  test('red: a record older than ttlSeconds is stale — the planned cap applies and the line says so (AC-1507a)', () => {
    const root = tmp('cap-stale');
    const at = Date.parse('2026-11-17T12:00:00Z');
    writeFileSync(join(root, 'capacity.json'), JSON.stringify({ lanes: 1, plannedMax: 3, binding: 'memory', caps: {}, reasons: [], at: new Date(at - 10 * 60000).toISOString(), ttlSeconds: 180, tick: 4 }));
    const r = cap.laneCap(root, at);
    assert.equal(r.lanes, null);
    assert.match(r.line, /^CAPACITY: record from .* is 600 s old, over its ttl of 180 s — ignored; the planned cap applies$/);
    const fresh = cap.laneCap(root, at - 10 * 60000 + 5000);
    assert.equal(fresh.lanes, 1);
    assert.equal(fresh.line, 'CAPACITY: lanes capped at 1 of 3 — memory');
    assert.match(cap.statusLine(root, at), /^capacity: 1 of 3 lane\(s\) · binding memory · tick 4 at .* · STALE — ignored$/);
  });
  test('no record → no cap and a status line that says so', () => {
    const root = tmp('cap-none');
    assert.deepEqual(cap.laneCap(root), { lanes: null, line: null });
    assert.equal(cap.statusLine(root), 'capacity: no record (run capacity --watch writes one)');
  });
  test('BUILDER_ORCH_LANE_CAP wins over maxLanes as the planned maximum (REQ-1508)', () => {
    assert.equal(cap.plannedMaxOf(settings(), { BUILDER_ORCH_LANE_CAP: '1' }), 1);
    assert.equal(cap.plannedMaxOf(settings(), { BUILDER_ORCH_LANE_CAP: 'x' }), 3);
    assert.equal(cap.plannedMaxOf({ features: {} }, {}), 2);
  });
});

describe('REQ-1515 — every line names the figure and the unit', () => {
  test('red: a memory bind holds the free figure and the per-lane figure in GB or MB (AC-1515a)', () => {
    const line = cap.govern(host(), policy, 4).reasons.find((l) => l.startsWith('memory:'));
    assert.match(line, /2\.9 GB free of 16 GB, 1\.5 GB per lane, 1 GB kept free/);
    assert.equal(cap.fmtMb(900), '900 MB');
    assert.equal(cap.fmtMb(1536), '1.5 GB');
  });
});

describe('REQ-1510, REQ-1618 — the watcher lease', () => {
  test('a live foreign pid keeps the lease; a dead one is taken over; the owner releases it', () => {
    const root = tmp('cap-lease');
    assert.equal(cap.takeLease(root, { pid: 111, kill: () => {} }).ok, true);
    const second = cap.takeLease(root, { pid: 222, kill: () => {} });
    assert.deepEqual([second.ok, second.pid], [false, 111]);
    const dead = () => { const e = new Error('no such process'); e.code = 'ESRCH'; throw e; };
    const third = cap.takeLease(root, { pid: 333, kill: dead });
    assert.deepEqual([third.ok, third.takenOver], [true, true]);
    cap.releaseLease(root, { pid: 333 });
    assert.equal(existsSync(cap.leaseFile(root)), false);
  });
});

describe('REQ-1516 — the pass RSS sampler', () => {
  test('red: a wrapper lane is measured by its process tree, not by the wrapper pid alone', () => {
    // pid 42 is a gateway wrapper (shell, 3 MB); its child 43 is npx (40 MB); the worker 44 is the grandchild (1.5 GB);
    // 99 is an unrelated process and must not count
    const listing = '    1     0  1024\n   42     1  3072\n   43    42 40960\n   44    43 1572864\n   99     1 999999\n';
    assert.equal(cap.rssMb(42, { platform: 'linux', ps: () => listing }), Math.round((3072 + 40960 + 1572864) / 1024));
    assert.equal(cap.rssMb(44, { platform: 'linux', ps: () => listing }), 1536, 'a leaf pid is its own RSS');
    assert.equal(cap.rssMb(7, { platform: 'linux', ps: () => listing }), null, 'a pid that is not in the listing is unmeasured');
  });
  test('red: ps prints 1572864 kB → 1536 MB; win32 → null (AC-1516a, AC-1516b)', () => {
    assert.equal(cap.rssMb(42, { platform: 'linux', ps: () => ' 1572864\n' }), 1536);
    assert.equal(cap.rssMb(42, { platform: 'win32', ps: () => '1572864' }), null);
    assert.equal(cap.rssMb(42, { platform: 'linux', ps: () => { throw new Error('no ps'); } }), null);
    assert.equal(cap.rssMb(42, { platform: 'linux', ps: () => '' }), null);
  });
});
