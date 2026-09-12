/**
 * The adopter path, end to end, on a project that is not TypeScript and has none of the optional features.
 *
 * WHY. Every other test proves a script against its own fixture. None proves that an adopter who unpacks the pack
 * into THEIR repo gets a working pipeline: that the installer copies what the scripts require, that the settings a
 * Python project would write validate, that each absent feature SAYS it is absent instead of crashing or passing,
 * and that the board and the checkers run with no source-project file anywhere on disk. This test unpacks the pack
 * into a throwaway directory holding a small Python service and drives the installed copies — never the pack's own.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const PACK = join(dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLE_PROFILE = join(PACK, 'tests', 'fixtures', 'profile', 'python-service.PIPELINE_PROFILE.md');

/** A copy of the pack as an adopter receives it: everything but its repository metadata. */
function copyPack(into) {
  cpSync(PACK, join(into, 'builder'), { recursive: true, filter: (src) => !/[\\/](?:\.git|node_modules)(?:[\\/]|$)/.test(src) });
}

function run(cwd, args) {
  const r = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', env: { ...process.env, BUILDER_NO_BASH_CAP: '1' } });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function write(root, rel, text) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

const BOARD = `# stock-levels — build board

_Started: 2026-03-02 · Track: FULL · Brief: reorder levels for the stock service_

<!-- progress:auto start -->
<!-- progress:auto end -->

## P2 — Code

| # | Task | Cites | Status | Test-seed / evidence | Notes |
|---|------|-------|--------|----------------------|-------|
| T1 | reorder level per item | D-1 | DONE | \`app/stock.py:1\` · tests/test_stock.py | |
| T2 | reorder endpoint | D-1 | IN-PROGRESS | tests/test_api.py | |

## Todo

- [x] open the run log
- [ ] start the watcher
`;

const PLAN = `# stock-levels — plan

## Track
FULL — a new bounded context.

## Context
Reorder levels for the stock service.

## Schema
One table, \`reorder_level\`.

## Routes

| Method | Path | Handler |
|---|---|---|
| POST | /items/{id}/reorder | app.stock.reorder |

## Tasks

| # | Task | Cites | Test-seed |
|---|------|-------|-----------|
| T1 | reorder level per item | D-1 | tests/test_stock.py::test_reorder_level |

## BLOCKERS
- DECIDED-FROM-DOCS: none
- NEEDS-RULING: none
- BLOCKING: none
`;

describe('adopter dogfood — a Python service with every optional feature off', () => {
  let root;

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'pack-dogfood-'));
    copyPack(root);
    write(root, 'app/stock.py', 'def reorder_level(item):\n    return item.minimum\n');
    write(root, 'tests/test_stock.py', 'def test_reorder_level():\n    assert True\n');
    writeFileSync(join(root, 'PIPELINE_PROFILE.md'), readFileSync(SAMPLE_PROFILE, 'utf8'));
  });

  after(() => rmSync(root, { recursive: true, force: true }));

  test('unpack installs the checkers, the libs they require and the oracle adapters — and no experimental file', () => {
    const r = run(root, ['builder/cli.js', 'unpack', '--tool', 'codex', '--no-extras']);
    assert.equal(r.status, 0, r.out);
    for (const f of ['scripts/features.mjs', 'scripts/claims-check.mjs', 'scripts/output-check.mjs', 'scripts/handoff-pack.mjs', 'scripts/lib/profile.cjs', 'scripts/lib/session-usage.cjs', 'scripts/lib/page-docs.cjs', 'scripts/oracles/openapi3.cjs', '.builder/playbooks/references/review-template.md']) {
      assert.ok(existsSync(join(root, f)), `not installed: ${f}`);
    }
    assert.ok(!existsSync(join(root, 'scripts', 'experimental')), 'experimental files installed without --experimental');
    assert.ok(!existsSync(join(root, '.builder', 'personas', 'experimental')), 'experimental personas installed without --experimental');
  });

  test('verify passes: the install is complete and the Python profile validates', () => {
    const r = run(root, ['builder/cli.js', 'verify']);
    assert.match(r.out, /PASS {2}pipeline settings valid/);
    assert.equal(r.status, 0, r.out);
  });

  test('every absent feature says so', () => {
    const f = run(root, ['scripts/features.mjs']);
    assert.equal(f.status, 0, f.out);
    for (const name of ['graph', 'contractOracle', 'rules', 'mutation']) assert.match(f.out, new RegExp(`${name}: not configured`));

    const oracle = run(root, ['scripts/contract-oracle.mjs']);
    assert.match(oracle.out, /contractOracle: not configured/);
    assert.equal(oracle.status, 0, oracle.out);

    const index = run(root, ['scripts/index-check.mjs']);
    assert.match(index.out, /graph: not configured/);
    assert.equal(index.status, 3, index.out); // 3 = absent → the playbook's "record and proceed" branch

    const mutation = run(root, ['scripts/mutation-step.mjs', 'stock']);
    assert.match(mutation.out, /mutation: not configured/);
    assert.equal(mutation.status, 0, mutation.out);

    const rules = run(root, ['scripts/rules-module.mjs', 'stock']);
    assert.match(rules.out, /rules: not configured/);
    assert.equal(rules.status, 0, rules.out);
  });

  test('a board computes its progress and renders to a page', () => {
    write(root, 'tasks/stock-levels.md', BOARD);
    const progress = run(root, ['scripts/board-progress.mjs', 'tasks/stock-levels.md']);
    assert.equal(progress.status, 0, progress.out);
    assert.equal(run(root, ['scripts/board-progress.mjs', 'tasks/stock-levels.md', '--check']).status, 0);

    const render = run(root, ['scripts/board-render.mjs', 'stock-levels']);
    assert.equal(render.status, 0, render.out);
    const html = readFileSync(join(root, 'tasks', 'stock-levels.html'), 'utf8');
    assert.match(html, /reorder level per item/);
    assert.match(html, /start the watcher/);
  });

  test('the claims check re-runs a count and holds a citation to its file', () => {
    write(root, '.pipeline/stock-levels/claims.jsonl', `${JSON.stringify({ id: 'C1', text: '3 items seeded', command: 'node -e "console.log(\'3 items\')"', expect: '3 items' })}\n`);
    const green = run(root, ['scripts/claims-check.mjs', '--run', 'stock-levels']);
    assert.equal(green.status, 0, green.out);

    write(root, '.pipeline/stock-levels/claims.jsonl', `${JSON.stringify({ id: 'C1', text: '4 items seeded', command: 'node -e "console.log(\'3 items\')"', expect: '4 items' })}\n`);
    const red = run(root, ['scripts/claims-check.mjs', '--run', 'stock-levels']);
    assert.equal(red.status, 1, red.out);
    rmSync(join(root, '.pipeline', 'stock-levels', 'claims.jsonl'));
  });

  test('the plan and findings checks hold their shapes, from the Python profile', () => {
    write(root, '.pipeline/stock-levels/plan.md', PLAN);
    const plan = run(root, ['scripts/output-check.mjs', 'plan', '.pipeline/stock-levels/plan.md']);
    assert.equal(plan.status, 0, plan.out);

    write(root, '.pipeline/stock-levels/plan-broken.md', PLAN.replace(/## BLOCKERS[\s\S]*$/, ''));
    assert.equal(run(root, ['scripts/output-check.mjs', 'plan', '.pipeline/stock-levels/plan-broken.md']).status, 1);

    const finding = { seat: 'security-auditor', verdict: 'PASS', findings: [{ id: 'W-1', severity: 'warning', location: 'app/stock.py:1', cite: 'D-1', claim: 'no input bound', evidence: 'reorder_level reads item.minimum unchecked' }] };
    write(root, '.pipeline/stock-levels/findings-security.json', JSON.stringify(finding));
    const good = run(root, ['scripts/output-check.mjs', 'findings', '.pipeline/stock-levels/findings-security.json']);
    assert.equal(good.status, 0, good.out);

    finding.findings[0].location = 'somewhere in stock';
    write(root, '.pipeline/stock-levels/findings-bad.json', JSON.stringify(finding));
    assert.equal(run(root, ['scripts/output-check.mjs', 'findings', '.pipeline/stock-levels/findings-bad.json']).status, 1);
  });

  test('check-ledgers passes on the board and the installed registry', () => {
    const r = run(root, ['builder/cli.js', 'check-ledgers']);
    assert.equal(r.status, 0, r.out);
  });

  test('the Claude Code install maps neutral frontmatter, copies hooks unarmed, and adds experimental files only on request', () => {
    const cc = mkdtempSync(join(tmpdir(), 'pack-dogfood-cc-'));
    try {
      copyPack(cc);
      writeFileSync(join(cc, 'PIPELINE_PROFILE.md'), readFileSync(SAMPLE_PROFILE, 'utf8'));
      const r = run(cc, ['builder/cli.js', 'unpack', '--tool', 'claude-code', '--no-extras', '--experimental']);
      assert.equal(r.status, 0, r.out);
      const agent = (name) => readFileSync(join(cc, '.claude', 'agents', `${name}.md`), 'utf8');
      assert.match(agent('module-reviewer'), /^tools: Read, Grep, Glob, Bash, Write$/m);
      assert.match(agent('security-auditor'), /^tools: Read, Grep, Glob, Bash$/m);
      assert.match(agent('page-keeper'), /^tools: Bash, Read, Artifact$/m);
      assert.match(agent('docs-maintainer'), /^effort: low$/m);
      for (const hook of ['bash-output-cap.cjs', 'registry-read-guard.cjs', 'reviewer-write-guard.cjs']) assert.ok(existsSync(join(cc, '.claude', 'hooks', hook)), hook);
      assert.ok(!existsSync(join(cc, '.claude', 'settings.json')), 'the installer armed a hook — that is the human\'s act');
      assert.ok(existsSync(join(cc, 'scripts', 'experimental', 'page-shell.mjs')), 'experimental page shell not installed with --experimental');
    } finally {
      rmSync(cc, { recursive: true, force: true });
    }
  });
});

