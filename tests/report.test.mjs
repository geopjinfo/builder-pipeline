/**
 * M16 — the progress reporter's library (REQ-1602 to REQ-1605, REQ-1607, REQ-1612, REQ-1614, REQ-1615; D75, D77, D78,
 * D79). Pure build and digest on a golden fixture; ticks on a scratch orch root with a channel stub.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const PACK = join(here, '..');
const report = require('../scripts/lib/report.cjs');
const FIX = join(here, 'fixtures', 'report');
const sources = () => JSON.parse(readFileSync(join(FIX, 'sources.json'), 'utf8'));
const NOW = Date.parse('2026-11-17T10:00:00.000Z');
const made = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
const tmp = (p) => { const d = mkdtempSync(join(tmpdir(), `kit-report-${p}-`)); made.push(d); return d; };

describe('REQ-1603 — build is deterministic and ordered', () => {
  test('red: REQ-1603 the golden fixture with a fixed clock renders byte for byte, twice', () => {
    const a = report.build(sources(), { now: NOW, intervalMinutes: 30, filePath: '.pipeline/reports/latest.md' });
    const b = report.build(sources(), { now: NOW, intervalMinutes: 30, filePath: '.pipeline/reports/latest.md' });
    assert.equal(a, b);
    const golden = join(FIX, 'golden.md');
    if (process.env.UPDATE_GOLDEN === '1') writeFileSync(golden, a);
    assert.equal(a, readFileSync(golden, 'utf8'));
    const order = report.SECTIONS.map((s) => a.indexOf(`## ${s}`));
    assert.deepEqual(order, [...order].sort((x, y) => x - y), 'the fixed section order');
    assert.ok(order.every((i) => i >= 0), 'every section is present');
  });
  test('red: REQ-1602 a missing source prints its own line and is never dropped: no runs, costAccounting not configured', () => {
    const s = { ...sources(), runs: [], loops: {}, boards: [], events: [], readiness: null, ratelimit: null, capacity: null, cost: { configured: false } };
    const text = report.build(s, { now: NOW, intervalMinutes: 30 });
    assert.match(text, /## RUNS AND LANES\n+no runs/);
    assert.match(text, /## COST\n+costAccounting: not configured/);
    assert.match(text, /## CAPACITY AND ACCOUNTS\n+capacity: not configured/);
    assert.match(text, /readiness: no record/);
    for (const sec of report.SECTIONS) assert.ok(text.includes(`## ${sec}`), sec);
  });
  test('red: REQ-1614 the SUMMARY (model) section appears only while summary.md is younger than one interval, and is labelled', () => {
    const young = report.build({ ...sources(), summary: { text: 'All quiet.', ageMinutes: 5 } }, { now: NOW, intervalMinutes: 30 });
    assert.match(young, /## SUMMARY \(model\)\n+_written by the progress-reporter persona; a model's words, not a measurement_\n+All quiet\./);
    const old = report.build({ ...sources(), summary: { text: 'All quiet.', ageMinutes: 40 } }, { now: NOW, intervalMinutes: 30 });
    assert.ok(!old.includes('SUMMARY'));
  });
});

describe('REQ-1604 — the digest hashes state, not time', () => {
  test('red: the same state at two clocks has one digest; a lane status change changes it', () => {
    const a = report.digest(sources());
    const b = report.digest({ ...sources(), events: [{ at: '2026-11-17T11:00:00.000Z', type: 'noise' }] });
    assert.equal(a, b, 'events and times are not state parts');
    const s = sources(); s.runs[0].lanes.l2.status = 'DONE';
    assert.notEqual(report.digest(s), a);
    assert.match(a, /^[0-9a-f]{64}$/);
  });
});

/** A scratch project: a profile with the reporter on, an orch root with one run, a reports dir. */
function project({ reporter = {}, run = true } = {}) {
  const dir = tmp('proj');
  const root = join(dir, '.pipeline', 'orchestrator');
  mkdirSync(join(root, 'runs', 'r1'), { recursive: true });
  if (run) {
    writeFileSync(join(root, 'runs', 'r1', 'state.json'), JSON.stringify({ runId: 'r1', target: 'dev', approved: true, paused: false, lanes: { l1: { status: 'LAUNCHED', seat: 'secondary', rows: ['T1'], timings: {} } }, mergeQueue: [], rows: [], seats: ['secondary'], limits: {}, usage: {} }));
    writeFileSync(join(root, 'runs', 'r1', 'events.jsonl'), JSON.stringify({ at: '2026-11-17T09:00:00.000Z', type: 'run.init' }) + '\n');
  }
  const settings = { paths: { boards: 'tasks', runs: '.pipeline', registry: 'DEFERRED_TASKS.md', decisions: 'DECISIONS.md', logs: 'logs' }, features: { reporter: { state: 'on', channels: [{ kind: 'stdout' }], intervalMinutes: 30, onlyOnChange: true, heartbeatEvery: 3, alertOn: [], alertPollSeconds: 30, maxBytes: 3500, timeoutMs: 10000, reportsDir: '.pipeline/reports', ...reporter }, costAccounting: { state: 'off' } } };
  const sent = [];
  const stub = { kind: 'stub', send: async (payload) => { sent.push(payload); return { ok: true }; } };
  const failing = { kind: 'stub', send: async () => ({ ok: false, error: 'stub refused' }) };
  const io = (over = {}) => ({ cwd: dir, root, settings, env: { HOME: dir }, channels: [stub], now: NOW, ...over });
  return { dir, root, settings, sent, stub, failing, io, reports: join(dir, '.pipeline', 'reports') };
}

