import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const lib = require('../scripts/lib/spec-trace.cjs');
const profile = require('../scripts/lib/profile.cjs');

const fixture = join(here, 'fixtures', 'spec-trace', 'project');
const cli = join(root, 'scripts', 'spec-trace-check.mjs');

const idRe = lib.compileId('REQ-\\d+');

describe('spec-trace — what a step is', () => {
  test('the four pack verbs, in both step forms the requirement-pack template names', () => {
    const text = [
      'assert  REQ-002  a duplicate reference is refused',
      'REQ-003: the total is the sum of its lines',
      'REQ-004 [by-design rulings/R-2.md]: archived, not refused',
      'REQ-005 [known-gap]: the clause is unenforced',
      'REQ-006 [skipped]: throttled, not refused',
      'gap  REQ-007  observed: no audit row',
      'skipped  REQ-008  fixture missing',
      'by-design  REQ-009 [rulings/R-3.md]  per-wave, not the range',
    ].join('\n');
    const { steps, uncited } = lib.scanFile(text, 'p.md', idRe, 'pack');
    assert.deepEqual(
      steps.map((s) => `${s.id}=${s.kind}`),
      ['REQ-002=assert', 'REQ-003=assert', 'REQ-004=by-design', 'REQ-005=gap', 'REQ-006=skipped', 'REQ-007=gap', 'REQ-008=skipped', 'REQ-009=by-design'],
    );
    assert.equal(steps.find((s) => s.id === 'REQ-004').cite, 'rulings/R-2.md');
    assert.deepEqual(uncited, []);
  });

  test('red: a plain mention in a pack is not a step — a note about a requirement asserts nothing', () => {
    const { steps } = lib.scanFile('Note: REQ-001 is covered elsewhere, see REQ-002.', 'p.md', idRe, 'pack');
    assert.deepEqual(steps, []);
  });

  test('red: a by-design step with no citation is UNCITED and traces nothing', () => {
    const text = 'REQ-004 [by-design]: archived, not refused\nby-design  REQ-005  no bracket at all';
    const { steps, uncited } = lib.scanFile(text, 'p.md', idRe, 'pack');
    assert.deepEqual(steps, []);
    assert.deepEqual(uncited.map((u) => `${u.id}@${u.line}`), ['REQ-004@1', 'REQ-005@2']);
  });

  test('in a test file any whole-token mention is a test, and a pack tag there keeps its verb', () => {
    const text = "test('REQ-001: refused', () => {});\n// also REQ-002\ntest('REQ-003 [known-gap]: unenforced', () => {});";
    const { steps } = lib.scanFile(text, 't.test.ts', idRe, 'test');
    assert.deepEqual(steps.map((s) => `${s.id}=${s.kind}`), ['REQ-001=test', 'REQ-002=test', 'REQ-003=gap']);
  });

  test('ids match as whole tokens only', () => {
    const { steps } = lib.scanFile('XREQ-001 · REQ-0010 · REQ-001_x · REQ-001', 't.ts', idRe, 'test');
    assert.deepEqual(steps.map((s) => s.id), ['REQ-0010', 'REQ-001']);
  });

  test('declared ids keep their first site; a second mention does not move it', () => {
    const map = lib.declared([{ path: 'r.md', text: '| REQ-001 | a |\n| REQ-002 | b, unlike REQ-001 |' }], idRe);
    assert.deepEqual([...map].map(([id, at]) => `${id}@${at.path}:${at.line}`), ['REQ-001@r.md:1', 'REQ-002@r.md:2']);
  });

  test('trace: untraced ids and undeclared references are both reported, in declared order', () => {
    const map = lib.declared([{ path: 'r.md', text: 'REQ-001\nREQ-002' }], idRe);
    const steps = [{ id: 'REQ-002', kind: 'assert', path: 'p.md', line: 1 }, { id: 'REQ-099', kind: 'test', path: 't.ts', line: 3 }];
    const t = lib.trace(map, steps);
    assert.deepEqual(t.results.map((r) => `${r.id}:${r.verdict}`), ['REQ-001:UNTRACED', 'REQ-002:traced']);
    assert.deepEqual(t.undeclared.map((s) => s.id), ['REQ-099']);
    assert.deepEqual(t.kinds, { test: 0, assert: 1, 'by-design': 0, gap: 0, skipped: 0 });
  });
});

