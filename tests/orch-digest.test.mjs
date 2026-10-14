/**
 * Batch orchestrator — plan intake (scripts/lib/orch-digest.cjs, `orch digest`). What an artifact states is kept;
 * what the digest infers is ⚠ CONFIRM; every unused line is listed under Unmapped; split refuses while a CONFIRM is
 * open. Every guard has a red case.
 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { orch, profileText, tmp } from './fixtures/orch/rig.mjs';

const require = createRequire(import.meta.url);
const digest = require('../scripts/lib/orch-digest.cjs');
const plan = require('../scripts/lib/orch-plan.cjs');

const opts = { source: 'artifact.md', run: 'r1', roots: ['src', 'test', 'tasks'], modules: ['payments', 'inbox'], modulesDir: 'src/modules', exists: () => true };
const row = (res, id) => res.rows.find((r) => r.id === id);

describe('a table artifact', () => {
  const md = ['# Q4 tidy-up', '', '## Work', '| ID | Task | Kind | Files | Depends on |', '|---|---|---|---|---|',
    '| T1 | Refund verb | build | `src/modules/payments/**`; `CHANGELOG.md` | - |',
    '| T2 | Refund report | build | src/modules/payments/reports/refunds.ts | T1 |'].join('\n');

  test('keeps ids, titles, files and dependencies; a stated kind needs no confirm', () => {
    const res = digest.digest(md, opts);
    assert.deepEqual(res.rows.map((r) => r.id), ['T1', 'T2']);
    assert.equal(row(res, 'T1').title, 'Refund verb');
    assert.deepEqual(row(res, 'T1').files, ['src/modules/payments/**', 'CHANGELOG.md']);
    assert.deepEqual(row(res, 'T2').dependsOn, ['T1']);
    assert.deepEqual(row(res, 'T1').confirm.filter((c) => /^(kind|files)/.test(c)), []);
  });

  test('red: a flag inferred from the words ("refund" = money) is marked CONFIRM', () => {
    const res = digest.digest(md, opts);
    assert.ok(row(res, 'T1').flags.includes('money'));
    assert.ok(row(res, 'T1').confirm.some((c) => /^flags: money inferred/.test(c)));
  });

  test('the rendered plan parses and splits once every CONFIRM is resolved', () => {
    const res = digest.digest(md, opts);
    const resolved = res.markdown.replace(/\| [^|\n]*⚠[^|\n]* \|\n/g, '| |\n');
    assert.doesNotThrow(() => plan.split(resolved));
  });

  test('red: a row whose status says DONE / Dropped goes to Unmapped, not to Rows', () => {
    const t = ['## Work', '| # | Task | Status | Files |', '|---|---|---|---|', '| T1 | Old | DONE | tasks/a.md |', '| T2 | Gone | Dropped | tasks/b.md |', '| T3 | Live | PLANNED | tasks/c.md |'].join('\n');
    const res = digest.digest(t, opts);
    assert.deepEqual(res.rows.map((r) => r.id), ['T3']);
    assert.ok(res.unmapped.some((u) => /^\(status DONE\) \| T1/.test(u.text)));
    assert.ok(res.unmapped.some((u) => /^\(status Dropped\) \| T2/.test(u.text)));
  });
});

describe('a bullet artifact', () => {
  const md = ['# Plan for the inbox', '', 'Some background prose that is not a task.', '', '## Tasks',
    '- [ ] **A-1** — Inbox labels show the project name (`src/modules/inbox/inbox.mapper.ts`)',
    '- A-2: Fix the broken currency label in payments, after A-1',
    '- Add a permission for archiving projects', '', '## Risks', '- The FX feed may lag.'].join('\n');
  const res = digest.digest(md, opts);

  test('id-prefixed bullets and plain bullets under a task heading become rows; plain ones get generated ids', () => {
    assert.deepEqual(res.rows.map((r) => r.id), ['A-1', 'A-2', 'D1']);
    assert.deepEqual(row(res, 'A-1').files, ['src/modules/inbox/inbox.mapper.ts']);
    assert.deepEqual(row(res, 'A-2').dependsOn, ['A-1']);
  });

  test('red: an inferred kind and a module-name file guess are both CONFIRM', () => {
    assert.equal(row(res, 'A-2').kind, 'fix');
    assert.ok(row(res, 'A-2').confirm.some((c) => /^kind: fix inferred/.test(c)));
    assert.ok(row(res, 'A-2').confirm.some((c) => /^files: src\/modules\/payments\/\*\* inferred from "payments"/.test(c)));
  });

  test('red: a task naming no file and no module gets files ⚠ CONFIRM, and split refuses the plan', () => {
    assert.deepEqual(row(res, 'D1').files, [digest.CONFIRM]);
    assert.ok(row(res, 'D1').flags.includes('permission'));
    assert.throws(() => plan.split(res.markdown), /still ⚠ CONFIRM/);
  });

  test('red: prose and bullets that did not become rows are listed under Unmapped — nothing dropped silently', () => {
    const texts = res.unmapped.map((u) => u.text);
    assert.ok(texts.includes('Some background prose that is not a task.'));
    assert.ok(texts.includes('- The FX feed may lag.'));
    assert.match(res.markdown, /## Unmapped\n[\s\S]*L3: Some background prose/);
  });

  test('red: a named path that does not exist is CONFIRM (a new file, or a typo?)', () => {
    const r2 = digest.digest(md, { ...opts, exists: (p) => p !== 'src/modules/inbox/inbox.mapper.ts' });
    assert.ok(row(r2, 'A-1').confirm.some((c) => /^files: src\/modules\/inbox\/inbox\.mapper\.ts does not exist/.test(c)));
  });

  test('red: with no modulesDir configured, a module name infers nothing', () => {
    const r3 = digest.digest(md, { ...opts, modulesDir: null });
    assert.deepEqual(row(r3, 'A-2').files, [digest.CONFIRM]);
  });
});

describe('HTML artifacts, the check and the CLI', () => {
  test('list items are read out of HTML', () => {
    const html = '<html><body><h1>Plan</h1><h2>Tasks</h2><ul><li>B-7: Projects archive verb &amp; its audit (<code>src/modules/projects/**</code>)</li></ul><p>Notes here.</p></body></html>';
    const res = digest.digest(html, { ...opts, source: 'plan.html' });
    assert.equal(row(res, 'B-7').title, 'Projects archive verb & its audit');
    assert.deepEqual(row(res, 'B-7').files, ['src/modules/projects/**']);
    assert.ok(res.unmapped.map((u) => u.text).includes('Notes here.'));
  });

  test('red: check counts open CONFIRMs and is clean when none remain', () => {
    const res = digest.digest('## Tasks\n- Z-1: something vague\n', opts);
    assert.ok(digest.check(res.markdown).open > 0);
    const clean = '## Rows\n| id | title | kind | files | depends-on | flags | confirm |\n|---|---|---|---|---|---|---|\n| Z-1 | x | record | tasks/z.md | - | record-only | |\n';
    assert.deepEqual(digest.check(clean), { rows: 1, open: 0, items: [] });
  });

  test('red: the CLI writes the plan (exit 10 while CONFIRMs are open), and orch split refuses it', () => {
    const dir = tmp('digest');
    writeFileSync(join(dir, 'PIPELINE_PROFILE.md'), profileText());
    writeFileSync(join(dir, 'plan.md'), '# P\n## Tasks\n- C-1: Payments refund verb\n');
    const root = join(dir, 'orch');
    const outFile = join(dir, 'out.plan.md');
    const d = orch(dir, root, ['digest', join(dir, 'plan.md'), '--out', outFile, '--run', 'r9']);
    assert.equal(d.status, 10, d.out);
    assert.match(d.stdout, /wrote .*out\.plan\.md · 1 row\(s\) · \d+ ⚠ CONFIRM/);
    const c = orch(dir, root, ['digest', '--check', outFile]);
    assert.equal(c.status, 10);
    const s = orch(dir, root, ['split', outFile]);
    assert.notEqual(s.status, 0);
    assert.match(s.out, /still ⚠ CONFIRM/);
  });
});
