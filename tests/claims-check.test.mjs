import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const { check, lockClass, makeRunner } = require('../scripts/lib/claims-check.cjs');

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

  test('red: a bare-number expect must be a whole output line, not any digit in the output', () => {
    const claim = { id: 'C1', text: '1 row', command: 'count rows', expect: '1' };
    const missing = () => ({ status: 1, output: "cat: logs/2026-10-14.log: No such file or directory\n10" });
    assert.deepEqual(kinds(check(doc(''), fsProbe, ctx({ claims: [claim], run: missing }))), ['count']);
    assert.deepEqual(check(doc(''), fsProbe, ctx({ claims: [claim], run: () => ({ status: 0, output: 'rows:\n 1 \n' }) })), []);
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

// ── the COUNT runner: output streams + tier lock ────────────────────────────────────────────────────────────
describe('claims checker — makeRunner', () => {
  const tierLock = require('../examples/jest-tier-runner/tier-lock.cjs');
  const lockDir = mkdtempSync(join(tmpdir(), 'builder-claims-lock-'));
  after(() => rmSync(lockDir, { recursive: true, force: true }));
  const lockPath = join(lockDir, 'tier.lock');
  const ok = (stdout, stderr = '') => () => ({ status: 0, stdout, stderr });

  test('red: a figure printed to stderr on exit 0 is seen (jest prints its Tests: line there)', () => {
    const run = makeRunner({ exec: ok('', 'Tests:       12 passed, 12 total\n'), lock: null });
    const claim = { id: 'C1', text: '12 passed', command: 'npx jest', expect: '\\b12 passed' };
    assert.deepEqual(check(doc(''), fsProbe, ctx({ claims: [claim], run })), []);
  });

  test('red: two claims naming the same command spawn it once and share its output', () => {
    let calls = 0;
    const exec = () => {
      calls += 1;
      return { status: 0, stdout: '', stderr: 'Tests:       12 passed, 12 total\n' };
    };
    const run = makeRunner({ exec, lock: null });
    const claims = [
      { id: 'C1', text: '12 passed', command: 'npx jest', expect: '\\b12 passed' },
      { id: 'C2', text: '12 total', command: 'npx jest', expect: '\\b12 total' },
    ];
    assert.deepEqual(check(doc(''), fsProbe, ctx({ claims, run })), []);
    assert.equal(calls, 1);
  });

  test('lockClass: direct is tested first over a compound command; npm run tier:<x> is not the wrapper', () => {
    assert.equal(lockClass('npx jest -c test/jest.integration.config.cjs'), 'direct');
    assert.equal(lockClass('npm run test:e2e'), 'direct');
    assert.equal(lockClass('npm run test:e2e:drift'), 'none');
    assert.equal(lockClass('npm run tier -- integration'), 'wrapped');
    assert.equal(lockClass('node scripts/run-tier.mjs unit'), 'wrapped');
    assert.equal(lockClass('npm run tier:remote -- unit'), 'none');
    assert.equal(lockClass('npm run tier -- unit && npm run test:integration'), 'direct');
    assert.equal(lockClass('node -e "1"'), 'none');
  });

  test('a direct command runs under the lock and releases it', () => {
    let sawLock = false;
    const run = makeRunner({ lock: tierLock, lockPath, exec: () => ((sawLock = existsSync(lockPath)), { status: 0, stdout: 'ok', stderr: '' }) });
    assert.deepEqual(run('npm run test:integration', { id: 'C1' }), { status: 0, output: 'ok' });
    assert.equal(sawLock, true);
    assert.equal(existsSync(lockPath), false);
  });

  test('red: while a live run holds the lock, direct and wrapped claims are refused and reported, never passed', () => {
    const held = tierLock.acquire('integration', { lockPath });
    try {
      let ran = 0;
      const run = makeRunner({ lock: tierLock, lockPath, exec: () => (ran++, { status: 0, stdout: '12 passed', stderr: '' }) });
      assert.equal(run('npm run test:integration', { id: 'C1' }).refused, true);
      assert.equal(run('npm run tier -- integration', { id: 'C2' }).refused, true);
      assert.equal(run('node -e "1"', { id: 'C3' }).refused, undefined); // unrelated commands still run
      assert.equal(ran, 1);
      const claim = { id: 'C1', text: '12 passed', command: 'npm run test:integration', expect: '12 passed' };
      const problems = check(doc(''), fsProbe, ctx({ claims: [claim], run }));
      assert.deepEqual(kinds(problems), ['count']);
      assert.match(problems[0].detail, /not run: BUSY/);
    } finally {
      held.release();
    }
  });

  test('no lock installed (lock: null): every command runs unlocked', () => {
    let ran = 0;
    const run = makeRunner({ lock: null, exec: () => (ran++, { status: 0, stdout: 'x', stderr: '' }) });
    run('npm run test:integration', { id: 'C1' });
    run('npm run tier -- e2e', { id: 'C2' });
    assert.equal(ran, 2);
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

describe('claims checker — extended checks (UNANCHORED, NAMED), off by default', () => {
  const testFile = { 'app/test_stock.py': ['def test_reorder_level_doubles_the_minimum():', '    """reorder level is twice the `minimum`"""', '    assert True'] };
  const probe = { exists: (p) => p in testFile, lines: (p) => testFile[p] ?? null };
  const board = (status, evidence) =>
    `| # | Task | Cites | Status | Test-seed / evidence | Notes |\n|---|---|---|---|---|---|\n| T1 | Reorder level | REQ-1 | ${status} | ${evidence} | — |`;
  const kinds = (status, evidence, extended = true) =>
    check([{ name: 'tasks/stock-levels.md', text: board(status, evidence) }], probe, { roots: [], refRoots: [], registryText: '', retracted: null, claims: [], run: () => ({ status: 0, output: '' }), extended }).map((p) => p.kind);

  test('without extended, neither check runs even on a row both would flag', () => {
    assert.deepEqual(kinds('DONE', 'all green 16/16; title "nothing like it"', false), []);
  });
  test('red: an unanchored count in DONE evidence', () => {
    assert.deepEqual(kinds('DONE', 'all green 16/16'), ['unanchored']);
  });
  test('a count beside a file, a backticked command, a script name or a logs/ path is anchored', () => {
    assert.deepEqual(kinds('DONE', '`app/test_stock.py` 3/3'), []);
    assert.deepEqual(kinds('DONE', '`pytest -q app` 3/3'), []);
    assert.deepEqual(kinds('DONE', 'test:unit 3/3'), []);
    assert.deepEqual(kinds('DONE', 'logs/unit.log 3/3'), []);
  });
  test('HTTP codes with spaces are not counts, and only DONE rows are read', () => {
    assert.deepEqual(kinds('DONE', 'answers 404 / 409'), []);
    assert.deepEqual(kinds('PLANNED', 'aim for 16/16'), []);
  });
  test('red: a cited test name absent from every cited file; present, elided or re-quoted it passes', () => {
    assert.deepEqual(kinds('DONE', "`app/test_stock.py` test 'reorder level is three times the minimum'"), ['named']);
    assert.deepEqual(kinds('DONE', "`app/test_stock.py` test 'reorder level is twice the minimum'"), []);
    assert.deepEqual(kinds('DONE', "`app/test_stock.py` test 'reorder level … minimum'"), []);
    assert.deepEqual(kinds('DONE', "`app/test_stock.py` test 'reorder level … maximum'"), ['named']);
  });
  test('a table without an evidence column is skipped', () => {
    const bare = '| # | Task | Status |\n|---|---|---|\n| T1 | Reorder level 16/16 | DONE |';
    assert.deepEqual(check([{ name: 'tasks/x.md', text: bare }], probe, { roots: [], refRoots: [], registryText: '', retracted: null, claims: [], run: () => ({}), extended: true }), []);
  });
});
