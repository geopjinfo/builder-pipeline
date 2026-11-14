/**
 * `builder.choices.json` and applyChoices() — a person's per-item decision, and the installer honouring it.
 *
 * WHY. An answer that is not recorded is undone by the next upgrade, and a clash with no answer must never be
 * installed on a guess: the project wins until a person decided. The red case below is the one that matters most —
 * an undecided clash is SKIPPED and reported, not installed and not silently dropped.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ch = require('../scripts/lib/choices.cjs');
const PACK = join(dirname(fileURLToPath(import.meta.url)), '..');

const temps = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'choices-'));
  temps.push(d);
  return d;
};
after(() => temps.forEach((d) => rmSync(d, { recursive: true, force: true })));

const NOW = new Date('2026-01-02T03:04:05.678Z');
const ok = (decision) => ({ decision, decidedAt: '2026-01-02T03:04:05Z', by: 'reviewer-a' });

describe('validate()', () => {
  test('a valid object has no errors', () => {
    assert.deepEqual(ch.validate({ version: 1, items: { 'skill:code-review': ok('keep'), 'agent:module-planner': { ...ok('both'), project: ['personas/planner.md'], note: 'ours plans differently' } } }), []);
  });

  test('red: every bad field is named', () => {
    const errors = ch.validate({
      version: 2,
      extra: true,
      items: {
        'widget:x': ok('keep'),
        'skill:a': { decision: 'maybe', decidedAt: 'yesterday', by: '' },
        'skill:b': { ...ok('kit'), project: 'one/path', colour: 'red' },
      },
    });
    const text = errors.join('\n');
    for (const re of [/version: expected 1/, /extra: unknown top-level key/, /widget:x: key must be/, /skill:a\.decision/, /skill:a\.decidedAt/, /skill:a\.by/, /skill:b\.project/, /skill:b\.colour: unknown field/]) {
      assert.match(text, re);
    }
  });

  test('red: not an object, and items not an object', () => {
    assert.deepEqual(ch.validate(null), ['choices: not a JSON object']);
    assert.match(ch.validate({ version: 1, items: [] }).join(), /items: must be an object/);
  });
});

describe('read() / write() / set() / unset()', () => {
  test('no file: found false, empty, no errors', () => {
    const r = ch.read(tempDir());
    assert.equal(r.found, false);
    assert.deepEqual(r.choices, { version: 1, items: {} });
    assert.deepEqual(r.errors, []);
  });

  test('set + write + read round-trips, keys sorted, timestamp to the second', () => {
    const root = tempDir();
    let c = ch.set(ch.empty(), 'skill:zeta', 'kit', 'reviewer-a', { now: NOW });
    c = ch.set(c, 'skill:alpha', 'keep', 'reviewer-b', { now: NOW, project: ['.claude/skills/alpha/SKILL.md'], note: 'ours is stricter' });
    ch.write(root, c);
    const r = ch.read(root);
    assert.equal(r.found, true);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(Object.keys(r.choices.items), ['skill:alpha', 'skill:zeta']);
    assert.equal(r.choices.items['skill:zeta'].decidedAt, '2026-01-02T03:04:05Z');
    assert.deepEqual(r.choices.items['skill:alpha'].project, ['.claude/skills/alpha/SKILL.md']);
    assert.deepEqual(Object.keys(ch.unset(r.choices, 'skill:alpha').items), ['skill:zeta']);
  });

  test('red: set refuses a bad decision; write refuses an invalid object and writes nothing', () => {
    assert.throws(() => ch.set(ch.empty(), 'skill:x', 'overwrite', 'a', { now: NOW }), /decision/);
    assert.throws(() => ch.set(ch.empty(), 'skill:x', 'keep', '', { now: NOW }), /by/);
    const root = tempDir();
    assert.throws(() => ch.write(root, { version: 1, items: { 'skill:x': { decision: 'nope' } } }), /refusing to write/);
    assert.equal(existsSync(join(root, ch.FILE)), false);
  });

  test('red: a corrupt file is reported, not thrown, and reads as no choices', () => {
    const root = tempDir();
    writeFileSync(join(root, ch.FILE), '{ not json');
    const r = ch.read(root);
    assert.equal(r.found, true);
    assert.match(r.errors[0], /not valid JSON/);
    assert.deepEqual(r.choices.items, {});
  });
});

describe('applyChoices()', () => {
  const plan = [
    { key: 'skill:build-module-pipeline', kind: 'skill', name: 'build-module-pipeline', dst: '.claude/skills/build-module-pipeline/SKILL.md', clash: false },
    { key: 'skill:code-review', kind: 'skill', name: 'code-review', dst: '.claude/skills/code-review/SKILL.md', clash: true, with: ['.claude/skills/code-review/SKILL.md'] },
    { key: 'agent:module-planner', kind: 'agent', name: 'module-planner', dst: '.claude/agents/module-planner.md', clash: true },
    { key: 'skill:release-notes', kind: 'skill', name: 'release-notes', dst: '.agents/skills/release-notes/SKILL.md', clash: true },
    { key: 'skill:diff-audit', kind: 'skill', name: 'diff-audit', dst: '.claude/skills/diff-audit/SKILL.md', clash: true },
  ];

  test('red: an undecided clash is skipped and reported — never installed', () => {
    const r = ch.applyChoices(plan, ch.empty());
    assert.deepEqual(r.install.map((e) => e.key), ['skill:build-module-pipeline']);
    assert.deepEqual(r.skip.map((s) => [s.entry.key, s.reason]), [
      ['skill:code-review', 'undecided-clash'],
      ['agent:module-planner', 'undecided-clash'],
      ['skill:release-notes', 'undecided-clash'],
      ['skill:diff-audit', 'undecided-clash'],
    ]);
    assert.match(r.report[0], /skipped \(undecided clash\): skill:code-review .* clashes with \.claude\/skills\/code-review\/SKILL\.md/);
    assert.equal(r.report.length, 4);
  });

  test('no choices file at all behaves like an empty one', () => {
    assert.deepEqual(ch.applyChoices(plan, undefined).install.map((e) => e.key), ['skill:build-module-pipeline']);
  });

  test('keep skips, kit replaces, both renames with the builder- prefix; a non-clash installs regardless', () => {
    const choices = {
      version: 1,
      items: {
        'skill:code-review': ok('keep'),
        'agent:module-planner': ok('both'),
        'skill:release-notes': ok('kit'),
        'skill:build-module-pipeline': ok('keep'), // stale: no clash any more — harmless
      },
    };
    const r = ch.applyChoices(plan, choices);
    const byKey = Object.fromEntries(r.install.map((e) => [e.key, e]));
    assert.deepEqual(Object.keys(byKey).sort(), ['agent:module-planner', 'skill:build-module-pipeline', 'skill:release-notes']);
    assert.equal(byKey['skill:release-notes'].replace, true);
    assert.equal(byKey['agent:module-planner'].dst, '.claude/agents/builder-module-planner.md');
    assert.equal(byKey['agent:module-planner'].rename, 'builder-module-planner');
    assert.equal(byKey['skill:build-module-pipeline'].replace, undefined);
    assert.deepEqual(r.skip.map((s) => [s.entry.key, s.reason]), [['skill:code-review', 'kept-project'], ['skill:diff-audit', 'undecided-clash']]);
  });

  test('both on a skill dir renames the folder; a dst without the name cannot be renamed and is skipped', () => {
    assert.equal(ch.renamedDst('.claude/skills/code-review/SKILL.md', 'code-review'), '.claude/skills/builder-code-review/SKILL.md');
    const r = ch.applyChoices([{ key: 'hook:x', kind: 'hook', name: 'x', dst: 'scripts/other.cjs', clash: true }], { version: 1, items: { 'hook:x': ok('both') } });
    assert.deepEqual(r.skip.map((s) => s.reason), ['rename-impossible']);
  });

  test('renameFrontmatter rewrites only the frontmatter name', () => {
    const out = ch.renameFrontmatter('---\nname: code-review\ndescription: x\n---\n\nname: code-review in prose\n', 'builder-code-review');
    assert.equal(out, '---\nname: builder-code-review\ndescription: x\n---\n\nname: code-review in prose\n');
  });
});

describe('scripts/choices.mjs', () => {
  const run = (cwd, args) => spawnSync(process.execPath, [join(PACK, 'scripts', 'choices.mjs'), ...args], { cwd, encoding: 'utf8' });

  test('set, list, unset, check', () => {
    const root = tempDir();
    assert.match(run(root, ['check']).stdout, /every clashing kit item will be skipped/);
    const s = run(root, ['set', 'skill:caveman', 'both', '--by', 'reviewer-a', '--project', '.claude/skills/code-review/SKILL.md', '--note', 'different scope']);
    assert.equal(s.status, 0, s.stderr);
    const saved = JSON.parse(readFileSync(join(root, ch.FILE), 'utf8'));
    assert.equal(saved.items['skill:caveman'].decision, 'both');
    assert.match(run(root, ['list']).stdout, /skill:caveman\s+both\s+reviewer-a/);
    assert.equal(run(root, ['unset', 'skill:caveman']).status, 0);
    assert.match(run(root, ['check']).stdout, /valid, 0 choice/);
  });

  test('red: set without --by, with a bad decision, or over an invalid file fails', () => {
    const root = tempDir();
    assert.equal(run(root, ['set', 'skill:x', 'keep']).status, 1);
    assert.equal(run(root, ['set', 'skill:x', 'maybe', '--by', 'a']).status, 1);
    writeFileSync(join(root, ch.FILE), '[]');
    assert.equal(run(root, ['set', 'skill:x', 'keep', '--by', 'a']).status, 1);
    assert.equal(run(root, ['check']).status, 1);
  });
});