describe('spec-trace — settings', () => {
  const settings = (config) => ({ schema: 2, features: { specTrace: { state: 'on', idPattern: 'REQ-\\d+', requirements: ['docs'], ...config } } });

  test('the feature is declared and off by default', () => {
    assert.equal(profile.FEATURES.specTrace.defaults.state, 'off');
    assert.equal(profile.feature({}, 'specTrace').line, 'specTrace: not configured');
  });

  test('red: on with neither tests nor packs is refused at load — a trace with nowhere to look traces nothing', () => {
    const errors = profile.validate(settings({ tests: [], packs: [] }));
    assert.ok(errors.some((e) => e.startsWith('features.specTrace: needs "tests" or "packs"')), errors.join('\n'));
  });

  test('red: an invalid idPattern or testPattern, and non-string path lists, are refused at load', () => {
    const errors = profile.validate(settings({ idPattern: '(', testPattern: '[', tests: ['tests'], packs: 'packs' }));
    assert.ok(errors.some((e) => e.startsWith('features.specTrace.idPattern: not a valid regular expression')), errors.join('\n'));
    assert.ok(errors.some((e) => e.startsWith('features.specTrace.testPattern: not a valid regular expression')), errors.join('\n'));
    assert.ok(errors.some((e) => e.startsWith('features.specTrace.packs: an array of non-empty paths')), errors.join('\n'));
  });
});

const temps = [];
after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});
const project = () => {
  const dir = mkdtempSync(join(tmpdir(), 'spec-trace-'));
  temps.push(dir);
  cpSync(fixture, dir, { recursive: true });
  return dir;
};
const run = (cwd, ...args) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });
const lastLine = (r) => (r.stdout + r.stderr).trim().split(/\r?\n/).at(-1);
const setProfile = (dir, mutate) => {
  const path = join(dir, 'PIPELINE_PROFILE.md');
  const text = readFileSync(path, 'utf8');
  const [, body] = /```json pipeline-settings\n([\s\S]*?)\n```/.exec(text.replace(/\r\n/g, '\n'));
  const s = JSON.parse(body);
  mutate(s);
  writeFileSync(path, `\`\`\`json pipeline-settings\n${JSON.stringify(s, null, 2)}\n\`\`\`\n`);
};

const GREEN =
  'spec-trace-check: PASS — 6 of 6 requirement(s) traced (1 test · 2 assert · 1 by-design · 1 gap · 1 skipped), from 1 requirement file(s) and 2 test/pack file(s)';

