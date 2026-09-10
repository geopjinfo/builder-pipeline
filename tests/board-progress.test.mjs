/**
 * scripts/board-progress.mjs — no path is a usage error; a board's progress block is rewritten from its
 * Status column, and `--check` then passes (and fails on a stale block).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, '..', 'scripts', 'board-progress.mjs');
const FIXTURE = join(here, 'fixtures', 'board', 'tasks', 'sample.md');

/** Run in a scratch directory that is not a git checkout, so the worktree hint stays silent. */
const run = (cwd, ...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', cwd });

const withCopy = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'board-progress-'));
  try {
    const board = join(dir, 'sample.md');
    copyFileSync(FIXTURE, board);
    fn(dir, board);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test('no path: exit 2 with usage, and nothing is read or written', () => {
  withCopy((dir) => {
    const bare = run(dir);
    assert.equal(bare.status, 2);
    assert.match(bare.stderr, /usage: node scripts\/board-progress\.mjs <board\.md>/);
    const flagsOnly = run(dir, '--check');
    assert.equal(flagsOnly.status, 2, 'a flag is not a path');
    assert.match(flagsOnly.stderr, /usage:/);
  });
});

test('a fixture board: rewrite, then --check exits 0', () => {
  withCopy((dir, board) => {
    const original = readFileSync(board, 'utf8');
    // Make the block stale so the rewrite has real work to do.
    writeFileSync(board, original.replace('| P2 — Code | `▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░` 67% | 4 | 1 | 6 |', '| P2 — Code | `░░░░░░░░░░░░░░░░░░░░` 0% | 0 | 0 | 6 |'));

    const stale = run(dir, board, '--check');
    assert.equal(stale.status, 1, 'red: a stale block fails --check');
    assert.match(stale.stderr, /STALE/);

    const rewrite = run(dir, board);
    assert.equal(rewrite.status, 0, rewrite.stderr);
    assert.match(rewrite.stdout, /progress block rewritten/);
    assert.equal(readFileSync(board, 'utf8'), original, 'the recomputed block matches the fixture, and nothing else moved');

    const check = run(dir, board, '--check');
    assert.equal(check.status, 0, check.stderr);
    assert.match(check.stdout, /TOTAL 63%  5\/8/);
    assert.match(check.stdout, /is up to date/);
  });
});
