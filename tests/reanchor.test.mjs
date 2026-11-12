import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const profile = require('../scripts/lib/profile.cjs');
const reanchor = require('../scripts/lib/reanchor.cjs');
const hook = require('../hooks/claude-code/reanchor-after-compact.cjs');

const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const settingsWith = (features = {}) => profile.merge(profile.DEFAULTS, { features });
const ON = settingsWith({ reanchor: { state: 'on', maxRuns: 2 } });

const board = (phases, rows) => `# k — build board

<!-- phase:status start -->
| Phase | Seat | Status | Artifact | Verdict |
|---|---|---|---|---|
${phases.map(([p, s]) => `| ${p} | seat | ${s} | a | v |`).join('\n')}
<!-- phase:status end -->

## P2 — Code

| # | Task | Cites | Status | Test-seed / evidence | Notes |
|---|------|-------|--------|----------------------|-------|
${rows.map(([id, task, status]) => `| ${id} | ${task} | G-1 | ${status} | t.spec.ts | |`).join('\n')}
`;

const state = (now, fix) => `# k — orchestrator state

**Now:** ${now}

## Open FIX rows
| # | file:line | Rule / requirement id | Minimal fix | Status |
|---|-----------|-----------------------|-------------|--------|
${fix.map(([id, f, status]) => `| ${id} | src/a.ts:12 | SEC-3 | ${f} | ${status} |`).join('\n')}
`;

/** A project with one run per entry: { key, board, state, age } (age in seconds — larger is older). */
function project(runs) {
  const root = mkdtempSync(join(tmpdir(), 'reanchor-'));
  dirs.push(root);
  mkdirSync(join(root, 'tasks'));
  for (const r of runs) {
    mkdirSync(join(root, '.pipeline', r.key), { recursive: true });
    const s = join(root, '.pipeline', r.key, 'state.md');
    writeFileSync(s, r.state);
    if (r.board) writeFileSync(join(root, 'tasks', `${r.key}.md`), r.board);
    const t = Date.now() / 1000 - (r.age ?? 0);
    utimesSync(s, t, t);
  }
  return root;
}

test('a run in flight: state path with its Now line, the board with its first open phase, open FIX rows verbatim', () => {
  const root = project([
    {
      key: 'x44',
      state: state('P3 Test — dispatched', [['FIX-1', 'add the scope check', 'IN-PROGRESS'], ['FIX-2', 'old fix', 'DONE']]),
      board: board([['P1 Plan', 'DONE'], ['P2 Code', 'DONE'], ['P3 Test', 'IN-PROGRESS']], [['T1', 'build', 'DONE'], ['FIX-3', 'board-only fix', 'PLANNED']]),
    },
  ]);
  const { runs } = reanchor.collect({ root, settings: ON });
  assert.equal(runs.length, 1);
  assert.equal(runs[0].state, '.pipeline/x44/state.md');
  assert.equal(runs[0].board, 'tasks/x44.md');
  assert.equal(runs[0].now, 'P3 Test — dispatched');
  assert.equal(runs[0].phase, 'P3 Test · IN-PROGRESS');
  assert.deepEqual(runs[0].fix, [
    '| FIX-1 | src/a.ts:12 | SEC-3 | add the scope check | IN-PROGRESS |',
    '| FIX-3 | board-only fix | G-1 | PLANNED | t.spec.ts | |',
  ]);
  const text = reanchor.render({ runs });
  assert.match(text, /re-read these files in order/);
  assert.match(text, /1\. \.pipeline\/x44\/state\.md {2}\(Now: P3 Test — dispatched\)/);
  assert.match(text, /\| FIX-1 \| src\/a\.ts:12 \| SEC-3 \| add the scope check \| IN-PROGRESS \|/);
  assert.doesNotMatch(text, /old fix/);
});

test('a FIX row on both the state file and the board is printed once, from the state file', () => {
  const root = project([
    {
      key: 'k',
      state: state('P2 Code', [['FIX-1', 'state wording', 'PLANNED']]),
      board: board([['P2 Code', 'IN-PROGRESS']], [['FIX-1', 'board wording', 'PLANNED']]),
    },
  ]);
  const [run] = reanchor.collect({ root, settings: ON }).runs;
  assert.equal(run.fix.length, 1);
  assert.match(run.fix[0], /state wording/);
});

test('finished runs are skipped, newest first, at most maxRuns', () => {
  const done = board([['P1 Plan', 'DONE'], ['P2 Code', 'DONE']], [['T1', 'x', 'DONE']]);
  const open = board([['P1 Plan', 'DONE'], ['P2 Code', 'IN-PROGRESS']], [['T1', 'x', 'PLANNED']]);
  const root = project([
    { key: 'finished', state: state('P8', []), board: done, age: 0 },
    { key: 'old', state: state('P2', []), board: open, age: 300 },
    { key: 'mid', state: state('P2', []), board: open, age: 200 },
    { key: 'new', state: state('P2', []), board: open, age: 100 },
  ]);
  assert.deepEqual(reanchor.collect({ root, settings: ON }).runs.map((r) => r.key), ['new', 'mid']);
  const one = settingsWith({ reanchor: { state: 'on', maxRuns: 1 } });
  assert.deepEqual(reanchor.collect({ root, settings: one }).runs.map((r) => r.key), ['new']);
});

test('a run with a state file but no board is still pointed at, and says so', () => {
  const root = project([{ key: 'nob', state: state('P1 Plan', []) }]);
  const { runs } = reanchor.collect({ root, settings: ON });
  assert.equal(runs[0].board, null);
  assert.match(reanchor.render({ runs }), /\(no board found\)/);
});

test('no runs on disk → empty text', () => {
  const root = project([]);
  assert.equal(reanchor.render(reanchor.collect({ root, settings: ON })), '');
});

test('hook decide: only after a compaction, only with the feature on', () => {
  const root = project([{ key: 'k', state: state('P2', [['FIX-1', 'f', 'PLANNED']]) }]);
  assert.equal(hook.decide({ source: 'compact' }, settingsWith(), { root }).reason, 'reanchor: not configured');
  assert.equal(hook.decide({ source: 'startup' }, ON, { root }).action, 'pass');
  assert.equal(hook.decide({ source: 'resume' }, ON, { root }).action, 'pass');
  const d = hook.decide({ source: 'compact' }, ON, { root });
  assert.equal(d.action, 'context');
  assert.match(d.text, /FIX-1/);
});

test('hook as a process: SessionStart additionalContext JSON with the feature on; silent with it off; never a non-zero exit', () => {
  const root = project([{ key: 'k', state: state('P2 Code', [['FIX-1', 'f', 'PLANNED']]) }]);
  const run = (input) =>
    spawnSync(process.execPath, [join(here, '..', 'hooks', 'claude-code', 'reanchor-after-compact.cjs')], {
      input: JSON.stringify(input),
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    });
  const off = run({ hook_event_name: 'SessionStart', source: 'compact' });
  assert.equal(off.status, 0);
  assert.equal(off.stdout, '');

  writeFileSync(join(root, 'PIPELINE_PROFILE.md'), '```json pipeline-settings\n{ "schema": 2, "features": { "reanchor": { "state": "on" } } }\n```\n');
  const on = run({ hook_event_name: 'SessionStart', source: 'compact' });
  assert.equal(on.status, 0);
  const out = JSON.parse(on.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(out.hookSpecificOutput.additionalContext, /\.pipeline\/k\/state\.md/);

  writeFileSync(join(root, 'PIPELINE_PROFILE.md'), '```json pipeline-settings\n{ not json\n```\n');
  assert.equal(run({ source: 'compact' }).status, 0);
});
