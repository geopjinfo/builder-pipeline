/**
 * REQ-2001 to REQ-2010 — pipeline sizing (specs/pipeline-sizing.spec.md). The SMALL track, the foreground rule, the
 * unattended mode and the report header in the skill text; the `Human:` and `Size hint:` lines of the brief; and
 * `track-check`, the free check that counts the production source files and modules changed since a base commit.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const PACK = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(PACK, rel), 'utf8');
const SKILL = read('skills/build-module-pipeline.md');
const REF_PATH = 'skills/references/sizing.md';
const REF = existsSync(join(PACK, REF_PATH)) ? read(REF_PATH) : '';
const BOTH = `${SKILL}\n${REF}`;
const made = [];
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

const git = (cwd, ...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
const write = (dir, rel, text) => {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
};
/** A repository with one base commit: two modules under src/, a test, a doc and a package.json. Returns { dir, base }. */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'track-check-'));
  made.push(dir);
  git(dir, 'init', '-q');
  write(dir, 'src/report/a.ts', 'export const a = 1;\n');
  write(dir, 'src/report/b.ts', 'export const b = 1;\n');
  write(dir, 'src/api/x.ts', 'export const x = 1;\n');
  write(dir, 'src/jobs/y.ts', 'export const y = 1;\n');
  write(dir, 'test/report.test.ts', 'test("a", () => {});\n');
  write(dir, 'README.md', '# t\n');
  write(dir, 'package.json', JSON.stringify({ name: 't', version: '1.0.0', dependencies: { left: '1.0.0' } }, null, 2) + '\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  const base = git(dir, 'rev-parse', 'HEAD').stdout.trim();
  return { dir, base };
}
const run = (cwd, args = []) => spawnSync(process.execPath, [join(PACK, 'scripts', 'track-check.mjs'), ...args], { cwd, encoding: 'utf8' });

