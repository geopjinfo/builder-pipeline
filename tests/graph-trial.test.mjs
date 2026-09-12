/**
 * tooling/experimental/graph-trial — per-seat knowledge-index usage from the harness transcripts, the seat's
 * claimed return line beside it, a mismatch as a finding, and a control seat with calls flagged.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const trial = require('../tooling/experimental/graph-trial.cjs');

const project = join(here, 'fixtures', 'graph-trial', 'project');
const transcripts = join(project, 'transcripts');
const PATTERN = '(?:^|[\\s;&|/])idx(?:\\.exe)?\\s+(find|vocab|explain|query|path|affected)\\b';
const SEATS = ['orchestrator', 'module-planner', 'standards-auditor', 'invariant-auditor'];
const lines = (...p) => readFileSync(join(transcripts, ...p), 'utf8').split(/\r?\n/);
const bash = (command, extra = {}) => JSON.stringify({ type: 'assistant', ...extra, message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] } });
const text = (t) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: t }] } });

describe('graph-trial — pure', () => {
  test('counts every match in a command, normalises backslashes, and ignores non-Bash tools and other commands', () => {
    assert.deepEqual(trial.indexCalls([bash('idx query "a" && idx path "a" "b"'), bash('C:\\bin\\idx.exe explain "X"'), bash('npm test')], PATTERN), ['query', 'path', 'explain']);
    assert.deepEqual(trial.indexCalls(lines('sess-alpha', 'subagents', 'agent-s1.jsonl'), PATTERN), [], 'a Read tool_use carrying a command field is not a call');
  });

  test('red: a subcommand left out of the pattern is not a call — the record write-back never counts', () => {
    assert.deepEqual(trial.indexCalls(lines('sess-alpha', 'subagents', 'agent-p1.jsonl'), PATTERN), ['explain']);
  });

  test('a pattern with no capture group still counts, under "(call)"', () => {
    assert.deepEqual(trial.indexCalls([bash('idx find x; idx find y')], '\\bidx find\\b'), ['(call)', '(call)']);
  });

  test('sidechain records are dropped from the main session, torn lines are skipped', () => {
    const main = trial.withoutSidechain(lines('sess-alpha.jsonl'));
    assert.deepEqual(trial.indexCalls(main, PATTERN), ['find', 'query', 'path']);
    assert.deepEqual(trial.indexCalls(lines('sess-alpha.jsonl'), PATTERN), ['find', 'explain', 'query', 'path'], 'without the filter the sidechain call leaks in');
  });

  test('the claim is read from the LAST assistant text only; "not used" is a zero claim; no line is null', () => {
    assert.deepEqual(trial.claimedOutcome([text('graph: 4 calls, 3 useful, 1 dead_end')]), { calls: 4, useful: 3, deadEnd: 1, notUsed: false });
    assert.deepEqual(trial.claimedOutcome([text('graph: not used — no index')]), { calls: 0, useful: 0, deadEnd: 0, notUsed: true });
    assert.equal(trial.claimedOutcome(lines('sess-alpha', 'subagents', 'agent-x1.jsonl')), null, 'an earlier return line is superseded by a later text without one');
    assert.equal(trial.claimedOutcome([bash('idx find x')]), null);
  });

  test('a claimed count that differs from the transcript is a mismatch; "not used" with calls is one too', () => {
    const planner = trial.seatRow('module-planner', lines('sess-alpha', 'subagents', 'agent-p1.jsonl'), PATTERN, SEATS);
    assert.equal(planner.calls, 1);
    assert.equal(planner.claimed.calls, 3);
    assert.equal(planner.mismatch, true);
    assert.equal(trial.seatRow('standards-auditor', [bash('idx find x'), text('graph: not used')], PATTERN, SEATS).mismatch, true);
    assert.equal(trial.seatRow('standards-auditor', [bash('idx find x')], PATTERN, SEATS).mismatch, false, 'no claim, no mismatch');
  });

  test('a seat outside the trial group is control; a control seat with calls is flagged', () => {
    const row = trial.seatRow('module-builder', lines('sess-alpha', 'subagents', 'agent-b1.jsonl'), PATTERN, SEATS);
    assert.equal(row.group, 'control');
    assert.equal(row.controlCalls, true);
    assert.equal(trial.seatRow('module-planner', [bash('idx find x')], PATTERN, SEATS).controlCalls, false);
  });
});

const cli = join(here, '..', 'tooling', 'experimental', 'graph-trial-report.mjs');
const run = (cwd, ...args) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });
const made = [];
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));
const withProfile = (json) => {
  const dir = mkdtempSync(join(tmpdir(), 'builder-graphtrial-'));
  made.push(dir);
  writeFileSync(join(dir, 'PIPELINE_PROFILE.md'), `\`\`\`json pipeline-settings\n${json}\n\`\`\`\n`);
  return dir;
};

describe('graph-trial-report — CLI on a fixture project', () => {
  test('prints one row per dispatch, the mismatch, the flagged control seat, and both summary lines', () => {
    const r = run(project, 'sess-alpha', 'sess-beta', '--dir', 'transcripts');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const out = r.stdout.split(/\r?\n/);
    assert.equal(out[0], 'graphTrial: experimental — enabled; its measurement is owed (EXPERIMENTS.md)');
    assert.equal(out[1], '| Session | Seat | Group | Index calls | By subcommand | Seat says | Mismatch |');
    assert.deepEqual(out.slice(3, 9), [
      '| sess-alp | orchestrator | trial | 3 | find 1, query 1, path 1 | 3 calls, 2 useful, 1 dead-end |  |',
      '| sess-alp | module-builder | control — FLAG: should read 0 | 1 | find 1 | — |  |',
      '| sess-alp | module-planner | trial | 1 | explain 1 | 3 calls, 1 useful, 0 dead-end | YES |',
      '| sess-alp | standards-auditor | trial | 0 | — | not used |  |',
      '| sess-alp | unknown | control | 0 | — | — |  |',
      '| sess-bet | orchestrator | trial | 0 | — | not used |  |',
    ]);
    assert.match(r.stdout, /^trial seats: 4 dispatch\(es\), 4 index call\(s\) in the transcripts, 3 useful \/ 1 dead-end claimed, 1 mismatch\(es\), 0 with no return line$/m);
    assert.match(r.stdout, /^control seats: 2 dispatch\(es\), 1 index call\(s\) — FLAG: 1 control seat\(s\) made calls$/m);
  });

  test('--json carries the rows and the summary', () => {
    const data = JSON.parse(run(project, 'sess-alpha', '--dir', 'transcripts', '--json').stdout);
    assert.equal(data.rows.length, 5);
    assert.deepEqual(data.seats, SEATS);
    assert.equal(data.summary.trial.mismatches, 1);
    assert.equal(data.summary.flaggedControl, 1);
  });

  test('exit 1 when a named session has no transcript', () => {
    const r = run(project, 'sess-alpha', 'sess-missing', '--dir', 'transcripts');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no transcript .*transcripts\/sess-missing\.jsonl/);
  });

  test('exit 2 on usage: no session, --dir without a value, an unknown flag', () => {
    assert.equal(run(project).status, 2);
    assert.equal(run(project, 'sess-alpha', '--dir').status, 2);
    assert.equal(run(project, 'sess-alpha', '--dir', 'transcripts', '--verbose').status, 2);
  });

  test('the feature not enabled prints its line and exits 0; enabled without callPattern is an invalid profile, exit 2', () => {
    const off = run(withProfile('{ "schema": 2 }'), 'sess-alpha');
    assert.equal(off.status, 0);
    assert.equal(off.stdout.trim(), 'graphTrial: experimental — not enabled');
    const bad = run(withProfile('{ "schema": 2, "features": { "graphTrial": { "state": "experimental-on" } } }'), 'sess-alpha');
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /features\.graphTrial\.callPattern: required/);
  });
});
