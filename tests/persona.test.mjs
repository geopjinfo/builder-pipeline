/**
 * tooling/experimental/persona — role profiles from a permission catalogue: the generated blocks come from the
 * catalogue and the login map only, drafted sections survive a refresh, and --check names every drifted key,
 * uncited bullet, missing and stray profile.
 */
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
const persona = require('../tooling/experimental/persona.cjs');
const { csvCells } = require('../scripts/lib/output-check.cjs');

const fixture = join(here, 'fixtures', 'personas', 'project');
const csv = readFileSync(join(fixture, 'catalogue', 'grants.csv'), 'utf8');
const CITE = /`[^`\s]+\.[a-z]+:\d+`|\bRULE-\d+\b/;
const opts = { csvCells, keyColumn: 'key', labelColumn: 'label', roleColumns: null, grant: '1' };

describe('persona — pure', () => {
  test('infers role columns: only the grant value or nothing, at least once; a quoted label keeps its comma', () => {
    const { columns, keysFor, errors } = persona.parseCatalogue(csv, opts);
    assert.deepEqual(errors, []);
    assert.deepEqual(columns, ['Store Manager', 'Stock Clerk', 'Auditor (read-only)'], 'domain and notes are not roles; an all-empty column cannot be inferred');
    assert.deepEqual(keysFor['Stock Clerk'], [{ key: 'stock.read', label: 'Read stock levels' }, { key: 'stock.adjust', label: 'Adjust stock, with a reason' }]);
    assert.equal(keysFor['Store Manager'].length, 4);
  });

  test('columns by 0-based index, and an explicit roleColumns list (which can name an empty role)', () => {
    const r = persona.parseCatalogue(csv, { ...opts, keyColumn: 0, labelColumn: 1, roleColumns: ['Night Porter', 'Stock Clerk'] });
    assert.deepEqual(r.columns, ['Night Porter', 'Stock Clerk']);
    assert.deepEqual(r.keysFor['Night Porter'], []);
    assert.match(persona.parseCatalogue(csv, { ...opts, roleColumns: ['Cashier'] }).errors[0], /no column named "Cashier"/);
    assert.match(persona.parseCatalogue(csv, { ...opts, keyColumn: 'permission' }).errors[0], /keyColumn "permission": no such column/);
  });

  test('red: a grant value other than the configured one is not held, and makes the column not a role', () => {
    const r = persona.parseCatalogue('key,label,A,B\nx.read,Read,1,yes\nx.write,Write,1,\n', opts);
    assert.deepEqual(r.columns, ['A']);
  });

  test('two role columns sharing a file name are refused', () => {
    assert.match(persona.parseCatalogue('key,label,Store Manager,store-manager\nx,X,1,1\n', opts).errors[0], /share the profile file store-manager\.md/);
  });

  test('a fresh profile passes its own check; a login-less role says so', () => {
    const keys = [{ key: 'stock.read', label: 'Read stock levels' }];
    const text = persona.renderProfile({ column: 'Auditor', keys, login: null, catalogue: 'catalogue/grants.csv' });
    assert.match(text, /- — no seeded login recorded/);
    assert.match(text, /^## Keys held \(1\)$/m);
    assert.deepEqual(persona.checkProfile(text, { keys, login: null, citation: CITE }), []);
  });

  test('a refresh rewrites only the marker blocks and the count; drafted text survives, CRLF kept', () => {
    const existing = readFileSync(join(fixture, 'roles', 'store-manager.md'), 'utf8').replace(/\r?\n/g, '\r\n');
    const { keysFor } = persona.parseCatalogue(csv, opts);
    const out = persona.renderProfile({ column: 'Store Manager', keys: keysFor['Store Manager'], login: 'new login line', existing });
    assert.match(out, /Holds every store in the region, never another region — RULE-4/);
    assert.match(out, /^## Keys held \(4\)\r$/m);
    assert.match(out, /- `stock\.approve` — Approve an adjustment\r\n/);
    assert.match(out, /<!-- generated:login start -->\r\n- new login line\r\n<!-- generated:login end -->/);
    assert.equal(out.replace(/\r\n/g, '').includes('\n'), false, 'no bare LF introduced');
  });

  test('an existing file without its markers is not overwritten', () => {
    assert.equal(persona.renderProfile({ column: 'X', keys: [], existing: '# X\n\n- drafted — RULE-1\n' }), null);
  });

  test('check names held-but-unlisted and listed-but-not-held keys, the stale count, the login drift and an uncited bullet', () => {
    const keys = [{ key: 'stock.read', label: 'Read stock levels' }, { key: 'stock.approve', label: 'Approve an adjustment' }];
    let text = persona.renderProfile({ column: 'Clerk', keys, login: 'a login' });
    text = text
      .replace('- `stock.approve` — Approve an adjustment', '- `stock.delete` — Delete stock (added by hand)')
      .replace('- a login', '- another login')
      .replace('## Scope rules\n', '## Scope rules\n\n- May see every store\n1. May export — RULE-2\n');
    assert.deepEqual(persona.checkProfile(text, { keys, login: 'a login', citation: CITE }), [
      'key held by the catalogue column but not listed: stock.approve',
      'key listed but not held by the catalogue column: stock.delete',
      'login block differs from the seeded-login map — run persona-gen',
      'uncited line: - May see every store',
    ]);
  });

  test('a reordered keys block with the same keys is still drift', () => {
    const keys = [{ key: 'a.read', label: 'A' }, { key: 'b.read', label: 'B' }];
    const text = persona.renderProfile({ column: 'R', keys }).replace('- `a.read` — A\n- `b.read` — B', '- `b.read` — B\n- `a.read` — A');
    assert.deepEqual(persona.checkProfile(text, { keys, citation: CITE }), ['keys block differs from the generated text (labels, order or wording) — run persona-gen']);
  });

  test('the login map must be an object of single lines', () => {
    assert.deepEqual(persona.checkLoginsShape({ A: 'one line' }), []);
    assert.equal(persona.checkLoginsShape(['A']).length, 1);
    assert.deepEqual(persona.checkLoginsShape({ A: 'two\nlines', B: 3 }), ['logins.A: must be a non-empty single line', 'logins.B: must be a non-empty single line']);
  });
});

const cli = join(here, '..', 'tooling', 'experimental', 'persona-gen.mjs');
const run = (cwd, ...args) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });
const made = [];
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));
const copy = () => {
  const dir = mkdtempSync(join(tmpdir(), 'builder-personas-'));
  cpSync(fixture, dir, { recursive: true });
  made.push(dir);
  return dir;
};
const setProfile = (dir, personas) =>
  writeFileSync(join(dir, 'PIPELINE_PROFILE.md'), `\`\`\`json pipeline-settings\n${JSON.stringify({ schema: 2, features: { personas } })}\n\`\`\`\n`);
