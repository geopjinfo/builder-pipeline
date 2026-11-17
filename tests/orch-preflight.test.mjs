/**
 * Pre-launch checks and lane worktree hygiene — scripts/lib/orch-preflight.cjs and the gate-launch path
 * (plan M4, REQ-402, REQ-405, REQ-703, D50).
 */
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { PACK, git, lanes, orch, profileText, scratchRepo, tmp } from './fixtures/orch/rig.mjs';

const require = createRequire(import.meta.url);
const pre = require(join(PACK, 'scripts', 'lib', 'orch-preflight.cjs'));
const state = require(join(PACK, 'scripts', 'lib', 'orch-state.cjs'));

const temps = [];
after(() => temps.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** Every regular file under a worktree, project-relative, .git left out. */
function filesOf(dir, rel = '') {
  const out = [];
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    if (e.name === '.git') continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...filesOf(dir, r));
    else out.push(r);
  }
  return out.sort();
}

const worktreeBranches = (repo) => git(repo, 'worktree', 'list', '--porcelain').split(/\n/).filter((l) => l.startsWith('branch ')).map((l) => l.slice(7));

function accountsProfile(account = {}, feature = {}) {
  return profileText({
    orchestrator: { launchCommand: 'start-worker --brief "{brief}" --lane {lane}' },
    extraFeatures: { accounts: { state: 'on', accounts: { alpha: { worker: 'claude-code', pays: 'subscription', content: 'any', command: 'start-worker --brief "{brief}"', ...account } }, ...feature } },
  });
}

/** A run `r` with one claimed lane on the secondary seat, its worktree beside the primary. */
function claimedRun(repo, root, run, extra = {}) {
  state.init(root, run, lanes(1, extra), { repo, target: 'dev', worktreeBase: join(repo, '..'), worktreePrefix: 'wt-', preflightMode: 'parallel', seats: ['secondary'] });
  state.approve(root, run, 'human');
  state.setLane(root, run, 'l1', { status: 'CLAIMED' });
  return state.load(root, run).lanes.l1;
}

describe('REQ-405 lane worktree hygiene (createLaneWorktree)', () => {
  test('red: REQ-405 two lanes get two fresh branches named from the lane id, and git worktree list shows no shared branch', () => {
    const { dir, repo } = scratchRepo();
    temps.push(dir);
    const a = pre.createLaneWorktree({ repo, worktree: join(dir, 'wt-r1-l1'), branch: 'orch/r1-l1', base: 'dev' });
    const b = pre.createLaneWorktree({ repo, worktree: join(dir, 'wt-r1-l2'), branch: 'orch/r1-l2', base: 'dev' });
    assert.equal(a.fresh, true);
    assert.notEqual(a.branch, b.branch);
    const branches = worktreeBranches(repo);
    assert.deepEqual(branches.sort(), ['refs/heads/dev', 'refs/heads/orch/r1-l1', 'refs/heads/orch/r1-l2']);
    assert.equal(new Set(branches).size, branches.length, 'no two worktrees hold one branch');
  });

  test('red: REQ-405 a branch another worktree holds is refused, naming the holder; an existing folder is refused', () => {
    const { dir, repo } = scratchRepo();
    temps.push(dir);
    pre.createLaneWorktree({ repo, worktree: join(dir, 'wt-a'), branch: 'orch/held', base: 'dev' });
    assert.throws(() => pre.createLaneWorktree({ repo, worktree: join(dir, 'wt-b'), branch: 'orch/held', base: 'dev' }), /branch orch\/held is held by worktree .*wt-a.*fresh branch/);
    assert.throws(() => pre.createLaneWorktree({ repo, worktree: join(dir, 'wt-a'), branch: 'orch/other', base: 'dev' }), /already exists/);
    assert.throws(() => pre.createLaneWorktree({ repo, worktree: join(dir, 'wt-c'), branch: 'dev', base: 'dev' }), /branch dev is held by worktree/);
  });

  test('red: REQ-405 include: [".env"] copies the ignored file into the worktree — a regular file, never a symlink', () => {
    const { dir, repo } = scratchRepo({ files: { '.gitignore': '.env\n.pipeline/\nlogs/\n' } });
    temps.push(dir);
    writeFileSync(join(repo, '.env'), 'LANE_MARK=1\n');
    mkdirSync(join(repo, 'config', 'local'), { recursive: true });
    writeFileSync(join(repo, 'config', 'local', 'dev.json'), '{}\n');
    const r = pre.createLaneWorktree({ repo, worktree: join(dir, 'wt-env'), branch: 'orch/env', base: 'dev', include: ['.env', 'config/local/dev.json', 'missing.txt'] });
    const env = join(dir, 'wt-env', '.env');
    assert.ok(existsSync(env));
    assert.equal(lstatSync(env).isSymbolicLink(), false);
    assert.equal(lstatSync(env).isFile(), true);
    assert.equal(readFileSync(env, 'utf8'), 'LANE_MARK=1\n');
    assert.ok(existsSync(join(dir, 'wt-env', 'config', 'local', 'dev.json')));
    assert.deepEqual(r.copied, ['.env', 'config/local/dev.json']);
    assert.deepEqual(r.missing, ['missing.txt']);
  });

  test('red: REQ-402 path roots give a sparse worktree that holds only those roots', () => {
    const { dir, repo } = scratchRepo({ files: { 'src/public/a.ts': 'a\n', 'src/public/deep/b.ts': 'b\n', 'src/private/c.ts': 'c\n', 'docs/d.md': 'd\n' } });
    temps.push(dir);
    const r = pre.createLaneWorktree({ repo, worktree: join(dir, 'wt-sparse'), branch: 'orch/sparse', base: 'dev', roots: ['src/public'] });
    assert.deepEqual(filesOf(join(dir, 'wt-sparse')), ['src/public/a.ts', 'src/public/deep/b.ts']);
    assert.deepEqual(r.sparse, ['src/public']);
    assert.deepEqual(pre.sparseRoots(join(dir, 'wt-sparse')), ['src/public']);
    assert.equal(pre.sparseRoots(repo), null);
    assert.ok(pre.trackedFiles(repo, 'dev').includes('src/private/c.ts'));
  });
});

