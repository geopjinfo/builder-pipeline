import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const exampleDir = join(here, '..', 'examples', 'jest-tier-runner');
const inPlace = join(exampleDir, 'instruction-trailer-check.mjs');

const probe = spawnSync('git', ['--version'], { encoding: 'utf8' });
const skip = probe.status === 0 ? false : 'git is not available on PATH — the CI entry shells out to git, so there is no repository to run it against';

describe('instruction-trailer-check — a throwaway git repository', { skip }, () => {
  let root;
  let repo;
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const commit = (message, files = {}) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), text);
    }
    git('add', '-A');
    git('commit', '-q', '--allow-empty', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  const run = (script, base) => spawnSync(process.execPath, [script, base], { cwd: repo, encoding: 'utf8' });
  const out = (r) => `${r.stdout}${r.stderr}`;

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'builder-trailer-'));
    repo = join(root, 'repo');
    mkdirSync(repo);
    mkdirSync(join(root, 'no-hooks'));
    git('init', '-q');
    git('config', 'user.name', 'Pack Test');
    git('config', 'user.email', 'pack-test@example.invalid');
    // Hermetic: a machine-wide hook or signing setting must not change what this throwaway repository records.
    git('config', 'core.hooksPath', join(root, 'no-hooks'));
    git('config', 'commit.gpgsign', 'false');
  });
  after(() => root && rmSync(root, { recursive: true, force: true }));

  let base;
  test('red: a change to AGENTS.md with no trailer in the range exits 1, naming the file', () => {
    base = commit('chore: initial', { 'README.md': '# app\n' });
    commit('docs: agent notes', { 'AGENTS.md': '# Agent notes\n' });
    const r = run(inPlace, base);
    assert.equal(r.status, 1, out(r));
    assert.match(r.stdout, /^instruction-trailer-check: FAIL — 1 instruction file\(s\) changed with no "instructions-change:" trailer/);
    assert.match(r.stdout, /AGENTS\.md/);
  });

  test('a later commit carrying "instructions-change: …" declares the range — exit 0', () => {
    commit('chore: declare the notes\n\ninstructions-change: add the agent notes file');
    const r = run(inPlace, base);
    assert.equal(r.status, 0, out(r));
    assert.equal(r.stdout.trim(), 'instruction-trailer-check: PASS — 1 instruction file(s), declared');
  });

  test('a diff that touches no instruction file exits 0', () => {
    const fresh = git('rev-parse', 'HEAD');
    commit('feat: app', { 'src/app.js': 'module.exports = 1;\n' });
    const r = run(inPlace, fresh);
    assert.equal(r.status, 0, out(r));
    assert.equal(r.stdout.trim(), 'instruction-trailer-check: PASS — no instruction files in the diff');
  });

  test('a base ref that does not resolve exits 2 — never a pass', () => {
    const r = run(inPlace, 'no-such-ref');
    assert.equal(r.status, 2, out(r));
    assert.match(r.stderr, /git could not compare against no-such-ref/);
  });

  test('installed layout: the helper under ./lib/ is the one required', () => {
    const scripts = join(root, 'installed', 'scripts');
    mkdirSync(join(scripts, 'lib'), { recursive: true });
    copyFileSync(inPlace, join(scripts, 'instruction-trailer-check.mjs'));
    writeFileSync(join(scripts, 'lib', 'instruction-trailer.cjs'), "module.exports = { verdict: () => ({ ok: true, reason: 'the ./lib helper answered' }) };\n");
    const r = run(join(scripts, 'instruction-trailer-check.mjs'), base);
    assert.equal(r.status, 0, out(r));
    assert.equal(r.stdout.trim(), 'instruction-trailer-check: PASS — the ./lib helper answered');
  });
});

describe('the fence fences its own definition', () => {
  const { verdict, INSTRUCTION_DIFF } = createRequire(import.meta.url)(join(exampleDir, 'instruction-trailer.cjs'));
  const DEF = 'scripts/lib/instruction-trailer.cjs';

  test('red: an undeclared change to the file that defines the set is flagged, naming it', () => {
    const r = verdict({ changedFiles: [DEF], commitMessages: ['chore: tidy'] });
    assert.equal(r.ok, false);
    assert.match(r.reason, /scripts\/lib\/instruction-trailer\.cjs/);
    assert.equal(verdict({ changedFiles: [DEF.replace(/\//g, '\\')], commitMessages: ['chore: tidy'] }).ok, false); // a Windows spelling too
  });

  test('green: declared, it passes; near-miss names stay outside the set', () => {
    assert.equal(verdict({ changedFiles: [DEF], commitMessages: ['x\n\ninstructions-change: widen the set'] }).ok, true);
    for (const near of ['scripts/lib/instruction-trailer.cjs.bak', 'scripts/lib/other.cjs', 'scripts/instruction-trailer-check.mjs']) {
      assert.equal(INSTRUCTION_DIFF.test(near), false, near);
    }
  });

  test('a tracked git-hooks folder is in the set; a near-miss folder name is not', () => {
    assert.equal(verdict({ changedFiles: ['.githooks/post-merge'], commitMessages: ['chore: tidy'] }).ok, false);
    assert.equal(INSTRUCTION_DIFF.test('.githooks'), true);
    for (const near of ['.githooksx/post-merge', 'docs/.githooks.md']) assert.equal(INSTRUCTION_DIFF.test(near), false, near);
  });
});
