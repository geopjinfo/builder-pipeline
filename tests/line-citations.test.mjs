import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const lib = require('../scripts/lib/line-citations.cjs');

const fixture = join(here, 'fixtures', 'line-citations', 'project');
const idx = lib.catalogueIndex(['catalogue/actions.csv', 'ref/roles.csv']);
const kinds = (line) => lib.occurrences(line, idx).map((o) => `${o.kind}:${o.cite}`);

describe('line-citations — what counts', () => {
  test('red: a catalogue line citation is caught — by basename, through a path, in any case', () => {
    assert.deepEqual(kinds('`stock.adjust` — verified present (`actions.csv:3`)'), ['catalogue:actions.csv:3']);
    assert.deepEqual(kinds('see catalogue/actions.csv:3 and ref/Roles.CSV:40'), ['catalogue:actions.csv:3', 'catalogue:Roles.CSV:40']);
  });

  test('red: the bare <ext>:<N> form — no file name at all — is caught when the extension is a catalogue\'s', () => {
    assert.deepEqual(kinds("  guard({ reason: 'stock.adjust is buyer-only (csv:3)' })"), ['catalogue:csv:3']);
    assert.deepEqual(kinds('listening on host:8080, step:2'), []);
  });

  test('every other <name>.<ext>:<N> is the other population, not an offender', () => {
    assert.deepEqual(kinds('summed in levels.py:12; register row requirements.csv:468 names its id too'), ['other:levels.py:12', 'other:requirements.csv:468']);
  });

  test('red: the same sentence cited BY KEY is clean', () => {
    assert.deepEqual(kinds('The catalogue grants `stock.adjust` to the buyer role.'), []);
  });

  test('a line with no colon is never scanned, and a pathological line stays linear', () => {
    assert.deepEqual(lib.occurrences('actions.csv 3', idx), []);
    const lines = ['a.'.repeat(40000) + ':', 'a-'.repeat(40000) + 'csv:', 'x.csv:'.repeat(8000), 'a:'.repeat(40000)];
    const start = Date.now();
    for (const l of lines) lib.occurrences(l, idx);
    assert.ok(Date.now() - start < 2000, `took ${Date.now() - start}ms — a backtracking regex is back`);
  });

  test('scanText returns offenders with line numbers, the other count and control hits', () => {
    const text = '# head\nuse actions.csv:2 here\nsee stock.py:4\n';
    const s = lib.scanText(text, 'notes/a.md', idx, /head/);
    assert.deepEqual(s.offenders.map((o) => `${o.file}:${o.line}:${o.cited}`), ['notes/a.md:2:2']);
    assert.equal(s.other, 1);
    assert.equal(s.controlHits, 1);
  });
});

describe('line-citations — positive control and roster', () => {
  const base = { files: 10, minFiles: 3, control: null, controlHits: 0, other: 4 };

  test('the control holds when the walk reached minFiles and saw something to check', () => {
    assert.equal(lib.positiveControl(base), null);
    assert.equal(lib.positiveControl({ ...base, control: 'x', controlHits: 1, other: 0 }), null);
  });

  test('red: too few files, no other citation, or an unmatched control — zero offenders proves nothing', () => {
    assert.match(lib.positiveControl({ ...base, files: 2 }), /walked 2 file\(s\) \(minFiles 3\).*proves nothing/);
    assert.match(lib.positiveControl({ ...base, other: 0 }), /saw 0 other line citation/);
    assert.match(lib.positiveControl({ ...base, control: 'KEEP', controlHits: 0 }), /saw 0 line\(s\) matching control KEEP/);
  });

  const off = (file, line = 1) => ({ file, line, cited: 1, cite: 'actions.csv:1' });

  test('red: a dead roster entry, an offender outside the roster, and a count over total are each reported', () => {
    const j = lib.judgeRoster([off('a.md'), off('a.md', 2), off('b.md')], { files: ['a.md', 'gone.md'], total: 1 });
    assert.deepEqual(j.dead, ['gone.md']);
    assert.deepEqual(j.unrostered.map((o) => o.file), ['b.md']);
    assert.equal(j.over, true);
  });

  test('a count under total is reported as under, and no roster rosters nothing', () => {
    assert.equal(lib.judgeRoster([off('a.md')], { files: ['./a.md'], total: 3 }).under, true);
    const none = lib.judgeRoster([off('a.md')], null);
    assert.deepEqual([none.unrostered.length, none.dead.length, none.over, none.under], [1, 0, false, false]);
  });

  test('a malformed roster is named', () => {
    assert.deepEqual(lib.rosterErrors({ files: ['a.md'], total: 2 }), []);
    assert.equal(lib.rosterErrors([]).length, 1);
    assert.equal(lib.rosterErrors({ files: 'a.md', total: -1 }).length, 2);
  });
});