describe('spec-trace-check — CLI on a fixture project', () => {
  test('green: every requirement has a test or a pack step; a helper and a pack note trace nothing', () => {
    const r = run(project());
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(lastLine(r), GREEN);
  });

  test('feature off prints its not-configured line and exits 0 — never a pass', () => {
    const dir = project();
    setProfile(dir, (s) => {
      s.features.specTrace.state = 'off';
    });
    const r = run(dir);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), 'specTrace: not configured');
  });

  test('red: a requirement with no test and no pack step fails, named with where it is declared', () => {
    const dir = project();
    appendFileSync(join(dir, 'docs', 'requirements.md'), '| REQ-007 | a shipped order cannot be edited |\n');
    const r = run(dir);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /UNTRACED REQ-007 {2}declared at docs\/requirements\.md:11/);
    assert.equal(lastLine(r), 'spec-trace-check: FAIL — 1 of 7 requirement(s) have no test and no requirement-pack step (assert · by-design · gap · skipped)');
  });

  test('red: removing the only test leaves its requirement untraced — the pack note and the helper do not count', () => {
    const dir = project();
    rmSync(join(dir, 'tests', 'orders.test.ts'));
    const r = run(dir);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /UNTRACED REQ-001 {2}declared at docs\/requirements\.md:5/);
  });

  test('red: a by-design step with no citation fails, and its requirement is untraced', () => {
    const dir = project();
    const pack = join(dir, 'packs', 'orders.pack.md');
    writeFileSync(pack, readFileSync(pack, 'utf8').replace('[by-design rulings/R-2.md]', '[by-design]'));
    const r = run(dir);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /UNCITED REQ-004 {2}at packs\/orders\.pack\.md:7/);
    assert.match(r.stderr, /UNTRACED REQ-004/);
    assert.match(lastLine(r), /^spec-trace-check: FAIL — 1 of 6 requirement\(s\) .* · 1 by-design step\(s\) carry no citation$/);
  });

  test('named requirement files narrow the check to one module', () => {
    const dir = project();
    writeFileSync(join(dir, 'docs', 'billing.md'), '| REQ-010 | an invoice is immutable once sent |\n');
    assert.equal(run(dir).status, 1);
    const r = run(dir, 'docs/requirements.md');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(lastLine(r), GREEN);
  });

  test('a reference to an undeclared id is reported, not failed', () => {
    const dir = project();
    appendFileSync(join(dir, 'packs', 'orders.pack.md'), '    assert  REQ-099  an id the register does not hold\n');
    const r = run(dir);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /undeclared REQ-099 at packs\/orders\.pack\.md:12/);
    assert.equal(lastLine(r), GREEN);
  });

  test('--json carries each requirement with its traces, the counts and the verdict', () => {
    const data = JSON.parse(run(project(), '--json').stdout);
    assert.equal(data.verdict, 'PASS');
    assert.deepEqual(data.kinds, { test: 1, assert: 2, 'by-design': 1, gap: 1, skipped: 1 });
    const r4 = data.results.find((r) => r.id === 'REQ-004');
    assert.deepEqual(r4.traces.map((t) => `${t.kind}@${t.path}:${t.line}`), ['by-design@packs/orders.pack.md:7']);
  });

  test('--list prints every requirement with its verdict and traces', () => {
    const r = run(project(), '--list');
    assert.match(r.stdout, /^traced\s+REQ-001\s+test tests\/orders\.test\.ts:4$/m);
    assert.match(r.stdout, /^traced\s+REQ-006\s+skipped packs\/orders\.pack\.md:9$/m);
  });

  test('a missing source exits 2 and names it', () => {
    const dir = project();
    rmSync(join(dir, 'packs'), { recursive: true });
    const r = run(dir);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /^spec-trace-check: source missing — packs \(features\.specTrace\.packs\)/m);
  });

  test('red: requirement files that declare zero ids fail the positive control', () => {
    const dir = project();
    writeFileSync(join(dir, 'docs', 'requirements.md'), '# Requirements — none yet\n');
    const r = run(dir);
    assert.equal(r.status, 1);
    assert.match(lastLine(r), /^spec-trace-check: FAIL — the requirement file\(s\) declare zero ids matching REQ-\\d\+/);
  });

  test('red: no test or pack file to read fails — a trace that read nothing traced nothing', () => {
    const dir = project();
    setProfile(dir, (s) => {
      s.features.specTrace.testPattern = '\\.spec\\.py$';
      s.features.specTrace.packs = [];
    });
    const r = run(dir);
    assert.equal(r.status, 1);
    assert.match(lastLine(r), /^spec-trace-check: FAIL — .*no test or pack file was read/);
  });
});

describe('spec-trace — the readiness gate runs it', () => {
  test('the readiness skill names the check and its not-configured line', () => {
    const text = readFileSync(join(root, 'skills', 'module-readiness-check.md'), 'utf8');
    assert.match(text, /spec-trace-check/);
    assert.match(text, /specTrace: not configured/);
  });
});
