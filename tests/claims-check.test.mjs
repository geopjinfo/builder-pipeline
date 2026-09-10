import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const { check } = require('../scripts/lib/claims-check.cjs');

// ── pure ────────────────────────────────────────────────────────────────────────────────────────────────────
const files = {
  'app/stock.py': ['"""doc"""', 'def reorder_level(item):', '    return item.minimum * 2', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'],
  'DECISIONS.md': ['# decisions'],
  'handoffs/2026-02-03-stock-levels-handoff.md': ['# pack'],
};
const fsProbe = { exists: (p) => p in files, lines: (p) => files[p] ?? null };
const ctx = (over = {}) => ({
  roots: ['app', 'tasks'],
  refRoots: ['DECISIONS.md', 'handoffs'],
  registryText: '| STK-D1 | stock-levels | … |\n| ~~STK-D2~~ | stock-levels | … |',
  retracted: [{ phrase: 'stock counts are cached', retractedBy: 'D-2 — counts are read live' }],
  claims: [],
  run: () => ({ status: 0, output: 'unit: 9 passed' }),
  ...over,
});
const doc = (text) => [{ name: 'tasks/stock-levels.md', text }];
const kinds = (problems) => problems.map((p) => p.kind);

describe('claims checker — pure', () => {
  test('a clean document passes', () => {
    assert.deepEqual(check(doc('evidence: `app/stock.py:2 «def reorder_level»` and STK-D1 is owed there'), fsProbe, ctx()), []);
  });

  test('red: a stale count — the command no longer prints the figure; the current figure passes', () => {
    const claim = { id: 'C1', text: 'unit 12/12', command: 'run unit', expect: '\\b12 passed' };
    assert.deepEqual(kinds(check(doc(''), fsProbe, ctx({ claims: [claim] }))), ['count']);
    assert.deepEqual(check(doc(''), fsProbe, ctx({ claims: [{ ...claim, expect: '\\b9 passed' }] })), []);
    assert.deepEqual(kinds(check(doc(''), fsProbe, ctx({ claims: [{ ...claim, expect: '(' }] }))), ['count']);
  });

  test('red: a drifted anchor — the snippet is no longer within two lines; small drift is tolerated', () => {
    assert.deepEqual(kinds(check(doc('see `app/stock.py:9 «def reorder_level»`'), fsProbe, ctx())), ['citation']);
    assert.deepEqual(check(doc('see `app/stock.py:3 «def reorder_level»`'), fsProbe, ctx()), []);
  });

  test('red: a line past the end of the file, and a range past it', () => {
    const problems = check(doc('app/stock.py:40 and app/stock.py:9-11'), fsProbe, ctx());
    assert.deepEqual(kinds(problems), ['citation', 'citation']);
    assert.match(problems[0].detail, /the file has 10 lines/);
  });

  test('red: a citation to a file that does not exist', () => {
    const problems = check(doc('see app/gone.py:3'), fsProbe, ctx());
    assert.deepEqual(kinds(problems), ['citation']);
    assert.match(problems[0].detail, /does not exist/);
  });

  test('templates, elided paths and paths outside the citation roots are not citations', () => {
    assert.deepEqual(check(doc('see app/<module>/x.py:3, app/.../stock.py:537 and vendor/lib.py:9'), fsProbe, ctx()), []);
    assert.deepEqual(check(doc('app/gone.py:3'), fsProbe, ctx({ roots: [] })), [], 'no roots → no citation check, never a match-everything pattern');
  });

  test('red: a retracted phrase asserted in plain prose', () => {
    const problems = check(doc('reminder: stock counts are cached for a minute'), fsProbe, ctx());
    assert.deepEqual(kinds(problems), ['retracted']);
    assert.match(problems[0].detail, /retracted by D-2/);
  });

  test('a retracted phrase QUOTED, or on a line naming the id that retracted it, is a mention', () => {
    assert.deepEqual(check(doc('the stale "stock counts are cached" note is gone'), fsProbe, ctx()), []);
    assert.deepEqual(check(doc('D-2 replaced the rule that stock counts are cached'), fsProbe, ctx()), []);
    // a different id does not excuse it — the id must be the one that retracted the phrase
    assert.deepEqual(kinds(check(doc('D-22 says stock counts are cached'), fsProbe, ctx())), ['retracted']);
  });

  test('retracted phrases not configured (null) skips that check', () => {
    assert.deepEqual(check(doc('stock counts are cached'), fsProbe, ctx({ retracted: null })), []);
  });

  test('red: an "owed" or NEEDS-RULING with nowhere it is owed', () => {
    assert.deepEqual(kinds(check(doc('the alert wording is owed'), fsProbe, ctx())), ['owed']);
    assert.deepEqual(kinds(check(doc('NEEDS-RULING: who may override a reorder'), fsProbe, ctx())), ['owed']);
    assert.deepEqual(kinds(check(doc('owed: handoffs/2026-02-03-missing-handoff.md'), fsProbe, ctx())), ['owed'], 'a decision file that does not exist');
    assert.deepEqual(kinds(check(doc('owed to handoffs'), fsProbe, ctx())), ['owed'], 'a bare folder names no file');
    assert.deepEqual(kinds(check(doc('owed: STK-D9'), fsProbe, ctx())), ['owed'], 'a registry id with no row');
  });

  test('resolved forms pass: a decision-workspace file, a handoff file, a registry id (struck through too), a handoff §', () => {
    assert.deepEqual(check(doc('NEEDS-RULING — filed in DECISIONS.md'), fsProbe, ctx()), []);
    assert.deepEqual(check(doc('owed: handoffs/2026-02-03-stock-levels-handoff.md'), fsProbe, ctx()), []);
    assert.deepEqual(check(doc('owed: STK-D1'), fsProbe, ctx()), []);
    assert.deepEqual(check(doc('owed: STK-D2'), fsProbe, ctx()), []);
    assert.deepEqual(check(doc('owed to the decision workspace — handoff §E'), fsProbe, ctx()), []);
    assert.deepEqual(check(doc('### NEEDS-RULING (3)'), fsProbe, ctx()), []);
  });

  test('the term quoted, a negation, and a registry row carrying its own id are not owed notes', () => {
    assert.deepEqual(check(doc('every `NEEDS-RULING` / "owed" note resolves to an id'), fsProbe, ctx()), []);
    assert.deepEqual(check(doc('no new deferral is owed by this pass'), fsProbe, ctx()), []);
    assert.deepEqual(check(doc('| STK-D1 | stock-levels | the ruling is owed |'), fsProbe, ctx()), []);
  });

  test('the registry id shape comes from the settings', () => {
    const custom = ctx({ registryIdPattern: 'INV-\\d+', registryText: '| INV-4 | stock-levels | … |' });
    assert.deepEqual(check(doc('owed: INV-4'), fsProbe, custom), []);
    assert.deepEqual(kinds(check(doc('owed: STK-D1'), fsProbe, custom)), ['owed']);
  });
});

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────────────────────
const cli = join(here, '..', 'scripts', 'claims-check.mjs');
const made = [];
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));
const project = () => {
  const dir = mkdtempSync(join(tmpdir(), 'builder-claims-'));
  cpSync(join(here, 'fixtures', 'claims', 'project'), dir, { recursive: true });
  made.push(dir);
  return dir;
};
const run = (cwd, ...args) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });
const settings = (claims) => ({
  schema: 2,
  paths: { boards: 'tasks', registry: 'DEFERRED_TASKS.md', runs: '.pipeline', decisions: 'DECISIONS.md', handoffs: 'handoffs', logs: 'logs', citationRoots: ['app', 'tasks'] },
  features: { claims },
});
const writeProfile = (dir, obj) =>
  writeFileSync(join(dir, 'PIPELINE_PROFILE.md'), `# profile\n\n\`\`\`json pipeline-settings\n${JSON.stringify(obj, null, 2)}\n\`\`\`\n`);