describe('line-citations — the stale measurement', () => {
  const keys = new Map([['actions.csv', lib.loadKeyLines(readFileSync(join(fixture, 'catalogue', 'actions.csv'), 'utf8'), 'actions.csv', 0)]]);

  test('a catalogue loads key → 1-based line, the header is never a key, and the first occurrence wins', () => {
    assert.equal(keys.get('actions.csv').get('stock.adjust'), 3);
    assert.equal(keys.get('actions.csv').has('key'), false);
    const md = lib.loadKeyLines('| key | label |\n|---|---|\n| `a.b` | x |\n| a.b | again |\n', 'keys.md', 0);
    assert.deepEqual([...md], [['a.b', 3]]);
  });

  test('red: an offender pairs with the nearest PRECEDING real key, and a stale line is visible', () => {
    const [p] = lib.pairOn(' * (stock.read, then stock.adjust, actions.csv:2) + reorder.approve', idx, keys);
    assert.deepEqual([p.key, p.cited, p.actual], ['stock.adjust', 2, 3]);
  });

  test('a dotted name that is not a key is passed over, and no key before the citation leaves it unpaired', () => {
    assert.equal(lib.pairOn('stock.read in levels.py then actions.csv:2', idx, keys)[0].key, 'stock.read');
    assert.equal(lib.pairOn('actions.csv:2 is stock.read', idx, keys)[0].key, null);
  });

  test('a bare <ext>:<N> pairs against the catalogue with that extension', () => {
    assert.deepEqual(lib.pairOn('stock.transfer (csv:4)', idx, keys).map((p) => [p.key, p.actual]), [['stock.transfer', 4]]);
  });
});

const cli = join(here, '..', 'scripts', 'line-citations-check.mjs');
const made = [];
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));
const project = () => {
  const dir = mkdtempSync(join(tmpdir(), 'builder-linecites-'));
  cpSync(fixture, dir, { recursive: true });
  made.push(dir);
  return dir;
};
const run = (cwd, ...args) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });
const lastLine = (r) => (r.stdout + r.stderr).trim().split(/\r?\n/).at(-1);
const setFeature = (dir, patch) => {
  const path = join(dir, 'PIPELINE_PROFILE.md');
  const [, body] = /```json pipeline-settings\n([\s\S]*?)\n```/.exec(readFileSync(path, 'utf8').replace(/\r\n/g, '\n'));
  const settings = JSON.parse(body);
  Object.assign(settings.features.lineCitations, patch);
  writeFileSync(path, `\`\`\`json pipeline-settings\n${JSON.stringify(settings, null, 2)}\n\`\`\`\n`);
};
const GREEN = 'line-citations-check: PASS — 0 catalogue line citation(s) outside the roster, 2 rostered (total 2), 4 file(s) walked, 3 other line citation(s) (positive control OK)';

