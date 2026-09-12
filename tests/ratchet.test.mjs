import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const ratchet = require('../scripts/lib/ratchet.cjs');

describe('ratchet — pure', () => {
  const bank = (items, count = items.length) => ({ items, count });

  test('drains bank items no longer measured; next is the sorted remainder', () => {
    const p = ratchet.plan(bank(['c', 'a', 'b']), ['b']);
    assert.equal(p.status, 'drain');
    assert.deepEqual(p.drained, ['a', 'c']);
    assert.deepEqual(p.next, ['b']);
  });

  test('red: a measured item the bank does not hold is refused, not added', () => {
    const p = ratchet.plan(bank(['a']), ['a', 'z', 'm']);
    assert.equal(p.status, 'refused');
    assert.deepEqual(p.added, ['m', 'z']);
    assert.deepEqual(p.drained, []);
  });

  test('red: a list and ceiling that disagree fail before anything is compared; so does a duplicate item', () => {
    assert.equal(ratchet.plan(bank(['a', 'b'], 3), ['a']).status, 'fail');
    assert.match(ratchet.plan(bank(['a', 'b'], 3), []).problems[0], /list and ceiling disagree — count 3, items 2/);
    assert.match(ratchet.plan(bank(['a', 'a']), ['a']).problems[0], /more than once/);
  });

  test('an equal measurement is unchanged; an empty measurement drains everything', () => {
    assert.equal(ratchet.plan(bank(['a', 'b']), ['b', 'a']).status, 'unchanged');
    assert.deepEqual(ratchet.plan(bank(['a', 'b']), []).next, []);
  });

  test('parsers: a bank needs items and an integer count; measured is an array or { items }, deduplicated', () => {
    assert.equal(ratchet.parseBank({ items: ['a'] }).bank, null);
    assert.equal(ratchet.parseBank({ items: ['a'], count: 1 }).errors.length, 0);
    assert.deepEqual(ratchet.parseMeasured(['a', 'a']).items, ['a']);
    assert.deepEqual(ratchet.parseMeasured({ items: ['b'], measuredAt: 'T' }), { items: ['b'], measuredAt: 'T', errors: [] });
    assert.equal(ratchet.parseMeasured({ actions: [] }).items, null);
  });

  test('renderBank keeps other keys in place and moves items, count and measuredAt together', () => {
    const text = ratchet.renderBank({ _doc: 'd', items: ['a', 'b'], count: 2, measuredAt: 'old' }, ['b'], 'new');
    assert.deepEqual(Object.keys(JSON.parse(text)), ['_doc', 'items', 'count', 'measuredAt']);
    assert.deepEqual(JSON.parse(text), { _doc: 'd', items: ['b'], count: 1, measuredAt: 'new' });
    assert.ok(text.endsWith('}\n'));
  });
});

const cli = join(here, '..', 'scripts', 'ratchet-refresh.mjs');
const fixture = join(here, 'fixtures', 'ratchet');
const made = [];
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));
const project = () => {
  const dir = mkdtempSync(join(tmpdir(), 'builder-ratchet-'));
  cpSync(fixture, dir, { recursive: true });
  made.push(dir);
  return dir;
};
const run = (cwd, ...args) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });
const bytes = (dir, p) => readFileSync(join(dir, p));
const EFFECTS = 'ratchets/unexercised-effects.json';
const UNTYPED = 'ratchets/untyped-files.json';

