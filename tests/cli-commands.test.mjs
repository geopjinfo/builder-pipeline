/**
 * The setup commands the `builder-init` skill drives: `inventory`, `choices`, `bootstrap`, `personas-check`.
 *
 * WHY. The skill does the judgement and the CLI does the mechanics, so every mechanical step the skill names must be
 * a `builder <command>` that works from the project root. `inventory` must not show the kit its own earlier install
 * as a project item (a re-run would then ask the human to "decide" about every kit persona); `bootstrap` installs
 * ONLY the setup skill, for the tools the project already uses.
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

function project(kitAt = 'builder') {
  const proj = mkdtempSync(join(tmpdir(), 'kit-cmds-'));
  made.push(proj);
  const kit = join(proj, ...kitAt.split('/'));
  mkdirSync(kit, { recursive: true });
  cpSync(PACK, kit, { recursive: true, filter: (src) => !/[\\/](?:\.git|tests|node_modules)(?:[\\/]|$)/.test(`/${relative(PACK, src)}`) });
  return { proj, cli: join(kit, 'cli.js') };
}
const run = (cli, cwd, args) => {
  const r = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', env: { ...process.env, BUILDER_NO_BASH_CAP: '1' } });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, stdout: r.stdout ?? '' };
};
const write = (root, rel, text) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const OWN_REVIEW = '---\nname: code-review\ndescription: Review the pending diff for bugs before a merge.\n---\nOur own review.\n';

describe('builder inventory', () => {
  test('red: --json lists the project items with the worker report shape; text mode prints the mode line', () => {
    const { proj, cli } = project();
    write(proj, '.claude/skills/code-review/SKILL.md', OWN_REVIEW);
    const r = run(cli, proj, ['inventory', '--json']);
    assert.equal(r.status, 0, r.out);
    const j = JSON.parse(r.stdout);
    for (const k of ['mode', 'items', 'kitItems', 'overlaps', 'clashes', 'kitInstalled']) assert.ok(k in j, k);
    assert.ok(j.items.some((it) => it.path === '.claude/skills/code-review/SKILL.md'));
    assert.match(run(cli, proj, ['inventory']).out, /^mode: (greenfield|brownfield)/m);
  });

  test('red: the kit\'s own earlier install is not a project item, so a re-run raises no clash for it', () => {
    const { proj, cli } = project();
    assert.equal(run(cli, proj, ['unpack', '--tool', 'claude-code']).status, 0);
    const j = JSON.parse(run(cli, proj, ['inventory', '--json']).stdout);
    assert.ok(j.kitInstalled.includes('.claude/agents/module-planner.md'));
    assert.ok(!j.items.some((it) => it.path === '.claude/agents/module-planner.md'));
    assert.deepEqual(j.clashes.filter((k) => /^(agent|skill):/.test(k)), []);
  });

  test('--threshold narrows the wording matches; a bad one is refused', () => {
    const { proj, cli } = project();
    write(proj, '.claude/skills/code-review/SKILL.md', OWN_REVIEW);
    const j = JSON.parse(run(cli, proj, ['inventory', '--json', '--threshold', '1']).stdout);
    assert.ok(j.overlaps.every((p) => p.sameName || p.sameContent));
    assert.equal(run(cli, proj, ['inventory', '--threshold', 'lots']).status, 1);
  });
});

describe('builder choices', () => {
  test('red: set, list, check and unset work from the project root and write builder.choices.json there', () => {
    const { proj, cli } = project();
    const set = run(cli, proj, ['choices', 'set', 'skill:caveman', 'keep', '--by', 'tester', '--note', 'ours is better']);
    assert.equal(set.status, 0, set.out);
    const file = JSON.parse(readFileSync(join(proj, 'builder.choices.json'), 'utf8'));
    assert.equal(file.items['skill:caveman'].decision, 'keep');
    assert.match(run(cli, proj, ['choices', 'list']).out, /skill:caveman\s+keep/);
    assert.equal(run(cli, proj, ['choices', 'check']).status, 0);
    assert.equal(run(cli, proj, ['choices', 'unset', 'skill:caveman']).status, 0);
    assert.deepEqual(JSON.parse(readFileSync(join(proj, 'builder.choices.json'), 'utf8')).items, {});
  });

  test('red: a decision without --by is refused', () => {
    const { proj, cli } = project();
    const r = run(cli, proj, ['choices', 'set', 'skill:code-review', 'kit']);
    assert.equal(r.status, 1);
    assert.match(r.out, /--by/);
  });
});

describe('builder bootstrap', () => {
  const files = (root) => {
    const out = [];
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.name === 'builder' || e.name === 'node_modules') continue;
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else out.push(relative(root, p).split('\\').join('/'));
      }
    };
    walk(root);
    return out.sort();
  };

  test('red: a project with nothing detected gets the Claude Code skill only — nothing else is installed', () => {
    const { proj, cli } = project();
    const r = run(cli, proj, ['bootstrap']);
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(files(proj), ['.claude/skills/builder-init/SKILL.md', 'builder.lock.json']);
    assert.equal(readFileSync(join(proj, '.claude/skills/builder-init/SKILL.md'), 'utf8'), readFileSync(join(PACK, 'skills/builder-init.md'), 'utf8'));
    assert.match(r.out, /builder-init/);
  });

  test('red: detection — .codex/ or AGENTS.md means .agents/skills; CLAUDE.md adds the Claude Code copy', () => {
    const { proj, cli } = project();
    mkdirSync(join(proj, '.codex'));
    write(proj, 'CLAUDE.md', '# ours\n');
    assert.equal(run(cli, proj, ['bootstrap']).status, 0);
    assert.ok(existsSync(join(proj, '.agents/skills/builder-init/SKILL.md')));
    assert.ok(existsSync(join(proj, '.claude/skills/builder-init/SKILL.md')));
    assert.equal(readFileSync(join(proj, 'CLAUDE.md'), 'utf8'), '# ours\n', 'bootstrap wires no pointer');
    assert.ok(!existsSync(join(proj, '.codex', 'agents')));
  });

  test('--tool picks the tools; installed as a package the skill names npx builder', () => {
    const { proj, cli } = project('node_modules/@geopjinfo/builder-pipeline');
    const r = run(cli, proj, ['bootstrap', '--tool', 'antigravity']);
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(files(proj), ['.agents/skills/builder-init/SKILL.md', 'builder.lock.json']);
    assert.match(readFileSync(join(proj, '.agents/skills/builder-init/SKILL.md'), 'utf8'), /npx builder inventory/);
    assert.equal(run(cli, proj, ['bootstrap', '--tool', 'nope']).status, 1);
  });
});

const COMMANDS = ['unpack', 'upgrade', 'bootstrap', 'inventory', 'choices', 'doctor', 'personas-check', 'run', 'targets', 'verify', 'features', 'check-ledgers', 'check-targets'];

test('red: the usage text, the README command list and the next steps name every command', () => {
  const { proj, cli } = project();
  const usage = run(cli, proj, []);
  assert.equal(usage.status, 0);
  for (const c of COMMANDS) assert.match(usage.out, new RegExp(`\\b${c}\\b`), `usage: ${c}`);
  const readme = readFileSync(join(PACK, 'README.md'), 'utf8');
  for (const c of COMMANDS) assert.match(readme, new RegExp(`\`${c}[\\s\`]`), `README: ${c}`);
  assert.match(readme, /`antigravity`/);
  const next = run(cli, proj, ['unpack', '--tool', 'claude-code', '--dry-run']).out;
  assert.match(next, /cli\.js doctor/);
});

test('builder personas-check runs the kit script in the project folder', () => {
  const { proj, cli } = project();
  const r = run(cli, proj, ['personas-check']);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /personas-check: no personas\//);
});