describe('claims checker — CLI on a fixture project', () => {
  test('--run reads the board, plan, state, handoff and claims file, re-runs the count, and passes', () => {
    const r = run(project(), '--run', 'stock-levels');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /4 document\(s\), 1 count claim\(s\), citation roots: app, tasks/); // board, plan, state, handoff
    assert.match(r.stdout, /retracted phrases: 1/);
    assert.match(r.stdout, /claims-check: PASS/);
  });

  test('red: an unresolved owed note in the board fails with exit 1', () => {
    const dir = project();
    appendFileSync(join(dir, 'tasks', 'stock-levels.md'), '- The reorder job is owed.\n');
    const r = run(dir, '--run', 'stock-levels');
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /OWED\s+tasks\/stock-levels\.md:\d+/);
  });

  test('red: a stale count in claims.jsonl fails; --no-run-counts skips it', () => {
    const dir = project();
    writeFileSync(join(dir, '.pipeline', 'stock-levels', 'claims.jsonl'), `${JSON.stringify({ id: 'C1', text: 'unit 12 passed', command: 'node -e "console.log(\'9 passed\')"', expect: '\\b12 passed' })}\n`);
    const r = run(dir, '--run', 'stock-levels');
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /COUNT\s+claims\.jsonl C1/);
    assert.equal(run(dir, '--run', 'stock-levels', '--no-run-counts').status, 0);
  });

  test('retracted phrases not configured is said, and the check is skipped', () => {
    const dir = project();
    writeProfile(dir, settings({ state: 'on', retracted: null }));
    appendFileSync(join(dir, 'tasks', 'stock-levels.md'), '- stock counts are cached\n');
    const r = run(dir, '--run', 'stock-levels');
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /retracted phrases: not configured/);
  });

  test('empty citation roots fall back to the top-level directories present, never dot-directories', () => {
    const dir = project();
    const s = settings({ state: 'on', retracted: 'retracted-phrases.json' });
    s.paths.citationRoots = [];
    writeProfile(dir, s);
    const r = run(dir, '--run', 'stock-levels');
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /citation roots: app, handoffs, tasks$/m);
  });

  test('the feature off prints "claims: not configured" and exits 0', () => {
    const dir = project();
    writeProfile(dir, settings({ state: 'off' }));
    appendFileSync(join(dir, 'tasks', 'stock-levels.md'), '- The reorder job is owed.\n');
    const r = run(dir, '--run', 'stock-levels');
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), 'claims: not configured');
  });

  test('usage error exits 2', () => {
    assert.equal(run(project()).status, 2);
  });
});
