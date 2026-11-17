/**
 * The hygiene checks without the full pipeline (specs/toolkit-hygiene-standalone.spec.md): instruction-lint,
 * instruction-budget and worktree-sweep run on named targets with the default settings while their feature is off, and
 * say so on the first line. Each test names the acceptance criterion it asserts (AC-nnn → REQ-nnn in the spec).
 *
 *   REQ-701…703  instruction-lint FILE… with defaults; no named file (or --files) stays "not configured"; refusals
 *   REQ-704…706  instruction-budget FILE… [--max-lines N] with defaults; no named file stays "not configured"; refusals
 *   REQ-707…711  worktree-sweep --target BRANCH with defaults, dry run unless --apply; no --target stays "not
 *                configured"; no holdCommand from defaults; refusals
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PACK = join(here, '..');
const script = (name) => join(PACK, 'scripts', `${name}.mjs`);
const made = [];
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

const project = () => {
  const dir = mkdtempSync(join(tmpdir(), 'builder-hygiene-'));
  made.push(dir);
  spawnSync('git', ['init', '-q'], { cwd: dir });
  return dir;
};
const write = (dir, rel, text) => {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
};
const run = (cwd, file, args = [], env = {}) => spawnSync(process.execPath, [file, ...args], { cwd, encoding: 'utf8', env: { ...process.env, BUILDER_CONFIG: '', ...env } });
const lines = (r) => r.stdout.split(/\r?\n/).filter(Boolean);
const settings = (features) => JSON.stringify({ schema: 2, features }, null, 2);

describe('REQ-701…703 — instruction-lint on named files, feature off', () => {
  const live = (dir) => {
    write(dir, 'src/index.js', 'module.exports = 1;\n');
    write(dir, 'AGENTS.md', '# Rules\n\nThe entry point is `src/index.js`.\n');
  };

  test('AC-701: named files are linted with defaults, no baseline, and the first line says so', () => {
    const dir = project();
    live(dir);
    const r = run(dir, script('instruction-lint'), ['AGENTS.md']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(lines(r)[0], 'instructionLint: not configured — checking AGENTS.md with defaults');
    assert.match(r.stdout, /instruction-lint: PASS/);
    assert.match(r.stdout, /no baseline: reported, not enforced/);
  });

  test('red: AC-702 a dead path in a named file fails with the script\'s normal exit code', () => {
    const dir = project();
    live(dir);
    write(dir, 'CLAUDE.md', '# Rules\n\nRead `src/missing.js` first.\n');
    const r = run(dir, script('instruction-lint'), ['AGENTS.md', 'CLAUDE.md']);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.equal(lines(r)[0], 'instructionLint: not configured — checking AGENTS.md, CLAUDE.md with defaults');
    assert.match(r.stdout, /CLAUDE\.md:3: `src\/missing\.js` does not exist/);
    assert.match(r.stdout, /instruction-lint: FAIL/);
  });

  test('AC-703: no named file, or --files (the edit hook), is still exactly "not configured", exit 0', () => {
    const dir = project();
    live(dir);
    const plain = run(dir, script('instruction-lint'));
    assert.equal(plain.status, 0);
    assert.equal(plain.stdout.trim(), 'instructionLint: not configured');
    const hook = run(dir, script('instruction-lint'), ['--files', 'AGENTS.md']);
    assert.equal(hook.status, 0);
    assert.equal(hook.stdout.trim(), 'instructionLint: not configured');
  });

  test('red: AC-704 a named path that does not exist, or an unknown flag, exits 2', () => {
    const dir = project();
    live(dir);
    const missing = run(dir, script('instruction-lint'), ['missing.md']);
    assert.equal(missing.status, 2, missing.stdout + missing.stderr);
    assert.match(missing.stderr, /missing\.md/);
    assert.match(missing.stderr, /not found|does not exist/);
    const bogus = run(dir, script('instruction-lint'), ['AGENTS.md', '--bogus']);
    assert.equal(bogus.status, 2, bogus.stdout + bogus.stderr);
    assert.match(bogus.stderr, /--bogus/);
    assert.match(bogus.stderr, /usage/);
  });
});

describe('REQ-704…706 — instruction-budget on named files, feature off', () => {
  const long = (dir) => write(dir, 'AGENTS.md', Array.from({ length: 150 }, (_, i) => `line ${i + 1}`).join('\n'));

  test('AC-705: named files are judged against the default of 200 lines, and the first line says so', () => {
    const dir = project();
    long(dir);
    const r = run(dir, script('instruction-budget'), ['AGENTS.md']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(lines(r)[0], 'instructionBudget: not configured — checking AGENTS.md with defaults');
    assert.match(r.stdout, /^AGENTS\.md {2}150\/200$/m);
    assert.match(r.stdout, /instruction-budget: PASS/);
  });

  test('red: AC-706 --max-lines N replaces the default and a file over it fails', () => {
    const dir = project();
    long(dir);
    const r = run(dir, script('instruction-budget'), ['AGENTS.md', '--max-lines', '100']);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /^AGENTS\.md {2}150\/100 {2}OVER$/m);
    assert.match(r.stdout, /instruction-budget: FAIL/);
  });

  test('AC-707: no named file is still exactly "not configured", exit 0', () => {
    const dir = project();
    long(dir);
    const r = run(dir, script('instruction-budget'));
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), 'instructionBudget: not configured');
  });

  test('red: AC-708 a missing path, --max-lines without a valid value, or an unknown flag exits 2', () => {
    const dir = project();
    long(dir);
    const missing = run(dir, script('instruction-budget'), ['missing.md']);
    assert.equal(missing.status, 2, missing.stdout + missing.stderr);
    assert.match(missing.stderr, /missing\.md/);
    const noValue = run(dir, script('instruction-budget'), ['AGENTS.md', '--max-lines']);
    assert.equal(noValue.status, 2, noValue.stdout + noValue.stderr);
    assert.match(noValue.stderr, /--max-lines <n>/);
    const badValue = run(dir, script('instruction-budget'), ['AGENTS.md', '--max-lines', 'zero']);
    assert.equal(badValue.status, 2, badValue.stdout + badValue.stderr);
    assert.match(badValue.stderr, /--max-lines <n>/);
    const bogus = run(dir, script('instruction-budget'), ['AGENTS.md', '--bogus']);
    assert.equal(bogus.status, 2, bogus.stdout + bogus.stderr);
    assert.match(bogus.stderr, /--bogus/);
  });
});

describe('REQ-707…711 — worktree-sweep with --target, feature off', () => {
  const git = (cwd, ...args) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  /** A primary repo on `main` with one merged, clean worktree beside it (idle at --idle-hours 0). */
  function rig() {
    const parent = realpathSync.native(mkdtempSync(join(tmpdir(), 'builder-hygiene-wt-')));
    made.push(parent);
    const repo = join(parent, 'app');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@example.com');
    git(repo, 'config', 'user.name', 'T');
    writeFileSync(join(repo, '.gitignore'), 'logs\n');
    writeFileSync(join(repo, 'a.txt'), 'a\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'init');
    const wt = join(parent, 'lane-done');
    git(repo, 'worktree', 'add', '-q', '-b', 'b/lane-done', wt);
    return { parent, repo, wt };
  }
  const DRY = 'worktreeSweep: not configured — checking worktrees against main with defaults (dry run: nothing is removed; add --apply to remove)';
  const APPLY = 'worktreeSweep: not configured — checking worktrees against main with defaults (--apply: merged, clean, idle worktrees are removed)';

  test('AC-709: --target runs a dry run with defaults and says so; nothing is removed', () => {
    const r = rig();
    const out = run(r.repo, script('worktree-sweep'), ['--target', 'main', '--idle-hours', '0']);
    assert.equal(out.status, 0, out.stdout + out.stderr);
    assert.equal(lines(out)[0], DRY);
    assert.match(out.stdout, /SWEEP lane-done \[b\/lane-done\]/);
    assert.match(out.stdout, /would remove 1/);
    assert.equal(existsSync(r.wt), true);
  });

  test('red: AC-710 --apply removes the merged worktree and keeps its branch', () => {
    const r = rig();
    const out = run(r.repo, script('worktree-sweep'), ['--target', 'main', '--idle-hours', '0', '--apply']);
    assert.equal(out.status, 0, out.stdout + out.stderr);
    assert.equal(lines(out)[0], APPLY);
    assert.match(out.stdout, /SWEPT lane-done \[b\/lane-done\]/);
    assert.equal(existsSync(r.wt), false);
    assert.match(git(r.repo, 'branch', '--list', 'b/lane-done'), /b\/lane-done/);
  });

  test('AC-711: no --target is still exactly "not configured", exit 0', () => {
    const r = rig();
    const plain = run(r.repo, script('worktree-sweep'));
    assert.equal(plain.status, 0, plain.stderr);
    assert.equal(plain.stdout.trim(), 'worktreeSweep: not configured');
    const idle = run(r.repo, script('worktree-sweep'), ['--idle-hours', '0']);
    assert.equal(idle.status, 0, idle.stderr);
    assert.equal(idle.stdout.trim(), 'worktreeSweep: not configured');
    assert.equal(existsSync(r.wt), true);
  });

  test('red: AC-712 a holdCommand in a config file never runs while the feature is off', () => {
    const r = rig();
    const marker = join(r.parent, 'hold-ran.txt');
    const hold = `${JSON.stringify(process.execPath)} -e "require('fs').writeFileSync(${JSON.stringify(marker)}, {path})"`;
    write(r.repo, 'builder.config.json', settings({ worktreeSweep: { state: 'off', target: 'main', holdCommand: hold } }));
    const out = run(r.repo, script('worktree-sweep'), ['--target', 'main', '--idle-hours', '0']);
    assert.equal(out.status, 0, out.stdout + out.stderr);
    assert.equal(lines(out)[0], DRY);
    assert.equal(existsSync(marker), false, 'the hold command ran from defaults');
  });

  test('red: AC-713 outside a git repository, or a flag without its value, exits 2', () => {
    const plain = mkdtempSync(join(tmpdir(), 'builder-hygiene-plain-'));
    made.push(plain);
    const noGit = run(plain, script('worktree-sweep'), ['--target', 'main'], { GIT_CEILING_DIRECTORIES: dirname(plain) });
    assert.equal(noGit.status, 2, noGit.stdout + noGit.stderr);
    assert.match(noGit.stderr, /not a git repository/);
    const r = rig();
    const noTarget = run(r.repo, script('worktree-sweep'), ['--target']);
    assert.equal(noTarget.status, 2, noTarget.stdout + noTarget.stderr);
    assert.match(noTarget.stderr, /--target/);
    assert.match(noTarget.stderr, /usage/);
    const noIdle = run(r.repo, script('worktree-sweep'), ['--idle-hours', '--target', 'main']);
    assert.equal(noIdle.status, 2, noIdle.stdout + noIdle.stderr);
    assert.match(noIdle.stderr, /--idle-hours/);
    assert.match(noIdle.stderr, /usage/);
  });
});

describe('the kit\'s own spec', () => {
  test('specs/toolkit-hygiene-standalone.spec.md passes spec-check as ratified, with no profile', () => {
    const r = run(PACK, script('spec-check'), ['specs/toolkit-hygiene-standalone.spec.md']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /spec-check: PASS/);
    assert.match(r.stdout, /\(ratified\)/);
  });

  test('every acceptance criterion in the spec is named by a test in this file', () => {
    const spec = readFileSync(join(PACK, 'specs', 'toolkit-hygiene-standalone.spec.md'), 'utf8');
    const ids = [...new Set([...spec.matchAll(/^\| (AC-\d+) \|/gm)].map((m) => m[1]))];
    const me = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    assert.ok(ids.length >= 13, `the spec declares ${ids.length} criteria`);
    assert.deepEqual(ids.filter((id) => !me.includes(`${id}:`) && !me.includes(`${id} `)), []);
  });
});
