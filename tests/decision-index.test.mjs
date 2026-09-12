import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const di = require('../scripts/lib/decision-index.cjs');

const P = 'D-\\d+';
const scan = (text, file = 'notes.md', pattern = P) => di.scanText(file, text, pattern);

describe('decision-index — pure', () => {
  test('heading anchors: plain, backticked, and with a qualifier inside the backticks', () => {
    const r = scan('## D-12 — Soft delete\n### `D-13`: Exports async\n# `D-14 (ii)` — Second half\n#### D-15 No separator');
    assert.deepEqual(r.anchors.map((a) => [a.id, a.title, a.where]), [
      ['D-12', 'Soft delete', 'notes.md:1'],
      ['D-13', 'Exports async', 'notes.md:2'],
      ['D-14', '(ii) Second half', 'notes.md:3'],
      ['D-15', 'No separator', 'notes.md:4'],
    ]);
    assert.deepEqual(r.citations, []);
  });

  test('a heading whose first token is not an id, a second id on an anchor line, and prose are citations', () => {
    const r = scan('## Notes on D-5\n## D-7 — supersedes D-3\nsee D-7');
    assert.deepEqual(r.anchors.map((a) => a.id), ['D-7']);
    assert.deepEqual(r.citations.map((c) => `${c.id}@${c.where}`), ['D-5@notes.md:1', 'D-3@notes.md:2', 'D-7@notes.md:3']);
  });

  test('the id match is greedy on the whole token', () => {
    assert.deepEqual(scan('## D-20260821-3 — batch', 'n.md', 'D-\\d+(?:-\\d+)?').anchors.map((a) => a.id), ['D-20260821-3']);
    assert.deepEqual(scan('D-12x and xD-3 and D-4', 'n.md').citations.map((c) => c.id), ['D-4']);
  });

  test('table rows: the Decision column is the title; without one the other cells join; a two-id first cell is not an anchor', () => {
    const log = '| Id | Date | Decision | Why |\n|---|---|---|---|\n| D-1 | 2026-01-02 | Holds expire | carts \\| stock |\n| `D-2` | 2026-01-03 | Strings for money (after D-1) | cents |';
    const r = scan(log);
    assert.deepEqual(r.anchors.map((a) => [a.id, a.title]), [['D-1', 'Holds expire'], ['D-2', 'Strings for money (after D-1)']]);
    assert.deepEqual(r.citations.map((c) => c.id), ['D-1']);
    const bare = scan('| Id | Scope | Note |\n|---|---|---|\n| D-3 | stock | first |');
    assert.equal(bare.anchors[0].title, 'stock · first');
    const two = scan('| Ids | Note |\n|---|---|\n| D-1, D-2 | pair |');
    assert.deepEqual([two.anchors.length, two.citations.length], [0, 2]);
  });

  test('red: a heading inside fenced code, or a `# D-n` comment in a non-markdown file, is a citation — never an anchor', () => {
    const fenced = scan('```md\n## D-9 — example\n```\n');
    assert.deepEqual([fenced.anchors.length, fenced.citations.map((c) => c.id)], [0, ['D-9']]);
    const py = scan('# D-2: strings\n', 'settings.py');
    assert.deepEqual([py.anchors.length, py.citations.length], [0, 1]);
  });

  test('ids order by trailing number, then lexically; problems name unanchored and doubly anchored ids', () => {
    assert.deepEqual(['D-10', 'D-9', 'D-2', 'X-2'].sort(di.compareIds), ['D-2', 'X-2', 'D-9', 'D-10']);
    const index = di.buildIndex([
      { file: 'b.md', text: '## D-3 — again' },
      { file: 'a.md', text: '## D-3 — first\ncites D-8' },
    ], P);
    assert.deepEqual(di.problems(index), { unanchored: ['D-8'], duplicates: ['D-3'] });
    const text = di.render(index);
    assert.match(text, /\| `D-3` \| first \| `a\.md:1` \(\+1\) \| 0 \|/);
    assert.match(text, /## Cited but never anchored\n\n- `D-8` — cited 1× · `a\.md:2`/);
    assert.match(text, /## Anchored more than once\n\n- `D-3` — `a\.md:1` · `b\.md:1`/);
    assert.equal(di.render(index), text);
  });
});

const cli = join(here, '..', 'scripts', 'decision-index.mjs');
const fixture = join(here, 'fixtures', 'decision-index');
const made = [];
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));
const project = () => {
  const dir = mkdtempSync(join(tmpdir(), 'builder-decisions-'));
  cpSync(fixture, dir, { recursive: true });
  made.push(dir);
  return dir;
};
const run = (cwd, ...args) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });
const OUT = 'notes/decision-index.md';

