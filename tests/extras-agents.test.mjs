/**
 * Personas that ship inside an extra skill (`skills-extra/<name>/agents/*.md`) install like the pipeline's own.
 *
 * WHY. A skill that dispatches a seat by name is broken if the seat is not in the harness's registry: on Claude
 * Code a Workflow `agentType` resolves from `.claude/agents/`, and a persona left inside the skill's folder never
 * loads. So an extra's personas go where `agents/*.md` go (transformed for a native harness, verbatim to
 * `.builder/personas/` elsewhere), copy-if-absent, and `--no-extras` installs none of them.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const PACK = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every persona an extra ships, discovered, so a future one is covered without editing this test. */
const EXTRA_AGENTS = readdirSync(join(PACK, 'skills-extra'), { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(join(PACK, 'skills-extra', e.name, 'agents')))
  .flatMap((e) => readdirSync(join(PACK, 'skills-extra', e.name, 'agents')).filter((f) => f.endsWith('.md')).map((file) => ({ skill: e.name, file })));

function copyPack(into) {
  cpSync(PACK, join(into, 'builder'), { recursive: true, filter: (src) => !/[\\/](?:\.git|node_modules)(?:[\\/]|$)/.test(src) });
}

function unpack(cwd, ...args) {
  const r = spawnSync(process.execPath, ['builder/cli.js', 'unpack', ...args], { cwd, encoding: 'utf8', env: { ...process.env, BUILDER_NO_BASH_CAP: '1' } });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

test('the repo-audit synthesis seat is among the discovered extra personas', () => {
  assert.ok(EXTRA_AGENTS.some((a) => a.skill === 'repo-audit' && a.file === 'repo-auditor.md'), JSON.stringify(EXTRA_AGENTS));
});

describe('extra personas — native install (claude-code)', () => {
  let root;
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'pack-extras-cc-'));
    copyPack(root);
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  test('--no-extras installs none of them', () => {
    const r = unpack(root, '--tool', 'claude-code', '--no-extras');
    assert.equal(r.status, 0, r.out);
    for (const { skill, file } of EXTRA_AGENTS) {
      assert.ok(!existsSync(join(root, '.claude', 'agents', file)), `${file} installed with --no-extras`);
      assert.ok(!existsSync(join(root, '.claude', 'skills', skill)), `${skill} installed with --no-extras`);
    }
  });

  test('with extras: each is transformed into .claude/agents/, never left in the skill folder, and an existing file is kept', () => {
    const kept = EXTRA_AGENTS[0];
    mkdirSync(join(root, '.claude', 'agents'), { recursive: true });
    writeFileSync(join(root, '.claude', 'agents', 'unrelated-local.md'), 'mine');
    const r = unpack(root, '--tool', 'claude-code');
    assert.equal(r.status, 0, r.out);
    for (const { skill, file } of EXTRA_AGENTS) {
      const installed = readFileSync(join(root, '.claude', 'agents', file), 'utf8');
      assert.match(installed, /^tools: /m, `${file} was not transformed`);
      assert.match(installed, /^model: /m, `${file} has no model`);
      assert.doesNotMatch(installed, /^capabilities:/m, `${file} kept neutral frontmatter`);
      assert.ok(!existsSync(join(root, '.claude', 'skills', skill, 'agents')), `${skill}/agents copied into the skill folder`);
      assert.ok(existsSync(join(root, '.claude', 'skills', skill, 'SKILL.md')));
    }
    const auditor = readFileSync(join(root, '.claude', 'agents', 'repo-auditor.md'), 'utf8');
    assert.match(auditor, /^name: repo-auditor$/m);
    assert.match(auditor, /^tools: Read, Grep, Glob, Bash$/m, 'the synthesis seat is read-only');
    assert.match(auditor, /^model: opus$/m);
    assert.ok(existsSync(join(root, '.claude', 'skills', 'repo-audit', 'audit-workflow.js')));

    writeFileSync(join(root, '.claude', 'agents', kept.file), 'local edit');
    const again = unpack(root, '--tool', 'claude-code');
    assert.equal(again.status, 0, again.out);
    assert.equal(readFileSync(join(root, '.claude', 'agents', kept.file), 'utf8'), 'local edit', 'copy-if-absent overwrote a persona');
  });
});

describe('extra personas — non-native install (codex)', () => {
  let root;
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'pack-extras-codex-'));
    copyPack(root);
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  test('--no-extras installs none of them', () => {
    const r = unpack(root, '--tool', 'codex', '--no-extras');
    assert.equal(r.status, 0, r.out);
    for (const { file } of EXTRA_AGENTS) assert.ok(!existsSync(join(root, '.builder', 'personas', file)), `${file} installed with --no-extras`);
  });

  test('with extras: each lands verbatim in .builder/personas/', () => {
    const r = unpack(root, '--tool', 'codex');
    assert.equal(r.status, 0, r.out);
    for (const { skill, file } of EXTRA_AGENTS) {
      const installed = join(root, '.builder', 'personas', file);
      assert.equal(readFileSync(installed, 'utf8'), readFileSync(join(PACK, 'skills-extra', skill, 'agents', file), 'utf8'));
      assert.ok(!existsSync(join(root, '.builder', 'skills', skill, 'agents')), `${skill}/agents copied into the skill folder`);
    }
  });
});
