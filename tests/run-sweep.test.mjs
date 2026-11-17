/**
 * run-sweep (specs/repo-hygiene.spec.md, M18): old run folders and backups listed with size and age, moved by rename
 * into <logs>/trash/<date>/ with --apply, a live run always KEEP. Each test names its acceptance criterion (AC-1806).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const lib = require('../scripts/lib/run-sweep.cjs');
const CLI = join(here, '..', 'scripts', 'run-sweep.mjs');

const temps = [];
after(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });
const DAY = 24 * 3600 * 1000;
const block = (obj) => `# PIPELINE_PROFILE — t\n\n## 16. Pipeline settings\n\n\`\`\`json pipeline-settings\n${JSON.stringify(obj, null, 2)}\n\`\`\`\n`;

/** A project with two orchestrator runs: `old-run` (40 days, all lanes merged) and `live-run` (40 days, one LAUNCHED lane). */
function rig() {
  const proj = mkdtempSync(join(tmpdir(), 'run-sweep-'));
  temps.push(proj);
  const old = new Date(Date.now() - 40 * DAY);
  const mk = (rel, text) => {
    const p = join(proj, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
    utimesSync(p, old, old);
  };
  mk('.pipeline/orchestrator/runs/old-run/state.json', JSON.stringify({ lanes: { a: { status: 'MERGED', branch: 'orch/a' } } }));
  mk('.pipeline/orchestrator/runs/old-run/logs/a.log', 'done\n');
  mk('.pipeline/orchestrator/runs/live-run/state.json', JSON.stringify({ lanes: { b: { status: 'LAUNCHED', branch: 'orch/b' } } }));
  mk('.pipeline/orchestrator/claims.json', '{}');
  mk('logs/backups/worktrees-2026-10-01/wt-x/logs/run.log', 'x\n');
  mk('.builder/backup-20261001T000000Z/cli.js', '// old\n');
  mk('PIPELINE_PROFILE.md.bak', '# old profile\n');
  return proj;
}
const run = (cwd, args) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout };
};

describe('run-sweep — scan', () => {
  test('red: AC-1806 lists run folders, worktree backups, upgrade backups and the profile backup with size and age; a live run is KEEP', () => {
    const proj = rig();
    const items = lib.scan({ root: proj, roots: ['.pipeline', 'logs/backups'], keepDays: 30, now: Date.now() });
    const by = Object.fromEntries(items.map((i) => [i.rel, i]));
    assert.equal(by['.pipeline/orchestrator/runs/old-run'].verdict, 'SWEEP');
    assert.ok(by['.pipeline/orchestrator/runs/old-run'].ageDays >= 39);
    assert.ok(by['.pipeline/orchestrator/runs/old-run'].bytes > 0);
    assert.equal(by['.pipeline/orchestrator/runs/live-run'].verdict, 'KEEP');
    assert.match(by['.pipeline/orchestrator/runs/live-run'].reasons.join(' '), /lane b .*LAUNCHED/);
    assert.equal(by['logs/backups/worktrees-2026-10-01'].verdict, 'SWEEP');
    assert.equal(by['.builder/backup-20261001T000000Z'].verdict, 'SWEEP');
    assert.equal(by['PIPELINE_PROFILE.md.bak'].verdict, 'SWEEP');
    assert.equal(by['.pipeline/orchestrator/claims.json'], undefined, 'the orchestrator store files are never items');
  });

  test('red: AC-1806 a folder younger than keepDays is KEEP with its age', () => {
    const proj = rig();
    const items = lib.scan({ root: proj, roots: ['.pipeline'], keepDays: 60, now: Date.now() });
    assert.ok(items.length > 0);
    assert.ok(items.every((i) => i.verdict === 'KEEP'), JSON.stringify(items));
  });
});

describe('run-sweep — CLI', () => {
  test('red: AC-1806 --apply moves the old run under logs/trash/DATE/ with its content, keeps the live run, exit 0', () => {
    const proj = rig();
    writeFileSync(join(proj, 'PIPELINE_PROFILE.md'), block({ schema: 2, features: { runSweep: { state: 'on', keepDays: 30 } } }));
    const res = run(proj, ['--apply']);
    assert.equal(res.status, 0, res.out);
    assert.ok(!existsSync(join(proj, '.pipeline', 'orchestrator', 'runs', 'old-run')), 'old run moved');
    assert.ok(existsSync(join(proj, '.pipeline', 'orchestrator', 'runs', 'live-run', 'state.json')), 'live run in place');
    const trash = join(proj, 'logs', 'trash');
    const dates = readdirSync(trash);
    assert.equal(dates.length, 1);
    assert.match(dates[0], /^\d{4}-\d{2}-\d{2}$/);
    const moved = readdirSync(join(trash, dates[0]));
    const oldRun = moved.find((n) => n.includes('old-run'));
    assert.ok(oldRun, moved.join(','));
    assert.equal(readFileSync(join(trash, dates[0], oldRun, 'logs', 'a.log'), 'utf8'), 'done\n');
    assert.ok(moved.some((n) => n.includes('PIPELINE_PROFILE.md.bak')));
    assert.match(res.stdout, /^KEEP +\.pipeline\/orchestrator\/runs\/live-run /m);
    assert.match(res.stdout, /logs\/trash\//);
  });

  test('red: AC-1806 without --apply nothing moves and the summary says dry run', () => {
    const proj = rig();
    writeFileSync(join(proj, 'PIPELINE_PROFILE.md'), block({ schema: 2, features: { runSweep: { state: 'on', keepDays: 30 } } }));
    const res = run(proj, []);
    assert.equal(res.status, 0, res.out);
    assert.ok(existsSync(join(proj, '.pipeline', 'orchestrator', 'runs', 'old-run', 'logs', 'a.log')));
    assert.ok(!existsSync(join(proj, 'logs', 'trash')));
    assert.match(res.stdout, /^SWEEP +\.pipeline\/orchestrator\/runs\/old-run /m);
    assert.match(res.stdout, /dry run/);
  });

  test('red: AC-1807 feature off: run-sweep runs with the defaults and says so; --keep-days overrides; off with no flag is exit 3', () => {
    const proj = rig();
    const off = run(proj, []);
    assert.equal(off.status, 3, off.out);
    assert.match(off.stdout, /^runSweep: not configured$/m);
    const res = run(proj, ['--keep-days', '30']);
    assert.equal(res.status, 0, res.out);
    assert.match(res.stdout.split('\n')[0], /^runSweep: not configured — checking .* with defaults \(.*dry run/);
    assert.match(res.stdout, /^SWEEP +\.pipeline\/orchestrator\/runs\/old-run /m);
    assert.ok(existsSync(join(proj, '.pipeline', 'orchestrator', 'runs', 'old-run')));
    const bad = run(proj, ['--bogus']);
    assert.equal(bad.status, 2);
    assert.match(bad.out, /usage:/);
  });

  test('red: AC-1806b the sweep sources hold no recursive delete', () => {
    for (const f of ['scripts/lib/run-sweep.cjs', 'scripts/run-sweep.mjs', 'scripts/lib/branch-sweep.cjs']) {
      const src = readFileSync(join(here, '..', f), 'utf8');
      assert.doesNotMatch(src, /rmSync|rm -rf|rimraf|rmdirSync/, f);
      assert.doesNotMatch(src, /recursive:\s*true\s*,\s*force/, f);
    }
  });
});
