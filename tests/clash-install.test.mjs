/**
 * unpack/upgrade read builder.choices.json for every kit skill and persona that clashes with a project item.
 *
 * WHY. The project's own items win by default: a clash nobody decided is SKIPPED and reported, never installed on a
 * guess — and never silently dropped either. "kit" backs the project's file up and overwrites it; "both" installs
 * the kit's renamed builder-<name>; "keep" leaves the project's alone. A project with no clash installs exactly as
 * before (tests/upgrade, tests/adapters and tests/native-tools hold that).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const PACK = join(dirname(fileURLToPath(import.meta.url)), '..');
const made = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

function project() {
  const proj = mkdtempSync(join(tmpdir(), 'kit-clash-'));
  made.push(proj);
  cpSync(PACK, join(proj, 'builder'), { recursive: true, filter: (src) => !/[\\/](?:\.git|tests|node_modules)(?:[\\/]|$)/.test(`/${relative(PACK, src)}`) });
  return proj;
}
const run = (cwd, args) => {
  const r = spawnSync(process.execPath, ['builder/cli.js', ...args], { cwd, encoding: 'utf8', env: { ...process.env, BUILDER_NO_BASH_CAP: '1' } });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};
const write = (root, rel, text) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const read = (root, rel) => readFileSync(join(root, rel), 'utf8');
const lock = (root) => JSON.parse(read(root, 'builder.lock.json')).files;
const OURS = '---\nname: orchestrator\ndescription: Our own orchestrator for release trains.\n---\nOurs.\n';
const SKILL = '.claude/skills/orchestrator/SKILL.md';
const choose = (root, key, decision) => assert.equal(run(root, ['choices', 'set', key, decision, '--by', 'tester']).status, 0);

describe('an undecided clash is skipped and reported', () => {
  test('red: a same-name project skill is left alone, reported, and not locked; the rest installs', () => {
    const root = project();
    write(root, SKILL, OURS);
    const r = run(root, ['unpack', '--tool', 'claude-code', '--no-extras']);
    assert.equal(r.status, 0, r.out);
    assert.equal(read(root, SKILL), OURS);
    assert.match(r.out, /skipped \(undecided clash\): skill:orchestrator/);
    assert.match(r.out, /1 kit item\(s\) skipped as undecided clashes/);
    assert.equal(lock(root)[SKILL], undefined);
    assert.ok(existsSync(join(root, '.claude/skills/build-module-pipeline/SKILL.md')));
  });

  test('red: a different-name project persona that does the same job blocks the kit one until decided', () => {
    const root = project();
    const planner = read(PACK, 'agents/module-planner.md');
    write(root, '.claude/agents/our-planner.md', planner.replace(/^name: module-planner$/m, 'name: our-planner'));
    const r = run(root, ['unpack', '--tool', 'claude-code', '--no-extras']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /skipped \(undecided clash\): agent:module-planner/);
    assert.ok(!existsSync(join(root, '.claude/agents/module-planner.md')));
  });

  test('red: upgrade skips it too — a clash is not overwritten by the kit\'s authority', () => {
    const root = project();
    assert.equal(run(root, ['unpack', '--tool', 'claude-code', '--no-extras']).status, 0);
    write(root, '.claude/skills/our-orch/SKILL.md', read(root, SKILL).replace(/^name: orchestrator$/m, 'name: our-orch'));
    const r = run(root, ['upgrade', '--tool', 'claude-code', '--no-extras']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /skipped \(undecided clash\): skill:orchestrator/);
  });

  test('red: an invalid builder.choices.json stops the install before anything is written', () => {
    const root = project();
    write(root, 'builder.choices.json', '{ "version": 9 }');
    const r = run(root, ['unpack', '--tool', 'claude-code']);
    assert.equal(r.status, 1);
    assert.match(r.out, /builder\.choices\.json is invalid/);
    assert.deepEqual(readdirSync(root).sort(), ['builder', 'builder.choices.json']);
  });
});

describe('a recorded choice is applied', () => {
  test('keep: the kit item is not installed, and the line says whose choice it was', () => {
    const root = project();
    write(root, SKILL, OURS);
    choose(root, 'skill:orchestrator', 'keep');
    const r = run(root, ['unpack', '--tool', 'claude-code', '--no-extras']);
    assert.match(r.out, /kept project's \(tester, .*\): skill:orchestrator not installed/);
    assert.equal(read(root, SKILL), OURS);
    assert.doesNotMatch(r.out, /undecided clashes/);
  });

  test('red: kit — the project file is backed up, then overwritten with the kit\'s, and locked', () => {
    const root = project();
    write(root, SKILL, OURS);
    choose(root, 'skill:orchestrator', 'kit');
    const r = run(root, ['unpack', '--tool', 'claude-code', '--no-extras']);
    assert.equal(r.status, 0, r.out);
    assert.equal(read(root, SKILL), read(PACK, 'skills/orchestrator.md'));
    const backups = readdirSync(join(root, '.builder')).filter((d) => d.startsWith('backup-'));
    assert.equal(backups.length, 1);
    assert.equal(read(root, join('.builder', backups[0], SKILL)), OURS);
    assert.match(lock(root)[SKILL], /^[0-9a-f]{64}$/);
  });

  test('red: both — the kit\'s lands as builder-<name> with its frontmatter renamed; the project\'s stays', () => {
    const root = project();
    write(root, SKILL, OURS);
    choose(root, 'skill:orchestrator', 'both');
    const r = run(root, ['unpack', '--tool', 'claude-code', '--no-extras']);
    assert.equal(r.status, 0, r.out);
    assert.equal(read(root, SKILL), OURS);
    const renamed = read(root, '.claude/skills/builder-orchestrator/SKILL.md');
    assert.match(renamed, /^name: builder-orchestrator$/m);
    assert.match(r.out, /both kept \(tester, .*\): skill:orchestrator/);
  });

  // A non-seat persona (an extra skill's): "both" for a pipeline seat is refused (tests/setup-flow.test.mjs).
  test('both, for a codex persona: .codex/agents/builder-<name>.toml named builder-<name>', () => {
    const root = project();
    write(root, '.codex/agents/repo-auditor.toml', 'name = "repo-auditor"\ndescription = "ours"\ndeveloper_instructions = "ours"\n');
    choose(root, 'agent:repo-auditor', 'both');
    const r = run(root, ['unpack', '--tool', 'codex']);
    assert.equal(r.status, 0, r.out);
    assert.match(read(root, '.codex/agents/builder-repo-auditor.toml'), /^name = "builder-repo-auditor"$/m);
    assert.match(read(root, '.codex/agents/repo-auditor.toml'), /description = "ours"/);
  });

  test('a skipped pipeline skill takes its references with it — nothing lands in the project\'s folder', () => {
    const root = project();
    write(root, '.claude/skills/build-module-pipeline/SKILL.md', '---\nname: build-module-pipeline\ndescription: ours\n---\n');
    assert.equal(run(root, ['unpack', '--tool', 'claude-code', '--no-extras']).status, 0);
    assert.ok(!existsSync(join(root, '.claude/skills/build-module-pipeline/references')));
  });
});
