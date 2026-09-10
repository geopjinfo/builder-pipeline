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
const { checkPlan, checkFindings, checkReview, csvCells, csvColumn, REVIEW_SECTIONS } = require('../scripts/lib/output-check.cjs');
const profile = require('../scripts/lib/profile.cjs');

const fixture = join(here, 'fixtures', 'outputs', 'project');
const read = (...p) => readFileSync(join(fixture, ...p), 'utf8').replace(/\r\n/g, '\n');
const { settings } = profile.parse(read('PIPELINE_PROFILE.md'));
const planConfig = profile.feature(settings, 'planSchema').config;
const oracleKeys = csvColumn(read('access-keys.csv'), 'key');
const schema = (over = {}) => ({ ...planConfig, oracleKeys, ...over });
const plan = read('.pipeline', 'stock-levels', 'plan.md');
const findings = JSON.parse(read('.pipeline', 'stock-levels', 'findings-security.json'));
const review = read('.pipeline', 'stock-levels', 'review-pass1.md');

describe('plan', () => {
  test('a well-formed plan passes against the profile schema and the oracle', () => {
    assert.deepEqual(checkPlan(plan, schema()), []);
  });

  test('red: a missing section', () => {
    assert.ok(checkPlan(plan.replace('## 1. Context', '## 1. Background'), schema()).includes('missing section: Context'));
    assert.ok(checkPlan(plan.replace('## 3. Tasks', '## 3. Tasksets'), schema()).includes('missing section: Tasks'), 'a section name must end at a word boundary');
  });

  test('red: a wrong fixed table header', () => {
    const errors = checkPlan(plan.replace('| Method | Path | Access key | Handler |', '| Verb | Route | Key | Handler |'), schema());
    assert.ok(errors.some((e) => e.startsWith('no interfaces table with the fixed header')), errors.join('\n'));
  });

  test('red: an oracle key not in the CSV — never invent a key', () => {
    const errors = checkPlan(plan.replace('`stock.reorder`', '`stock.approve`'), schema());
    assert.ok(errors.some((e) => /Access key "stock\.approve" is not in the oracle — never invent a key/.test(e)), errors.join('\n'));
    assert.ok(checkPlan(plan.replace('`stock.reorder`', ''), schema()).some((e) => /no Access key/.test(e)));
  });

  test('red: an oracle pointing at a table or column the schema does not have', () => {
    assert.ok(checkPlan(plan, schema({ oracle: { table: 'routes', column: 'Access key' } })).some((e) => e.startsWith('oracle: features.planSchema.tables has no "routes"')));
    assert.ok(checkPlan(plan, schema({ oracle: { table: 'interfaces', column: 'Scope' } })).some((e) => e.includes('has no "Scope" column')));
  });

  test('red: a Tasks table without its test-seed and cites columns, and a blocker class left unnamed', () => {
    assert.ok(checkPlan(plan.replace('| # | Task | Cites | Test-seed |', '| # | Task |'), schema()).some((e) => e.startsWith('no Tasks table with columns')));
    assert.deepEqual(checkPlan(plan.replace('| # | Task | Cites | Test-seed |', '| # | Task |'), schema({ taskColumns: [] })), []);
    assert.ok(checkPlan(plan.replace('### NEEDS-RULING', '### OPEN'), schema()).some((e) => e.includes('NEEDS-RULING class')));
  });

  test('the CSV reader honours quoted commas and refuses an absent key column', () => {
    assert.deepEqual(csvCells('stock.read,"read stock levels, per item"'), ['stock.read', 'read stock levels, per item']);
    assert.throws(() => csvColumn('id,name\n1,x', 'key'), /no "key" column/);
  });
});

describe('findings', () => {
  const ctx = { exists: () => true, diffFiles: new Set(['app/stock.py']) };

  test('a well-formed findings file passes', () => {
    assert.deepEqual(checkFindings(findings, ctx), []);
  });

  test('red: no evidence', () => {
    const bad = { ...findings, findings: [{ ...findings.findings[0], evidence: '' }] };
    assert.ok(checkFindings(bad, ctx).includes('findings[0] (S-1).evidence: required, non-empty'));
  });

  test('red: a location that is not file:line, and one whose file is gone', () => {
    const bad = { ...findings, findings: [{ ...findings.findings[0], location: 'the stock service' }] };
    assert.ok(checkFindings(bad, ctx).some((e) => /location: must be file:line, got "the stock service"/.test(e)));
    assert.ok(checkFindings(findings, { ...ctx, exists: () => false }).some((e) => /the file does not exist/.test(e)));
  });

  test('red: PASS over a blocker', () => {
    assert.ok(checkFindings({ ...findings, verdict: 'PASS' }, ctx).includes('verdict PASS with a blocker finding'));
    assert.deepEqual(checkFindings({ ...findings, verdict: 'PASS-WITH-RULINGS', findings: [{ ...findings.findings[0], severity: 'warning' }] }, ctx), []);
  });

  test('red: filesTouched outside the git diff (the diff set is injected)', () => {
    const errors = checkFindings({ ...findings, filesTouched: ['app/stock.py', 'app/never_changed.py'] }, ctx);
    assert.deepEqual(errors, ['filesTouched: "app/never_changed.py" is not in the git diff — a claimed change nobody can see']);
  });

  test('red: a bad severity, a duplicate id, a malformed commands list, not an object', () => {
    const f = findings.findings[0];
    const errors = checkFindings({ ...findings, findings: [{ ...f, severity: 'major' }, f], commands: [{ cmd: 'x' }] }, ctx);
    assert.ok(errors.some((e) => e.endsWith('severity: one of blocker | warning | nit')));
    assert.ok(errors.some((e) => e.endsWith('.id: duplicate')));
    assert.ok(errors.some((e) => e.startsWith('commands:')));
    assert.deepEqual(checkFindings([]), ['not a JSON object']);
  });
});

