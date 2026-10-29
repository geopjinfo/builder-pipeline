import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const { lint, pathCandidates, bareLineRefs, countClaims, historyHits } = require('../scripts/lib/instruction-lint.cjs');

const REPO = ['CLAUDE.md', 'docs/spec_v1.1.md', 'docs/permissions/permissions.csv', 'scripts/run.mjs', 'agents/reviewer.md'];
const has = (rel) => REPO.includes(rel) || REPO.some((p) => p.startsWith(`${rel}/`));
const base = { exists: has, index: REPO };
const one = (text, extra = {}) => lint([{ path: 'agents/reviewer.md', text }], { ...base, ...extra });

describe('instruction-lint — pure rules', () => {
  test('red: a dead path is caught; a live one, a partial tail and a bare basename resolve', () => {
    const r = one('Read `docs/spec_v1.0.md`, `docs/spec_v1.1.md`, `permissions/permissions.csv` and `permissions.csv`.');
    assert.deepEqual(r.problems, ['agents/reviewer.md:1: `docs/spec_v1.0.md` does not exist']);
  });

  test('placeholders, globs, bare extensions, URLs, fenced code and ignorePaths are not checked', () => {
    const text = ['`tasks/<key>.md` `src/**/*.ts` `.service.ts` `https://x.y/a.md`', '```', 'cat docs/gone.md `docs/gone.md`', '```', '`logs/run.txt`'].join('\n');
    assert.deepEqual(one(text, { ignorePaths: ['^logs/'] }).problems, []);
    assert.deepEqual(one('`logs/run.txt`').problems, ['agents/reviewer.md:1: `logs/run.txt` does not exist']);
  });

  test('a path relative to the citing file resolves; a slash token whose first segment is no directory is not a path', () => {
    assert.deepEqual(one('See `reviewer.md` and `PASS/FAIL`.').problems, []);
    assert.deepEqual(pathCandidates('`PASS/FAIL` `scripts/x`', { dirExists: (s) => s === 'scripts' }).map((c) => c.token), ['scripts/x']);
  });

  test('red: a bare line reference is caught; file:line and table alignment rows are not', () => {
    assert.deepEqual(bareLineRefs('lanes (`:124-125`) and the base (`:113`).').map((h) => h.ref), [':124-125', ':113']);
    assert.deepEqual(bareLineRefs('`docs/spec_v1.1.md:12` at 10:30\n|:---|---:|'), []);
    assert.match(one('see (`:113`)').problems[0], /bare line reference `:113`/);
  });

  test('red: a registered figure that disagrees with its source fails; one that agrees passes; a lost pattern fails', () => {
    const fig = (actual, pattern = '(\\d+) keys') => one('The catalogue has 312 keys.', { figures: [{ file: 'agents/reviewer.md', pattern, actual, label: 'keys' }] });
    assert.deepEqual(fig('312').problems, []);
    assert.match(fig('310').problems[0], /figure "keys" says 312, the source says 310/);
    assert.match(fig('312', '(\\d+) roles').problems[0], /pattern no longer matches/);
    assert.match(fig(null).problems[0], /command produced no value/);
  });

  test('a registered figure line is not also counted as an unregistered claim', () => {
    const r = one('The catalogue has 312 keys.', { figures: [{ file: 'agents/reviewer.md', pattern: '(\\d+) keys', actual: '312' }] });
    assert.deepEqual(r.counts, {});
  });

  test('red: a file that enumerates a set without every member fails', () => {
    const sets = [{ name: 'auditors', members: ['security-auditor', 'invariant-auditor'], files: ['agents/reviewer.md'] }];
    assert.match(one('Read security-auditor.', { sets }).problems[0], /enumerates the set "auditors" without invariant-auditor/);
    assert.deepEqual(one('Read security-auditor and invariant-auditor.', { sets }).problems, []);
    assert.match(one('x', { sets: [{ name: 'empty', members: [], files: [] }] }).problems[0], /a set of nothing asserts nothing/);
  });

  test('count claims: numbers and ranges are found, "one X" rules are not', () => {
    assert.deepEqual(countClaims('six seats, eight of the twelve skills, ADR-008…026, one module, 3 lanes').map((c) => c.claim), [
      'six seats',
      'eight of the twelve skills',
      '3 lanes',
      'ADR-008…026',
    ]);
  });

  test('history phrases are found', () => {
    const hits = historyHits('This bullet used to name seven. It was fixed 2026-08-19. Until the allocator merges, grep. In the first weeks, ask.');
    assert.equal(hits.length, 4);
  });

  test('red: the ratchet fails when a file gains a claim over its baseline, passes at or below it', () => {
    const baseline = { counts: { 'agents/reviewer.md': 1 }, history: {} };
    assert.deepEqual(one('six seats', { baseline }).ratchet, []);
    assert.match(one('six seats and four auditors', { baseline }).ratchet[0], /2 unregistered count claims, baseline 1/);
    assert.match(one('fixed 2026-08-19', { baseline }).ratchet[0], /1 unregistered history phrases, baseline 0/);
    assert.equal(one('six seats and four auditors', { baseline: null }).ok, true, 'no baseline: reported, not enforced');
  });

  test('red: no files is a failure — a lint over nothing asserts nothing', () => {
    assert.match(lint([], base).problems[0], /no instruction file matched/);
  });
});

