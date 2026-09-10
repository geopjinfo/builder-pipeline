import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const { classify, snippetOf, report, parseStream } = require('../scripts/lib/rules-module.cjs');

const fx = (...p) => join(here, 'fixtures', 'rules', ...p);
const stream = readFileSync(fx('scan.jsonl'), 'utf8');
const baseline = JSON.parse(readFileSync(fx('baseline.json'), 'utf8'));
const RATCHETED = ['offset-pagination-without-id-tiebreak', 'clock-read-outside-transaction'];
const hit = (ruleId, file, text, line = 9) => JSON.stringify({ ruleId, file, text, range: { start: { line } } });
const cli = join(here, '..', 'scripts', 'rules-module.mjs');

function env() {
  const e = { ...process.env };
  const key = Object.keys(e).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
  e[key] = `${dirname(process.execPath)}${delimiter}${e[key] ?? ''}`;
  return e;
}
const run = (dir, args = []) => spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: 'utf8', env: env() });

test('a hit matching rule + file + collapsed snippet is BASELINED with its why; others are NEW; unratcheted rules drop', () => {
  const hits = classify(stream, baseline, RATCHETED);
  assert.deepEqual(hits.map((h) => [h.ruleId, h.status]), [
    ['offset-pagination-without-id-tiebreak', 'BASELINED'],
    ['clock-read-outside-transaction', 'NEW'],
  ]);
  assert.deepEqual(hits[0], {
    ruleId: 'offset-pagination-without-id-tiebreak',
    file: 'src/items/items.repository.ts',
    line: 12,
    snippet: '{ where, skip, take }',
    status: 'BASELINED',
    why: baseline[0].why,
  });
  assert.equal(hits[1].why, null);
});

test('red: a line number is not the key — a moved hit stays baselined, an edited snippet does not', () => {
  const moved = classify(hit('offset-pagination-without-id-tiebreak', 'src/items/items.repository.ts', '{ where, skip, take }', 400), baseline, RATCHETED);
  assert.equal(moved[0].status, 'BASELINED');
  assert.equal(moved[0].line, 401);
  const edited = classify(hit('offset-pagination-without-id-tiebreak', 'src/items/items.repository.ts', '{ where, skip, take, cursor }'), baseline, RATCHETED);
  assert.equal(edited[0].status, 'NEW');
  const otherFile = classify(hit('offset-pagination-without-id-tiebreak', 'src/stock/stock.repository.ts', '{ where, skip, take }'), baseline, RATCHETED);
  assert.equal(otherFile[0].status, 'NEW');
});

test('an empty ratcheted list counts every rule — it never silently counts none', () => {
  assert.equal(classify(stream, baseline, []).length, 3);
  assert.equal(classify(stream, baseline).length, 3);
});

test('the baseline may be a bare array or { entries }; snippets collapse whitespace and clip at 160', () => {
  assert.equal(classify(stream, { entries: baseline }, RATCHETED)[0].status, 'BASELINED');
  assert.equal(snippetOf('a\n\t  b   c'), 'a b c');
  assert.equal(snippetOf('x'.repeat(500)).length, 160);
});

test('red: a malformed stream line throws with its number — a half-parsed scan did not run', () => {
  assert.throws(() => parseStream(`${hit('r', 'f', 't')}\nnot json\n`), /line 2 is not JSON/);
});

test('report lines: summary, NEW with location and snippet, BASELINED with its why', () => {
  const lines = report(classify(stream, baseline, RATCHETED), { target: 'src', baselinePath: 'baseline.json' });
  assert.equal(lines[0], 'rules src — 2 hit(s): 1 NEW, 1 BASELINED (baseline: baseline.json)');
  assert.equal(lines[1], 'NEW        clock-read-outside-transaction  src/stock/stock.service.ts:31  this.clock.now()');
  assert.match(lines[2], /^BASELINED {2}offset-pagination-without-id-tiebreak {2}src\/items\/items\.repository\.ts:12 — TRUE POSITIVE/);
});

test('CLI: a target narrows the scan through {target}; no target scans everything', () => {
  const items = run(fx(), ['src/items']);
  assert.equal(items.status, 0, items.stderr);
  assert.match(items.stdout, /^rules src\/items — 1 hit\(s\): 0 NEW, 1 BASELINED/);
  const all = run(fx());
  assert.equal(all.status, 0, all.stderr);
  assert.match(all.stdout, /^rules — 2 hit\(s\): 1 NEW, 1 BASELINED/);
  const json = JSON.parse(run(fx(), ['src/stock', '--json']).stdout);
  assert.deepEqual(json.hits.map((h) => h.status), ['NEW']);
});

test('CLI red: a scan that fails prints NOT RUN, never an empty list; a shell-unsafe target is refused', () => {
  const broken = run(fx(), ['broken']);
  assert.equal(broken.status, 0);
  assert.match(broken.stdout, /scan failed \(exit 3\) — rules: NOT RUN/);
  assert.doesNotMatch(broken.stdout, /0 hit/);
  const unsafe = run(fx(), ['src;echo']);
  assert.equal(unsafe.status, 1);
});

test('CLI: feature off prints not configured', () => {
  const off = run(fx('off'));
  assert.equal(off.status, 0);
  assert.equal(off.stdout.trim(), 'rules: not configured');
});
