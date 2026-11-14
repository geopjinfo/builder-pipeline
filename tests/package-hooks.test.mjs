/**
 * The kit installed as a package (node_modules/@geopjinfo/builder-pipeline) — what the sample-project run found broken:
 *   D2  board-check-all spawned `scripts/board-progress.mjs` relative to the working directory, and its --fix printed
 *       PASS after the child crashed;
 *   D3  the board-render and instruction-lint hooks looked for `<project>/scripts/lib`, which a package install never
 *       creates, so they were silent no-ops;
 *   D7  the docs the install sends the agent to named the folder-layout commands;
 *   D8  installed files named `scripts/…` and `builder/` paths that do not exist in this layout;
 *   D11 board-progress took a path only, not the board key the docs use.
 * The folder layout (kit copied in as `builder/`) is the control: it keeps its `node scripts/…` forms.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const PACK = join(dirname(fileURLToPath(import.meta.url)), '..');
const BOARD = join(PACK, 'tests', 'fixtures', 'board', 'tasks', 'sample.md');
const made = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

const git = (cwd, ...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8' });

function project(kitAt = 'node_modules/@geopjinfo/builder-pipeline') {
  const proj = mkdtempSync(join(tmpdir(), 'kit-pkg-'));
  made.push(proj);
  const kit = join(proj, ...kitAt.split('/'));
  mkdirSync(kit, { recursive: true });
  cpSync(PACK, kit, { recursive: true, filter: (src) => !/[\\/](?:\.git|tests|node_modules)(?:[\\/]|$)/.test(`/${relative(PACK, src)}`) });
  return { proj, kit, cli: join(kit, 'cli.js') };
}
const run = (cli, cwd, args, env = {}) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
const out = (r) => `${r.stdout}${r.stderr}`;

/** Every file under a folder (posix, relative to `root`), skipping the kit itself. */
function files(root, from = root) {
  const acc = [];
  if (!existsSync(from)) return acc;
  for (const e of readdirSync(from, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'builder' || e.name === '.git') continue;
    const p = join(from, e.name);
    if (e.isDirectory()) acc.push(...files(root, p));
    else acc.push(relative(root, p).split('\\').join('/'));
  }
  return acc;
}

describe('D3 — the hooks find the kit in the package', () => {
  /** A committed project with the kit installed as a package: the hooks trust what the committed lock records. */
  function installed() {
    const p = project();
    git(p.proj, 'init', '-q');
    writeFileSync(join(p.proj, '.gitignore'), 'node_modules/\n');
    const u = run(p.cli, p.proj, ['unpack', '--tool', 'claude-code']);
    assert.equal(u.status, 0, out(u));
    const lock = JSON.parse(readFileSync(join(p.proj, 'builder.lock.json'), 'utf8'));
    assert.ok(lock.package && lock.package.files['scripts/lib/profile.cjs'], 'the lock records the package files the hooks run');
    git(p.proj, 'add', '-A');
    git(p.proj, 'commit', '-q', '-m', 'setup');
    return p;
  }
  const hook = (proj, file, input) =>
    spawnSync(process.execPath, [join(proj, '.claude', 'hooks', file)], { cwd: proj, input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: proj } });

  test('red: board-render loads its libraries from the package', () => {
    const { proj } = installed();
    const r = hook(proj, 'board-render.cjs', { tool_name: 'Write', tool_input: { file_path: join(proj, 'x.md') } });
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.stderr, /not found|not run/, r.stderr);
  });

  test('red: board-render renders a stale board through the package script', () => {
    const { proj } = installed();
    copyFileSync(BOARD, join(proj, 'tasks', 'rooms.md'));
    mkdirSync(join(proj, '.pipeline', 'rooms'), { recursive: true });
    writeFileSync(join(proj, '.pipeline', 'rooms', 'run.jsonl'), `${JSON.stringify({ ts: new Date().toISOString(), kind: 'phase', phase: 'P1', status: 'start' })}\n`);
    const r = hook(proj, 'board-render.cjs', { tool_name: 'Write', tool_input: { file_path: join(proj, 'tasks', 'rooms.md') } });
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.stderr, /not found|not run/, r.stderr);
    assert.ok(existsSync(join(proj, 'tasks', 'rooms.html')), `the page was rendered: ${r.stderr}`);
  });

  test('red: instruction-lint runs the package lint on an instruction-file edit', () => {
    const { proj } = installed();
    const prof = join(proj, 'PIPELINE_PROFILE.md');
    writeFileSync(prof, `# Profile\n\n\`\`\`json pipeline-settings\n${JSON.stringify({ schema: 2, features: { instructionLint: { state: 'on', files: ['CLAUDE.md'] } } })}\n\`\`\`\n`);
    writeFileSync(join(proj, 'CLAUDE.md'), `${readFileSync(join(proj, 'CLAUDE.md'), 'utf8')}\nRead \`docs/never-written.md\` first.\n`);
    git(proj, 'add', '-A');
    git(proj, 'commit', '-q', '-m', 'lint on');
    const r = hook(proj, 'instruction-lint-on-edit.cjs', { tool_name: 'Edit', tool_input: { file_path: join(proj, 'CLAUDE.md') } });
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.stdout, /not run|not found/, r.stdout);
    const lint = run(join(proj, 'node_modules', '@geopjinfo', 'builder-pipeline', 'cli.js'), proj, ['run', 'instruction-lint', '--files', 'CLAUDE.md']);
    assert.equal(lint.status, 1, `the lint itself fails on the dead path: ${out(lint)}`);
    assert.match(r.stdout, /"decision":"block"/, `the lint ran and failed on the dead path: ${r.stdout}`);
    assert.match(r.stdout, /never-written/);
  });

  test('red: a package file changed after the lock was committed is not run', () => {
    const { proj, kit } = installed();
    const lib = join(kit, 'scripts', 'lib', 'board-freshness.cjs');
    writeFileSync(lib, `${readFileSync(lib, 'utf8')}\n// edited\n`);
    const r = hook(proj, 'board-render.cjs', { tool_name: 'Write', tool_input: { file_path: join(proj, 'x.md') } });
    assert.equal(r.status, 0);
    assert.match(r.stderr, /not run/);
    assert.match(r.stderr, /board-freshness\.cjs/);
  });

  test('red: an uncommitted lock does not vouch for the package', () => {
    const { proj } = installed();
    const lockAbs = join(proj, 'builder.lock.json');
    writeFileSync(lockAbs, readFileSync(lockAbs, 'utf8').replace('"kit"', '"kit" ') );
    const r = hook(proj, 'board-render.cjs', { tool_name: 'Write', tool_input: { file_path: join(proj, 'x.md') } });
    assert.match(r.stderr, /not run/);
  });

  test('red: registry-read-guard names the package run form', () => {
    const { proj } = installed();
    const prof = join(proj, 'PIPELINE_PROFILE.md');
    writeFileSync(prof, readFileSync(prof, 'utf8').replace('"registryGuard":    { "state": "off", "seats": [] }', '"registryGuard":    { "state": "on", "seats": ["module-builder"] }'));
    git(proj, 'add', '-A');
    git(proj, 'commit', '-q', '-m', 'guard on');
    const r = hook(proj, 'registry-read-guard.cjs', { tool_name: 'Read', agent_type: 'module-builder', tool_input: { file_path: join(proj, 'DEFERRED_TASKS.md') } });
    assert.match(out(r), /Blocked Read/, out(r));
    assert.doesNotMatch(out(r), /node scripts\//);
    assert.match(out(r), /npx builder run ledger-row registry/);
  });
});