describe('review', () => {
  test('a well-formed review passes, with LF or CRLF line endings', () => {
    assert.deepEqual(checkReview(review), []);
    assert.deepEqual(checkReview(review.replace(/\n/g, '\r\n')), []);
  });

  test('red: a missing section, and one out of order', () => {
    assert.ok(checkReview(review.replace('## Loop-back list\n', '')).includes('missing section: ## Loop-back list'));
    const swapped = review.replace('## Readiness', '## TMP').replace('## Invariant candidates', '## Readiness').replace('## TMP', '## Invariant candidates');
    assert.ok(checkReview(swapped).some((e) => e.startsWith('section out of order')), checkReview(swapped).join('\n'));
  });

  test('red: a finding heading without a file:line, or without a severity', () => {
    assert.ok(checkReview(review.replace(' · `app/stock.py:3`', '')).some((e) => e.startsWith('finding heading needs a severity and a file:line')));
    assert.ok(checkReview(review.replace('N-1 · NIT ·', 'N-1 ·')).some((e) => e.startsWith('finding heading needs')));
  });

  test('red: MERGE-READY over a BLOCKER, and a wrong title', () => {
    assert.ok(checkReview(review.replace('**CHANGES-REQUIRED**', '**MERGE-READY**')).includes('MERGE-READY with a BLOCKER finding'));
    assert.ok(checkReview(review.replace('— review pass 1', '— review')).some((e) => e.startsWith('title:')));
  });

  test('the shipped review template carries exactly the sections the checker enforces, and passes once filled', () => {
    const template = readFileSync(join(here, '..', 'skills', 'references', 'review-template.md'), 'utf8').replace(/\r\n/g, '\n');
    const headings = template.split('\n').filter((l) => /^## /.test(l)).map((l) => l.slice(3).trim());
    assert.deepEqual(headings, REVIEW_SECTIONS);
    const filled = template
      .replace(/<moduleKey>/g, 'stock-levels')
      .replace(/<n>/g, '1')
      .replace('**MERGE-READY** | **CHANGES-REQUIRED**', '**CHANGES-REQUIRED**')
      .replace(/:NN/g, ':3');
    assert.deepEqual(checkReview(filled), []);
  });
});

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────────────────────
const cli = join(here, '..', 'scripts', 'output-check.mjs');
const made = [];
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));
const project = () => {
  const dir = mkdtempSync(join(tmpdir(), 'builder-outputs-'));
  cpSync(fixture, dir, { recursive: true });
  made.push(dir);
  return dir;
};
const run = (cwd, ...args) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });

describe('output-check — CLI on a fixture project', () => {
  test('plan, findings and review pass', () => {
    const dir = project();
    for (const [kind, file] of [
      ['plan', '.pipeline/stock-levels/plan.md'],
      ['findings', '.pipeline/stock-levels/findings-security.json'],
      ['review', '.pipeline/stock-levels/review-pass1.md'],
    ]) {
      const r = run(dir, kind, file);
      assert.equal(r.status, 0, `${kind}: ${r.stdout}${r.stderr}`);
      assert.match(r.stdout, new RegExp(`${kind}-check: PASS`));
    }
  });

  test('red: an invented key fails through the CLI, reading the oracle CSV from the profile', () => {
    const dir = project();
    const p = join(dir, '.pipeline', 'stock-levels', 'plan.md');
    writeFileSync(p, readFileSync(p, 'utf8').replace('`stock.reorder`', '`stock.approve`'));
    const r = run(dir, 'plan', '.pipeline/stock-levels/plan.md');
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /never invent a key/);
  });

  test('red: a configured oracle whose source is missing fails rather than skipping', () => {
    const dir = project();
    rmSync(join(dir, 'access-keys.csv'));
    const r = run(dir, 'plan', '.pipeline/stock-levels/plan.md');
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /oracle: source access-keys\.csv does not exist/);
  });

  test('a feature off prints "<name>: not configured" and exits 0', () => {
    const dir = project();
    writeFileSync(join(dir, 'PIPELINE_PROFILE.md'), '```json pipeline-settings\n{ "schema": 2, "features": { "reviewTemplate": { "state": "off" } } }\n```\n');
    const r = run(dir, 'review', '.pipeline/stock-levels/does-not-matter.md');
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), 'reviewTemplate: not configured');
  });

  test('usage error exits 2', () => {
    assert.equal(run(project(), 'essay', 'x.md').status, 2);
  });
});
