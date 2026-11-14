/**
 * D3 — installed as a package (node_modules/@geopjinfo/builder-pipeline), the board-render and instruction-lint hooks
 * looked for `<project>/scripts/lib`, which a package install never creates, so they were silent no-ops.
 *
 * The design: a hook never loads anything from node_modules (agent-writable, outside the project's history). unpack
 * copies the few scripts the hooks use next to them, `.claude/hooks/kit/` (mirroring scripts/): kit-owned, locked,
 * committed, and checked against HEAD like every project file. The folder layout keeps loading the project's scripts/.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const PACK = join(dirname(fileURLToPath(import.meta.url)), '..');
const BOARD = join(PACK, 'tests', 'fixtures', 'board', 'tasks', 'sample.md');
const made = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

const git = (cwd, ...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8' });
const run = (cli, cwd, args) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });
const out = (r) => `${r.stdout}${r.stderr}`;
const HOOKS = ['.claude', 'hooks'];

function project(kitAt = 'node_modules/@geopjinfo/builder-pipeline') {
  const proj = mkdtempSync(join(tmpdir(), 'kit-hooks-'));
  made.push(proj);
  const kit = join(proj, ...kitAt.split('/'));
  mkdirSync(kit, { recursive: true });
  cpSync(PACK, kit, { recursive: true, filter: (src) => !/[\\/](?:\.git|tests|node_modules)(?:[\\/]|$)/.test(`/${relative(PACK, src)}`) });
  return { proj, kit, cli: join(kit, 'cli.js') };
}

/** A committed project with the kit installed as a package (node_modules ignored, as npm projects do). */
function installed({ profile } = {}) {
  const p = project();
  git(p.proj, 'init', '-q');
  writeFileSync(join(p.proj, '.gitignore'), 'node_modules/\n');
  const u = run(p.cli, p.proj, ['unpack', '--tool', 'claude-code']);
  assert.equal(u.status, 0, out(u));
  if (profile) writeFileSync(join(p.proj, 'PIPELINE_PROFILE.md'), `# Profile\n\n\`\`\`json pipeline-settings\n${JSON.stringify({ schema: 2, ...profile })}\n\`\`\`\n`);
  git(p.proj, 'add', '-A');
  git(p.proj, 'commit', '-q', '-m', 'setup');
  return p;
}
const hook = (proj, file, input) =>
  spawnSync(process.execPath, [join(proj, ...HOOKS, file)], { cwd: proj, input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: proj } });
const staleBoard = (proj) => {
  copyFileSync(BOARD, join(proj, 'tasks', 'rooms.md'));
  mkdirSync(join(proj, '.pipeline', 'rooms'), { recursive: true });
  writeFileSync(join(proj, '.pipeline', 'rooms', 'run.jsonl'), `${JSON.stringify({ ts: new Date().toISOString(), kind: 'phase', phase: 'P1', status: 'start' })}\n`);
};
const LINT_ON = { features: { instructionLint: { state: 'on', files: ['CLAUDE.md'] } } };