describe('line-citations-check — CLI on a fixture project', () => {
  test('green: the rostered file carries the only offenders', () => {
    const r = run(project());
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(lastLine(r), GREEN);
  });

  test('node_modules and paths.logs are not walked', () => {
    const dir = project();
    for (const d of [join(dir, 'app', 'node_modules', 'vendor'), join(dir, 'logs')]) {
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, 'x.md'), 'stock.read is actions.csv:2\n');
    }
    const r = run(dir);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(lastLine(r), GREEN);
  });

  test('red: a new catalogue line citation outside the roster fails and names its site', () => {
    const dir = project();
    appendFileSync(join(dir, 'app', 'stock.py'), '# stock.transfer is row actions.csv:4\n');
    const r = run(dir);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /app\/stock\.py:6 — cites the catalogue as `actions\.csv:4`/);
    assert.match(lastLine(r), /^line-citations-check: FAIL — 1 catalogue line citation\(s\) outside the roster/);
  });

  test('red: the bare form fails too', () => {
    const dir = project();
    appendFileSync(join(dir, 'app', 'levels.py'), '# buyer-only (csv:3)\n');
    const r = run(dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /app\/levels\.py:4 — cites the catalogue as `csv:3`/);
  });

  test('red: a swept file left on the roster is a dead entry and fails', () => {
    const dir = project();
    writeFileSync(join(dir, 'notes', 'reorder.md'), '# Reorder notes\n\n- `reorder.approve` is granted to the buyer.\n');
    const r = run(dir);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /dead roster entry: notes\/reorder\.md .* delete it from line-citations-roster\.json/);
    assert.match(lastLine(r), /FAIL — 1 dead roster entry/);
  });

  test('red: a rostered file gaining an offender exceeds the total and fails — shrink-only', () => {
    const dir = project();
    appendFileSync(join(dir, 'notes', 'reorder.md'), '- and stock.read (actions.csv:2)\n');
    const r = run(dir);
    assert.equal(r.status, 1);
    assert.match(lastLine(r), /FAIL — 3 rostered offender\(s\) exceed the roster total 2/);
  });

  test('red: a total above the measured count is slack and fails, naming the number to lower it to', () => {
    const dir = project();
    writeFileSync(join(dir, 'line-citations-roster.json'), '{ "files": ["notes/reorder.md"], "total": 5 }\n');
    const r = run(dir);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(lastLine(r), /^line-citations-check: FAIL — the roster total 5 is above the 2 rostered offender\(s\) .* lower "total" to 2 in line-citations-roster\.json$/);
  });

  test('red: a swept citation inside a rostered file leaves slack, and the gate fails until total follows', () => {
    const dir = project();
    const notes = join(dir, 'notes', 'reorder.md');
    writeFileSync(notes, readFileSync(notes, 'utf8').replace('(actions.csv:5)', '(by key)'));
    const r = run(dir);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(lastLine(r), /lower "total" to 1/);
    writeFileSync(join(dir, 'line-citations-roster.json'), '{ "files": ["notes/reorder.md"], "total": 1 }\n');
    assert.equal(run(dir).status, 0);
  });

  test('red: the positive control is fatal — too few files, even with offenders present', () => {
    const dir = project();
    setFeature(dir, { minFiles: 50 });
    appendFileSync(join(dir, 'app', 'stock.py'), '# actions.csv:4\n');
    const r = run(dir);
    assert.equal(r.status, 1);
    assert.match(lastLine(r), /^line-citations-check: FAIL — positive control failed — walked 4 file\(s\) \(minFiles 50\)/);
  });

  test('red: a control regex that matches nothing fails the control', () => {
    const dir = project();
    setFeature(dir, { control: 'NEVER-PRESENT-\\d+' });
    const r = run(dir);
    assert.equal(r.status, 1);
    assert.match(lastLine(r), /saw 0 line\(s\) matching control/);
  });

  test('red: with no other citation and no control, a clean-looking tree is not a pass', () => {
    const dir = project();
    writeFileSync(join(dir, 'app', 'stock.py'), '# nothing cited\n');
    writeFileSync(join(dir, 'app', 'levels.py'), '# nothing cited\n');
    const r = run(dir);
    assert.equal(r.status, 1);
    assert.match(lastLine(r), /saw 0 other line citation\(s\)/);
  });

  test('--list prints every offending site', () => {
    const r = run(project(), '--list');
    assert.equal(r.status, 0);
    assert.match(r.stdout, /notes\/reorder\.md:3 — cites `actions\.csv:5` \(rostered\)/);
    assert.match(r.stdout, /notes\/reorder\.md:4 — cites `actions\.csv:2` \(rostered\)/);
  });

  test('--stale measures cited against actual and exits 1 on a stale pairing', () => {
    const r = run(project(), '--stale');
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /notes\/reorder\.md:4 — stock\.adjust cited actions\.csv:2, actually :3 \(rostered\)/);
    assert.equal(lastLine(r), 'line-citations-check --stale: 1 STALE of 2 paired catalogue line citation(s), 0 unpaired');
  });

  test('--stale with every pairing correct exits 0; with none paired it is NOT-EVALUABLE', () => {
    const dir = project();
    const notes = join(dir, 'notes', 'reorder.md');
    writeFileSync(notes, readFileSync(notes, 'utf8').replace('actions.csv:2', 'actions.csv:3'));
    const ok = run(dir, '--stale');
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(lastLine(ok), /0 STALE of 2 paired/);
    writeFileSync(notes, '# Reorder notes\n\nrow actions.csv:5\nrow actions.csv:3\n');
    const none = run(dir, '--stale');
    assert.equal(none.status, 0);
    assert.match(lastLine(none), /NOT-EVALUABLE — 2 catalogue line citation\(s\), none beside a key/);
  });

  test('the check, its lib and the roster are excluded by exact path — each quotes the barred form', () => {
    const libDir = join(here, '..', 'scripts', 'lib');
    const ownText = readFileSync(join(libDir, 'line-citations.cjs'), 'utf8');
    const rolesIdx = lib.catalogueIndex(['roles.csv']);
    assert.ok(lib.scanText(ownText, 'self', rolesIdx).offenders.length > 0, 'the lib must itself carry the barred form, or this proof proves nothing');

    const dir = project();
    writeFileSync(join(dir, 'roles.csv'), 'key\nstock.read\n');
    writeFileSync(join(dir, 'roster.json'), '{ "why": "was roles.csv:40", "files": [], "total": 0 }\n');
    setFeature(dir, { catalogues: ['roles.csv'], roots: [libDir.replace(/\\/g, '/'), 'roster.json'], extensions: ['.cjs', '.json'], roster: 'roster.json', control: "'use strict'", minFiles: 2 });
    const r = run(dir);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(lastLine(r), /^line-citations-check: PASS — 0 catalogue line citation\(s\) outside the roster, 0 rostered \(total 0\)/);
  });

  test('a missing catalogue, a missing roster and a malformed roster each exit 2', () => {
    const a = project();
    rmSync(join(a, 'catalogue', 'actions.csv'));
    assert.match(run(a).stderr, /catalogue missing — catalogue\/actions\.csv/);
    assert.equal(run(a).status, 2);
    const b = project();
    rmSync(join(b, 'line-citations-roster.json'));
    assert.equal(run(b).status, 2);
    const c = project();
    writeFileSync(join(c, 'line-citations-roster.json'), '{ "files": "notes/reorder.md" }');
    const rc = run(c);
    assert.equal(rc.status, 2);
    assert.match(rc.stderr, /roster line-citations-roster\.json is malformed/);
  });

  test('the feature off prints "lineCitations: not configured"', () => {
    const dir = project();
    writeFileSync(join(dir, 'PIPELINE_PROFILE.md'), '```json pipeline-settings\n{ "schema": 2, "features": { "lineCitations": { "state": "off" } } }\n```\n');
    const r = run(dir);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), 'lineCitations: not configured');
  });
});
