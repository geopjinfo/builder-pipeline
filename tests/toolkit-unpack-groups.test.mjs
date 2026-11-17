/**
 * Tool groups (specs/toolkit-unpack-groups.spec.md): `unpack --tools <group>[,<group>]` installs one part of the kit,
 * and `upgrade` repeats the recorded choice. Each test names the acceptance criterion it asserts (AC-8nn → REQ-8nn).
 *
 *   REQ-801…802  every installed file in exactly one group; shared libs are core (checked against the require closure)
 *   REQ-803…806  the filtered install, the hooks group's scripts, the unknown-group refusal, the unchanged default
 *   REQ-807…809  the lock round trip through upgrade, narrowing with and without --prune
 *   REQ-810…811  verify names the groups; dry-run prints the count per group
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PACK = join(dirname(fileURLToPath(import.meta.url)), '..');
const groups = require(join(PACK, 'scripts', 'lib', 'tool-groups.cjs'));
const { closure } = require(join(PACK, 'hooks', 'claude-code', 'hook-trust.cjs'));
const made = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

const skipGit = (src) => !/[\\/](?:\.git|node_modules|tests)(?:[\\/]|$)/.test(`/${relative(PACK, src)}`);
/** A throwaway project with the kit copied in as builder/ (folder layout). */
function folderProject() {
  const proj = mkdtempSync(join(tmpdir(), 'kit-groups-'));
  made.push(proj);
  cpSync(PACK, join(proj, 'builder'), { recursive: true, filter: skipGit });
  return { proj, cli: join(proj, 'builder', 'cli.js') };
}
/** A throwaway project with the kit under node_modules (package layout). */
function packageProject() {
  const proj = mkdtempSync(join(tmpdir(), 'kit-groups-pkg-'));
  made.push(proj);
  const kit = join(proj, 'node_modules', '@geopjinfo', 'builder-pipeline');
  mkdirSync(kit, { recursive: true });
  cpSync(PACK, kit, { recursive: true, filter: skipGit });
  return { proj, cli: join(kit, 'cli.js') };
}
const run = (cli, cwd, args) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', env: { ...process.env, BUILDER_NO_BASH_CAP: '1' } });
const has = (proj, rel) => existsSync(join(proj, ...rel.split('/')));
const lock = (proj) => JSON.parse(readFileSync(join(proj, 'builder.lock.json'), 'utf8'));
/** The destination paths a dry run names (`would install:` / `skip (exists):` lines), without the .gitignore notes. */
const dryList = (out) => out.split(/\r?\n/).filter((l) => /^(would install|would wire|skip \(exists\)|skip \(wired\)):/.test(l)).map((l) => l.replace(/^[^:]+:\s+/, '')).filter((p) => !p.startsWith('.gitignore'));
/** Every file outside builder/ and node_modules/, as sorted relative paths. */
function fileList(root) {
  const out = [];
  const walk = (abs) => {
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const a = join(abs, e.name);
      const rel = relative(root, a).split('\\').join('/');
      if (rel === 'builder' || rel === 'node_modules' || rel.startsWith('.builder/backup-')) continue;
      if (e.isDirectory()) walk(a);
      else out.push(rel);
    }
  };
  walk(root);
  return out.sort();
}

describe('REQ-801…802 — the group table covers the real install list', () => {
  test('AC-801: every path unpack --tool all --experimental would install has exactly one group, in both layouts', () => {
    for (const make of [folderProject, packageProject]) {
      const { proj, cli } = make();
      const r = run(cli, proj, ['unpack', '--tool', 'all', '--experimental', '--dry-run']);
      assert.equal(r.status, 0, r.stderr);
      const paths = dryList(r.stdout);
      assert.ok(paths.length > 100, `dry run named ${paths.length} files`);
      const unmapped = paths.filter((p) => groups.groupOf(p) === null);
      assert.deepEqual(unmapped, [], 'files no group places');
      for (const p of paths) assert.ok([...groups.GROUPS, groups.CORE].includes(groups.groupOf(p)), `${p} → ${groups.groupOf(p)}`);
    }
  });

  test('AC-802: a scripts/lib file used by two or more groups is core; one used by one group is in that group', () => {
    const scriptsDir = join(PACK, 'scripts');
    const users = {};
    const note = (entryGroup, file) => {
      const rel = relative(scriptsDir, file).split('\\').join('/');
      if (rel.startsWith('lib/')) (users[rel] ||= new Set()).add(entryGroup);
    };
    for (const f of readdirSync(scriptsDir).filter((x) => x.endsWith('.mjs'))) {
      const g = groups.groupOf(`scripts/${f}`);
      assert.ok(g, `scripts/${f} has no group`);
      for (const file of closure(join(scriptsDir, f))) note(g, file);
    }
    for (const f of readdirSync(join(PACK, 'tooling', 'experimental'))) for (const file of closure(join(PACK, 'tooling', 'experimental', f))) note('evals', file);
    // The hooks are users too (the hooks group carries what they load, DL-7); a lib only a hook loads is the hooks group's.
    // The hooks load these through hook-trust (cli.js HOOK_SCRIPTS), so a static closure of the hook files misses them.
    const HOOK_SCRIPTS = ['lib/profile.cjs', 'lib/board-freshness.cjs', 'lib/bash-cap.cjs', 'lib/reanchor.cjs', 'lib/secret-scan.cjs', 'board-render.mjs', 'instruction-lint.mjs'];
    const hookUsers = new Set();
    for (const entry of HOOK_SCRIPTS) for (const file of closure(join(scriptsDir, ...entry.split('/')))) hookUsers.add(relative(scriptsDir, file).split('\\').join('/'));
    for (const lib of readdirSync(join(scriptsDir, 'lib'))) {
      const rel = `lib/${lib}`;
      const g = groups.groupOf(`scripts/${rel}`);
      assert.ok(g, `scripts/${rel} has no group`);
      const by = new Set([...(users[rel] || [])].filter((u) => u !== groups.CORE));
      if (by.size > 1) assert.equal(g, groups.CORE, `${rel} is used by ${[...by].join(', ')} and must be core`);
      else if (by.size === 1) assert.equal(g, [...by][0], `${rel} is used by ${[...by][0]} alone`);
      else if (hookUsers.has(rel)) assert.equal(g, 'hooks', `${rel} is loaded by a hook alone`);
      else assert.equal(g, groups.CORE, `${rel} has no script user: core (the CLI's own)`);
    }
    // The hooks group carries what the hooks load (DL-7): the real closure of the vendored entry points.
    assert.deepEqual([...hookUsers].map((r) => `scripts/${r}`).sort(), [...groups.HOOK_LOADS].sort());
  });
});

