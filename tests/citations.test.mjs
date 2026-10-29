import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const lib = require('../scripts/lib/citations.cjs');

const fixture = join(here, 'fixtures', 'citations', 'project');

const schemesWith = (defs) =>
  lib.compileSchemes(defs).map((s, i) => Object.assign(s, { ids: lib.idSet(s, defs[i].ids) }));

describe('citations — board parsing', () => {
  test('cells keep an escaped pipe inside its cell', () => {
    assert.deepEqual(lib.cells('| T5 | holds `a \\| b` | INV-1 |'), ['T5', 'holds `a | b`', 'INV-1']);
  });

  test('a separator row is not a row, and a Cites header sets the column', () => {
    assert.ok(lib.isSeparator('|---|:--|--:|'));
    assert.ok(!lib.isSeparator('| T1 | x | y |'));
    const { hasCites, sites } = lib.scanBoard('| Row | Cites |\n|---|---|\n| T1 | STK-001 |\n', 'b.md');
    assert.equal(hasCites, true);
    assert.deepEqual(sites, [{ path: 'b.md', line: 3, token: 'STK-001' }]);
  });

  test('a cell splits on · , ; and " + ", strips backticks and *, and skips — and -', () => {
    assert.deepEqual(lib.tokensOf('`STK-1` · **REG-2**, a.b; c + d'), ['STK-1', 'REG-2', 'a.b', 'c', 'd']);
    assert.deepEqual(lib.tokensOf('—'), []);
    assert.deepEqual(lib.tokensOf(' - '), []);
    assert.deepEqual(lib.tokensOf('STK-1 · —'), ['STK-1']);
  });

  test('a table with no Cites column after one that had it is not read as citations', () => {
    const board = '| Row | Cites |\n|---|---|\n| T1 | STK-1 |\n\n| Item | Owner |\n|---|---|\n| x | STK-9 |\n';
    assert.deepEqual(lib.scanBoard(board, 'b.md').sites.map((s) => s.token), ['STK-1']);
  });
});

describe('citations — schemes and sources', () => {
  const defs = [
    { name: 'requirement', pattern: 'STK-\\d+', ignoreCase: true, ids: ['STK-001'] },
    { name: 'action', pattern: '[a-z]+\\.[a-z]+', skip: '\\.(md|csv)$', ids: ['stock.read'] },
    { name: 'catch-all', pattern: '.+', ids: ['anything'] },
  ];

  test('the FIRST scheme that owns a token judges it, and skip hands the token on', () => {
    const [s0, s1, s2] = schemesWith(defs);
    assert.equal(lib.ownerOf('STK-001', [s0, s1, s2]).name, 'requirement');
    assert.equal(lib.ownerOf('stock.read', [s0, s1, s2]).name, 'action');
    assert.equal(lib.ownerOf('notes.md', [s0, s1, s2]).name, 'catch-all');
    assert.equal(lib.ownerOf('notes.md', [s0, s1]), null);
  });

  test('the pattern is anchored — a token that only CONTAINS an id is prose, not a resolution', () => {
    const schemes = schemesWith(defs.slice(0, 2));
    const [r] = lib.judge([{ path: 'b.md', line: 1, token: 'see STK-001 in the register' }], schemes);
    assert.equal(r.verdict, 'not-evaluable');
  });

  test('ignoreCase compares upper-cased; without it, case matters', () => {
    const schemes = schemesWith(defs.slice(0, 2));
    assert.equal(lib.judge([{ path: 'b', line: 1, token: 'stk-001' }], schemes)[0].verdict, 'resolved');
    assert.equal(lib.judge([{ path: 'b', line: 1, token: 'Stock.Read' }], schemes)[0].verdict, 'not-evaluable');
  });

  test('red: an invented id beside a real one is UNRESOLVED — the exact invention shape', () => {
    const schemes = schemesWith([{ name: 'requirement', pattern: 'STK-\\d+', ids: ['STK-004'] }]);
    const out = lib.judge([{ path: 'b.md', line: 7, token: 'STK-004' }, { path: 'b.md', line: 8, token: 'STK-014' }], schemes);
    assert.deepEqual(out.map((r) => r.verdict), ['resolved', 'UNRESOLVED']);
    assert.deepEqual(lib.counts(out), { resolved: 1, prose: 0, unresolved: 1 });
  });

  test('a CSV source reads a column by header name or by index, and never the header', () => {
    const csv = 'id,title\nSTK-001,"a, quoted title"\nSTK-002,b\n';
    assert.deepEqual(lib.idsFromCsv(csv, 'id'), ['STK-001', 'STK-002']);
    assert.deepEqual(lib.idsFromCsv(csv, 1), ['a, quoted title', 'b']);
    assert.throws(() => lib.idsFromCsv(csv, 'key'), /no column "key"/);
  });

  test('a dir source takes capture 1 of each file name; a files source takes every idPattern match', () => {
    assert.deepEqual(lib.idsFromNames(['REG-001-a.md', 'README.md', 'REG-2-b.md'], '^(REG-\\d+)-'), ['REG-001', 'REG-2']);
    assert.deepEqual(lib.idsFromTexts(['INV-1 and INV-2', 'no ids', 'INV-3'], 'INV-\\d+'), ['INV-1', 'INV-2', 'INV-3']);
    assert.deepEqual(lib.idsFromNames(['reg-001-a.md'], '^(REG-\\d+)-', 'i'), ['reg-001']);
  });
});

