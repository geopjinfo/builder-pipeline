import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const { countLines, judge } = require('../scripts/lib/instruction-budget.cjs');

const lines = (n) => Array.from({ length: n }, (_, i) => `line ${i}`).join('\n');

describe('instruction-budget — pure', () => {
  test('the fixed counting rule: split on \\n, a trailing newline is one more line, CRLF counts as LF', () => {
    assert.equal(countLines('one line'), 1);
    assert.equal(countLines('a\nb\n'), 3);
    assert.equal(countLines('a\r\nb'), 2);
    assert.equal(countLines(''), 1);
  });

  test('red: an over-length synthetic file is caught; the budget itself is allowed', () => {
    const over = judge([{ path: 'INSTRUCTIONS.md', text: lines(230) }], 200);
    assert.equal(over.ok, false);
    assert.deepEqual(over.rows, [{ path: 'INSTRUCTIONS.md', lines: 230, over: true }]);
    assert.match(over.problems[0], /230 lines, over the 200-line budget by 30/);
    assert.equal(judge([{ path: 'INSTRUCTIONS.md', text: lines(200) }], 200).ok, true);
    assert.equal(judge([{ path: 'INSTRUCTIONS.md', text: lines(201) }], 200).ok, false);
  });

  test('red: a missing file fails — a budget over an absent file asserts nothing', () => {
    const v = judge([{ path: 'INSTRUCTIONS.md', text: null }], 200);
    assert.equal(v.ok, false);
    assert.match(v.problems[0], /INSTRUCTIONS\.md is missing/);
  });

  test('red: no listed file fails — a budget over nothing asserts nothing', () => {
    assert.match(judge([], 200).problems[0], /no instruction file is listed/);
  });
});

const cli = join(here, '..', 'scripts', 'instruction-budget.mjs');
const fixture = join(here, 'fixtures', 'instruction-budget', 'project');
const made = [];
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));
const project = () => {
  const dir = mkdtempSync(join(tmpdir(), 'builder-budget-'));
  cpSync(fixture, dir, { recursive: true });
  made.push(dir);
  return dir;
};
const run = (cwd) => spawnSync(process.execPath, [cli], { cwd, encoding: 'utf8' });
const out = (r) => `${r.stdout}${r.stderr}`;

describe('instruction-budget — CLI on a fixture project', () => {
  test('the fixture is within budget and prints path  N/max per file', () => {
    const r = run(project());
    assert.equal(r.status, 0, out(r));
    const printed = r.stdout.trim().split(/\r?\n/);
    assert.deepEqual(printed, ['INSTRUCTIONS.md   10/12', 'rules/testing.md  7/12', 'instruction-budget: PASS — 2 file(s) within 12 lines']);
  });

  test('red: an over-length root file exits 1', () => {
    const dir = project();
    writeFileSync(join(dir, 'INSTRUCTIONS.md'), lines(30));
    const r = run(dir);
    assert.equal(r.status, 1, out(r));
    assert.match(r.stdout, /^INSTRUCTIONS\.md {3}30\/12 {2}OVER$/m);
    assert.match(r.stdout, /instruction-budget: FAIL — 1 problem\(s\)/);
  });

  test('red: a listed file that is missing exits 1', () => {
    const dir = project();
    rmSync(join(dir, 'rules', 'testing.md'));
    const r = run(dir);
    assert.equal(r.status, 1, out(r));
    assert.match(r.stdout, /^rules\/testing\.md {2}MISSING\/12$/m);
  });

  test('an invalid budget is an invalid profile — exit 2', () => {
    const dir = project();
    writeFileSync(join(dir, 'PIPELINE_PROFILE.md'), '```json pipeline-settings\n{ "schema": 2, "features": { "instructionBudget": { "state": "on", "files": ["INSTRUCTIONS.md"], "maxLines": 0 } } }\n```\n');
    const r = run(dir);
    assert.equal(r.status, 2, out(r));
    assert.match(r.stderr, /maxLines: a positive integer/);
  });

  test('the feature off prints "instructionBudget: not configured"', () => {
    const dir = project();
    writeFileSync(join(dir, 'PIPELINE_PROFILE.md'), '```json pipeline-settings\n{ "schema": 2, "features": { "instructionBudget": { "state": "off" } } }\n```\n');
    const r = run(dir);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), 'instructionBudget: not configured');
  });
});
