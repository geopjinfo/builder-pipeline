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
      for (const hook of ['bash-output-cap.js', 'registry-read-guard.js', 'reviewer-write-guard.js']) assert.ok(existsSync(join(cc, '.claude', 'hooks', hook)), hook);
      assert.ok(!existsSync(join(cc, '.claude', 'settings.json')), 'the installer armed a hook — that is the human\'s act');
      assert.ok(existsSync(join(cc, 'scripts', 'experimental', 'page-shell.mjs')), 'experimental page shell not installed with --experimental');
    } finally {
      rmSync(cc, { recursive: true, force: true });
    }
  });
});