describe('REQ-2008 — track-check counts the production source files and modules changed since a base', () => {
  test('red: AC-2008a two files under src/report/ plus a test file and a doc → SMALL: 2 source files in 1 module, exit 0', () => {
    const { dir, base } = repo();
    write(dir, 'src/report/a.ts', 'export const a = 2;\n');
    write(dir, 'src/report/c.ts', 'export const c = 1;\n'); // new, untracked: still a changed source file
    write(dir, 'test/report.test.ts', 'test("a", () => {});\ntest("c", () => {});\n');
    write(dir, 'README.md', '# t\n\nmore\n');
    const r = run(dir, ['--since', base]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.stdout.trim(), 'SMALL: 2 source files in 1 module');
  });

  test('red: AC-2008b five source files → ESCALATE: 5 source files changed, limit 4, exit 1', () => {
    const { dir, base } = repo();
    for (const n of ['a', 'b', 'c', 'd', 'e']) write(dir, `src/report/${n}.ts`, `export const ${n} = 9;\n`);
    const r = run(dir, ['--since', base]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /^ESCALATE: 5 source files changed, limit 4$/m);
  });

  test('red: --max-files raises the file limit', () => {
    const { dir, base } = repo();
    for (const n of ['a', 'b', 'c', 'd', 'e']) write(dir, `src/report/${n}.ts`, `export const ${n} = 9;\n`);
    const r = run(dir, ['--since', base, '--max-files', '6']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.stdout.trim(), 'SMALL: 5 source files in 1 module');
  });

  test('red: AC-2008c two files in src/api/ and one in src/jobs/ → ESCALATE: 2 modules touched (api, jobs), limit 1', () => {
    const { dir, base } = repo();
    write(dir, 'src/api/x.ts', 'export const x = 2;\n');
    write(dir, 'src/api/z.ts', 'export const z = 1;\n');
    write(dir, 'src/jobs/y.ts', 'export const y = 2;\n');
    const r = run(dir, ['--since', base]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /^ESCALATE: 2 modules touched \(api, jobs\), limit 1$/m);
  });

  test('red: AC-2008d package.json with a new dependency → ESCALATE: dependency change in package.json; a version-only edit is not', () => {
    const { dir, base } = repo();
    write(dir, 'package.json', JSON.stringify({ name: 't', version: '1.0.1', dependencies: { left: '1.0.0' } }, null, 2) + '\n');
    const same = run(dir, ['--since', base]);
    assert.equal(same.status, 0, same.stdout + same.stderr);
    assert.equal(same.stdout.trim(), 'SMALL: 0 source files in 0 modules');
    write(dir, 'package.json', JSON.stringify({ name: 't', version: '1.0.1', dependencies: { left: '1.0.0', right: '2.0.0' } }, null, 2) + '\n');
    const r = run(dir, ['--since', base]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /^ESCALATE: dependency change in package\.json \(added right\)$/m);
  });

  test('red: a new migration file escalates: a SMALL change adds no table', () => {
    const { dir, base } = repo();
    write(dir, 'src/report/migrations/0002_add_table.sql', 'create table t (id int);\n');
    const r = run(dir, ['--since', base]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /^ESCALATE: new migration src\/report\/migrations\/0002_add_table\.sql$/m);
  });

  test('red: every broken limit prints its own ESCALATE line, the file count first', () => {
    const { dir, base } = repo();
    for (const n of ['a', 'b', 'c', 'd']) write(dir, `src/report/${n}.ts`, `export const ${n} = 9;\n`);
    write(dir, 'src/api/x.ts', 'export const x = 2;\n');
    const r = run(dir, ['--since', base]);
    assert.equal(r.status, 1);
    const lines = r.stdout.trim().split('\n');
    assert.deepEqual(lines, ['ESCALATE: 5 source files changed, limit 4', 'ESCALATE: 2 modules touched (api, report), limit 1']);
  });

  test('red: AC-2008e outside a git repository, a missing --since and an unknown base each exit 2 with a message', () => {
    const plain = mkdtempSync(join(tmpdir(), 'track-check-plain-'));
    made.push(plain);
    const notGit = run(plain, ['--since', 'x']);
    assert.equal(notGit.status, 2);
    assert.match(notGit.stderr, /not a git repository/);
    const { dir } = repo();
    const noBase = run(dir, []);
    assert.equal(noBase.status, 2);
    assert.match(noBase.stderr, /--since <base> is required/);
    const badBase = run(dir, ['--since', 'no-such-ref']);
    assert.equal(badBase.status, 2);
    assert.match(badBase.stderr, /no-such-ref/);
    const unknown = run(dir, ['--since', 'HEAD', '--bogus']);
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /unknown flag/);
  });

  test('red: AC-2008f --json prints one object with track, files, modules and reasons', () => {
    const { dir, base } = repo();
    write(dir, 'src/api/x.ts', 'export const x = 2;\n');
    write(dir, 'src/jobs/y.ts', 'export const y = 2;\n');
    const r = run(dir, ['--since', base, '--json']);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.track, 'ESCALATE');
    assert.deepEqual(out.files, ['src/api/x.ts', 'src/jobs/y.ts']);
    assert.deepEqual(out.modules, ['api', 'jobs']);
    assert.deepEqual(out.reasons, ['2 modules touched (api, jobs), limit 1']);
    assert.equal(out.base, base);
    assert.equal(out.maxFiles, 4);
  });

  test('red: --src names the source roots a module sits under; a file outside them is its own top folder', () => {
    const { dir, base } = repo();
    write(dir, 'server/billing/a.ts', 'export const a = 1;\n');
    write(dir, 'server/billing/b.ts', 'export const b = 1;\n');
    const asRoot = run(dir, ['--since', base, '--src', 'server', '--json']);
    assert.deepEqual(JSON.parse(asRoot.stdout).modules, ['billing']);
    const notRoot = run(dir, ['--since', base, '--src', 'src', '--json']);
    assert.deepEqual(JSON.parse(notRoot.stdout).modules, ['server']);
  });
});