const cli = join(here, '..', 'scripts', 'citations-check.mjs');
const made = [];
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));
const project = () => {
  const dir = mkdtempSync(join(tmpdir(), 'builder-citations-'));
  cpSync(fixture, dir, { recursive: true });
  made.push(dir);
  return dir;
};
const run = (cwd, ...args) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });
const lastLine = (r) => (r.stdout + r.stderr).trim().split(/\r?\n/).at(-1);
const setProfile = (dir, mutate) => {
  const path = join(dir, 'PIPELINE_PROFILE.md');
  const text = readFileSync(path, 'utf8');
  const [, body] = /```json pipeline-settings\n([\s\S]*?)\n```/.exec(text.replace(/\r\n/g, '\n'));
  const settings = JSON.parse(body);
  mutate(settings);
  writeFileSync(path, `\`\`\`json pipeline-settings\n${JSON.stringify(settings, null, 2)}\n\`\`\`\n`);
};

describe('citations-check — CLI on a fixture project', () => {
  test('green: every owned id resolves; README.md, _*.md and a Cites-less table are not read', () => {
    const r = run(project());
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(lastLine(r), 'citations-check: PASS — 10 resolved, 2 prose (not-evaluable), 0 unresolved, across 2 board(s)');
  });

  test('red: an invented id fails, named with its scheme and path:line', () => {
    const dir = project();
    appendFileSync(join(dir, 'tasks', 'restock.md'), '| T2 | Restock threshold | STK-014 | restock.test.py::threshold | PLANNED |\n');
    const r = run(dir);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /UNRESOLVED STK-014 {2}\(requirement\) {2}at tasks\/restock\.md:6/);
    assert.equal(lastLine(r), 'citations-check: FAIL — 1 citation(s) do not resolve');
  });

  test('red: an invented action key and an invented record are both caught, across schemes', () => {
    const dir = project();
    appendFileSync(join(dir, 'tasks', 'restock.md'), '| T2 | x | stock.delete · REG-003 | — | PLANNED |\n');
    const r = run(dir, '--json');
    assert.equal(r.status, 1);
    const data = JSON.parse(r.stdout);
    assert.deepEqual(data.results.filter((x) => x.verdict === 'UNRESOLVED').map((x) => `${x.scheme}:${x.token}`), ['action:stock.delete', 'record:REG-003']);
    assert.equal(data.verdict, 'FAIL');
  });

  test('--list prints every token with its verdict, scheme and path:line', () => {
    const r = run(project(), '--list');
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^resolved\s+requirement\s+stk-004\s+tasks\/stock-levels\.md:8$/m);
    assert.match(r.stdout, /^not-evaluable\s+prose\s+stock\.md\s+tasks\/stock-levels\.md:11$/m);
    assert.match(r.stdout, /^not-evaluable\s+prose\s+spec §2\.3\s+tasks\/stock-levels\.md:9$/m);
  });

  test('--json carries counts, scheme id-set sizes and the verdict', () => {
    const data = JSON.parse(run(project(), '--json').stdout);
    assert.deepEqual(data.counts, { resolved: 10, prose: 2, unresolved: 0 });
    assert.deepEqual(data.schemes.map((s) => [s.name, s.ids]), [['requirement', 3], ['record', 2], ['invariant', 2], ['action', 3]]);
    assert.equal(data.verdict, 'PASS');
  });

  test('a missing source exits 2 and names it — never a pass', () => {
    const dir = project();
    rmSync(join(dir, 'records'), { recursive: true });
    const r = run(dir);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /^citations-check: source missing — records \(scheme "record"\)/m);
  });

  test('red: a source that yields zero ids fails the positive control, even with nothing unresolved to show', () => {
    const dir = project();
    writeFileSync(join(dir, 'register', 'actions.csv'), 'key,label\n');
    setProfile(dir, (s) => {
      s.features.citations.schemes[3].pattern = 'nothing\\.owns\\.this';
    });
    const r = run(dir);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(lastLine(r), /^citations-check: FAIL — scheme "action" resolves against zero ids from register\/actions\.csv/);
  });

  test('red: boards with no Cites column anywhere fail — a check that saw no column checked nothing', () => {
    const dir = project();
    for (const b of ['stock-levels.md', 'restock.md']) {
      const path = join(dir, 'tasks', b);
      writeFileSync(path, readFileSync(path, 'utf8').replace(/\| Cites \|/g, '| Source |'));
    }
    const r = run(dir);
    assert.equal(r.status, 1);
    assert.match(lastLine(r), /^citations-check: FAIL — 2 board\(s\) read and none has a Cites column/);
  });

  test('no board files at all says so and exits 0 — not a PASS', () => {
    const dir = project();
    for (const b of ['stock-levels.md', 'restock.md']) rmSync(join(dir, 'tasks', b));
    const r = run(dir);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), 'citations-check: no boards to check');
  });

  test('named boards are checked instead of the directory', () => {
    const r = run(project(), 'tasks/restock.md');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(lastLine(r), 'citations-check: PASS — 1 resolved, 0 prose (not-evaluable), 0 unresolved, across 1 board(s)');
  });

  test('a dir source may be an array — ids from every directory are merged into one set', () => {
    const dir = project();
    mkdirSync(join(dir, 'records-archive'));
    renameSync(join(dir, 'records', 'REG-002-negative-stock.md'), join(dir, 'records-archive', 'REG-002-negative-stock.md'));
    appendFileSync(join(dir, 'tasks', 'restock.md'), '| T2 | x | REG-002 | — | PLANNED |\n');
    // Negative control: one directory alone no longer holds REG-002, so the citation fails as invented.
    const single = run(dir);
    assert.equal(single.status, 1, single.stdout + single.stderr);
    assert.match(single.stderr, /UNRESOLVED REG-002 {2}\(record\)/);
    // Both directories: REG-002 resolves from the second, REG-001 still from the first.
    setProfile(dir, (s) => {
      s.features.citations.schemes[1].source.dir = ['records', 'records-archive'];
    });
    const both = run(dir, '--json');
    assert.equal(both.status, 0, both.stdout + both.stderr);
    const data = JSON.parse(both.stdout);
    assert.deepEqual(data.schemes.find((x) => x.name === 'record').ids, 2);
    assert.equal(data.results.filter((x) => x.token === 'REG-002').every((x) => x.verdict === 'resolved'), true);
    // A listed directory that is missing is a missing source — never skipped.
    rmSync(join(dir, 'records-archive'), { recursive: true });
    const missing = run(dir);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /source missing — records-archive \(scheme "record"\)/);
  });

  test('an empty dir list is an invalid profile', () => {
    const dir = project();
    setProfile(dir, (s) => {
      s.features.citations.schemes[1].source.dir = [];
    });
    const r = run(dir);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /features\.citations\.schemes\[1\]\.source: "dir" needs a path/);
  });

  test('an invalid profile exits 2 and lists the errors', () => {
    const dir = project();
    setProfile(dir, (s) => {
      s.features.citations.schemes[0].source = { csv: 'register/requirements.csv' };
    });
    const r = run(dir);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /features\.citations\.schemes\[0\]\.source/);
  });

  test('the feature off prints "citations: not configured"', () => {
    const dir = project();
    writeFileSync(join(dir, 'PIPELINE_PROFILE.md'), '```json pipeline-settings\n{ "schema": 2, "features": { "citations": { "state": "off" } } }\n```\n');
    const r = run(dir);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), 'citations: not configured');
  });
});
