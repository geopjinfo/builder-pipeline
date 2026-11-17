/**
 * M16 — `npx builder-pipeline run report` (REQ-1611, REQ-1618; D85) and the status and doctor lines (REQ-1613).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PACK = join(here, '..');
const CLI = join(PACK, 'scripts', 'report.mjs');
const made = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

function project(reporter) {
  const dir = mkdtempSync(join(tmpdir(), 'kit-report-cli-'));
  made.push(dir);
  const block = { schema: 2, commands: { tier: null, tiers: [], affected: null, typecheck: null }, models: { strong: 's', mid: 'm', orchestrator: null }, features: { ...(reporter ? { reporter } : {}) } };
  writeFileSync(join(dir, 'PIPELINE_PROFILE.md'), `# P\n\n\`\`\`json pipeline-settings\n${JSON.stringify(block, null, 2)}\n\`\`\`\n`);
  mkdirSync(join(dir, '.pipeline', 'orchestrator', 'runs'), { recursive: true });
  const run = (args, env = {}) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, BUILDER_NO_BASH_CAP: '1', BUILDER_ORCH_DIR: join(dir, '.pipeline', 'orchestrator'), ...env }, timeout: 60000 });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', out: `${r.stdout || ''}${r.stderr || ''}` };
  };
  return { dir, run, reports: join(dir, '.pipeline', 'reports') };
}

describe('REQ-1611 — run report', () => {
  test('red: the feature off prints reporter: not configured and exits 0', () => {
    const p = project(null);
    const r = p.run(['--once']);
    assert.equal(r.status, 0, r.out);
    assert.equal(r.stdout.trim(), 'reporter: not configured');
  });
  test('red: --once builds and sends once on stdout; a failing channel keeps exit 0 and lands in the log', () => {
    const p = project({ state: 'on', channels: [{ kind: 'stdout' }, { kind: 'webhook', format: 'slack', urlEnv: 'NO_SUCH_HOOK' }] });
    const r = p.run(['--once']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /# Progress report/);
    assert.match(r.stdout, /## RUNS AND LANES\n+no runs/);
    const log = readFileSync(join(p.reports, 'report.log.jsonl'), 'utf8');
    assert.match(log, /notify\.failed/);
    assert.match(log, /NO_SUCH_HOOK/);
    assert.ok(existsSync(join(p.reports, 'latest.md')));
  });
  test('red: a usage error exits 2; an invalid profile exits 2', () => {
    const p = project({ state: 'on', channels: [{ kind: 'stdout' }] });
    assert.equal(p.run(['--nonsense']).status, 2);
    const bad = project({ state: 'on', channels: [{ kind: 'email' }] });
    const r = bad.run(['--once']);
    assert.equal(r.status, 2);
    assert.match(r.out, /stdout \| file \| webhook \| command/);
  });
});

describe('REQ-1618 — one watcher', () => {
  test('red: a live lease makes a second watcher exit 0 naming the pid; a dead pid is taken over', () => {
    const p = project({ state: 'on', channels: [{ kind: 'stdout' }], intervalMinutes: 30 });
    mkdirSync(p.reports, { recursive: true });
    writeFileSync(join(p.reports, 'watch.lock'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    const live = p.run(['--watch', '--max-ticks', '1']);
    assert.equal(live.status, 0, live.out);
    assert.match(live.stdout, new RegExp(`reporter: a watcher is live \\(pid ${process.pid}\\)`));
    assert.equal(existsSync(join(p.reports, 'latest.md')), false, 'the second watcher ticked nothing');
    writeFileSync(join(p.reports, 'watch.lock'), JSON.stringify({ pid: 999999, startedAt: '2026-01-01T00:00:00.000Z' }));
    const dead = p.run(['--watch', '--max-ticks', '1']);
    assert.equal(dead.status, 0, dead.out);
    assert.match(dead.stdout, /stale lease \(pid 999999\) taken over/);
    assert.ok(existsSync(join(p.reports, 'latest.md')), 'the watcher ticked');
    assert.equal(existsSync(join(p.reports, 'watch.lock')), false, 'the lease is released on exit');
  });
});