describe('REQ-2008 — the library: what counts as production source', () => {
  const lib = require('../scripts/lib/track-check.cjs');
  test('red: tests, docs, boards, ledgers, lock files and the profile are not source; code under a module is', () => {
    assert.equal(lib.kindOf('src/report/a.ts'), 'source');
    assert.equal(lib.kindOf('lib/thing.py'), 'source');
    assert.equal(lib.kindOf('src/report/a.test.ts'), 'test');
    assert.equal(lib.kindOf('test/report/a.ts'), 'test');
    assert.equal(lib.kindOf('tests/test_report.py'), 'test');
    assert.equal(lib.kindOf('__tests__/a.js'), 'test');
    assert.equal(lib.kindOf('docs/guide.md'), 'doc');
    assert.equal(lib.kindOf('README.md'), 'doc');
    assert.equal(lib.kindOf('tasks/report.md'), 'artefact');
    assert.equal(lib.kindOf('handoffs/2026-01-01-report-handoff.md'), 'artefact');
    assert.equal(lib.kindOf('DECISIONS.md'), 'artefact');
    assert.equal(lib.kindOf('PIPELINE_PROFILE.md'), 'artefact');
    assert.equal(lib.kindOf('.pipeline/runs/report/state.md'), 'artefact');
    assert.equal(lib.kindOf('package.json'), 'manifest');
    assert.equal(lib.kindOf('package-lock.json'), 'lock');
    assert.equal(lib.kindOf('.gitignore'), 'other');
    assert.equal(lib.kindOf('tsconfig.json'), 'other');
  });
  test('red: the module of a path is the folder under a source root, else its top folder, else "."', () => {
    assert.equal(lib.moduleOf('src/report/a.ts'), 'report');
    assert.equal(lib.moduleOf('src/report/deep/a.ts'), 'report');
    assert.equal(lib.moduleOf('src/index.ts'), 'src');
    assert.equal(lib.moduleOf('scripts/x.mjs'), 'scripts');
    assert.equal(lib.moduleOf('index.js'), '.');
    assert.equal(lib.moduleOf('packages/billing/src/a.ts', ['packages']), 'billing');
  });
  test('red: a message per limit, in the fixed order: files, modules, dependency, migration', () => {
    const out = lib.judge({ files: ['src/a/1.ts', 'src/a/2.ts', 'src/b/3.ts', 'src/b/4.ts', 'src/b/5.ts'], modules: ['a', 'b'], dependency: ['dependency change in package.json (added x)'], migrations: ['src/b/migrations/1.sql'], maxFiles: 4 });
    assert.equal(out.track, 'ESCALATE');
    assert.deepEqual(out.reasons, ['5 source files changed, limit 4', '2 modules touched (a, b), limit 1', 'dependency change in package.json (added x)', 'new migration src/b/migrations/1.sql']);
    assert.equal(lib.render(lib.judge({ files: ['src/a/1.ts'], modules: ['a'], dependency: [], migrations: [], maxFiles: 4 })), 'SMALL: 1 source file in 1 module');
  });
});

describe('REQ-2009 — track-check is a free check with no feature key', () => {
  test('red: AC-2009 FEATURES.md has no track-check key, and the script and its library never load profile.feature', () => {
    assert.doesNotMatch(read('FEATURES.md'), /trackCheck|features\.sizing/);
    for (const rel of ['scripts/track-check.mjs', 'scripts/lib/track-check.cjs']) {
      const src = read(rel);
      assert.doesNotMatch(src, /profile\.feature|featureFor|not configured/, `${rel} reads the profile's features`);
    }
  });
  test('red: track-check belongs to the pipeline group', () => {
    const groups = require('../scripts/lib/tool-groups.cjs');
    assert.equal(groups.groupOf('scripts/track-check.mjs'), 'pipeline');
    assert.equal(groups.groupOf('scripts/lib/track-check.cjs'), 'pipeline');
  });
});