describe('REQ-1605, REQ-1604 — ticks: files, only on change, heartbeat', () => {
  test('red: REQ-1605 the first tick writes the dated file, latest.md and state.json, and the header says first report', async () => {
    const p = project();
    const r = await report.tick(p.io());
    assert.equal(r.sent, true);
    const files = readdirSync(p.reports);
    assert.ok(files.some((f) => /^report-\d{8}T\d{6}Z\.md$/.test(f)), files.join(','));
    assert.ok(existsSync(join(p.reports, 'latest.md')) && existsSync(join(p.reports, 'state.json')));
    assert.match(readFileSync(join(p.reports, 'latest.md'), 'utf8'), /first report/);
    assert.equal(p.sent.length, 1);
    assert.match(p.sent[0].text, /## RUNS AND LANES/);
    const st = JSON.parse(readFileSync(join(p.reports, 'state.json'), 'utf8'));
    assert.equal(st.lastDigest, r.digest);
    assert.ok(st.lastSentAt);
  });
  test('red: REQ-1604 the same state at a second tick writes the file and sends nothing; the third skipped tick sends one heartbeat line', async () => {
    const p = project();
    await report.tick(p.io());
    assert.equal(p.sent.length, 1);
    const t2 = await report.tick(p.io({ now: NOW + 30 * 60000 }));
    assert.equal(t2.sent, false);
    assert.equal(t2.skipped, true);
    assert.equal(p.sent.length, 1, 'nothing sent on an unchanged state');
    assert.equal(readdirSync(p.reports).filter((f) => f.startsWith('report-')).length, 2, 'the file is still written');
    await report.tick(p.io({ now: NOW + 60 * 60000 }));
    const t4 = await report.tick(p.io({ now: NOW + 90 * 60000 }));
    assert.equal(t4.heartbeat, true);
    assert.equal(p.sent.length, 2);
    assert.match(p.sent[1].text, /^heartbeat: no change since .* \(3 ticks skipped\)/);
  });
});

describe('REQ-1607, REQ-1615 — the guard in front of every payload', () => {
  test('red: a readiness reason holding an env value is NOT SENT; the log reads report.refused with the kind, never the value; the next header says so', async () => {
    const p = project();
    writeFileSync(join(p.dir, '.env'), 'DB_PASSWORD=s3cr3t-value-xyz\n');
    writeFileSync(join(p.root, 'accounts-readiness.json'), JSON.stringify({ accounts: { alpha: { state: 'not ready', reason: 'probe said s3cr3t-value-xyz', updatedAt: '2026-11-17T09:00:00.000Z' } }, updatedAt: '2026-11-17T09:00:00.000Z' }));
    const r = await report.tick(p.io());
    assert.equal(r.sent, false);
    assert.equal(r.refused, true);
    assert.equal(p.sent.length, 0);
    const log = readFileSync(join(p.reports, 'report.log.jsonl'), 'utf8');
    assert.match(log, /"type":"report\.refused"/);
    assert.match(log, /value from an env file/);
    assert.ok(!log.includes('s3cr3t-value-xyz'));
    const latest = readFileSync(join(p.reports, 'latest.md'), 'utf8');
    assert.ok(!latest.includes('s3cr3t-value-xyz'));
    assert.match(latest, /\[refused: value from an env file\]/);
    const next = await report.tick(p.io({ now: NOW + 30 * 60000 }));
    assert.match(readFileSync(join(p.reports, 'latest.md'), 'utf8'), /last send refused/);
    assert.ok(next.refused);
  });
  test('red: REQ-1615 each secret shape in a reason is replaced by [refused: <kind>] in the file copy and nothing is sent', async () => {
    const shapes = { 'Anthropic key': 'sk-ant-' + 'a'.repeat(40), 'GitHub token': 'ghp_' + 'b'.repeat(40), 'credentials in a URL': 'https://user:passw0rd@gateway.test/v1', JWT: ['eyJ' + 'a'.repeat(12), 'eyJ' + 'b'.repeat(12), 'c'.repeat(12)].join('.') };
    for (const [kind, value] of Object.entries(shapes)) {
      const p = project();
      writeFileSync(join(p.root, 'accounts-readiness.json'), JSON.stringify({ accounts: { alpha: { state: 'not ready', reason: `probe said ${value}` } }, updatedAt: '2026-11-17T09:00:00.000Z' }));
      const r = await report.tick(p.io());
      assert.equal(r.sent, false, kind);
      const latest = readFileSync(join(p.reports, 'latest.md'), 'utf8');
      assert.ok(!latest.includes(value), `${kind}: the value is absent`);
      assert.ok(latest.includes(`[refused: ${kind}]`), `${kind}: the kind is named`);
    }
  });
});

describe('REQ-1612 — alerts', () => {
  test('red: alertOn stall and a new lane.stall event sends one alert at once; the same offset sends nothing again', async () => {
    const p = project({ reporter: { alertOn: ['stall'] } });
    await report.tick(p.io());
    p.sent.length = 0;
    writeFileSync(join(p.root, 'runs', 'r1', 'events.jsonl'), JSON.stringify({ at: '2026-11-17T09:00:00.000Z', type: 'run.init' }) + '\n' + JSON.stringify({ at: '2026-11-17T10:05:00.000Z', type: 'lane.set', lane: 'l1', status: 'STALLED', stallReason: 'no notice in time' }) + '\n', 'utf8');
    const a = await report.alertPoll(p.io({ now: NOW + 5 * 60000 }));
    assert.equal(a.sent, 1);
    assert.equal(p.sent.length, 1);
    assert.match(p.sent[0].text, /^alert stall: r1\/l1 STALLED/);
    const b = await report.alertPoll(p.io({ now: NOW + 6 * 60000 }));
    assert.equal(b.sent, 0);
    assert.equal(p.sent.length, 1);
    assert.equal(report.alertKind({ type: 'lane.set', status: 'FAILED' }), 'failed');
    assert.equal(report.alertKind({ type: 'merge.stop' }), 'conflict');
    assert.equal(report.alertKind({ type: 'ratelimit.hit' }), 'rate-limit');
    assert.equal(report.alertKind({ type: 'account.limit' }), 'limit');
    assert.equal(report.alertKind({ type: 'run.end' }), 'run-complete');
    assert.equal(report.alertKind({ type: 'lane.set', status: 'DONE' }), null);
  });
});

describe('REQ-1601 — the profile rules live with the reporter', () => {
  test('red: validateReporter names the allowed kinds, the closed alert set, and urlEnv or urlFile without echoing a literal url', () => {
    const errs = (reporter) => report.validateReporter({ features: { reporter: { state: 'on', ...reporter } } });
    assert.match(errs({ channels: [] }).join('\n'), /channels/);
    assert.match(errs({ channels: [{ kind: 'email' }] }).join('\n'), /stdout \| file \| webhook \| command/);
    const lit = errs({ channels: [{ kind: 'webhook', format: 'slack', url: 'https://hooks.example.test/T000/B000/XXXXXXXX' }] }).join('\n');
    assert.match(lit, /urlEnv|urlFile/);
    assert.ok(!lit.includes('hooks.example.test') && !lit.includes('XXXXXXXX'), 'the URL is never echoed');
    assert.match(errs({ channels: [{ kind: 'webhook', format: 'teams', urlEnv: 'HOOK' }] }).join('\n'), /slack \| generic/);
    assert.match(errs({ channels: [{ kind: 'stdout' }], alertOn: ['email'] }).join('\n'), /stall, failed, conflict, rate-limit, limit, run-complete/);
    assert.deepEqual(errs({ channels: [{ kind: 'stdout' }, { kind: 'webhook', format: 'generic', urlEnv: 'HOOK' }], alertOn: ['stall'] }), []);
  });
});
