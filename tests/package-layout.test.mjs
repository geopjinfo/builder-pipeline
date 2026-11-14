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

describe('D2 — board-check-all runs from the package', () => {
  const { proj, cli } = project();
  assert.equal(run(cli, proj, ['unpack', '--tool', 'claude-code']).status, 0);
  copyFileSync(BOARD, join(proj, 'tasks', 'rooms.md'));

  test('red: a fresh board passes; the sibling scripts are found beside the script, not in the project', () => {
    assert.equal(run(cli, proj, ['run', 'board-progress', 'tasks/rooms.md']).status, 0);
    const r = run(cli, proj, ['run', 'board-check-all']);
    assert.doesNotMatch(out(r), /Cannot find module/);
    assert.equal(r.status, 0, out(r));
    assert.match(r.stdout, /board-check-all: PASS — 1 board\(s\) checked/);
  });

  test('red: a stale board fails, and the advice is the package form', () => {
    const board = join(proj, 'tasks', 'rooms.md');
    writeFileSync(board, readFileSync(board, 'utf8').replace(/\*\*TOTAL\*\* \| `[^`]*` \*\*\d+%\*\*/, '**TOTAL** | `░░░░░░░░░░░░░░░░░░░░` **0%**'));
    const r = run(cli, proj, ['run', 'board-check-all']);
    assert.equal(r.status, 1, out(r));
    assert.match(r.stderr, /npx builder run board-check-all --fix/);
    assert.doesNotMatch(r.stderr, /node scripts\//);
    const fixed = run(cli, proj, ['run', 'board-check-all', '--fix']);
    assert.equal(fixed.status, 0, out(fixed));
    assert.equal(run(cli, proj, ['run', 'board-check-all']).status, 0, 'rewritten for real');
  });

  test('red: --fix never reports PASS after a child failed', () => {
    const bad = join(proj, 'tasks', 'broken.md');
    writeFileSync(bad, '# broken\n\n<!-- progress:auto start -->\n<!-- progress:auto end -->\n\nno sections here\n');
    try {
      const r = run(cli, proj, ['run', 'board-check-all', '--fix']);
      assert.notEqual(r.status, 0, out(r));
      assert.doesNotMatch(r.stdout, /PASS/);
      assert.match(out(r), /broken\.md/);
    } finally {
      rmSync(bad);
    }
  });

  test('D11 red: board-progress takes a board key and resolves it through paths.boards', () => {
    const r = run(cli, proj, ['run', 'board-progress', 'rooms', '--check']);
    assert.equal(r.status, 0, out(r));
    assert.doesNotMatch(out(r), /ENOENT/);
    assert.equal(run(cli, proj, ['run', 'board-progress', 'no-such-board']).status, 1);
  });

  test('D11 red: builder run lists each script once', () => {
    const names = run(cli, proj, ['run']).stdout.split('\n').map((l) => l.trim()).filter(Boolean).slice(1);
    assert.deepEqual(names, [...new Set(names)]);
    assert.ok(names.includes('experimental/page-shell'));
  });

  test('control: in the folder layout the advice keeps the node scripts/ form', () => {
    const c = project('builder');
    assert.equal(run(c.cli, c.proj, ['unpack', '--tool', 'claude-code']).status, 0);
    copyFileSync(BOARD, join(c.proj, 'tasks', 'rooms.md'));
    const board = join(c.proj, 'tasks', 'rooms.md');
    writeFileSync(board, readFileSync(board, 'utf8').replace(/\*\*TOTAL\*\* \| `[^`]*` \*\*\d+%\*\*/, '**TOTAL** | `░░░░░░░░░░░░░░░░░░░░` **0%**'));
    const r = spawnSync(process.execPath, [join('scripts', 'board-check-all.mjs')], { cwd: c.proj, encoding: 'utf8' });
    assert.equal(r.status, 1, out(r));
    assert.match(r.stderr, /node scripts\/board-check-all\.mjs --fix/);
    assert.equal(spawnSync(process.execPath, [join('scripts', 'board-check-all.mjs'), '--fix'], { cwd: c.proj, encoding: 'utf8' }).status, 0);
  });
});