/**
 * A host whose package.json says "type": "module".
 *
 * WHY. Node decides how to load a .js file from the NEAREST package.json. The pack's own suite ran under a CommonJS
 * host, so nothing ever proved that cli.js and the hooks survive an ESM host — and they did not: require() threw
 * at the first line, which for a PreToolUse guard means the guard crashes and the tool call proceeds. A guard that
 * fails open is the defect this kit exists to prevent. builder/package.json pins the kit to CommonJS, and the hooks
 * ship as .cjs so the copies installed into the host stay CommonJS wherever they land.
 */
describe('adopter dogfood — a host that declares "type": "module"', () => {
  const HOOKS = ['bash-output-cap.cjs', 'registry-read-guard.cjs', 'reviewer-write-guard.cjs', 'protected-paths.cjs', 'board-render.cjs'];
  let esm;
  before(() => {
    esm = mkdtempSync(join(tmpdir(), 'builder-esm-host-'));
    write(esm, 'package.json', '{ "name": "esm-host", "type": "module" }\n');
    copyPack(esm);
    writeFileSync(join(esm, 'PIPELINE_PROFILE.md'), readFileSync(SAMPLE_PROFILE, 'utf8'));
  });
  after(() => rmSync(esm, { recursive: true, force: true }));

  test('the CLI runs and installs the hooks as .cjs', () => {
    const r = run(esm, ['builder/cli.js', 'unpack', '--tool', 'claude-code', '--no-extras']);
    assert.equal(r.status, 0, r.out);
    assert.doesNotMatch(r.out, /require is not defined/);
    for (const hook of HOOKS) assert.ok(existsSync(join(esm, '.claude', 'hooks', hook)), hook);
  });

  test('every installed hook runs under the ESM host without throwing', () => {
    for (const hook of HOOKS) {
      const r = spawnSync(process.execPath, [join(esm, '.claude', 'hooks', hook)], {
        cwd: esm, input: '{}', encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: esm },
      });
      assert.doesNotMatch(`${r.stderr}`, /ReferenceError|ERR_REQUIRE_ESM|Cannot use import/, `${hook}: ${r.stderr}`);
      assert.equal(r.status, 0, `${hook} exited ${r.status}: ${r.stderr}`);
    }
  });

  test('red: without builder/package.json the same host loads cli.js as an ES module and it fails on require()', () => {
    const red = mkdtempSync(join(tmpdir(), 'builder-esm-red-'));
    try {
      write(red, 'package.json', '{ "name": "esm-host", "type": "module" }\n');
      copyPack(red);
      rmSync(join(red, 'builder', 'package.json'));
      const r = run(red, ['builder/cli.js', 'targets']);
      assert.notEqual(r.status, 0);
      assert.match(r.out, /require is not defined/);
    } finally {
      rmSync(red, { recursive: true, force: true });
    }
  });
});

