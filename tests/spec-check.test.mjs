/**
 * The spec authoring stage's checker — scripts/spec-check.mjs over scripts/lib/spec-check.cjs.
 *
 * A spec turns an intent into requirement rows, acceptance criteria and an API contract before Phase 1. These tests
 * hold the shape (sections, verbatim headers, id shapes), the traceability both ways (every requirement has a
 * criterion; every operation names requirements; every non-constraint requirement is reached by an operation), the
 * ratification bar (no placeholder, no pending amendment, no unanswered question, a named ratifier) and the three
 * outputs the stage feeds forward: the requirement-pack skeleton, the tracker rows and the contract file.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const PACK = join(here, '..');
const lib = require('../scripts/lib/spec-check.cjs');
const handoff = require('../scripts/lib/handoff-check.cjs');

const fixture = join(here, 'fixtures', 'spec', 'project');
const read = (...p) => readFileSync(join(fixture, ...p), 'utf8').replace(/\r\n/g, '\n');
const spec = read('specs', 'stock-levels.spec.md');
const ctx = (over = {}) => ({
  idPattern: 'REQ-\\d+',
  decisionIds: handoff.idsIn(read('DECISIONS.md'), handoff.DEFAULT_DECISION_ID),
  registryIds: handoff.registryRowIds(read('DEFERRED_TASKS.md')),
  ...over,
});
const check = (text, over) => lib.checkSpec(text, ctx(over));
const has = (list, re) => list.some((e) => re.test(e));
const swap = (from, to) => {
  assert.ok(spec.includes(from), `fixture lost: ${from}`);
  return spec.replace(from, to);
};

describe('spec checker — the shape', () => {
  test('the ratified fixture passes with nothing left before ratification', () => {
    const r = check(spec);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.pending, []);
    assert.equal(r.status, 'ratified');
    assert.equal(r.module, 'stock-levels');
  });

  for (const name of lib.SECTIONS) {
    test(`red: missing section ## ${name}`, () => {
      const cut = spec.replace(new RegExp(`\\n## ${name}\\n[\\s\\S]*?(?=\\n## |$)`), '\n');
      assert.ok(check(cut).errors.includes(`missing section: ## ${name}`), check(cut).errors.join('\n'));
    });
  }

  test('red: sections out of order', () => {
    const scope = spec.match(/\n## Scope\n[\s\S]*?(?=\n## )/)[0];
    const moved = spec.replace(scope, '').replace('\n## Open questions', `${scope}\n## Open questions`);
    assert.ok(has(check(moved).errors, /section out of order: ## /), check(moved).errors.join('\n'));
  });

  test('red: no Module line, or an unknown Status', () => {
    assert.ok(check(swap('Module: stock-levels\n', '')).errors.includes('missing line: Module: <module key>'));
    assert.ok(has(check(swap('Status: ratified', 'Status: approved')).errors, /Status: draft or ratified/));
  });

  test('red: a requirements table whose header was paraphrased', () => {
    const r = check(swap('| Id | Requirement | Actor | Kind | Source |', '| Id | Rule | Actor | Kind | Source |'));
    assert.ok(has(r.errors, /## Requirements: header must be/), r.errors.join('\n'));
  });
});

describe('spec checker — requirement rows', () => {
  test('red: an id outside the configured pattern', () => {
    assert.ok(has(check(swap('| REQ-006 |', '| R6 |')).errors, /R6: id does not match REQ-\\d\+/));
  });

  test('red: a duplicate id', () => {
    assert.ok(check(swap('| REQ-006 |', '| REQ-005 |')).errors.includes('REQ-005: duplicate requirement id'));
  });

  test('red: an unknown kind, and an empty source', () => {
    assert.ok(has(check(swap('| warehouse manager | constraint | intent |', '| warehouse manager | nice-to-have | intent |')).errors, /REQ-006: Kind must be one of behaviour \| refusal \| effect \| constraint/));
    assert.ok(check(swap('| warehouse manager | constraint | intent |', '| warehouse manager | constraint |  |')).errors.includes('REQ-006: Source is empty — name the intent, a decision or a question'));
  });

  test('red: a spec with no refusal — it would only prove routing', () => {
    const none = spec.replace(/\| refusal \|/g, '| behaviour |');
    assert.ok(check(none).errors.includes('no refusal requirement — a spec that only says what succeeds proves routing, not a rule'));
  });

  test('red: a requirement with no acceptance criterion', () => {
    const r = check(spec.replace(/^\| AC-005 .*\n/m, ''));
    assert.ok(r.errors.includes('REQ-005: no acceptance criterion'), r.errors.join('\n'));
  });
});

describe('spec checker — acceptance criteria', () => {
  test('red: a criterion for a requirement that does not exist', () => {
    assert.ok(check(swap('| AC-005 | REQ-005 |', '| AC-005 | REQ-099 |')).errors.includes('AC-005: REQ-099 is not a requirement row'));
  });

  test('red: an unknown verb (skipped is a run outcome, not a spec verb)', () => {
    assert.ok(has(check(swap('| AC-005 | REQ-005 | assert |', '| AC-005 | REQ-005 | skipped |')).errors, /AC-005: Verb must be one of assert \| by-design \| gap/));
  });

  test('red: an empty Then', () => {
    assert.ok(check(swap('| 200 with the level |', '|  |')).errors.includes('AC-005: Given, When and Then are all required'));
  });

  test('red: by-design without a decision, or citing one the workspace never recorded', () => {
    assert.ok(check(swap('whole units per D-1', 'whole units')).errors.includes('AC-003: by-design must cite the decision it follows'));
    assert.ok(check(swap('whole units per D-1', 'whole units per D-9')).errors.includes('AC-003: D-9 is not in the decision workspace'));
  });

  test('red: gap without a registry row, or citing one the registry does not hold', () => {
    assert.ok(check(swap('(STK-D1 tracks the server check)', '(nobody tracks it)')).errors.includes('AC-006: gap must cite the deferred-registry row that knows it'));
    assert.ok(check(swap('(STK-D1 tracks the server check)', '(STK-D7 tracks it)')).errors.includes('AC-006: STK-D7 is not a deferred-registry row'));
  });

  test('red: a duplicate criterion id', () => {
    assert.ok(check(swap('| AC-006 |', '| AC-005 |')).errors.includes('AC-005: duplicate criterion id'));
  });
});

describe('spec checker — the API contract', () => {
  const contract = () => JSON.parse(spec.match(/```json api-contract\n([\s\S]*?)\n```/)[1]);
  const withContract = (doc) => spec.replace(/```json api-contract\n[\s\S]*?\n```/, `\`\`\`json api-contract\n${JSON.stringify(doc, null, 2)}\n\`\`\``);

  test('red: no contract block and no stated reason', () => {
    const r = check(spec.replace(/```json api-contract\n[\s\S]*?\n```/, ''));
    assert.ok(r.errors.includes('## API contract: one ```json api-contract block, or the line "No API contract — <reason>"'), r.errors.join('\n'));
  });

  test('"No API contract — <reason>" stands in for the block; then nothing needs an operation', () => {
    const r = check(spec.replace(/```json api-contract\n[\s\S]*?\n```/, 'No API contract — the module is a batch job with no served interface.'));
    assert.deepEqual(r.errors, []);
  });

  test('red: the block is not JSON', () => {
    const r = check(spec.replace('"openapi": "3.0.3",', '"openapi": "3.0.3"'));
    assert.ok(has(r.errors, /## API contract: not JSON/), r.errors.join('\n'));
  });

  test('red: not an OpenAPI 3 document', () => {
    const doc = contract();
    doc.openapi = '2.0';
    assert.ok(check(withContract(doc)).errors.includes('## API contract: "openapi" must be 3.x (the contract oracle reads OpenAPI 3)'));
  });

  test('red: an operation that names no requirement', () => {
    const doc = contract();
    delete doc.paths['/warehouses/{warehouseId}/items/{itemId}/reorder-level'].get['x-req'];
    assert.ok(check(withContract(doc)).errors.includes('GET /warehouses/{warehouseId}/items/{itemId}/reorder-level: x-req must list the requirement ids it serves'));
  });

  test('red: an operation that names a requirement that does not exist', () => {
    const doc = contract();
    doc.paths['/warehouses/{warehouseId}/items/{itemId}/reorder-level'].get['x-req'] = ['REQ-042'];
    assert.ok(check(withContract(doc)).errors.includes('GET /warehouses/{warehouseId}/items/{itemId}/reorder-level: x-req names REQ-042, which is not a requirement row'));
  });

  test('red: an operation with no refusal response', () => {
    const doc = contract();
    delete doc.paths['/warehouses/{warehouseId}/items/{itemId}/reorder-level'].get.responses['403'];
    assert.ok(check(withContract(doc)).errors.includes('GET /warehouses/{warehouseId}/items/{itemId}/reorder-level: declares no 4xx response — every operation can be refused'));
  });

  test('red: a behaviour no operation reaches (constraints are exempt)', () => {
    const doc = contract();
    doc.paths['/warehouses/{warehouseId}/items/{itemId}/reorder-level'].get['x-req'] = ['REQ-001'];
    const r = check(withContract(doc));
    assert.ok(r.errors.includes('REQ-005: no operation in the contract lists it in x-req (only a constraint may stand outside the contract)'), r.errors.join('\n'));
    assert.ok(!has(r.errors, /REQ-006/), 'REQ-006 is a constraint');
  });

  test('the contract is the document the contract oracle compiles', () => {
    const ops = lib.contractOf(spec).operations;
    assert.deepEqual(ops.map((o) => `${o.method} ${o.template}`).sort(), [
      'GET /warehouses/{warehouseId}/items/{itemId}/reorder-level',
      'PUT /warehouses/{warehouseId}/items/{itemId}/reorder-level',
    ]);
  });
});

describe('spec checker — ratification', () => {
  const draft = spec.replace('Status: ratified', 'Status: draft');

  test('a draft with open items is well-formed; the open items are listed, not errors', () => {
    const text = draft
      .replace('| accepted D-2 |', '| pending |')
      .replace('| read and set — the inventory lead, 2026-02-02 |', '|  |')
      .replace('Ratified-by: the inventory lead, 2026-02-02', 'Ratified-by: —')
      .replace('reorder levels per warehouse', '<title>');
    const r = check(text);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.pending.sort(), [
      'Q-1: unanswered',
      'Ratified-by: name the person who ratified it',
      '`stock.level.write`: amendment still pending',
      'placeholder left: <title>',
    ].sort());
  });

  test('red: a ratified spec with any open item fails on it', () => {
    const r = check(spec.replace('| accepted D-2 |', '| pending |'));
    assert.ok(r.errors.includes('`stock.level.write`: amendment still pending'), r.errors.join('\n'));
  });

  test('red: an amendment decision outside the three forms, or citing an unknown decision', () => {
    assert.ok(has(check(swap('| accepted D-2 |', '| yes |')).errors, /`stock.level.write`: Decision must be pending, accepted <decision id> or dropped — <reason>/));
    assert.ok(check(swap('| accepted D-2 |', '| accepted D-8 |')).errors.includes('`stock.level.write`: D-8 is not in the decision workspace'));
  });

  test('--ratified refuses a draft: only a person ratifies', () => {
    const r = lib.checkSpec(draft, ctx({ requireRatified: true }));
    assert.ok(r.errors.includes('Status is draft — a person ratifies the spec before Phase 1'));
  });

  test('placeholders inside the contract block are not prose placeholders', () => {
    const r = check(spec.replace('"description": "the level"', '"description": "<the level>"'));
    assert.deepEqual(r.pending, []);
  });

  test('the shipped template is a well-formed draft whose blanks are all listed', () => {
    const tpl = readFileSync(join(PACK, 'templates', 'spec.md'), 'utf8');
    const r = lib.checkSpec(tpl, ctx({ decisionIds: new Set(), registryIds: new Set(), lenient: true }));
    assert.deepEqual(r.errors, []);
    assert.equal(r.status, 'draft');
    assert.ok(r.pending.length > 5, r.pending.join('\n'));
  });
});

describe('spec checker — what the stage feeds forward', () => {
  test('the requirement-pack skeleton: happy path, refusals, effects, with the template step names', () => {
    const out = lib.packSkeleton(spec);
    const lines = out.split('\n');
    assert.equal(lines[0], 'pack stock-levels:');
    assert.equal(lines[1], '  journey "reorder levels per warehouse":');
    const at = (re) => lines.findIndex((l) => re.test(l));
    assert.ok(at(/happy path/) < at(/REQ-001: 200, and a read returns 12/));
    assert.ok(at(/refusals/) < at(/REQ-002: 403/));
    assert.ok(at(/REQ-002: 403/) < at(/effects/) && at(/effects/) < at(/REQ-004:/));
    assert.match(out, /by-design\s+REQ-003 \[by-design D-1\]: 422/);
    assert.match(out, /gap\s+REQ-006 \[known-gap STK-D1\]: recorded/);
    assert.match(out, /AC-001 · given a manager of warehouse W and an item in W · when they set its reorder level to 12/);
  });

  test('the tracker rows: one CSV line per requirement, citing the spec', () => {
    const csv = lib.rowsCsv(spec, 'specs/stock-levels.spec.md').trim().split('\n');
    assert.equal(csv[0], 'id,requirement,actor,kind,source,criteria,operations,spec');
    assert.equal(csv.length, 7);
    assert.equal(csv[1], 'REQ-001,A warehouse manager can set the reorder level of an item in their own warehouse,warehouse manager,behaviour,intent,AC-001,PUT /warehouses/{warehouseId}/items/{itemId}/reorder-level,specs/stock-levels.spec.md');
  });
});

describe('spec-check CLI', () => {
  const made = [];
  after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
  const project = () => {
    const dir = mkdtempSync(join(tmpdir(), 'kit-spec-'));
    made.push(dir);
    cpSync(fixture, dir, { recursive: true });
    return dir;
  };
  const run = (cwd, args) => spawnSync(process.execPath, [join(PACK, 'scripts', 'spec-check.mjs'), ...args], { cwd, encoding: 'utf8' });

  test('a module key resolves to <dir>/<key>.spec.md and passes', () => {
    const r = run(project(), ['stock-levels', '--ratified']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /spec-check: PASS — specs\/stock-levels\.spec\.md \(ratified\)/);
  });

  test('red: a failing spec exits 1 and names each problem', () => {
    const dir = project();
    const f = join(dir, 'specs', 'stock-levels.spec.md');
    writeFileSync(f, readFileSync(f, 'utf8').replace(/^\| AC-005 .*\n/m, ''));
    const r = run(dir, ['stock-levels']);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /REQ-005: no acceptance criterion/);
    assert.match(r.stdout, /spec-check: FAIL — 1 problem\(s\)/);
  });

  test('a draft passes plain, fails --ratified, and lists what is left', () => {
    const dir = project();
    const f = join(dir, 'specs', 'stock-levels.spec.md');
    writeFileSync(f, readFileSync(f, 'utf8').replace('Status: ratified', 'Status: draft').replace('| accepted D-2 |', '| pending |'));
    const plain = run(dir, ['stock-levels']);
    assert.equal(plain.status, 0, plain.stdout);
    assert.match(plain.stdout, /before ratification \(1\):\n {2}`stock\.level\.write`: amendment still pending/);
    assert.match(plain.stdout, /spec-check: PASS — specs\/stock-levels\.spec\.md \(draft\)/);
    const strict = run(dir, ['stock-levels', '--ratified']);
    assert.equal(strict.status, 1, strict.stdout);
  });

  test('--pack, --rows and --contract write the three outputs', () => {
    const dir = project();
    assert.match(run(dir, ['stock-levels', '--pack']).stdout, /^pack stock-levels:/m);
    assert.match(run(dir, ['stock-levels', '--rows']).stdout, /^REQ-004,/m);
    const r = run(dir, ['stock-levels', '--contract', 'specs/stock-levels.openapi.json']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const doc = JSON.parse(readFileSync(join(dir, 'specs', 'stock-levels.openapi.json'), 'utf8'));
    assert.equal(doc.openapi, '3.0.3');
    assert.match(r.stdout, /wrote specs\/stock-levels\.openapi\.json — point features\.contractOracle\.spec at it/);
  });

  test('red: an output is refused while the spec fails', () => {
    const dir = project();
    const f = join(dir, 'specs', 'stock-levels.spec.md');
    writeFileSync(f, readFileSync(f, 'utf8').replace(/^\| AC-005 .*\n/m, ''));
    const r = run(dir, ['stock-levels', '--contract', 'out.json']);
    assert.equal(r.status, 1);
    assert.equal(existsSync(join(dir, 'out.json')), false);
  });

  test('the feature off: its not-configured line and exit 0', () => {
    const dir = project();
    const p = join(dir, 'PIPELINE_PROFILE.md');
    writeFileSync(p, readFileSync(p, 'utf8').replace('"state": "on"', '"state": "off"'));
    const r = run(dir, ['stock-levels', '--ratified']);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), 'specAuthoring: not configured');
  });

  test('usage and a missing spec exit 2', () => {
    const dir = project();
    assert.equal(run(dir, []).status, 2);
    const r = run(dir, ['no-such-module']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /no spec at specs\/no-such-module\.spec\.md/);
  });
});
