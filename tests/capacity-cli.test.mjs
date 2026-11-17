/**
 * M15 — the capacity command (REQ-1510), the persona and the skill text (REQ-1512), the shipped-figure rule
 * (REQ-1514): scripts/capacity.mjs over a scratch project with an injected orch root. No model, no network.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { PACK, profileText, tmp } from './fixtures/orch/rig.mjs';

const require = createRequire(import.meta.url);
const cap = require('../scripts/lib/capacity.cjs');
const CLI = join(PACK, 'scripts', 'capacity.mjs');

function project(capacity = { state: 'on', perLaneMb: 1500 }) {
  const dir = tmp('capcli');
  writeFileSync(join(dir, 'PIPELINE_PROFILE.md'), profileText({ extraFeatures: { capacity } }));
  const root = join(dir, 'orch');
  mkdirSync(root, { recursive: true });
  const run = (args, env = {}) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8', timeout: 60000, env: { ...process.env, BUILDER_ORCH_DIR: root, BUILDER_NO_BASH_CAP: '1', ...env } });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', out: `${r.stdout || ''}${r.stderr || ''}` };
  };
  return { dir, root, run };
}

describe('REQ-1510 — run capacity --once | --watch', () => {
  test('red: the feature off → "capacity: not configured", exit 0, no record (AC-1510a)', () => {
    const { root, run } = project({ state: 'off' });
    const r = run(['--once']);
    assert.equal(r.status, 0, r.out);
    assert.equal(r.stdout.trim(), 'capacity: not configured');
    assert.equal(existsSync(join(root, 'capacity.json')), false);
  });

  test('--once writes the record and prints the table with figures and units; --json prints the record; exit 0', () => {
    const { root, run } = project();
    const r = run(['--once']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /^capacity: \d+ of 2 lane\(s\) — binding: [a-z-]+ \(tick 1, .*, ttl 180 s\)$/m);
    assert.match(r.stdout, /^ {2}memory: [\d.]+ (MB|GB) free of [\d.]+ (MB|GB), 1\.5 GB per lane, 1 GB kept free → \d+ lane\(s\)$/m);
    assert.match(r.stdout, /^ {2}accounts: /m);
    assert.match(r.stdout, /^ {2}rate-limit: no 429 on record — does not bind$/m);
    const rec = JSON.parse(readFileSync(join(root, 'capacity.json'), 'utf8'));
    for (const f of cap.RECORD_FIELDS) assert.ok(f in rec, f);
    assert.ok(rec.lanes <= 2);
    const j = run(['--once', '--json']);
    assert.equal(j.status, 0, j.out);
    assert.equal(JSON.parse(j.stdout).tick, 2);
  });

  test('red: a usage error exits 2; an invalid profile exits 2 naming the key', () => {
    const { run } = project();
    assert.equal(run([]).status, 2);
    assert.equal(run(['--once', '--watch']).status, 2);
    assert.equal(run(['--bogus']).status, 2);
    const bad = project({ state: 'on' });
    const r = bad.run(['--once']);
    assert.equal(r.status, 2, r.out);
    assert.match(r.out, /features\.capacity\.perLaneMb/);
  });

  test('red: a second watcher exits 0 saying one is live; a dead lease is taken over (AC-1510b)', () => {
    const { root, run } = project();
    writeFileSync(join(root, cap.LEASE), JSON.stringify({ pid: process.pid, at: '2026-11-17T12:00:00.000Z' }));
    const second = run(['--watch']);
    assert.equal(second.status, 0, second.out);
    assert.match(second.stdout, new RegExp(`^capacity: a watcher is live \\(pid ${process.pid} since 2026-11-17T12:00:00.000Z\\) — this one exits$`, 'm'));
    assert.equal(existsSync(join(root, 'capacity.json')), false, 'the second watcher writes nothing');
    writeFileSync(join(root, cap.LEASE), JSON.stringify({ pid: 2 ** 22 - 1, at: '2026-11-17T12:00:00.000Z' }));
    const taken = run(['--watch'], { BUILDER_CAPACITY_WATCH_TICKS: '1' });
    assert.equal(taken.status, 0, taken.out);
    assert.match(taken.stdout, /^capacity: \d+ of 2 lane\(s\)/m);
    assert.equal(existsSync(join(root, cap.LEASE)), false, 'the watcher releases its lease on exit');
  });

  test('red: a failing reading never changes the exit code (AC-1510c): the record says unmeasured', () => {
    const io = { os: { totalmem: () => 16 * 2 ** 30, freemem: () => 8 * 2 ** 30, cpus: () => Array(4).fill({}), loadavg: () => [1, 1, 1] }, platform: 'linux', statfs: () => { throw new Error('ENOSYS'); }, readiness: {}, ratelimit: null, env: {} };
    const root = tmp('capcli-io');
    const rec = cap.tick(root, { features: { orchestrator: { state: 'on', maxLanes: 2 }, capacity: { state: 'on', perLaneMb: 1500 } } }, io);
    assert.equal(rec.caps.disk.lanes, null);
    assert.match(cap.table(rec).join('\n'), /disk: unmeasured \(statfs threw: ENOSYS\) — does not bind/);
  });
});

describe('REQ-1512 — the capacity-steward persona and the orchestrator skill', () => {
  const persona = readFileSync(join(PACK, 'agents', 'capacity-steward.md'), 'utf8');
  test('red: neutral frontmatter, read-only, tier mid; the five-clause contract; the three return items (AC-1512a)', () => {
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(persona)[1];
    assert.match(fm, /^name: capacity-steward$/m);
    assert.match(fm, /^capabilities: read-only/m);
    assert.match(fm, /^tier: mid/m);
    assert.doesNotMatch(fm, /\b(acme|inventory service|georg)/i);
    for (let i = 1; i <= 5; i++) assert.match(persona, new RegExp(`^${i}\\. \\*\\*`, 'm'), `contract clause ${i}`);
    assert.match(persona, /The binding signal in words/);
    assert.match(persona, /One profile change, or none/);
    assert.match(persona, /A decision row/);
    assert.match(persona, /never raise the\s+cap/i);
  });
  test('red: the orchestrator skill names when the steward is dispatched and the watcher start (AC-1512c)', () => {
    const skill = readFileSync(join(PACK, 'skills', 'orchestrator.md'), 'utf8');
    assert.match(skill, /features\.capacity/);
    assert.match(skill, /run capacity --watch/);
    assert.match(skill, /capacity-steward/);
    assert.match(skill, /explainAfterTicks/);
  });
  test('the FEATURES table has the governor row and the template has the key (REQ-1514)', () => {
    assert.match(readFileSync(join(PACK, 'FEATURES.md'), 'utf8'), /^\| Capacity governor \|/m);
    assert.match(readFileSync(join(PACK, 'PIPELINE_PROFILE.template.md'), 'utf8'), /"capacity": {2,}\{ "state": "off", "perLaneMb": null/);
  });
});