/**
 * The ledgers live where §16 says.
 *
 * WHY. The installer places the boards and the registry at its defaults because no profile exists yet. An adopter
 * whose conventions keep project history under a documentation tree then moves them and records the move in §16 —
 * and every script honours that, except that `verify` and `check-ledgers` used to look at the defaults. `verify`
 * failed the one install that followed the profile; `check-ledgers` looped over a directory that was no longer
 * there and printed PASS over nothing. A gate that finds no input must fail, and say where it looked.
 */
describe('ledgers follow §16 paths, and an empty board set is not a pass', () => {
  const BOARDS = 'docs/history/tasks';
  const REGISTRY = 'docs/history/DEFERRED_TASKS.md';
  let root;
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'builder-ledger-paths-'));
    copyPack(root);
    const profile = readFileSync(SAMPLE_PROFILE, 'utf8')
      .replace('"boards": "tasks"', `"boards": "${BOARDS}"`)
      .replace('"registry": "DEFERRED_TASKS.md"', `"registry": "${REGISTRY}"`);
    assert.notEqual(profile, readFileSync(SAMPLE_PROFILE, 'utf8'), 'the sample profile no longer carries the default paths this test rewrites');
    writeFileSync(join(root, 'PIPELINE_PROFILE.md'), profile);
    const r = run(root, ['builder/cli.js', 'unpack', '--tool', 'codex', '--no-extras']);
    assert.equal(r.status, 0, r.out);
    // The adopter's move: the board rules and the registry go to the §16 paths, the defaults are gone.
    mkdirSync(join(root, BOARDS), { recursive: true });
    cpSync(join(root, 'tasks', 'README.md'), join(root, BOARDS, 'README.md'));
    cpSync(join(root, 'DEFERRED_TASKS.md'), join(root, REGISTRY));
    rmSync(join(root, 'tasks'), { recursive: true, force: true });
    rmSync(join(root, 'DEFERRED_TASKS.md'));
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  test('verify finds the board rules and the registry at the §16 paths', () => {
    const r = run(root, ['builder/cli.js', 'verify']);
    assert.match(r.out, new RegExp(`PASS {2}${BOARDS}/README\\.md \\(board rules\\) exists`));
    assert.match(r.out, new RegExp(`PASS {2}${REGISTRY.replace('.', '\\.')} exists`));
    assert.equal(r.status, 0, r.out);
  });

  test('red: check-ledgers with zero boards fails with LG-0 and names the directory it looked in', () => {
    const r = run(root, ['builder/cli.js', 'check-ledgers']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, new RegExp(`\\[LG-0\\] ${BOARDS} :: - — no boards found under ${BOARDS}/`));
  });

  test('green: a board at the §16 path is read, and its DEFERRED→id resolves against the §16 registry', () => {
    write(root, `${BOARDS}/stock-levels.md`, BOARD);
    const r = run(root, ['builder/cli.js', 'check-ledgers']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /PASS — 1 board\(s\)/);
    // And an unevidenced DONE at that path is still caught — the rules did not move with the paths.
    write(root, `${BOARDS}/restock.md`, BOARD.replace('| T1 | reorder level per item | D-1 | DONE | `app/stock.py:1` · tests/test_stock.py | |', '| T1 | reorder level per item | D-1 | DONE | — | |'));
    const red = run(root, ['builder/cli.js', 'check-ledgers']);
    assert.equal(red.status, 1, red.out);
    assert.match(red.out, new RegExp(`\\[LG-5\\] ${BOARDS}/restock\\.md :: T1`));
  });

  test('red: a missing boards directory is LG-0, not a pass over nothing', () => {
    const bare = mkdtempSync(join(tmpdir(), 'builder-ledger-bare-'));
    try {
      copyPack(bare);
      const r = run(bare, ['builder/cli.js', 'check-ledgers']);
      assert.equal(r.status, 1, r.out);
      assert.match(r.out, /\[LG-0\] tasks :: - — boards directory missing — paths\.boards says "tasks"/);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

/**
 * The board tooling follows §16 paths too — and a nested boards directory keeps its root.
 *
 * WHY. `check-ledgers` was not the only reader of the installer's default: `board-check-all` walked
 * `tasks/` and crashed on ENOENT when the boards had moved; `board-render <key>` resolved a bare key
 * against `tasks/` and took a board's GRANDPARENT as the repo root, which two levels down is the
 * wrong `.pipeline` and the wrong profile; `board-watch` and the hook walked `tasks/`.
 */
describe('board tooling follows §16 paths', () => {
  const BOARDS = 'docs/history/tasks';
  let root;
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'builder-board-paths-'));
    copyPack(root);
    writeFileSync(join(root, 'PIPELINE_PROFILE.md'), readFileSync(SAMPLE_PROFILE, 'utf8')
      .replace('"boards": "tasks"', `"boards": "${BOARDS}"`)
      .replace('"registry": "DEFERRED_TASKS.md"', '"registry": "docs/history/DEFERRED_TASKS.md"'));
    const r = run(root, ['builder/cli.js', 'unpack', '--tool', 'codex', '--no-extras']);
    assert.equal(r.status, 0, r.out);
    mkdirSync(join(root, BOARDS), { recursive: true });
    rmSync(join(root, 'tasks'), { recursive: true, force: true });
    write(root, `${BOARDS}/stock-levels.md`, BOARD);
    write(root, '.pipeline/stock-levels/run.jsonl', '{"t":"2026-03-02T10:00:00Z","type":"run.start","module":"stock-levels","track":"FULL"}\n');
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  test('board-check-all reads the §16 directory, and names it when it is missing', () => {
    const fixed = run(root, ['scripts/board-check-all.mjs', '--fix']);
    assert.equal(fixed.status, 0, fixed.out);
    assert.match(fixed.out, new RegExp(`${BOARDS}/stock-levels\\.md`));
    const bare = mkdtempSync(join(tmpdir(), 'builder-board-bare-'));
    try {
      copyPack(bare);
      const r = run(bare, ['builder/scripts/board-check-all.mjs']);
      assert.equal(r.status, 1, r.out);
      assert.match(r.out, /boards directory missing — paths\.boards says "tasks"/);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  test('board-render resolves a bare key against §16 and keeps the repo root for a nested board', () => {
    const r = run(root, ['scripts/board-render.mjs', 'stock-levels']);
    assert.equal(r.status, 0, r.out);
    const html = readFileSync(join(root, BOARDS, 'stock-levels.html'), 'utf8');
    assert.match(html, /reorder level per item/);
    // The run log under the REPO root's .pipeline was found — the grandparent has none.
    assert.match(html, /run\.start|FULL/);
  });

  test('board-watch --once sweeps the §16 directory and re-renders a board its run log has outrun', () => {
    // A new event after the last render makes the page stale; the watcher must find the board where §16 says.
    const event = { t: '2026-03-02T11:00:00Z', type: 'step', id: 'S1', seat: 'module-builder', title: 'seed', status: 'DONE' };
    writeFileSync(join(root, '.pipeline', 'stock-levels', 'run.jsonl'), `${JSON.stringify(event)}\n`, { flag: 'a' });
    const r = run(root, ['scripts/board-watch.mjs', '--once']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /rendered 1 — .*stock-levels/);
  });
});

/**
 * Ledger columns are resolved by header name, and a row that does not match its header is refused.
 *
 * WHY. Every rule used to read a FIXED POSITION — status at index 3, evidence at index 4. A board whose rows
 * carry one column fewer than their header does not fail that read; it passes it, against the wrong cell. On a
 * real board whose FIX-* rows omitted the `Cites` cell the gate reported hundreds of "status not in vocabulary"
 * violations quoting the evidence prose, while the actual statuses were never examined at all. The noise reads
 * as the finding, and the check the gate exists to perform silently did not happen.
 */
describe('check-ledgers resolves columns by header, not by position', () => {
  let root;
  const board = (rows) => `# stock-levels — build board

_Started: 2026-03-02 · Track: FULL · Brief: reorder levels_

## Phases

| Phase | Seat | Status | Artifact | Verdict |
|---|---|---|---|---|
| P2 Code | module-builder | IN-PROGRESS | — | — |

## P2 — Code

| # | Task | Cites | Status | Test-seed / evidence | Notes |
|---|------|-------|--------|----------------------|-------|
${rows}
`;

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'builder-ledger-cols-'));
    copyPack(root);
    const r = run(root, ['builder/cli.js', 'unpack', '--tool', 'codex', '--no-extras']);
    assert.equal(r.status, 0, r.out);
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  const check = (rows) => {
    write(root, 'tasks/stock-levels.md', board(rows));
    return run(root, ['builder/cli.js', 'check-ledgers']);
  };

  test('green: a well-formed board passes, and the phase table is not mistaken for a ledger table', () => {
    const r = check('| T1 | reorder level per item | D-1 | DONE | tests/test_stock.py | |');
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /PASS — 1 board\(s\)/);
  });

  test('red: a row missing one cell is LG-6 — refused, not read against the wrong column', () => {
    // The `Cites` cell is gone, so index 3 is the EVIDENCE cell. The old positional read called that
    // evidence an out-of-vocabulary status and never looked at DONE at all.
    const r = check('| FIX-1 | fail-closed was one-directional | DONE | tests/test_grid.py | |');
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /\[LG-6\] tasks\/stock-levels\.md :: FIX-1 — row has 5 cell\(s\), its header has 6/);
    // And it is reported ONCE, as a shape defect — not as a status violation quoting the evidence.
    assert.doesNotMatch(r.out, /\[LG-2\]/); // the legend names every rule; only a FINDING line counts
  });

  test('red: an unescaped pipe in prose makes the row too long, and is caught the same way', () => {
    const r = check('| T1 | the guard reads a | b as two cells | D-1 | DONE | tests/test_stock.py | |');
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /\[LG-6\] .*:: T1 — row has 7 cell\(s\), its header has 6/);
  });

  test('a column inserted before Status moves nothing — the rules follow the header', () => {
    const shifted = `# stock-levels — build board

## P2 — Code

| # | Task | Owner | Cites | Status | Test-seed / evidence |
|---|------|-------|-------|--------|----------------------|
| T1 | reorder level per item | ana | D-1 | DONE | tests/test_stock.py |
| T2 | reorder endpoint | bo | D-1 | DONE | — |
`;
    write(root, 'tasks/stock-levels.md', shifted);
    const r = run(root, ['builder/cli.js', 'check-ledgers']);
    // T1 is read as DONE with evidence (no LG-2 about "ana" or "D-1"), and T2's missing evidence is the
    // ONLY finding — proof both columns were located by name at their new positions.
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /\[LG-5\] tasks\/stock-levels\.md :: T2/);
    assert.doesNotMatch(r.out, /\[LG-2\]|\[LG-6\]/);
  });

  test('a registry whose rows are ragged is refused too, and its ids are not invented from shifted cells', () => {
    write(root, 'tasks/stock-levels.md', board('| T1 | reorder level per item | D-1 | DONE | tests/test_stock.py | |'));
    write(root, 'DEFERRED_TASKS.md', `# Deferred

| Id | Raised by | Task | Status | Dependency | Why blocked | How to resume |
|----|-----------|------|--------|------------|-------------|---------------|
| D-1 | stock | wait for the queue | DEFERRED | queue | one line | steps |
| D-2 | stock | ragged row | DEFERRED | queue | one line |
`);
    const r = run(root, ['builder/cli.js', 'check-ledgers']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /\[LG-6\] DEFERRED_TASKS\.md :: D-2 — row has 6 cell\(s\), its header has 7/);
  });
});