describe('REQ-803…806 — the filtered install', () => {
  test('AC-803: --tools spec installs the spec group and core, nothing else', () => {
    const { proj, cli } = folderProject();
    const r = run(cli, proj, ['unpack', '--tool', 'claude-code', '--tools', 'spec']);
    assert.equal(r.status, 0, r.stderr);
    for (const f of ['.claude/skills/spec-author/SKILL.md', 'scripts/spec-check.mjs', 'scripts/lib/spec-check.cjs', 'specs/spec.template.md', 'PIPELINE_PROFILE.md', 'CLAUDE.md', 'scripts/lib/profile.cjs']) assert.ok(has(proj, f), `${f} missing`);
    for (const f of ['.claude/agents/module-builder.md', 'scripts/orch.mjs', '.claude/hooks/protected-paths.cjs', 'scripts/claims-check.mjs', '.claude/skills/build-module-pipeline/SKILL.md']) assert.ok(!has(proj, f), `${f} installed`);
    for (const p of fileList(proj)) {
      if (p === 'builder.lock.json' || p === 'builder.choices.json' || p === '.gitignore') continue;
      assert.ok(['spec', 'core'].includes(groups.groupOf(p)), `${p} is ${groups.groupOf(p)}`);
    }
  });

  test('AC-804 + AC-808: --tools audit,orchestrator installs both groups; the lock records them sorted', () => {
    const { proj, cli } = folderProject();
    const r = run(cli, proj, ['unpack', '--tool', 'claude-code', '--tools', 'orchestrator,audit']);
    assert.equal(r.status, 0, r.stderr);
    for (const f of ['.claude/agents/module-reviewer.md', 'scripts/claims-check.mjs', 'scripts/orch.mjs', 'scripts/lib/orch-state.cjs', 'specs/orchestrator-plan.template.md', '.claude/skills/orchestrator/SKILL.md']) assert.ok(has(proj, f), `${f} missing`);
    for (const f of ['.claude/agents/module-builder.md', 'scripts/spec-check.mjs']) assert.ok(!has(proj, f), `${f} installed`);
    assert.deepEqual(lock(proj).install.toolGroups, ['audit', 'orchestrator']);
  });

  test('AC-805: --tools hooks installs the hooks and the scripts they load', () => {
    const { proj, cli } = folderProject();
    const r = run(cli, proj, ['unpack', '--tool', 'claude-code', '--tools', 'hooks']);
    assert.equal(r.status, 0, r.stderr);
    for (const f of ['.claude/hooks/protected-paths.cjs', '.claude/hooks/hook-trust.cjs', 'scripts/board-render.mjs', 'scripts/instruction-lint.mjs', 'scripts/lib/bash-cap.cjs', 'scripts/lib/board-parse.cjs']) assert.ok(has(proj, f), `${f} missing`);
    assert.ok(!has(proj, 'scripts/claims-check.mjs'));
  });

  test('AC-806: an unknown group is refused with the valid list, and nothing is written', () => {
    const { proj, cli } = folderProject();
    const r = run(cli, proj, ['unpack', '--tool', 'claude-code', '--tools', 'spec,trello']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /trello/);
    assert.match(r.stderr, /spec, audit, orchestrator, hooks, evals, pipeline/);
    assert.ok(!has(proj, 'CLAUDE.md'));
    assert.ok(!has(proj, 'builder.lock.json'));
  });

  test('AC-807: no --tools and --tools all install the same files, and record no toolGroups', () => {
    const a = folderProject();
    const b = folderProject();
    assert.equal(run(a.cli, a.proj, ['unpack', '--tool', 'all', '--experimental']).status, 0);
    assert.equal(run(b.cli, b.proj, ['unpack', '--tool', 'all', '--experimental', '--tools', 'all']).status, 0);
    const la = fileList(a.proj);
    assert.deepEqual(fileList(b.proj), la);
    assert.ok(la.length > 200);
    assert.equal(lock(a.proj).install.toolGroups, undefined);
    assert.equal(lock(b.proj).install.toolGroups, undefined);
  });
});

