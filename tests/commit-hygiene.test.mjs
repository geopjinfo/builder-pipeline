/**
 * Commit hygiene — commits carry human authors only. hooks/commit-msg-no-ai-attribution.sh strips an agent's
 * Co-Authored-By trailer and the "Generated with <agent>" line; `builder git-hooks` arms it in a clone without
 * overwriting a hook already there; the pointer block tells every agent the rule. Each guard has a red case.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PACK = join(here, '..');
const HOOK = join(PACK, 'hooks', 'commit-msg-no-ai-attribution.sh');
const CLI = join(PACK, 'cli.js');
const NO_SH = spawnSync('sh', ['-c', 'exit 0']).status !== 0 ? 'no POSIX sh on this machine' : false;

const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = (p) => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};
const git = (cwd, ...args) => spawnSync('git', ['-c', 'user.name=Dev Person', '-c', 'user.email=dev@example.com', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8' });

/** Run the hook over a message; returns the message as git would commit it. */
function strip(message) {
  const d = tmp('commit-msg-');
  const f = join(d, 'COMMIT_EDITMSG');
  writeFileSync(f, message);
  const r = spawnSync('sh', [HOOK, f], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return readFileSync(f, 'utf8');
}

describe('the commit-msg hook', { skip: NO_SH }, () => {
  test('red: agent co-author trailers and "Generated with" lines are removed, the gap closed', () => {
    const out = strip(
      'fix(x): a change\n\nWhy it was needed.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\nCo-Authored-By: Claude Opus <noreply@anthropic.com>\nCo-authored-by: Codex <codex@openai.com>\nCo-Authored-By: GitHub Copilot <copilot@example.com>\n',
    );
    assert.equal(out, 'fix(x): a change\n\nWhy it was needed.\n');
  });

  test('a human co-author and the rest of the message are kept', () => {
    const msg = 'feat: pair work\n\nBody line.\n\nCo-Authored-By: Dana Smith <dana@example.com>\n';
    assert.equal(strip(msg), msg);
  });

  test('a message with nothing to strip is left byte-for-byte', () => {
    const msg = 'docs: one line\n';
    assert.equal(strip(msg), msg);
  });

  test('red: a real commit through the armed hook loses the trailer', () => {
    const repo = tmp('commit-repo-');
    git(repo, 'init', '-q');
    const armed = spawnSync(process.execPath, [CLI, 'git-hooks'], { cwd: repo, encoding: 'utf8' });
    assert.equal(armed.status, 0, armed.stderr);
    writeFileSync(join(repo, 'a.txt'), 'a\n');
    git(repo, 'add', 'a.txt');
    const c = git(repo, 'commit', '-q', '-m', 'chore: a\n\nCo-Authored-By: Claude <noreply@anthropic.com>');
    assert.equal(c.status, 0, c.stderr);
    assert.equal(git(repo, 'log', '-1', '--format=%B').stdout.trim(), 'chore: a');
  });
});

describe('builder git-hooks', () => {
  test('arms the hook in .git/hooks, then reports armed; doctor says so', () => {
    const repo = tmp('arm-');
    git(repo, 'init', '-q');
    const dry = spawnSync(process.execPath, [CLI, 'git-hooks', '--dry-run'], { cwd: repo, encoding: 'utf8' });
    assert.match(dry.stdout, /would copy/);
    assert.equal(existsSync(join(repo, '.git', 'hooks', 'commit-msg')), false, '--dry-run writes nothing');
    const before = spawnSync(process.execPath, [CLI, 'doctor'], { cwd: repo, encoding: 'utf8' });
    assert.match(before.stdout, /commit hygiene: missing/);
    assert.equal(spawnSync(process.execPath, [CLI, 'git-hooks'], { cwd: repo, encoding: 'utf8' }).status, 0);
    assert.equal(readFileSync(join(repo, '.git', 'hooks', 'commit-msg'), 'utf8'), readFileSync(HOOK, 'utf8'));
    assert.match(spawnSync(process.execPath, [CLI, 'git-hooks'], { cwd: repo, encoding: 'utf8' }).stdout, /armed/);
    assert.match(spawnSync(process.execPath, [CLI, 'doctor'], { cwd: repo, encoding: 'utf8' }).stdout, /commit hygiene: armed/);
  });

  test('red: a different commit-msg hook already there is never overwritten (exit 1, with the line to add)', () => {
    const repo = tmp('foreign-');
    git(repo, 'init', '-q');
    const theirs = '#!/bin/sh\necho mine\n';
    mkdirSync(join(repo, '.git', 'hooks'), { recursive: true });
    writeFileSync(join(repo, '.git', 'hooks', 'commit-msg'), theirs);
    const r = spawnSync(process.execPath, [CLI, 'git-hooks'], { cwd: repo, encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /left as it is/);
    assert.match(r.stderr, /commit-msg-no-ai-attribution\.sh/);
    assert.equal(readFileSync(join(repo, '.git', 'hooks', 'commit-msg'), 'utf8'), theirs);
  });

  test('core.hooksPath is honoured: the hook lands where git runs hooks from', () => {
    const repo = tmp('hookspath-');
    git(repo, 'init', '-q');
    git(repo, 'config', 'core.hooksPath', '.githooks');
    assert.equal(spawnSync(process.execPath, [CLI, 'git-hooks'], { cwd: repo, encoding: 'utf8' }).status, 0);
    assert.ok(existsSync(join(repo, '.githooks', 'commit-msg')));
    assert.equal(existsSync(join(repo, '.git', 'hooks', 'commit-msg')), false);
  });

  test('outside a git repository it refuses', () => {
    const r = spawnSync(process.execPath, [CLI, 'git-hooks'], { cwd: tmp('nogit-'), encoding: 'utf8', env: { ...process.env, GIT_CEILING_DIRECTORIES: tmpdir() } });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not a git repository/);
  });
});

describe('the pointer block states the rule', () => {
  test('every installed pointer tells agents commits carry human authors only', () => {
    const src = readFileSync(CLI, 'utf8');
    assert.match(src, /Commits and PRs carry human authors only/);
    assert.match(src, /git-hooks/);
  });
});
