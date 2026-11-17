import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const { fixOfFix, fixRows } = require('../scripts/lib/fix-rate.cjs');

const fixture = join(here, 'fixtures', 'ledger', 'project');
const board = readFileSync(join(fixture, 'tasks', 'stock-levels.md'), 'utf8');

describe('fix-rate — pure', () => {
  test('counts a row that repairs another FIX, not one that merely mentions it', () => {
    assert.deepEqual(fixOfFix(board), { total: 5, fixOfFix: 2, ids: ['FIX-2', 'FIX-4'] });
  });

  test('red: "same shape as FIX-1" is not a repair; "re-opens FIX-2" is', () => {
    const one = (row) => fixOfFix(`| FIX-1 | first | DONE |\n| FIX-2 | second | DONE |\n${row}\n`).ids;
    assert.deepEqual(one('| FIX-3 | same shape as FIX-1, on the export route | DONE |'), []);
    assert.deepEqual(one('| FIX-3 | re-opens FIX-2: the export route | DONE |'), ['FIX-3']);
  });

  test('red: the mention-counting rule would have counted FIX-3 as a loop — the fixed rule does not', () => {
    const mentionRule = fixRows(board)
      .filter((r) => [...r.text.slice(r.text.indexOf(r.id) + r.id.length).matchAll(/\bFIX-(\d+)\b/g)].some((m) => `FIX-${m[1]}` !== r.base))
      .map((r) => r.id);
    assert.deepEqual(mentionRule, ['FIX-2', 'FIX-3', 'FIX-4']);
    assert.ok(!fixOfFix(board).ids.includes('FIX-3'));
  });

  test('a sub-lettered row naming its own base is not a loop, and a named id the board lacks is ignored', () => {
    assert.deepEqual(fixOfFix('| FIX-3 | a | DONE |\n| FIX-3a | FIX-3 was incomplete | DONE |\n| FIX-4 | FIX-9 regressed | DONE |').ids, []);
  });
});

const cli = join(here, '..', 'scripts', 'fix-rate.mjs');
const made = [];
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));
const project = () => {
  const dir = mkdtempSync(join(tmpdir(), 'builder-fixrate-'));
  cpSync(fixture, dir, { recursive: true });
  made.push(dir);
  return dir;
};
const run = (cwd, ...args) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });

describe('fix-rate — CLI on a fixture project', () => {
  test('no args reads every board in paths.boards (README and _*.md skipped) and says the lane is unmeasured', () => {
    const r = run(project());
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const lines = r.stdout.trim().split(/\r?\n/);
    assert.match(lines[0], /^fixLane: on \(unmeasured/);
    assert.match(lines[1], /^tasks\/stock-levels\.md\s+5 FIX · {2}2 fix-of-fix \(FIX-2, FIX-4\)$/);
    assert.match(lines[2], /^tasks\/restock\.md\s+2 FIX · {2}0 fix-of-fix$/);
    assert.equal(lines.at(-1), 'TOTAL 7 FIX rows · 2 fix-of-fix · 28.6%');
  });

  test('--json carries the totals and the feature line', () => {
    const r = run(project(), '--json');
    const data = JSON.parse(r.stdout);
    assert.equal(data.total, 7);
    assert.equal(data.fixOfFix, 2);
    assert.match(data.feature, /unmeasured/);
  });

  test('red: REQ-1403 a board with no FIX rows prints "fixLane: unmeasured" and exits with the not-configured code, never a pass', () => {
    const dir = project();
    writeFileSync(join(dir, 'tasks', 'stock-levels.md'), '# s\n\n## P2 — Code\n\n| # | Task | Cites | Status | Test-seed / evidence | Notes |\n|---|---|---|---|---|---|\n| T1 | a | R1 | DONE | t | |\n');
    writeFileSync(join(dir, 'tasks', 'restock.md'), '# r\n\n## P2 — Code\n\n| # | Task | Cites | Status | Test-seed / evidence | Notes |\n|---|---|---|---|---|---|\n| T1 | b | R2 | DONE | t | |\n');
    const r = run(dir);
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.match(r.stdout, /^fixLane: unmeasured — no FIX row in 2 board\(s\)/m);
    assert.ok(!/TOTAL .*0\.0%/.test(r.stdout), 'no rate is printed when nothing was measured');
  });

  test('red: REQ-1403 the lane is off by default in 2.0.0: the fixture profile switches it on', () => {
    const dir = project();
    writeFileSync(join(dir, 'PIPELINE_PROFILE.md'), '```json pipeline-settings\n{ "schema": 2 }\n```\n');
    const r = run(dir);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), 'fixLane: not configured');
  });

  test('the feature off prints "fixLane: not configured"', () => {
    const dir = project();
    writeFileSync(join(dir, 'PIPELINE_PROFILE.md'), '```json pipeline-settings\n{ "schema": 2, "features": { "fixLane": { "state": "off" } } }\n```\n');
    const r = run(dir);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), 'fixLane: not configured');
  });
});