const BASE = { state: 'experimental-on', catalogue: 'catalogue/grants.csv', keyColumn: 'key', labelColumn: 'label', out: 'roles', logins: 'catalogue/logins.json', citationPattern: CITE.source };

describe('persona-gen — CLI on a fixture project', () => {
  test('--check on the untouched fixture fails: two missing profiles and the stale drafted one', () => {
    const r = run(copy(), '--check');
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /Stock Clerk: no profile at roles\/stock-clerk\.md/);
    assert.match(r.stdout, /Auditor \(read-only\): no profile at roles\/auditor-read-only\.md/);
    assert.match(r.stdout, /Store Manager: key held by the catalogue column but not listed: stock\.approve/);
    assert.match(r.stdout, /Store Manager: "Keys held \(3\)" — the column holds 4/);
    assert.match(r.stdout, /FAIL — 3 role column\(s\), 4 problem\(s\)/);
  });

  test('generate, then --check passes; drafted sections survive; a second run changes nothing', () => {
    const dir = copy();
    const g = run(dir);
    assert.equal(g.status, 0, g.stdout + g.stderr);
    assert.match(g.stdout, /3 role column\(s\) → roles\/ — 3 written, 0 unchanged, 0 refused \(2 with a seeded login\)/);
    const manager = readFileSync(join(dir, 'roles', 'store-manager.md'), 'utf8');
    assert.match(manager, /1\. May not approve an adjustment they raised — `docs\/rules\.md:31`/);
    assert.match(manager, /- `stock\.approve` — Approve an adjustment/);
    assert.match(readFileSync(join(dir, 'roles', 'auditor-read-only.md'), 'utf8'), /- — no seeded login recorded/);
    assert.equal(run(dir, '--check').status, 0);
    assert.match(run(dir).stdout, /0 written, 3 unchanged/);
  });

  test('red: a hand-added grant, an uncited bullet, a stray profile and a stale login entry each fail --check', () => {
    const dir = copy();
    run(dir);
    const clerk = join(dir, 'roles', 'stock-clerk.md');
    writeFileSync(clerk, readFileSync(clerk, 'utf8').replace('<!-- generated:keys end -->', '- `stock.approve` — Approve an adjustment\n<!-- generated:keys end -->'));
    appendFileSync(join(dir, 'roles', 'store-manager.md'), '\n- May approve anything under a threshold\n');
    writeFileSync(join(dir, 'roles', 'cashier.md'), '# Cashier\n');
    const logins = JSON.parse(readFileSync(join(dir, 'catalogue', 'logins.json'), 'utf8'));
    writeFileSync(join(dir, 'catalogue', 'logins.json'), JSON.stringify({ ...logins, Cashier: 'cashier@example.test' }));
    const r = run(dir, '--check');
    assert.equal(r.status, 1);
    assert.match(r.stdout, /Stock Clerk: key listed but not held by the catalogue column: stock\.approve/);
    assert.match(r.stdout, /Store Manager: uncited line: - May approve anything under a threshold/);
    assert.match(r.stdout, /cashier\.md: no role column in the catalogue matches this profile/);
    assert.match(r.stdout, /logins: "Cashier" names no role column/);
    assert.doesNotMatch(r.stdout, /README\.md/);
  });

  test('a profile that lost its markers is refused, not overwritten: exit 1', () => {
    const dir = copy();
    const file = join(dir, 'roles', 'store-manager.md');
    writeFileSync(file, '# Store Manager\n\n- drafted — RULE-1\n');
    const r = run(dir);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /roles\/store-manager\.md: a generated marker pair is missing — not overwritten/);
    assert.equal(readFileSync(file, 'utf8'), '# Store Manager\n\n- drafted — RULE-1\n');
  });

  test('zero role columns is refused with exit 2, and nothing is written', () => {
    const dir = copy();
    writeFileSync(join(dir, 'catalogue', 'grants.csv'), 'key,label,domain\nstock.read,Read,stock\n');
    rmSync(join(dir, 'roles'), { recursive: true });
    const r = run(dir, '--check');
    assert.equal(r.status, 2);
    assert.match(r.stderr, /zero role columns — a generator over nothing proves nothing/);
    assert.equal(run(dir).status, 2);
    assert.equal(existsSync(join(dir, 'roles')), false);
  });

  test('exit 2: a missing catalogue, an unknown explicit role column, a torn login map, an unknown flag', () => {
    const missing = copy();
    setProfile(missing, { ...BASE, catalogue: 'catalogue/nope.csv' });
    assert.match(run(missing).stderr, /no catalogue at catalogue\/nope\.csv/);
    const explicit = copy();
    setProfile(explicit, { ...BASE, roleColumns: ['Cashier'] });
    assert.equal(run(explicit).status, 2);
    const torn = copy();
    writeFileSync(join(torn, 'catalogue', 'logins.json'), '{ "Store Manager": ');
    assert.equal(run(torn).status, 2);
    assert.equal(run(copy(), '--fix').status, 2);
  });

  test('without a login map every role renders "no seeded login recorded"', () => {
    const dir = copy();
    rmSync(join(dir, 'roles', 'store-manager.md'));
    setProfile(dir, { ...BASE, logins: null });
    assert.equal(run(dir).status, 0);
    assert.match(readFileSync(join(dir, 'roles', 'stock-clerk.md'), 'utf8'), /<!-- generated:login start -->\n- — no seeded login recorded\n/);
  });

  test('not enabled prints its line, exit 0; enabled without citationPattern is an invalid profile, exit 2', () => {
    const off = copy();
    setProfile(off, { state: 'experimental-off' });
    const r = run(off, '--check');
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), 'personas: experimental — not enabled');
    const bad = copy();
    setProfile(bad, { ...BASE, citationPattern: null });
    const b = run(bad);
    assert.equal(b.status, 2);
    assert.match(b.stderr, /features\.personas\.citationPattern: required/);
  });
});
