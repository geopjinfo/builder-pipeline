/**
 * branch-sweep (specs/repo-hygiene.spec.md, M18): one verdict per local branch, a snapshot ref before every
 * `git branch -d`, never `-D`, never a push. Each test names the acceptance criterion it asserts (AC-18nn → REQ-18nn).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const lib = require('../scripts/lib/branch-sweep.cjs');
const CLI = join(here, '..', 'scripts', 'branch-sweep.mjs');

const temps = [];
after(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const DAY = 24 * 3600 * 1000;

/** A repo on `main` with `merged` (contained in main) and `wip` (one commit ahead). */
function rig() {
  const parent = realpathSync.native(mkdtempSync(join(tmpdir(), 'branch-sweep-')));
  temps.push(parent);
  const repo = join(parent, 'app');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 'T');
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  git(repo, 'branch', 'merged');
  git(repo, 'checkout', '-q', '-b', 'wip');
  writeFileSync(join(repo, 'b.txt'), 'b\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'wip');
  git(repo, 'checkout', '-q', 'main');
  return { parent, repo };
}
const run = (cwd, args, env = {}) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: { ...process.env, BUILDER_ORCH_DIR: join(cwd, '.no-orch'), ...env } });
  return { status: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout };
};
const branches = (repo) => git(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').filter(Boolean).sort();

describe('branch-sweep — judge (pure)', () => {
  test('red: AC-1802 MERGED with age, STALE, KEEP for target, current, keep match, checked out — each with its reason', () => {
    const now = Date.parse('2026-11-17T12:00:00Z');
    const b = (name, days, sha = `sha-${name}`) => ({ name, sha, committedAt: now - days * DAY });
    const contained = new Set(['sha-main', 'sha-done', 'sha-release/1']);
    const items = lib.judge({
      branches: [b('main', 0), b('done', 12), b('old', 45), b('fresh', 2), b('release/1', 100), b('wt', 60), b('cur', 50)],
      target: 'main',
      current: 'cur',
      staleDays: 30,
      keep: ['release/*'],
      checkedOut: new Map([['wt', '/tmp/wt-lane']]),
      isAncestor: (sha) => contained.has(sha),
      held: new Map(),
      now,
    });
    const by = Object.fromEntries(items.map((i) => [i.name, i]));
    assert.equal(by.main.verdict, 'KEEP');
    assert.match(by.main.reasons.join(' '), /target/);
    assert.equal(by.done.verdict, 'MERGED');
    assert.equal(by.done.ageDays, 12);
    assert.match(by.done.reasons.join(' '), /contained in main/);
    assert.equal(by.old.verdict, 'STALE');
    assert.match(by.old.reasons.join(' '), /45 d/);
    assert.equal(by.fresh.verdict, 'KEEP');
    assert.match(by.fresh.reasons.join(' '), /not contained.*2 d/);
    assert.equal(by['release/1'].verdict, 'KEEP');
    assert.match(by['release/1'].reasons.join(' '), /keep: release\/\*/);
    assert.equal(by.wt.verdict, 'KEEP');
    assert.match(by.wt.reasons.join(' '), /checked out/);
    assert.equal(by.cur.verdict, 'KEEP');
    assert.match(by.cur.reasons.join(' '), /current branch/);
  });

  test('red: AC-1805 a branch a LAUNCHED orchestrator lane holds is KEEP, naming the run and the lane, even when contained', () => {
    const now = Date.parse('2026-11-17T12:00:00Z');
    const items = lib.judge({
      branches: [{ name: 'orch/l1', sha: 's1', committedAt: now - 3 * DAY }, { name: 'orch/l2', sha: 's2', committedAt: now - 3 * DAY }],
      target: 'main',
      current: 'main',
      staleDays: 30,
      keep: [],
      checkedOut: new Map(),
      isAncestor: () => true,
      held: new Map([['orch/l1', { run: 'r-7', lane: 'l1', status: 'LAUNCHED' }]]),
      now,
    });
    assert.equal(items[0].verdict, 'KEEP');
    assert.match(items[0].reasons.join(' '), /run r-7.*lane l1.*LAUNCHED/);
    assert.equal(items[1].verdict, 'MERGED');
  });

  test('red: AC-1805 heldBranches reads every run state under the orchestrator root and keeps only LAUNCHED and STALLED lanes', () => {
    const root = mkdtempSync(join(tmpdir(), 'orch-root-'));
    temps.push(root);
    const state = (run, lanes) => {
      mkdirSync(join(root, 'runs', run), { recursive: true });
      writeFileSync(join(root, 'runs', run, 'state.json'), JSON.stringify({ lanes }));
    };
    state('r-1', { a: { branch: 'orch/a', status: 'LAUNCHED' }, b: { branch: 'orch/b', status: 'MERGED' } });
    state('r-2', { c: { branch: 'orch/c', status: 'STALLED' } });
    const held = lib.heldBranches(root);
    assert.deepEqual([...held.keys()].sort(), ['orch/a', 'orch/c']);
    assert.deepEqual(held.get('orch/c'), { run: 'r-2', lane: 'c', status: 'STALLED' });
    assert.equal(lib.heldBranches(join(root, 'missing')).size, 0);
  });
});

describe('branch-sweep — CLI', () => {
  test('red: AC-1803b without --apply both branches remain and the first line says dry run', () => {
    const r = rig();
    const res = run(r.repo, ['--target', 'main']);
    assert.equal(res.status, 0, res.out);
    assert.match(res.stdout.split('\n')[0], /dry run/);
    assert.match(res.stdout, /^MERGED +merged /m);
    assert.match(res.stdout, /^KEEP +wip /m);
    assert.deepEqual(branches(r.repo), ['main', 'merged', 'wip']);
  });

  test('red: AC-1803 --apply writes refs/builder/branches/NAME, deletes with -d, keeps wip, prints the restore command', () => {
    const r = rig();
    const tip = git(r.repo, 'rev-parse', 'merged');
    const res = run(r.repo, ['--target', 'main', '--apply']);
    assert.equal(res.status, 0, res.out);
    assert.deepEqual(branches(r.repo), ['main', 'wip']);
    assert.equal(git(r.repo, 'rev-parse', 'refs/builder/branches/merged'), tip);
    assert.match(res.stdout, /git branch merged refs\/builder\/branches\/merged/);
    assert.match(res.stdout, /refs\/builder\/branches\/merged/);
  });

  test('red: AC-1807 no profile: the first line says the defaults are in use, verdicts print, exit 0; a missing --target is exit 2', () => {
    const r = rig();
    const res = run(r.repo, ['--target', 'main']);
    assert.equal(res.status, 0, res.out);
    assert.match(res.stdout.split('\n')[0], /^branchSweep: not configured — checking branches against main with defaults/);
    const none = run(r.repo, []);
    assert.equal(none.status, 0, none.out); // off and no target: the step says so, never guesses a branch
    assert.match(none.stdout, /^branchSweep: not configured$/m);
    const bad = run(r.repo, ['--stale-days']);
    assert.equal(bad.status, 2);
    assert.match(bad.out, /usage:/);
  });

  test('red: AC-1804 remote: list prints the push command and never pushes; --apply prunes the gone tracking ref only', () => {
    const r = rig();
    const bare = join(r.parent, 'origin.git');
    git(r.parent, 'init', '-q', '--bare', bare);
    git(r.repo, 'remote', 'add', 'origin', bare);
    git(r.repo, 'push', '-q', 'origin', 'main', 'merged', 'wip');
    // a tracking ref whose remote branch is gone
    // (a delete push drops the local tracking ref too, so the stale ref is written back by hand, as a fetch that missed
    // the deletion would leave it)
    git(r.repo, 'branch', 'gone');
    git(r.repo, 'push', '-q', 'origin', 'gone');
    git(r.repo, 'push', '-q', 'origin', '--delete', 'gone');
    git(r.repo, 'update-ref', 'refs/remotes/origin/gone', git(r.repo, 'rev-parse', 'gone'));
    git(r.repo, 'branch', '-D', 'gone');
    assert.ok(git(r.repo, 'for-each-ref', 'refs/remotes/origin/gone'));
    const res = run(r.repo, ['--target', 'main', '--apply']);
    assert.equal(res.status, 0, res.out);
    assert.match(res.stdout, /git push origin --delete merged/);
    assert.ok(git(bare, 'for-each-ref', 'refs/heads/merged'), 'the remote branch is untouched');
    assert.equal(git(r.repo, 'for-each-ref', 'refs/remotes/origin/gone'), '', 'the gone tracking ref is pruned');
    assert.ok(git(r.repo, 'for-each-ref', 'refs/remotes/origin/wip'));
  });

  test('red: AC-1806b the sweep sources hold no force delete, recursive delete or push', () => {
    const { readFileSync } = require('node:fs');
    for (const f of ['scripts/lib/branch-sweep.cjs', 'scripts/branch-sweep.mjs']) {
      const src = readFileSync(join(here, '..', f), 'utf8').replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '');
      assert.doesNotMatch(src, /'-D'|"-D"|branch -D/, f);
      assert.doesNotMatch(src, /recursive:\s*true/, f);
      assert.doesNotMatch(src, /\['push'|"push",/, f);
    }
  });
});
