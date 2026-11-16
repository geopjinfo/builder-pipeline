/**
 * The toolkit split (specs/toolkit-standalone.spec.md): one kit tool runs in a project that never adopted the
 * pipeline. Each test names the acceptance criterion it asserts (AC-nnn → REQ-nnn in the spec).
 *
 *   REQ-101…105  settings without a profile: BUILDER_CONFIG / builder.config.json, same validation, profile wins,
 *                `run --config`, `features` names the source
 *   REQ-201…202  check-ledgers --boards / --registry
 *   REQ-301…306  board-import (ralph prd.json, Spec Kit tasks.md): stated kept, inferred marked, unmapped listed,
 *                DONE without a test stays unevidenced, refusals write nothing, the board is a build board
 *   REQ-401…405  spec-check on a .md path and spec-trace-check on named files run with defaults while off
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const PACK = join(here, '..');
const script = (name) => join(PACK, 'scripts', `${name}.mjs`);
const cli = join(PACK, 'cli.js');
const made = [];
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

const project = () => {
  const dir = mkdtempSync(join(tmpdir(), 'builder-toolkit-'));
  made.push(dir);
  spawnSync('git', ['init', '-q'], { cwd: dir });
  return dir;
};
const write = (dir, rel, text) => {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
};
const run = (cwd, file, args = [], env = {}) => spawnSync(process.execPath, [file, ...args], { cwd, encoding: 'utf8', env: { ...process.env, BUILDER_CONFIG: '', ...env } });
const lines = (r) => r.stdout.split(/\r?\n/).filter(Boolean);
const settings = (features) => JSON.stringify({ schema: 2, features }, null, 2);
const profile = (features) => `# PIPELINE_PROFILE — fixture\n\n## 16. Pipeline settings\n\n\`\`\`json pipeline-settings\n${settings(features)}\n\`\`\`\n`;

describe('REQ-101…105 — settings without a profile', () => {
  test('AC-101: BUILDER_CONFIG names the settings file', () => {
    const dir = project();
    write(dir, 'cfg/kit.json', settings({ specTrace: { state: 'on', requirements: ['docs'], tests: ['tests'] } }));
    const r = run(dir, script('features'), [], { BUILDER_CONFIG: 'cfg/kit.json' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^specTrace: on$/m);
  });

  test('AC-102 + AC-108: builder.config.json in the project root is read, and named on the first line', () => {
    const dir = project();
    write(dir, 'builder.config.json', settings({ bashCap: { state: 'on', limitBytes: 2048 } }));
    const r = run(dir, script('features'));
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(lines(r)[0], 'no PIPELINE_PROFILE.md — settings from builder.config.json');
    assert.match(r.stdout, /^bashCap: on$/m);
  });

  test('AC-103: no profile, no config: defaults in use', () => {
    const r = run(project(), script('features'));
    assert.equal(r.status, 0);
    assert.equal(lines(r)[0], 'no PIPELINE_PROFILE.md — defaults in use');
  });

  test('red: AC-104 an unknown feature in the config file is refused with the profile\'s message', () => {
    const dir = project();
    write(dir, 'builder.config.json', settings({ claimz: { state: 'on' } }));
    const r = run(dir, script('features'));
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /features\.claimz: unknown feature/);
    assert.match(r.stdout, /features: INVALID — fix the config file/);
  });

  test('red: AC-105 a config file that is not JSON is refused', () => {
    const dir = project();
    write(dir, 'builder.config.json', '{ nope');
    const r = run(dir, script('features'));
    assert.equal(r.status, 1);
    assert.match(r.stdout, /not valid JSON/);
  });

  test('red: a BUILDER_CONFIG path that does not exist is an error, never a silent default', () => {
    const r = run(project(), script('features'), [], { BUILDER_CONFIG: 'missing.json' });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /BUILDER_CONFIG names .*missing\.json, which does not exist/);
  });

  test('AC-106: the profile wins over a config file beside it, and says so', () => {
    const dir = project();
    write(dir, 'PIPELINE_PROFILE.md', profile({ claims: { state: 'off' } }));
    write(dir, 'builder.config.json', settings({ claims: { state: 'on' } }));
    const r = run(dir, script('features'));
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /^claims: not configured$/m);
    assert.match(r.stdout, /builder\.config\.json is ignored: PIPELINE_PROFILE\.md exists and is the one source of settings/);
  });

  test('AC-107: `run <script> --config <path>` becomes BUILDER_CONFIG and leaves the script\'s arguments', () => {
    const dir = project();
    write(dir, 'cfg.json', settings({ specTrace: { state: 'on', requirements: ['docs'], tests: ['tests'] } }));
    const r = run(dir, cli, ['run', 'features', '--config', 'cfg.json']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^specTrace: on$/m);
    assert.match(r.stdout, /settings from cfg\.json/);
    const bad = run(dir, cli, ['run', 'features', '--config']);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /--config <path> needs the path/);
  });

  test('the library: load() reports its source', () => {
    const lib = createRequire(import.meta.url)(join(PACK, 'scripts', 'lib', 'profile.cjs'));
    const dir = project();
    assert.equal(lib.load(dir).source, 'defaults');
    write(dir, 'builder.config.json', settings({}));
    assert.equal(lib.load(dir).source, 'config');
    write(dir, 'PIPELINE_PROFILE.md', profile({}));
    const loaded = lib.load(dir);
    assert.equal(loaded.source, 'profile');
    assert.equal(loaded.notes.length, 1);
  });
});

const REGISTRY = '# DEFERRED_TASKS\n\n| ID | Task | Status | Blocker |\n|---|---|---|---|\n';
const BOARD = '# x — build board\n\n## P2 — Code\n\n| # | Task | Cites | Status | Test-seed / evidence | Notes |\n|---|---|---|---|---|---|\n| T1 | a | — | DONE | tests/a.test.ts | |\n';

describe('REQ-201…202 — check-ledgers with explicit paths', () => {
  test('AC-201 + AC-202: --boards and --registry replace §16 and the defaults', () => {
    const dir = project();
    write(dir, 'work/REGISTRY.md', REGISTRY);
    write(dir, 'work/boards/x.md', BOARD);
    const r = run(dir, cli, ['check-ledgers', '--boards', 'work/boards', '--registry', 'work/REGISTRY.md']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /check-ledgers: PASS/);
    const bare = run(dir, cli, ['check-ledgers']);
    assert.equal(bare.status, 1);
    assert.match(bare.stdout, /\[LG-0\] DEFERRED_TASKS\.md/);
    assert.match(bare.stdout, /\[LG-0\] tasks ::/);
  });

  test('red: AC-203 a flag without its value is refused', () => {
    const r = run(project(), cli, ['check-ledgers', '--boards']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--boards needs a value/);
    assert.match(r.stderr, /--boards <dir>/);
  });
});

const PRD = JSON.stringify({
  project: 'x',
  branchName: 'ralph/x',
  description: 'd',
  userStories: [
    { id: 'US-001', title: 'Add priority field to database', description: 'As a developer', acceptanceCriteria: ['Add priority column', 'Typecheck passes'], priority: 1, passes: true, notes: '' },
    { id: 'US-002', title: 'Expose priority in API', description: '', acceptanceCriteria: ['Typecheck passes'], priority: 2, passes: true, notes: 'two passes' },
    { id: 'US-003', title: 'Show priority in UI', description: '', acceptanceCriteria: ['Verify in browser'], priority: 3, passes: false, notes: '' },
    { id: 'US-004', title: 'Sort | by priority', description: '', acceptanceCriteria: [], priority: 4, passes: false, notes: '' },
  ],
});
const TASKS = '# Tasks\n\n## Phase 1: Setup\n\n- [x] T001 Create project structure per plan\n- [ ] T012 [P] [US1] Create model in src/models/a.py\nSome prose line here\n- [ ] TXXX Polish\n';

describe('REQ-301…306 — board-import', () => {
  test('AC-301 + AC-302: a ralph prd.json becomes one row per story, stated values kept', () => {
    const dir = project();
    write(dir, 'prd.json', PRD);
    const r = run(dir, script('board-import'), ['--format', 'ralph', 'prd.json', '--out', 'tasks/imported.md']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const board = readFileSync(join(dir, 'tasks', 'imported.md'), 'utf8');
    assert.match(board, /^## P0 — Imported from ralph$/m);
    const rows = board.split('\n').filter((l) => /^\| T\d+ \|/.test(l));
    assert.equal(rows.length, 4);
    assert.match(rows[0], /^\| T1 \| Add priority field to database \| US-001 \| DONE \| — \| Add priority column; Typecheck passes/);
    assert.match(rows[2], /^\| T3 \| Show priority in UI \| US-003 \| PLANNED \|/);
    assert.match(rows[3], /Sort \\\| by priority/, 'a pipe in the source is escaped, not a cell boundary');
    assert.match(r.stdout, /4 row\(s\) · 2 DONE · 2 DONE with no test named/);
  });

  test('AC-303 + AC-304: a Spec Kit tasks.md keeps ids and markers; prose and TXXX are unmapped; inferences are marked', () => {
    const dir = project();
    write(dir, 'tasks.md', TASKS);
    const r = run(dir, script('board-import'), ['--format', 'spec-kit', 'tasks.md', '--out', 'tasks/sk.md']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const board = readFileSync(join(dir, 'tasks', 'sk.md'), 'utf8');
    assert.match(board, /^\| T001 \| Create project structure per plan \| — \| DONE \| — \|/m);
    assert.match(board, /^\| T012 \| Create model in src\/models\/a\.py \| \[P\] \[US1\] \| PLANNED \|/m);
    assert.match(board, /^- line 7: Some prose line here$/m);
    assert.match(board, /^- line 8: - \[ \] TXXX Polish$/m);
    assert.match(board, /^- ⚠ CONFIRM T001: no file path on the line$/m);
    assert.match(board, /_Started: \d{4}-\d{2}-\d{2} ⚠ CONFIRM/);
  });

  test('AC-305: an imported DONE with no test named is reported by check-ledgers under LG-5', () => {
    const dir = project();
    write(dir, 'prd.json', PRD);
    write(dir, 'EMPTY.md', REGISTRY);
    run(dir, script('board-import'), ['--format', 'ralph', 'prd.json', '--out', 'tasks/imported.md']);
    const r = run(dir, cli, ['check-ledgers', '--boards', 'tasks', '--registry', 'EMPTY.md']);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /\[LG-5\] tasks\/imported\.md :: T1 /);
    assert.match(r.stdout, /\[LG-5\] tasks\/imported\.md :: T2 /);
    assert.doesNotMatch(r.stdout, /:: T3 /);
  });

  test('AC-309: the board is a build board board-progress counts', () => {
    const dir = project();
    write(dir, 'prd.json', PRD);
    run(dir, script('board-import'), ['--format', 'ralph', 'prd.json', '--out', 'tasks/imported.md']);
    const r = run(dir, script('board-progress'), ['tasks/imported.md']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const board = readFileSync(join(dir, 'tasks', 'imported.md'), 'utf8');
    assert.match(board, /2\s*\/\s*4|2 of 4|50/, 'the computed block counts two settled rows of four');
  });

  test('red: AC-306 an unknown format is refused and nothing is written', () => {
    const dir = project();
    write(dir, 'x.json', '{}');
    const r = run(dir, script('board-import'), ['--format', 'trello', 'x.json', '--out', 'b.md']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /ralph, spec-kit/);
    assert.ok(!existsSync(join(dir, 'b.md')));
  });

  test('red: AC-307 an existing output is kept unless --force', () => {
    const dir = project();
    write(dir, 'prd.json', PRD);
    write(dir, 'tasks/imported.md', 'mine\n');
    const r = run(dir, script('board-import'), ['--format', 'ralph', 'prd.json', '--out', 'tasks/imported.md']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--force/);
    assert.equal(readFileSync(join(dir, 'tasks', 'imported.md'), 'utf8'), 'mine\n');
    const forced = run(dir, script('board-import'), ['--format', 'ralph', 'prd.json', '--out', 'tasks/imported.md', '--force']);
    assert.equal(forced.status, 0, forced.stderr);
  });

  test('red: AC-308 invalid JSON, a missing source and a flag without a value are refused', () => {
    const dir = project();
    write(dir, 'prd.json', '{ nope');
    const bad = run(dir, script('board-import'), ['--format', 'ralph', 'prd.json', '--out', 'b.md']);
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /not valid JSON/);
    assert.ok(!existsSync(join(dir, 'b.md')));
    const missing = run(dir, script('board-import'), ['--format', 'ralph', 'none.json', '--out', 'b.md']);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /source missing/);
    const flag = run(dir, script('board-import'), ['--format', 'ralph', 'prd.json', '--out']);
    assert.equal(flag.status, 2);
    assert.match(flag.stderr, /--out needs a value/);
    const notRalph = run(dir, script('board-import'), ['--format', 'spec-kit', 'prd.json', '--out', 'b.md']);
    assert.equal(notRalph.status, 2);
    assert.match(notRalph.stderr, /not a Spec Kit tasks\.md/);
  });
});

describe('REQ-401…405 — the spec checkers on named files, feature off', () => {
  const specFixture = join(here, 'fixtures', 'spec', 'project', 'specs', 'stock-levels.spec.md');
  const traceFixture = join(here, 'fixtures', 'spec-trace', 'project');

  test('AC-401 + AC-402: spec-check on a .md path runs with defaults and says so; a broken spec fails', () => {
    const dir = project();
    const spec = readFileSync(specFixture, 'utf8')
      .replace('Status: ratified', 'Status: draft')
      .replace('accepted D-2', 'dropped — not needed here')
      .replace('AC-003 | REQ-003 | by-design', 'AC-003 | REQ-003 | assert')
      .replace('| AC-006 | REQ-006 | gap | a manager of W | they send -1 | recorded: refused today only by the UI (STK-D1 tracks the server check) |', '| AC-006 | REQ-006 | assert | a manager of W | they send -1 | 422 `LEVEL_NEGATIVE` |');
    write(dir, 'specs/a.spec.md', spec);
    const r = run(dir, script('spec-check'), ['specs/a.spec.md']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(lines(r)[0], 'specAuthoring: not configured — checking specs/a.spec.md with defaults');
    assert.match(r.stdout, /spec-check: PASS/);
    write(dir, 'specs/a.spec.md', spec.replace('## Requirements', '## Rows'));
    const red = run(dir, script('spec-check'), ['specs/a.spec.md']);
    assert.equal(red.status, 1);
    assert.match(red.stdout, /spec-check: FAIL/);
  });

  test('AC-403: a module key with the feature off is still "not configured", exit 0', () => {
    const r = run(project(), script('spec-check'), ['stock-levels']);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), 'specAuthoring: not configured');
  });

  test('AC-404: spec-trace-check on named files with --tests runs with defaults', () => {
    const dir = project();
    cpSync(join(traceFixture, 'docs'), join(dir, 'docs'), { recursive: true });
    cpSync(join(traceFixture, 'tests'), join(dir, 'tests'), { recursive: true });
    const r = run(dir, script('spec-trace-check'), ['docs/requirements.md', '--tests', 'tests']);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.equal(lines(r)[0], 'specTrace: not configured — checking docs/requirements.md with defaults');
    assert.match(r.stderr, /UNTRACED REQ-/);
    const green = run(dir, script('spec-trace-check'), ['docs/requirements.md', '--tests', 'tests', '--packs', join(traceFixture, 'packs')]);
    assert.equal(green.status, 0, green.stdout + green.stderr);
    assert.match(green.stdout, /spec-trace-check: PASS/);
  });

  test('AC-405: no named file with the feature off is still "not configured", exit 0', () => {
    const r = run(project(), script('spec-trace-check'));
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), 'specTrace: not configured');
    const named = run(project(), script('spec-trace-check'), ['docs/requirements.md']);
    assert.equal(named.status, 0, 'named files without a trace source cannot run: the line is printed, nothing is read');
    assert.equal(named.stdout.trim(), 'specTrace: not configured');
  });

  test('red: AC-406 + AC-407 a flag without a value, or a missing source, exits 2', () => {
    const dir = project();
    const flag = run(dir, script('spec-trace-check'), ['docs/requirements.md', '--tests']);
    assert.equal(flag.status, 2);
    assert.match(flag.stderr, /--tests needs a value/);
    assert.match(flag.stderr, /--tests <path>/);
    const missing = run(dir, script('spec-trace-check'), ['docs/missing.md', '--tests', 'tests']);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /source missing — docs\/missing\.md/);
  });
});

describe('the kit\'s own spec', () => {
  test('specs/toolkit-standalone.spec.md passes spec-check as a draft, with no profile', () => {
    const r = run(PACK, script('spec-check'), ['specs/toolkit-standalone.spec.md']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /spec-check: PASS/);
  });

  test('every requirement id in the spec is named by a test in this file', () => {
    const spec = readFileSync(join(PACK, 'specs', 'toolkit-standalone.spec.md'), 'utf8');
    const ids = [...new Set([...spec.matchAll(/^\| (REQ-\d+) \|/gm)].map((m) => m[1]))];
    const me = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    const ranges = [...me.matchAll(/REQ-(\d+)…(\d+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
    const covered = (id) => {
      const n = Number(id.slice(4));
      return me.includes(id) || ranges.some(([a, b]) => n >= a && n <= b);
    };
    assert.deepEqual(ids.filter((id) => !covered(id)), []);
  });
});