describe('REQ-807…809 — the lock round trip through upgrade', () => {
  test('AC-809 + AC-810: upgrade repeats the recorded groups; --tools given again replaces them', () => {
    const { proj, cli } = folderProject();
    assert.equal(run(cli, proj, ['unpack', '--tool', 'claude-code', '--tools', 'audit,orchestrator']).status, 0);
    appendFileSync(join(proj, 'builder', 'agents', 'module-reviewer.md'), '\nkit change in a new release\n');
    let up = run(cli, proj, ['upgrade']);
    assert.equal(up.status, 0, up.stderr);
    assert.match(readFileSync(join(proj, '.claude', 'agents', 'module-reviewer.md'), 'utf8'), /kit change in a new release/);
    assert.ok(!has(proj, '.claude/agents/module-builder.md'));
    assert.ok(!has(proj, 'scripts/spec-check.mjs'));
    assert.deepEqual(lock(proj).install.toolGroups, ['audit', 'orchestrator']);
    up = run(cli, proj, ['upgrade', '--tools', 'audit,orchestrator,spec']);
    assert.equal(up.status, 0, up.stderr);
    assert.ok(has(proj, 'scripts/spec-check.mjs'));
    assert.deepEqual(lock(proj).install.toolGroups, ['audit', 'orchestrator', 'spec']);
  });

  test('AC-811 + AC-812: upgrade --tools over a wider install keeps the files outside the groups; --prune removes them', () => {
    const { proj, cli } = folderProject();
    assert.equal(run(cli, proj, ['unpack', '--tool', 'claude-code']).status, 0);
    const up = run(cli, proj, ['upgrade', '--tools', 'spec']);
    assert.equal(up.status, 0, up.stderr);
    assert.match(up.stdout, /kept \(outside the tool groups\):\s+\.claude\/agents\/module-builder\.md/);
    assert.ok(has(proj, '.claude/agents/module-builder.md'));
    assert.deepEqual(lock(proj).install.toolGroups, ['spec']);
    const pruned = run(cli, proj, ['upgrade', '--tools', 'spec', '--prune']);
    assert.equal(pruned.status, 0, pruned.stderr);
    assert.ok(!has(proj, '.claude/agents/module-builder.md'));
    const backups = readdirSync(join(proj, '.builder')).filter((d) => d.startsWith('backup-'));
    assert.ok(backups.some((d) => existsSync(join(proj, '.builder', d, '.claude', 'agents', 'module-builder.md'))), 'backed up first');
    assert.equal(lock(proj).files['.claude/agents/module-builder.md'], undefined);
  });
});

describe('REQ-810…811 — verify and dry-run name the groups', () => {
  test('AC-813: verify names the installed groups and skips the checks outside them', () => {
    const { proj, cli } = folderProject();
    assert.equal(run(cli, proj, ['unpack', '--tool', 'claude-code', '--tools', 'spec']).status, 0);
    const v = run(cli, proj, ['verify']);
    assert.match(v.stdout, /tool groups: spec \(builder\.lock\.json\)/);
    assert.match(v.stdout, /SKIP\s+personas installed/);
    assert.doesNotMatch(v.stdout, /FAIL\s+personas installed/);
    const audit = folderProject();
    assert.equal(run(audit.cli, audit.proj, ['unpack', '--tool', 'claude-code', '--tools', 'audit']).status, 0);
    assert.match(run(audit.cli, audit.proj, ['verify']).stdout, /PASS\s+personas installed/, 'the reviewer is a persona too');
    const full = folderProject();
    assert.equal(run(full.cli, full.proj, ['unpack', '--tool', 'claude-code']).status, 0);
    assert.match(run(full.cli, full.proj, ['verify']).stdout, /tool groups: all/);
  });

  test('AC-814: --dry-run prints the groups and a count per group, and writes nothing', () => {
    const { proj, cli } = folderProject();
    const r = run(cli, proj, ['unpack', '--tool', 'claude-code', '--tools', 'spec', '--dry-run']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^tool groups: spec$/m);
    assert.match(r.stdout, /spec: \d+ file/);
    assert.match(r.stdout, /core: \d+ file/);
    assert.deepEqual(fileList(proj), []);
  });
});