describe('REQ-2001 to REQ-2007 — the skill text: the SMALL track, the foreground rule, the unattended mode, the report header', () => {
  const row = SKILL.split('\n').find((l) => /^\| \*\*SMALL\*\* \|/.test(l)) || '';
  test('red: AC-2001 the track table has a SMALL row that names the five limits', () => {
    assert.ok(row, 'no SMALL row in the track table');
    for (const limit of [/\b4 production source files/, /one module/, /no new public operation, table, permission key or dependency/, /no protected path/]) assert.match(row, limit);
    assert.ok(existsSync(join(PACK, REF_PATH)), `${REF_PATH} is missing`);
    assert.match(row, /references\/sizing\.md/);
  });
  test('red: AC-2002 SMALL is one builder dispatch, the orchestrator runs typecheck and the tiers, six phases are skipped (SMALL), no board and no pack', () => {
    assert.match(REF, /one `module-builder` dispatch/);
    assert.match(REF, /`commands\.typecheck`/);
    assert.match(REF, /`commands\.tiers`/);
    assert.match(REF, /skipped \(SMALL\)/);
    for (const p of ['P1', 'P3', 'P4', 'P5', 'P6', 'P6.5']) assert.ok(REF.includes(p), `${p} is not named in the SMALL phase list`);
    assert.match(REF, /no board/i);
    assert.match(REF, /no handoff pack/i);
  });
  test('red: AC-2003 a broken limit continues from Phase 1 as ADDITIVE, measured by track-check', () => {
    assert.match(BOTH, /track-check\.mjs --since/);
    assert.match(BOTH, /continues from Phase 1 as `ADDITIVE`/);
    assert.match(SKILL, /SOLO → SMALL → FIX → ADDITIVE → FULL/);
  });
  test('red: AC-2004 the foreground rule forbids a timer, wake-up or sleep, and the four auditors return before Phase 5', () => {
    assert.match(SKILL, /foreground/);
    assert.match(SKILL, /[Nn]ever schedule a timer, a wake-up or a sleep to wait for a seat/);
    assert.match(SKILL, /all four return before Phase 5/);
  });
  test('red: AC-2005, AC-2006 Human: none makes the run unattended, decisions land under Needs a human, the verdict is never upgraded', () => {
    assert.match(SKILL, /`Human: none`/);
    assert.match(BOTH, /Needs a human/);
    assert.match(BOTH, /ends with its verdict/);
    assert.match(REF, /CHANGES-REQUIRED/);
    assert.match(REF, /never upgraded/);
  });
  test('red: AC-2007 the report opens with Track: and Phases: lines', () => {
    assert.match(SKILL, /`Track: <track> — <reason>`/);
    // pilot-02-E: 6 of 15 runs ended in prose with no header, and 4 dispatched no seat; the rule now sits in the run discipline
    assert.match(SKILL, /\*\*The last message of every run opens with `Track: <track> — <reason>` and a `Phases:` line\*\*/);
    assert.match(SKILL, /a blocked run, an early\s+stop and a `Needs a human` ending included/);
    assert.match(SKILL, /\*\*Every run dispatches\s+at least one seat\.\*\*/);
    assert.match(SKILL, /SMALL is one `module-builder` dispatch, never a direct edit/);
    assert.match(SKILL, /`Phases:`/);
    assert.match(REF, /^Track: /m);
    assert.match(REF, /^Phases: /m);
  });
  test('red: the sizing reference is linked from the skill and ships with the other references', () => {
    assert.match(SKILL, /references\/sizing\.md/);
  });
});

describe('REQ-2010 — the brief template carries Human: and Size hint:', () => {
  test('red: AC-2010 a Human: line with available and none, and a Size hint: line', () => {
    const brief = read('templates/module-brief.md');
    const human = brief.split('\n').find((l) => /\*\*Human:\*\*/.test(l)) || '';
    assert.ok(human, 'no Human: line');
    assert.match(human, /`available`/);
    assert.match(human, /`none`/);
    assert.match(brief, /\*\*Size hint:\*\*/);
  });
});