describe('ratchet-refresh — CLI on a fixture project', () => {
  test('the default run is a dry run: prints what drains, exits 0, and writes nothing', () => {
    const dir = project();
    const before = [bytes(dir, EFFECTS), bytes(dir, UNTYPED)];
    const r = run(dir);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /unexercised-effects — bank ratchets\/unexercised-effects\.json: 3 banked · 1 measured — 2 item\(s\) gained coverage/);
    assert.match(r.stdout, / {4}- stock\.adjust\n {4}- stock\.reserve/);
    assert.match(r.stdout, /untyped-files — .*nothing drained, bank left byte-identical/);
    assert.match(r.stdout, /ratchet-refresh: PASS — 2 list\(s\); 2 item\(s\) drained \(dry run — re-run with --write to apply\)/);
    assert.deepEqual([bytes(dir, EFFECTS), bytes(dir, UNTYPED)], before);
  });

  test('--write moves items, count and measuredAt in one motion; the unchanged bank stays byte-identical; a second run moves nothing', () => {
    const dir = project();
    const untyped = bytes(dir, UNTYPED);
    const r = run(dir, '--write');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const next = JSON.parse(readFileSync(join(dir, EFFECTS), 'utf8'));
    assert.deepEqual(next, { _doc: next._doc, items: ['stock.release'], count: 1, measuredAt: '2026-09-01T12:00:00.000Z' });
    assert.deepEqual(bytes(dir, UNTYPED), untyped);
    const written = bytes(dir, EFFECTS);
    const again = run(dir, '--write');
    assert.equal(again.status, 0);
    assert.match(again.stdout, /nothing drained, every bank left byte-identical/);
    assert.deepEqual(bytes(dir, EFFECTS), written);
  });

  test('red: a newly uncovered item is REFUSED by name, exit 1, and --write does not touch that bank', () => {
    const dir = project();
    writeFileSync(join(dir, 'reports/unexercised-effects.json'), JSON.stringify({ items: ['stock.release', 'stock.transfer'] }));
    const before = bytes(dir, EFFECTS);
    const r = run(dir, '--write');
    assert.equal(r.status, 1);
    assert.match(r.stdout, /REFUSED — 1 item\(s\) are uncovered NOW but were not banked:\n {4}\+ stock\.transfer/);
    assert.match(r.stdout, /shipped without coverage/);
    assert.match(r.stdout, /ratchet-refresh: FAIL — unexercised-effects refused/);
    assert.deepEqual(bytes(dir, EFFECTS), before);
  });

  test('red: a bank whose count disagrees with its items fails, exit 1', () => {
    const dir = project();
    writeFileSync(join(dir, UNTYPED), JSON.stringify({ items: ['src/legacy/export.js'], count: 4 }));
    const r = run(dir, 'untyped-files');
    assert.equal(r.status, 1);
    assert.match(r.stdout, /list and ceiling disagree — count 4, items 1/);
  });

  test('a missing measured file exits 2 and says to run the measurement; an unknown list name exits 2', () => {
    const dir = project();
    rmSync(join(dir, 'reports/untyped-files.json'));
    const r = run(dir, 'untyped-files');
    assert.equal(r.status, 2);
    assert.match(r.stdout, /run the measurement first — the measured set is runtime-only, it cannot be derived from source/);
    const unknown = run(dir, 'nope');
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /no list named "nope"/);
  });

  test('draining to empty says the list can be closed; a named list is the only one read', () => {
    const dir = project();
    writeFileSync(join(dir, 'reports/unexercised-effects.json'), '[]\n');
    const before = bytes(dir, UNTYPED);
    const r = run(dir, 'unexercised-effects', '--write', '--json');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const data = JSON.parse(r.stdout);
    assert.deepEqual(data.lists.map((l) => [l.name, l.status, l.closable, l.written]), [['unexercised-effects', 'drain', true, true]]);
    assert.equal(JSON.parse(readFileSync(join(dir, EFFECTS), 'utf8')).count, 0);
    assert.match(run(dir, 'unexercised-effects').stdout, /nothing drained/);
    assert.deepEqual(bytes(dir, UNTYPED), before);
    const dry = project();
    writeFileSync(join(dry, 'reports/unexercised-effects.json'), '[]\n');
    assert.match(run(dry, 'unexercised-effects').stdout, /the bank would be EMPTY — the list can be closed/);
  });

  test('the feature off prints "ratchets: not configured"', () => {
    const dir = project();
    writeFileSync(join(dir, 'PIPELINE_PROFILE.md'), '```json pipeline-settings\n{ "schema": 2, "features": { "ratchets": { "state": "off" } } }\n```\n');
    const r = run(dir);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), 'ratchets: not configured');
  });
});