describe('decision-index — CLI on a fixture project', () => {
  test('the default run writes the index; a second run skips its own output and leaves it byte-identical; --check passes', () => {
    const dir = project();
    const r = run(dir);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /4 file\(s\) read · 5 id\(s\) · 5 anchored · 0 unanchored · 0 anchored more than once/);
    assert.match(r.stdout, /index written — notes\/decision-index\.md/);
    const text = readFileSync(join(dir, OUT), 'utf8');
    assert.match(text, /regenerate with `node scripts\/decision-index\.mjs`, never hand-edit/);
    const rows = text.split('\n').filter((l) => l.startsWith('| `'));
    assert.deepEqual(rows, [
      '| `D-1` | Reservations expire after 24 hours | `DECISIONS.md:5` | 2 |',
      '| `D-2` | Money travels as a decimal string | `DECISIONS.md:6` | 2 |',
      '| `D-3` | Soft delete cascades to child rows | `notes/rulings.md:3` | 0 |',
      '| `D-4` | Exports run in the background | `notes/rulings.md:7` | 0 |',
      '| `D-10` | Reservations expire after 4 hours (supersedes D-1) | `DECISIONS.md:7` | 2 |',
    ]);
    const bytes = readFileSync(join(dir, OUT));
    const again = run(dir);
    assert.equal(again.status, 0);
    assert.match(again.stdout, /index unchanged — notes\/decision-index\.md left byte-identical/);
    assert.deepEqual(readFileSync(join(dir, OUT)), bytes);
    const ok = run(dir, '--check');
    assert.equal(ok.status, 0, ok.stdout);
    assert.match(ok.stdout, /decision-index: PASS — 5 id\(s\), each anchored once/);
  });

  test('red: a hand-edit to the index fails --check, and --check writes nothing', () => {
    const dir = project();
    run(dir);
    appendFileSync(join(dir, OUT), '| `D-11` | added by hand | `nowhere` | 0 |\n');
    const edited = readFileSync(join(dir, OUT));
    const r = run(dir, '--check');
    assert.equal(r.status, 1);
    assert.match(r.stdout, /decision-index: FAIL — notes\/decision-index\.md is stale/);
    assert.deepEqual(readFileSync(join(dir, OUT)), edited);
  });

  test('red: a missing index fails --check and is not created', () => {
    const dir = project();
    const r = run(dir, '--check');
    assert.equal(r.status, 1);
    assert.match(r.stdout, /notes\/decision-index\.md is missing/);
    assert.equal(existsSync(join(dir, OUT)), false);
  });

  test('red: an id cited but never anchored fails --check by name; the default run writes it into the index and still exits 1', () => {
    const dir = project();
    run(dir);
    writeFileSync(join(dir, 'src', 'export.ts'), '// the export queue follows D-77\n');
    const r = run(dir, '--check');
    assert.equal(r.status, 1);
    assert.match(r.stdout, /UNANCHORED {2}D-77 — cited at src\/export\.ts:1/);
    assert.match(r.stdout, /1 id\(s\) cited but never anchored \(D-77\)/);
    const regen = run(dir);
    assert.equal(regen.status, 1);
    assert.match(readFileSync(join(dir, OUT), 'utf8'), /## Cited but never anchored\n\n- `D-77` — cited 1× · `src\/export\.ts:1`/);
  });

  test('red: an id anchored twice fails', () => {
    const dir = project();
    writeFileSync(join(dir, 'notes', 'later.md'), '## D-3 — Soft delete, restated\n');
    const r = run(dir);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /TWICE {7}D-3 — notes\/later\.md:1, notes\/rulings\.md:3/);
  });

  test('a root that does not exist exits 2; the feature off prints "decisionIndex: not configured"', () => {
    const dir = project();
    rmSync(join(dir, 'src'), { recursive: true });
    const missing = run(dir);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /root src does not exist/);
    writeFileSync(join(dir, 'PIPELINE_PROFILE.md'), '```json pipeline-settings\n{ "schema": 2, "features": { "decisionIndex": { "state": "off" } } }\n```\n');
    const off = run(dir);
    assert.equal(off.status, 0);
    assert.equal(off.stdout.trim(), 'decisionIndex: not configured');
  });
});