describe('REQ-703 pre-launch checks in gate-launch', () => {
  test("red: REQ-703 an account whose dir is missing: nothing launches and the output is the check line", () => {
    const home = tmp('home');
    temps.push(home);
    const { dir, repo, root } = scratchRepo({ profile: accountsProfile() });
    temps.push(dir);
    const l = claimedRun(repo, root, 'ad');
    const r = orch(repo, root, ['gate-launch', 'ad', 'l1'], { BUILDER_ACCOUNTS_HOME: home });
    assert.equal(r.status, 3, r.out);
    assert.match(r.out.trim(), /^CHECK account-dir: account alpha: dir .*alpha is missing — nothing launched/);
    assert.ok(!r.out.includes('start-worker'), 'the launch command was printed');
    assert.equal(existsSync(l.worktree), false, 'no worktree was created');
  });

  test('REQ-703 launchChecks: the session worker and a worker with no launcher are named; a known worker with its dir passes', () => {
    const home = tmp('home2');
    temps.push(home);
    const paths = { configDir: join(home, 'accounts', 'alpha') };
    assert.match(pre.launchChecks({ account: { name: 'alpha', worker: 'session' }, paths, homeExists: true })[0].message, /orchestrating session/);
    assert.match(pre.launchChecks({ account: { name: 'alpha', worker: 'codex', command: null }, paths, homeExists: false })[0].message, /no launcher here/);
    assert.deepEqual(pre.launchChecks({ account: { name: 'alpha', worker: 'codex', command: 'x {brief}' }, paths, homeExists: false }), []);
    assert.equal(pre.launchChecks({ account: { name: 'alpha', worker: 'claude-code' }, paths, homeExists: true })[0].check, 'account-dir');
    mkdirSync(paths.configDir, { recursive: true });
    assert.deepEqual(pre.launchChecks({ account: { name: 'alpha', worker: 'claude-code' }, paths, homeExists: true }), []);
  });

  test('red: REQ-405 gate-launch creates the lane worktree on a fresh branch with the include files copied, and a second gate-launch reuses it', () => {
    const home = tmp('home3');
    temps.push(home);
    mkdirSync(join(home, 'accounts', 'alpha'), { recursive: true });
    const { dir, repo, root } = scratchRepo({ profile: accountsProfile({}, { worktree: { include: ['.env'] } }), files: { '.gitignore': '.env\n.pipeline/\nlogs/\n' } });
    temps.push(dir);
    writeFileSync(join(repo, '.env'), 'LANE_MARK=1\n');
    const l = claimedRun(repo, root, 'wt');
    const r = orch(repo, root, ['gate-launch', 'wt', 'l1'], { BUILDER_ACCOUNTS_HOME: home });
    assert.equal(r.status, 0, r.out);
    assert.ok(existsSync(l.worktree));
    assert.equal(git(l.worktree, 'rev-parse', '--abbrev-ref', 'HEAD'), l.branch);
    assert.equal(lstatSync(join(l.worktree, '.env')).isSymbolicLink(), false);
    assert.equal(readFileSync(join(l.worktree, '.env'), 'utf8'), 'LANE_MARK=1\n');
    assert.equal(statSync(l.worktree).isDirectory(), true);
    const again = orch(repo, root, ['gate-launch', 'wt', 'l1'], { BUILDER_ACCOUNTS_HOME: home });
    assert.equal(again.status, 0, again.out);
    assert.equal(worktreeBranches(repo).filter((b) => b === `refs/heads/${l.branch}`).length, 1);
  });
});
