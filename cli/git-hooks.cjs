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
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOK = 'commit-msg-no-ai-attribution.sh';

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

function cmdGitHooks(ctx, argv) {
  const { CWD, KIT } = ctx;
  const dry = argv.includes('--dry-run');
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

module.exports = { cmdGitHooks, status, hooksDir, HOOK };
