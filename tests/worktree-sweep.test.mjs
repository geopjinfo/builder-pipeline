import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const sweep = require('../scripts/lib/worktree-sweep.cjs');
const profile = require('../scripts/lib/profile.cjs');
const CLI = join(here, '..', 'scripts', 'worktree-sweep.mjs');

const temps = [];
after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const LATER = Date.now() + 7 * 3600 * 1000; // every file is "old" against this clock

/** A primary repo on branch `main` with a node_modules dir, worktrees created as siblings under one parent. */
function rig() {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'wt-sweep-')));
  temps.push(parent);
  const repo = join(parent, 'app');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 'T');
  git(repo, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(repo, '.gitignore'), 'node_modules\nlogs\n.pipeline\n');
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  mkdirSync(join(repo, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(repo, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n');
  return { parent, repo };
}
const addWt = (r, name) => {
  const wt = join(r.parent, name);
  git(r.repo, 'worktree', 'add', '-q', '-b', `b/${name}`, wt);
  return wt;
};
const opts = (r, over = {}) => ({ repo: r.repo, target: 'main', procLines: [], now: LATER, cwd: r.repo, ...over });
const verdict = (items, name) => items.find((i) => i.name === name);

describe('worktree sweep — plan', () => {
  test('a merged, clean, idle worktree is SWEEP; the primary is always KEEP', () => {
    const r = rig();
    addWt(r, 'wt-done');
    const items = sweep.plan(opts(r));
    assert.equal(verdict(items, 'wt-done').verdict, 'SWEEP');
    assert.deepEqual(verdict(items, 'app').reasons, ['primary checkout']);
  });

  test('red: unmerged, dirty, untracked, reserved, recently touched, named by a process, or check unavailable — each is KEEP with its reason', () => {
    const r = rig();
    const ahead = addWt(r, 'wt-ahead');
    writeFileSync(join(ahead, 'b.txt'), 'b\n');
    git(ahead, 'add', '.');
    git(ahead, 'commit', '-q', '-m', 'ahead');
    const dirty = addWt(r, 'wt-dirty');
    writeFileSync(join(dirty, 'a.txt'), 'changed\n');
    const untracked = addWt(r, 'wt-untracked');
    writeFileSync(join(untracked, 'new.txt'), 'n\n');
    addWt(r, 'wt-lane');
    addWt(r, 'wt-busy');
    const items = sweep.plan(opts(r, { reserved: ['wt-lane'], procLines: [`node runner.js --cwd ${join(r.parent, 'wt-busy')}`] }));
    assert.match(verdict(items, 'wt-ahead').reasons.join(';'), /not merged into main \(1 commit\(s\) ahead\)/);
    assert.match(verdict(items, 'wt-dirty').reasons.join(';'), /uncommitted\/untracked change/);
    assert.match(verdict(items, 'wt-untracked').reasons.join(';'), /uncommitted\/untracked change/);
    assert.deepEqual(verdict(items, 'wt-lane').reasons, ['reserved folder']);
    assert.deepEqual(verdict(items, 'wt-busy').reasons, ['a running process names it']);

    const fresh = sweep.plan(opts(r, { now: Date.now() }));
    assert.match(verdict(fresh, 'wt-lane').reasons.join(';'), /touched \d+ min ago \(idle threshold 6 h\)/);
    const blind = sweep.plan(opts(r, { procLines: null }));
    assert.match(verdict(blind, 'wt-lane').reasons.join(';'), /process check could not run/);
  });

  test('red: a folder outside the prefix is never considered', () => {
    const r = rig();
    addWt(r, 'wt-done');
    addWt(r, 'scratch');
    const items = sweep.plan(opts(r, { prefix: 'wt-' }));
    assert.equal(verdict(items, 'wt-done').verdict, 'SWEEP');
    assert.deepEqual(verdict(items, 'scratch').reasons, ['name outside the sweep prefix "wt-"']);
  });

  test('red: the hold command holds on exit 1 (its reason) and fails closed on any other exit; exit 0 frees', () => {
    const r = rig();
    addWt(r, 'wt-done');
    const held = sweep.plan(opts(r, { holdCommand: 'x {path}', runHold: () => ({ code: 1, out: 'job 7 queued\nmore' }) }));
    assert.deepEqual(verdict(held, 'wt-done').reasons, ['held: job 7 queued']);
    const broken = sweep.plan(opts(r, { holdCommand: 'x {path}', runHold: () => ({ code: 127, out: '' }) }));
    assert.deepEqual(verdict(broken, 'wt-done').reasons, ['hold check failed (exit 127)']);
    const seen = [];
    const free = sweep.plan(opts(r, { holdCommand: 'x {path}', runHold: (cmd, p) => (seen.push([cmd, p]), { code: 0, out: '' }) }));
    assert.equal(verdict(free, 'wt-done').verdict, 'SWEEP');
    assert.deepEqual(seen, [['x {path}', join(r.parent, 'wt-done')]]);
  });

  test('a target branch is required', () => {
    const r = rig();
    assert.throws(() => sweep.plan(opts(r, { target: null })), /target branch is required/);
  });
});

describe('worktree sweep — apply', () => {
  test('red: --apply backs up the evidence, unlinks the node_modules junction WITHOUT emptying the primary\'s, removes the worktree, keeps the branch', () => {
    const r = rig();
    const wt = addWt(r, 'wt-done');
    symlinkSync(join(r.repo, 'node_modules'), join(wt, 'node_modules'), 'junction');
    mkdirSync(join(wt, 'logs'), { recursive: true });
    writeFileSync(join(wt, 'logs', 'run-1.log'), 'evidence\n');
    mkdirSync(join(wt, '.pipeline', 'k1'), { recursive: true });
    writeFileSync(join(wt, '.pipeline', 'k1', 'state.md'), 'state\n');
    const lines = [];
    const out = sweep.run({ ...opts(r), apply: true, date: '2026-10-14', report: (l) => lines.push(l) });
    assert.deepEqual(out.failed, []);
    assert.equal(existsSync(wt), false);
    assert.equal(readFileSync(join(r.repo, 'node_modules', 'pkg', 'index.js'), 'utf8'), 'module.exports = 1;\n');
    assert.deepEqual([out.nmBefore, out.nmAfter], [1, 1]);
    const bk = join(r.repo, 'logs', 'backups', 'worktrees-2026-10-14', 'wt-done');
    assert.equal(readFileSync(join(bk, 'logs', 'run-1.log'), 'utf8'), 'evidence\n');
    assert.equal(readFileSync(join(bk, '.pipeline', 'k1', 'state.md'), 'utf8'), 'state\n');
    assert.match(git(r.repo, 'branch', '--list', 'b/wt-done'), /b\/wt-done/);
    assert.doesNotMatch(git(r.repo, 'worktree', 'list'), /wt-done/);
    assert.ok(lines.some((l) => /^SWEPT wt-done \[b\/wt-done\] — backup .*; branch kept$/.test(l)), lines.join('\n'));
  });

  test('a dry run removes nothing', () => {
    const r = rig();
    const wt = addWt(r, 'wt-done');
    const out = sweep.run({ ...opts(r), apply: false });
    assert.equal(out.swept.length, 1);
    assert.equal(existsSync(wt), true);
    assert.match(out.summary, /would remove 1, kept 1 · dry run/);
  });

  test('the module never uses a recursive delete or --force (git refuses what it would lose)', () => {
    const src = readFileSync(join(here, '..', 'scripts', 'lib', 'worktree-sweep.cjs'), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
    assert.doesNotMatch(src, /rmSync|rmdirSync|force:\s*true|'--force'|'-f'/);
    assert.match(src, /\['worktree', 'remove', item\.path\]/);
  });
});

describe('worktree sweep — settings and CLI', () => {
  const profileText = (feature) => `\`\`\`json pipeline-settings\n${JSON.stringify({ schema: 2, features: { worktreeSweep: feature } })}\n\`\`\`\n`;

  test('red: the profile refuses a missing target, a hold command without {path}, and a bad idleHours', () => {
    const errs = (f) => profile.parse(profileText(f)).errors;
    assert.deepEqual(errs({ state: 'on', target: 'main' }), []);
    assert.match(errs({ state: 'on' }).join('\n'), /worktreeSweep\.target: required/);
    assert.match(errs({ state: 'on', target: 'main', holdCommand: 'check' }).join('\n'), /holdCommand: null, or a command containing \{path\}/);
    assert.match(errs({ state: 'on', target: 'main', idleHours: -1 }).join('\n'), /idleHours: a number >= 0/);
    assert.match(errs({ state: 'on', target: 'main', reserved: 'lane-1' }).join('\n'), /reserved: an array of non-empty strings/);
  });

  test('the feature off prints "worktreeSweep: not configured" and exits 0', () => {
    const r = rig();
    writeFileSync(join(r.repo, 'PIPELINE_PROFILE.md'), profileText({ state: 'off' }));
    const out = spawnSync(process.execPath, [CLI, '--apply'], { cwd: r.repo, encoding: 'utf8' });
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stdout.trim(), 'worktreeSweep: not configured');
  });

  test('on, the CLI dry-runs by default against the profile target, and refuses an unknown flag', () => {
    const r = rig();
    writeFileSync(join(r.repo, 'PIPELINE_PROFILE.md'), profileText({ state: 'on', target: 'main', idleHours: 0 }));
    const wt = addWt(r, 'wt-done');
    const old = new Date(Date.now() - 3600 * 1000);
    utimesSync(join(wt, 'a.txt'), old, old);
    const out = spawnSync(process.execPath, [CLI], { cwd: r.repo, encoding: 'utf8' });
    assert.match(out.stdout, /SWEEP wt-done \[b\/wt-done\]/, out.stdout + out.stderr);
    assert.equal(existsSync(wt), true);
    const bad = spawnSync(process.execPath, [CLI, '--force'], { cwd: r.repo, encoding: 'utf8' });
    assert.equal(bad.status, 2);
  });
});