/**
 * A status cell is read for the term it CLAIMS, not for its typography.
 *
 * WHY. People write ledgers in markdown, for people: `**DONE**`, `DONE 2026-09-03`, `**DONE (2026-08-26)**
 * — CP3 B4`. All three claim DONE, and an exact-match gate failed all three. On one repo's ledgers that was
 * 146 findings of which 127 were emphasis and annotation — and a gate that fails on bold teaches its readers
 * to skip it, so the nineteen that were REAL (`OPEN`, `BUILT`, `CLOSED — by observation`, `needs-ruling`)
 * went unread with the rest. Being liberal here is what makes the remaining findings worth reading; the
 * limit is that the cell must still BEGIN with a vocabulary term.
 */
describe('check-ledgers reads the status a cell claims, not its markup', () => {
  let root;
  const board = (status, evidence = 'tests/test_stock.py') => `# stock-levels — build board

## P2 — Code

| # | Task | Cites | Status | Test-seed / evidence | Notes |
|---|------|-------|--------|----------------------|-------|
| T1 | reorder level per item | D-1 | ${status} | ${evidence} | |
`;

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'builder-status-'));
    copyPack(root);
    assert.equal(run(root, ['builder/cli.js', 'unpack', '--tool', 'codex', '--no-extras']).status, 0);
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  const check = (status, evidence) => {
    write(root, 'tasks/stock-levels.md', board(status, evidence));
    return run(root, ['builder/cli.js', 'check-ledgers']);
  };

  for (const status of [
    'DONE',
    '**DONE**',
    'DONE 2026-09-03',
    '**DONE 2026-09-03**',
    '**DONE (2026-08-26)** — CP3 B4, ADR-105',
    '**DONE (2026-08-20, v0.73.1)**',
    'IN-PROGRESS',
    '**IN-PROGRESS** — three of five routes',
  ]) {
    test(`accepted: ${status}`, () => {
      const r = check(status);
      assert.equal(r.status, 0, r.out);
    });
  }

  for (const [status, why] of [
    ['OPEN', 'not a vocabulary term at all'],
    ['**CLOSED — by observation**', 'CLOSED is not DONE, and the annotation does not make it one'],
    ['**BUILT (2026-07-23)**', 'a term the board vocabulary does not have'],
    ['**needs-ruling** — DEFERRED→`X-D1`', 'a deferral hidden behind a word that is not DEFERRED'],
    ['DONEISH', 'a term must end at a separator, not merely start the cell'],
  ]) {
    test(`still refused: ${status} — ${why}`, () => {
      const r = check(status);
      assert.equal(r.status, 1, r.out);
      assert.match(r.out, /\[LG-2\] tasks\/stock-levels\.md :: T1/);
    });
  }

  test('the evidence rule follows the claim: an annotated DONE with no evidence is still LG-5', () => {
    // This is the half that BITES. Before, such a row failed LG-2 on its markup and its evidence was
    // never examined; now the claim resolves to DONE and the missing evidence is the finding.
    const r = check('**DONE (2026-08-26)** — CP3 B4', '—');
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /\[LG-5\] tasks\/stock-levels\.md :: T1/);
    assert.doesNotMatch(r.out, /\[LG-2\]/);
  });

  test('a deferral is read through its emphasis and its backticks', () => {
    write(root, 'DEFERRED_TASKS.md', `# Deferred

| Id | Raised by | Task | Status | Dependency | Why blocked | How to resume |
|----|-----------|------|--------|------------|-------------|---------------|
| D-7 | stock | wait for the queue | **DEFERRED** | queue | one line | steps |
`);
    const ok = check('**DEFERRED→`D-7`**', '—');
    assert.equal(ok.status, 0, ok.out);
    const missing = check('DEFERRED→D-99', '—');
    assert.equal(missing.status, 1, missing.out);
    assert.match(missing.out, /\[LG-3\] .*DEFERRED→D-99 has no matching row/);
  });
});