const cli = join(here, '..', 'scripts', 'instruction-lint.mjs');
const made = [];
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));
const project = (feature) => {
  const dir = mkdtempSync(join(tmpdir(), 'builder-ilint-'));
  made.push(dir);
  mkdirSync(join(dir, '.claude', 'agents'), { recursive: true });
  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'spec.md'), '# spec\n');
  writeFileSync(join(dir, 'CLAUDE.md'), 'Read `docs/spec.md`. The repo has 2 specs.\n');
  writeFileSync(join(dir, '.claude', 'agents', 'reviewer.md'), 'Read the security-auditor and invariant-auditor reports.\n');
  for (const seat of ['security-auditor', 'invariant-auditor']) writeFileSync(join(dir, '.claude', 'agents', `${seat}.md`), `# ${seat}\n`);
  writeFileSync(join(dir, 'PIPELINE_PROFILE.md'), `\`\`\`json pipeline-settings\n${JSON.stringify({ schema: 2, features: { instructionLint: feature } })}\n\`\`\`\n`);
  return dir;
};
const run = (cwd, ...args) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });
const out = (r) => `${r.stdout}${r.stderr}`;
const ON = {
  state: 'on',
  files: ['CLAUDE.md', '.claude/**/*.md'],
  figures: [{ file: 'CLAUDE.md', pattern: '(\\d+) specs', command: 'node -e "console.log(1)"', label: 'specs' }],
  sets: [{ name: 'auditors', membersFrom: { dir: '.claude/agents', pattern: '^(.*-auditor)\\.md$' }, files: ['.claude/agents/reviewer.md'] }],
};

describe('instruction-lint — CLI on a temporary project', () => {
  test('the feature off prints "instructionLint: not configured"', () => {
    const r = run(project({ state: 'off' }));
    assert.equal(r.status, 0, out(r));
    assert.equal(r.stdout.trim(), 'instructionLint: not configured');
  });

  test('red: a figure whose command disagrees fails; fixed, it passes', () => {
    const dir = project(ON);
    const r = run(dir);
    assert.equal(r.status, 1, out(r));
    assert.match(r.stdout, /CLAUDE\.md:1: figure "specs" says 2, the source says 1/);
    writeFileSync(join(dir, 'CLAUDE.md'), 'Read `docs/spec.md`. The repo has 1 specs.\n');
    const ok = run(dir);
    assert.equal(ok.status, 0, out(ok));
    assert.match(ok.stdout, /instruction-lint: PASS — 4 file\(s\)/);
  });

  test('red: a dead path fails, and --files limits the run to the edited file', () => {
    const dir = project({ ...ON, figures: [] });
    writeFileSync(join(dir, '.claude', 'agents', 'reviewer.md'), 'Read `docs/gone.md`.\n');
    assert.match(run(dir).stdout, /reviewer\.md:1: `docs\/gone\.md` does not exist/);
    const only = run(dir, '--files', 'CLAUDE.md');
    assert.equal(only.status, 0, out(only));
    assert.equal(run(dir, '--files', 'README.md').stdout.trim(), 'instruction-lint: none of the given files is an instruction file — nothing to check');
  });

  test('the edit hook: an instruction file that fails is blocked with the lint lines; a pass, another file or bad input is silent', () => {
    const { decide } = require('../hooks/claude-code/instruction-lint-on-edit.cjs');
    const dir = project({ ...ON, figures: [] });
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    writeFileSync(join(dir, 'scripts', 'instruction-lint.mjs'), '');
    const fakeRun = (status, stdout = '') => () => ({ status, stdout });
    const edit = (file) => ({ tool_input: { file_path: join(dir, file) } });
    const blocked = decide(edit('.claude/agents/reviewer.md'), { root: dir, run: fakeRun(1, '  reviewer.md:1: `docs/gone.md` does not exist') });
    assert.equal(blocked.action, 'block');
    assert.match(blocked.reason, /instruction-lint failed for \.claude\/agents\/reviewer\.md[\s\S]*docs\/gone\.md/);
    assert.equal(decide(edit('CLAUDE.md'), { root: dir, run: fakeRun(0) }).action, 'pass');
    assert.equal(decide({}, { root: dir }).action, 'pass');
    assert.equal(decide({ tool_input: { file_path: join(tmpdir(), 'elsewhere.md') } }, { root: dir }).action, 'pass');
    const real = spawnSync(process.execPath, [join(here, '..', 'hooks', 'claude-code', 'instruction-lint-on-edit.cjs')], { input: 'not json', encoding: 'utf8' });
    assert.equal(real.status, 0);
    assert.equal(real.stdout, '');
  });

  test('--refresh writes the baseline; a later rise fails the ratchet', () => {
    const dir = project({ ...ON, figures: [], baseline: 'lint-baseline.json' });
    assert.equal(run(dir).status, 2, 'a configured baseline that is missing is an error');
    assert.equal(run(dir, '--refresh').status, 0);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'lint-baseline.json'), 'utf8')).counts, { 'CLAUDE.md': 1 });
    writeFileSync(join(dir, 'CLAUDE.md'), 'Read `docs/spec.md`. The repo has 2 specs and four auditors.\n');
    const r = run(dir);
    assert.equal(r.status, 1, out(r));
    assert.match(r.stdout, /ratchet: CLAUDE\.md: 2 unregistered count claims, baseline 1/);
  });
});
