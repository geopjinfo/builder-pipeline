/**
 * Codex and Antigravity install NATIVELY, through adapters/lib: personas as each harness's own agent files, skills in
 * the shared `.agents/skills/` (written once when both are selected), the pointer in AGENTS.md. Hooks are copied and
 * never armed: Codex gets the script in `.codex/hooks/` and the `hooks.json` snippet is PRINTED, not written;
 * Antigravity gets no hooks at all (the shape is unconfirmed).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const PACK = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const lib = require('../adapters/lib/index.cjs');
const made = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

function project(kitAt = 'builder') {
  const proj = mkdtempSync(join(tmpdir(), 'kit-native-'));
  made.push(proj);
  const kit = join(proj, ...kitAt.split('/'));
  mkdirSync(kit, { recursive: true });
  cpSync(PACK, kit, { recursive: true, filter: (src) => !/[\\/](?:\.git|tests|node_modules)(?:[\\/]|$)/.test(`/${relative(PACK, src)}`) });
  return { proj, cli: join(kit, 'cli.js') };
}
const run = (cli, cwd, args) => {
  const r = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', env: { ...process.env, BUILDER_NO_BASH_CAP: '1' } });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};
const read = (root, rel) => readFileSync(join(root, rel), 'utf8');
const persona = (f) => readFileSync(join(PACK, 'agents', f), 'utf8');

describe('codex — native install', () => {
  const { proj, cli } = project();
  const r = run(cli, proj, ['unpack', '--tool', 'codex', '--no-extras']);

  test('red: personas are .codex/agents/*.toml rendered by the adapter, skills in .agents/skills, pointer in AGENTS.md', () => {
    assert.equal(r.status, 0, r.out);
    assert.equal(read(proj, '.codex/agents/module-planner.toml'), lib.codex.renderAgent(persona('module-planner.md'), { file: 'module-planner.md' }).content);
    assert.ok(existsSync(join(proj, '.agents/skills/build-module-pipeline/SKILL.md')));
    assert.ok(existsSync(join(proj, '.agents/skills/build-module-pipeline/references/state-template.md')));
    const pointer = read(proj, 'AGENTS.md');
    assert.match(pointer, /<!-- builder-kit:pipeline -->/);
    assert.match(pointer, /\.codex\/agents\//);
    assert.match(pointer, /\.agents\/skills\//);
    assert.ok(!existsSync(join(proj, '.builder', 'personas')), 'a native install writes no .builder/personas');
  });

  test('red: the hook script is copied to .codex/hooks and NOT armed — hooks.json is printed, never written', () => {
    assert.ok(existsSync(join(proj, '.codex/hooks/protected-paths.cjs')));
    assert.ok(!existsSync(join(proj, '.codex/hooks.json')), 'writing hooks.json would arm a hook');
    assert.ok(r.out.includes(lib.codex.hooksConfig().content.trim().split('\n')[1].trim()), 'the hooks.json snippet is printed');
  });

  test('the lock records the kit-owned codex files', () => {
    const lock = JSON.parse(read(proj, 'builder.lock.json')).files;
    assert.match(lock['.codex/agents/module-planner.toml'], /^[0-9a-f]{64}$/);
    assert.match(lock['.agents/skills/build-module-pipeline/SKILL.md'], /^[0-9a-f]{64}$/);
  });
});

describe('antigravity — native install', () => {
  const { proj, cli } = project();
  const r = run(cli, proj, ['unpack', '--tool', 'antigravity', '--no-extras']);

  test('red: personas in .agents/agents, skills in .agents/skills, pointer AGENTS.md, no hooks written', () => {
    assert.equal(r.status, 0, r.out);
    assert.equal(read(proj, '.agents/agents/module-planner.md'), lib.antigravity.renderAgent(persona('module-planner.md'), { file: 'module-planner.md' }).content);
    assert.ok(existsSync(join(proj, '.agents/skills/orchestrator/SKILL.md')));
    assert.match(read(proj, 'AGENTS.md'), /\.agents\/agents\//);
    assert.ok(!existsSync(join(proj, '.agents/hooks.json')));
    assert.ok(!existsSync(join(proj, '.codex')));
  });
});

describe('codex + antigravity together', () => {
  test('red: .agents/skills is written once, and both persona sets land', () => {
    const { proj, cli } = project();
    const r = run(cli, proj, ['unpack', '--tool', 'codex,antigravity', '--no-extras']);
    assert.equal(r.status, 0, r.out);
    const lines = r.out.split('\n').filter((l) => /\.agents[\\/]skills[\\/]build-module-pipeline[\\/]SKILL\.md/.test(l));
    assert.equal(lines.length, 1, lines.join('\n'));
    assert.ok(existsSync(join(proj, '.codex/agents/module-planner.toml')));
    assert.ok(existsSync(join(proj, '.agents/agents/module-planner.md')));
    assert.equal(read(proj, 'AGENTS.md').split('<!-- builder-kit:pipeline -->').length, 2, 'one pointer block');
  });

  test('a second unpack and an upgrade find nothing to change', () => {
    const { proj, cli } = project();
    assert.equal(run(cli, proj, ['unpack', '--tool', 'codex,antigravity']).status, 0);
    const up = run(cli, proj, ['upgrade', '--tool', 'codex,antigravity']);
    assert.equal(up.status, 0, up.out);
    assert.match(up.out, /Upgraded: 0 updated, 0 added, /);
  });
});

test('extras: skill folders land in .agents/skills and their personas render natively', () => {
  const { proj, cli } = project();
  const r = run(cli, proj, ['unpack', '--tool', 'codex']);
  assert.equal(r.status, 0, r.out);
  const extras = readdirSync(join(PACK, 'skills-extra'), { withFileTypes: true }).filter((e) => e.isDirectory());
  for (const e of extras) assert.ok(existsSync(join(proj, '.agents/skills', e.name, 'SKILL.md')), e.name);
  for (const e of extras.filter((x) => existsSync(join(PACK, 'skills-extra', x.name, 'agents')))) {
    for (const f of readdirSync(join(PACK, 'skills-extra', e.name, 'agents'))) {
      const out = lib.codex.renderAgent(readFileSync(join(PACK, 'skills-extra', e.name, 'agents', f), 'utf8'), { file: f });
      assert.equal(read(proj, out.path), out.content, f);
    }
    assert.ok(!existsSync(join(proj, '.agents/skills', e.name, 'agents')), `${e.name}/agents copied into the skill folder`);
  }
});

describe('--tool all and package mode', () => {
  test('red: --tool all includes antigravity', () => {
    const { proj, cli } = project();
    const r = run(cli, proj, ['unpack', '--tool', 'all', '--no-extras', '--dry-run']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /^\[antigravity\]/m);
    assert.match(run(cli, proj, ['targets']).out, /^ {2}antigravity\s/m);
  });

  test('red: installed as a package, the native texts go through kitPaths (no builder/ folder named)', () => {
    const { proj, cli } = project('node_modules/@geopjinfo/builder-pipeline');
    assert.equal(run(cli, proj, ['unpack', '--tool', 'codex,antigravity', '--no-extras']).status, 0);
    for (const rel of ['.agents/skills/build-module-pipeline/SKILL.md', '.codex/agents/module-builder.toml', '.agents/agents/module-builder.md']) {
      assert.doesNotMatch(read(proj, rel), /node builder\/cli\.js|node scripts\/features\.mjs/, rel);
    }
    assert.match(read(proj, '.agents/skills/build-module-pipeline/SKILL.md'), /npx builder/);
  });
});

test('control: claude-code output is unchanged — every persona equals the claude adapter render', () => {
  const { proj, cli } = project();
  assert.equal(run(cli, proj, ['unpack', '--tool', 'claude-code', '--no-extras']).status, 0);
  for (const f of readdirSync(join(PACK, 'agents')).filter((x) => x.endsWith('.md'))) {
    assert.equal(read(proj, `.claude/agents/${f}`), lib['claude-code'].renderAgent(persona(f), { file: f }).content, f);
  }
});