describe('D3 — the hooks run committed copies beside them, never node_modules', () => {
  test('red: unpack vendors the hook scripts beside the hooks, kit-owned and locked', () => {
    const { proj } = installed();
    const lock = JSON.parse(readFileSync(join(proj, 'builder.lock.json'), 'utf8')).files;
    for (const rel of ['kit/lib/profile.cjs', 'kit/lib/board-freshness.cjs', 'kit/board-render.mjs', 'kit/instruction-lint.mjs']) {
      assert.ok(existsSync(join(proj, ...HOOKS, ...rel.split('/'))), rel);
      assert.match(lock[`.claude/hooks/${rel}`] || '', /^[0-9a-f]{64}$/, `${rel} is locked`);
    }
    assert.equal(lock.package, undefined);
  });

  test('red: with node_modules deleted after unpack, board-render renders a stale board', () => {
    const { proj } = installed();
    rmSync(join(proj, 'node_modules'), { recursive: true, force: true });
    staleBoard(proj);
    const r = hook(proj, 'board-render.cjs', { tool_name: 'Write', tool_input: { file_path: join(proj, 'tasks', 'rooms.md') } });
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.stderr, /not found|not run/, r.stderr);
    assert.ok(existsSync(join(proj, 'tasks', 'rooms.html')), `the page was rendered: ${r.stderr}`);
  });

  test('red: with node_modules deleted, instruction-lint runs and blocks a dead path', () => {
    const { proj } = installed({ profile: LINT_ON });
    rmSync(join(proj, 'node_modules'), { recursive: true, force: true });
    writeFileSync(join(proj, 'CLAUDE.md'), `${readFileSync(join(proj, 'CLAUDE.md'), 'utf8')}\nRead \`docs/never-written.md\` first.\n`);
    git(proj, 'add', '-A');
    git(proj, 'commit', '-q', '-m', 'edit');
    const r = hook(proj, 'instruction-lint-on-edit.cjs', { tool_name: 'Edit', tool_input: { file_path: join(proj, 'CLAUDE.md') } });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /"decision":"block"/, r.stdout);
    assert.match(r.stdout, /never-written/);
  });

  test('red: node_modules not installed (fresh clone) → the pointer block is not a dead path; "not configured", allowed', () => {
    const { proj } = installed({ profile: LINT_ON });
    rmSync(join(proj, 'node_modules'), { recursive: true, force: true });
    // The hook runs its vendored copy — there is no scripts/ copy in the package layout.
    assert.ok(existsSync(join(proj, ...HOOKS, 'kit', 'instruction-lint.mjs')));
    assert.ok(!existsSync(join(proj, 'scripts', 'instruction-lint.mjs')));
    assert.match(readFileSync(join(proj, 'CLAUDE.md'), 'utf8'), /node_modules\/@geopjinfo\/builder-pipeline\//, 'the pointer cites the package');
    const r = hook(proj, 'instruction-lint-on-edit.cjs', { tool_name: 'Edit', tool_input: { file_path: join(proj, 'CLAUDE.md') } });
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.stdout, /"decision":"block"/, r.stdout);
    assert.match(r.stdout, /not configured/, r.stdout);
    assert.match(r.stdout, /npm install/, r.stdout);
    // A real dead path beside it still blocks, and the uninstalled package is not reported as one.
    writeFileSync(join(proj, 'CLAUDE.md'), `${readFileSync(join(proj, 'CLAUDE.md'), 'utf8')}\nRead \`docs/never-written.md\` first.\n`);
    const dead = hook(proj, 'instruction-lint-on-edit.cjs', { tool_name: 'Edit', tool_input: { file_path: join(proj, 'CLAUDE.md') } });
    assert.match(dead.stdout, /"decision":"block"/, dead.stdout);
    assert.doesNotMatch(dead.stdout, /builder-pipeline\/[^`]*` does not exist/, dead.stdout);
  });

  test('red: no vendored copy → "not found", never a fallback into node_modules', () => {
    const { proj } = installed();
    rmSync(join(proj, ...HOOKS, 'kit'), { recursive: true, force: true });
    git(proj, 'add', '-A');
    git(proj, 'commit', '-q', '-m', 'drop kit');
    staleBoard(proj);
    const r = hook(proj, 'board-render.cjs', { tool_name: 'Write', tool_input: { file_path: join(proj, 'tasks', 'rooms.md') } });
    assert.match(r.stderr, /not run — .*not found/);
    assert.ok(!existsSync(join(proj, 'tasks', 'rooms.html')), 'nothing was rendered from node_modules');
  });

  test('red: a vendored file that requires into node_modules is refused, even committed', () => {
    const { proj } = installed();
    const trust = require(join(proj, ...HOOKS, 'hook-trust.cjs'));
    const lib = join(proj, ...HOOKS, 'kit', 'lib', 'profile.cjs');
    writeFileSync(lib, `require('../../../../node_modules/@geopjinfo/builder-pipeline/scripts/lib/profile.cjs');\n${readFileSync(lib, 'utf8')}`);
    git(proj, 'add', '-A', '-f');
    git(proj, 'commit', '-q', '-m', 'planted');
    const r = trust.locate(proj, join(proj, ...HOOKS), join('lib', 'profile.cjs'));
    assert.equal(r.ok, false);
    assert.match(r.reason, /under node_modules/);
  });

  test('red: a vendored file edited after the commit is not run', () => {
    const { proj } = installed();
    const lib = join(proj, ...HOOKS, 'kit', 'lib', 'board-freshness.cjs');
    writeFileSync(lib, `${readFileSync(lib, 'utf8')}\n// edited\n`);
    const r = hook(proj, 'board-render.cjs', { tool_name: 'Write', tool_input: { file_path: join(proj, 'x.md') } });
    assert.equal(r.status, 0);
    assert.match(r.stderr, /not run — .*board-freshness/);
  });

  test('red: registry-read-guard names the package run form', () => {
    const { proj } = installed({ profile: { paths: { registry: 'DEFERRED_TASKS.md' }, features: { registryGuard: { state: 'on', seats: ['module-builder'] } } } });
    const r = hook(proj, 'registry-read-guard.cjs', { tool_name: 'Read', agent_type: 'module-builder', tool_input: { file_path: join(proj, 'DEFERRED_TASKS.md') } });
    assert.match(out(r), /Blocked Read/, out(r));
    assert.match(out(r), /npx builder run ledger-row registry/);
  });

  test('control: the folder layout vendors nothing — the hooks load the project scripts/', () => {
    const c = project('builder');
    assert.equal(run(c.cli, c.proj, ['unpack', '--tool', 'claude-code']).status, 0);
    assert.ok(!existsSync(join(c.proj, ...HOOKS, 'kit')));
    assert.ok(existsSync(join(c.proj, 'scripts', 'lib', 'profile.cjs')));
  });
});
