/**
 * The gate-queue CLI (scripts/gate-queue.mjs), spawned for real against a throwaway git repository. The pure
 * functions have their own suite (gate-queue.test.mjs); this one holds what only the CLI does: it reads the
 * profile, resolves shas with git, writes `<boards>/_gate-queue.md`, and maps each refusal to its exit code
 * (0 ok · 1 refused · 2 feature off / still owed / still open · 3 at the cap · 10 status: something owed).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', 'scripts', 'gate-queue.mjs');
const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  GIT_CONFIG_NOSYSTEM: '1',
};

const profile = (state, cap = 1) =>
  '# profile\n\n```json pipeline-settings\n' +
  JSON.stringify({ schema: 2, features: { liteSplit: { state, cap, trigger: 1 } } }, null, 2) +
  '\n```\n';

function repo(state = 'experimental-on') {
  const dir = mkdtempSync(join(tmpdir(), 'gate-queue-cli-'));
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: dir, env: ENV, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git('init', '-q', '-b', 'lite/batch-one');
  git('config', 'commit.gpgsign', 'false');
  mkdirSync(join(dir, 'tasks'));
  writeFileSync(join(dir, 'tasks', 'README.md'), '# boards\n');
  writeFileSync(join(dir, 'PIPELINE_PROFILE.md'), profile(state));
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  const commit = (file, text, msg) => {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
    git('add', '-A');
    git('commit', '-q', '-m', msg);
    return git('rev-parse', 'HEAD');
  };
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: dir, env: ENV, encoding: 'utf8' });
  const queue = join(dir, 'tasks', '_gate-queue.md');
  return { dir, git, base, commit, run, queue, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const MODULE = ['1', '2', '3', '3a', '4', '5', '6', '7'];
const BATCH = ['3b', 'gates', 'integration', 'e2e', '6.5'];

test('gate-queue CLI: feature off exits 2 and writes nothing', () => {
  const r = repo('off');
  try {
    const out = r.run('add', 'alpha', '--base', r.base);
    assert.equal(out.status, 2, out.stderr);
    assert.match(out.stderr, /liteSplit/);
    assert.equal(existsSync(r.queue), false);
  } finally {
    r.done();
  }
});

test('gate-queue CLI: add, cap, mark, stale-sha refusal, retip ancestry, close and reset — with their exit codes', () => {
  const r = repo();
  try {
    const a1 = r.commit('src/alpha/alpha.cjs', 'module.exports = 1;\n', 'alpha built');

    // usage and argument refusals
    assert.equal(r.run('frobnicate').status, 1);
    assert.equal(r.run('add', 'alpha').status, 1, 'add without --base is refused');

    // add: queued from base..HEAD, written to <boards>/_gate-queue.md
    const add = r.run('add', 'alpha', '--base', r.base, '--dir', 'src/alpha');
    assert.equal(add.status, 0, add.stderr);
    assert.match(add.stdout, /alpha queued BUILT-UNGATED .*1 files/);
    assert.ok(existsSync(r.queue));
    assert.match(readFileSync(r.queue, 'utf8'), /src\/alpha\/alpha\.cjs/);
    assert.equal(r.run('add', 'alpha', '--base', r.base).status, 1, 'a key is queued once');
    const cap = r.run('add', 'beta', '--base', r.base);
    assert.equal(cap.status, 3, 'cap 1 reached');
    assert.match(cap.stderr, /cap 1 reached/);

    // status before anything is proven: exit 10
    assert.equal(r.run('status').status, 10);

    // mark: a DONE needs evidence; an unknown phase is refused
    assert.equal(r.run('mark', 'alpha', '3').status, 1, 'no --evidence');
    assert.equal(r.run('mark', 'alpha', '9', '--evidence', 'x').status, 1, 'not a phase');
    for (const p of MODULE) assert.equal(r.run('mark', 'alpha', p, '--evidence', `phase ${p} -> ok`).status, 0);
    for (const c of BATCH) assert.equal(r.run('mark', 'batch', c, '--evidence', `${c} -> ok`).status, 0);
    const clean = r.run('status');
    assert.equal(clean.status, 0, clean.stdout);
    assert.match(clean.stdout, /verdict: 1 open of cap 1/);

    // reset while a module is open: exit 2
    assert.equal(r.run('reset').status, 2);

    // the code moves after every DONE was stamped: the stamps are stale, close refuses with exit 2
    const a2 = r.commit('src/alpha/alpha.cjs', 'module.exports = 2;\n', 'FIX-1');
    const stale = r.run('status');
    assert.equal(stale.status, 10);
    assert.match(stale.stdout, /OWED .*P3 test/);
    assert.doesNotMatch(stale.stdout.split('\n').find((l) => /^alpha/.test(l)), /P1 plan|P2 build/, 'plan and build never go stale');
    const refused = r.run('close', 'alpha');
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /still OWED/);

    // retip: a side branch that does not descend from the recorded tip is refused (exit 1); the real tip is taken
    r.git('checkout', '-q', '-b', 'side', r.base);
    const side = r.commit('src/alpha/side.cjs', 'x\n', 'side');
    r.git('checkout', '-q', 'lite/batch-one');
    const bad = r.run('retip', 'alpha', '--tip', side);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /does not descend/);
    assert.equal(r.run('retip', 'alpha', '--tip', a2).status, 0);
    assert.notEqual(a1, a2);

    // re-prove what went stale at the new HEAD, then close and reset
    for (const p of MODULE.slice(2)) assert.equal(r.run('mark', 'alpha', p, '--evidence', `phase ${p} again -> ok`).status, 0);
    for (const c of BATCH) assert.equal(r.run('mark', 'batch', c, '--evidence', `${c} again -> ok`).status, 0);
    const closed = r.run('close', 'alpha');
    assert.equal(closed.status, 0, closed.stderr);
    assert.match(closed.stdout, /alpha GATED/);
    assert.equal(r.run('retip', 'alpha', '--tip', a2).status, 1, 'a GATED key keeps its range');
    assert.equal(r.run('status').status, 0);
    assert.equal(r.run('reset').status, 0);
    assert.doesNotMatch(readFileSync(r.queue, 'utf8'), /alpha/);
  } finally {
    r.done();
  }
});
