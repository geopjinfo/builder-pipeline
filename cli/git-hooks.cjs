'use strict';
/*
 * `builder git-hooks [--dry-run]` — arm the kit's commit-msg hook in this clone: commits carry human authors only
 * (hooks/commit-msg-no-ai-attribution.sh strips agent co-author trailers and "Generated with" lines).
 *
 * Where: the folder git itself runs hooks from — `git rev-parse --git-path hooks`, which honours core.hooksPath and
 * linked worktrees. It writes nothing tracked and changes no git config. A commit-msg hook already there that is not
 * this one is never overwritten: it is named, with the line to add to it, and the command exits 1.
 *
 * `status(cwd, kit)` is what `doctor` reports: armed | missing | foreign | no-git.
 *
 * `builder git-hooks --secret-scan` arms hooks/secret-scan-precommit.sh as `pre-commit` the same way (REQ-1815): never
 * over a pre-commit already there, KIT_LIB filled with the kit's lib folder so the hook finds scripts/lib/secret-scan.cjs
 * from any layout. `preCommitStatus(cwd, kit)` is its doctor row: armed | missing | foreign | no-git.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOK = 'commit-msg-no-ai-attribution.sh';
const PRE_COMMIT = 'secret-scan-precommit.sh';

function hooksDir(cwd) {
  const r = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-path', 'hooks'], { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0 || !r.stdout.trim()) return null;
  return path.resolve(cwd, r.stdout.trim());
}

/** Same bytes, line endings aside (a CRLF checkout of the kit is still the kit's hook). */
const sameText = (a, b) => a.replace(/\r\n/g, '\n') === b.replace(/\r\n/g, '\n');

function status(cwd, kit) {
  const dir = hooksDir(cwd);
  if (!dir) return { state: 'no-git', note: 'not a git repository' };
  const target = path.join(dir, 'commit-msg');
  if (!fs.existsSync(target)) return { state: 'missing', target, note: 'commit-msg hook not armed — run `npx builder-pipeline git-hooks`' };
  const ours = fs.readFileSync(path.join(kit, 'hooks', HOOK), 'utf8');
  const theirs = fs.readFileSync(target, 'utf8');
  if (sameText(ours, theirs)) return { state: 'armed', target, note: 'commit-msg strips AI attribution' };
  if (theirs.includes(HOOK) || /Co-?Authored-By/i.test(theirs)) return { state: 'armed', target, note: 'a project commit-msg hook that handles AI attribution (not the kit copy)' };
  return { state: 'foreign', target, note: `a different commit-msg hook is installed at ${target} — call the kit's from it` };
}

/** The secret-scan pre-commit hook (REQ-1815): armed when the installed pre-commit is ours or calls it; foreign otherwise. */
function preCommitStatus(cwd, kit) {
  const dir = hooksDir(cwd);
  if (!dir) return { state: 'no-git', note: 'not a git repository' };
  const target = path.join(dir, 'pre-commit');
  if (!fs.existsSync(target)) return { state: 'missing', target, note: 'secret-scan pre-commit hook not armed — run `npx builder-pipeline git-hooks --secret-scan`' };
  const theirs = fs.readFileSync(target, 'utf8');
  if (theirs.includes(PRE_COMMIT) || /secret-scan\.cjs/.test(theirs)) return { state: 'armed', target, note: 'pre-commit scans the staged lines for secret shapes' };
  return { state: 'foreign', target, note: `a different pre-commit hook is installed at ${target} — call the kit's from it` };
}

/** The kit's pre-commit hook text with KIT_LIB filled, LF always. */
const preCommitText = (kit) => fs.readFileSync(path.join(kit, 'hooks', PRE_COMMIT), 'utf8').replace(/\r\n/g, '\n').replace(/^KIT_LIB=''$/m, `KIT_LIB='${path.join(kit, 'scripts', 'lib').replace(/\\/g, '/').replace(/'/g, "'\\''")}'`);

function armPreCommit(ctx, dry) {
  const { CWD, KIT } = ctx;
  const s = preCommitStatus(CWD, KIT);
  if (s.state === 'no-git') ctx.die('git-hooks: not a git repository — run it inside the project clone');
  if (s.state === 'armed') return console.log(`git-hooks: armed — ${s.note} (${s.target})`);
  if (s.state === 'foreign') {
    console.error(`git-hooks: ${s.target} already exists and is not the kit's hook — left as it is.`);
    console.error(`  Keep yours and add this line to it, before its own checks:  sh "${path.join(KIT, 'hooks', PRE_COMMIT)}" || exit 1`);
    process.exit(1);
  }
  if (dry) return console.log(`git-hooks: would copy hooks/${PRE_COMMIT} to ${s.target} (--dry-run: nothing written)`);
  fs.mkdirSync(path.dirname(s.target), { recursive: true });
  fs.writeFileSync(s.target, preCommitText(KIT));
  try {
    fs.chmodSync(s.target, 0o755);
  } catch (_) {
    /* Windows: git for Windows runs it without the bit */
  }
  console.log(`git-hooks: armed ${s.target} — a commit whose staged lines carry a secret shape is rejected (features.secretScan.allow is the only exception)`);
}

function cmdGitHooks(ctx, argv) {
  const { CWD, KIT } = ctx;
  const dry = argv.includes('--dry-run');
  if (argv.includes('--secret-scan')) return armPreCommit(ctx, dry);
  const s = status(CWD, KIT);
  if (s.state === 'no-git') ctx.die('git-hooks: not a git repository — run it inside the project clone');
  if (s.state === 'armed') return console.log(`git-hooks: armed — ${s.note} (${s.target})`);
  if (s.state === 'foreign') {
    console.error(`git-hooks: ${s.target} already exists and is not the kit's hook — left as it is.`);
    console.error(`  Keep yours and add this line to it, before its own checks:  sh "${path.join(KIT, 'hooks', HOOK)}" "$1"`);
    console.error(`  (or copy ${path.join('hooks', HOOK)} from the kit into it)`);
    process.exit(1);
  }
  if (dry) return console.log(`git-hooks: would copy hooks/${HOOK} to ${s.target} (--dry-run: nothing written)`);
  fs.mkdirSync(path.dirname(s.target), { recursive: true });
  // LF always: a Windows checkout of the kit (core.autocrlf) holds this file with CRLF, and sh reads `\r` as part
  // of every command.
  fs.writeFileSync(s.target, fs.readFileSync(path.join(KIT, 'hooks', HOOK), 'utf8').replace(/\r\n/g, '\n'));
  try {
    fs.chmodSync(s.target, 0o755);
  } catch (_) {
    /* Windows: git for Windows runs it without the bit */
  }
  console.log(`git-hooks: armed ${s.target} — commit messages lose agent Co-Authored-By trailers and "Generated with" lines`);
}

module.exports = { cmdGitHooks, status, preCommitStatus, preCommitText, hooksDir, HOOK, PRE_COMMIT };
