'use strict';
/**
 * Git config / hooks integrity around every unattended worker run.
 *
 * WHY. A worker that edits `.git/config` (core.fsmonitor, a diff driver, a pager) or a hook gets code run later by
 * someone else's git command — the merge, a reviewer's diff, the next session. A diff of the worktree cannot see
 * it: none of those files is tracked. So before and after each worker run (a credit job; a lane's launch → finish
 * notice) this hashes:
 *   common:config           <git common dir>/config
 *   common:hooks/<f>        every file under <git common dir>/hooks
 *   gitdir:config.worktree  the worktree's own config.worktree, when present
 *   hooksPath:<f>           every file under the configured core.hooksPath dir
 * Any difference fails the run: credit → FAILED-INTEGRITY (its own exit code); lane → STALLED with the reason.
 * Hashes only: nothing here prints or stores a file's content.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const gitOut = (cwd, args, gitBin) => {
  const r = spawnSync(gitBin, args, { cwd, encoding: 'utf8' });
  return r.status === 0 ? (r.stdout || '').trim() : null;
};

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** Every file under dir (recursive) as [relative path, sha256]. A missing dir is empty. */
function hashTree(dir) {
  const out = [];
  const walk = (rel) => {
    let entries = [];
    try {
      entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const e of entries) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push([p, sha(path.join(dir, p))]);
    }
  };
  walk('');
  return out;
}

/** { label: sha256 } for the git config and every hook a worker run could change. Throws when git cannot say. */
function integritySnapshot(worktree, { gitBin = 'git' } = {}) {
  const common = gitOut(worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir'], gitBin);
  const gitDir = gitOut(worktree, ['rev-parse', '--path-format=absolute', '--git-dir'], gitBin);
  const top = gitOut(worktree, ['rev-parse', '--show-toplevel'], gitBin);
  if (!common || !gitDir || !top) throw new Error(`integrity: ${worktree} is not a git worktree`);
  const snap = {};
  const config = path.join(common, 'config');
  snap['common:config'] = fs.existsSync(config) ? sha(config) : 'missing';
  for (const [p, h] of hashTree(path.join(common, 'hooks'))) snap[`common:hooks/${p}`] = h;
  const wtConfig = path.join(gitDir, 'config.worktree');
  if (fs.existsSync(wtConfig)) snap['gitdir:config.worktree'] = sha(wtConfig);
  const hooksPath = gitOut(worktree, ['config', '--get', 'core.hooksPath'], gitBin);
  if (hooksPath) {
    snap['hooksPath:dir'] = hooksPath;
    for (const [p, h] of hashTree(path.resolve(top, hooksPath))) snap[`hooksPath:${p}`] = h;
  }
  return snap;
}

/** What changed between two snapshots: ['<label>: changed|added|removed']. Empty = intact. */
function integrityDiff(before, after) {
  const out = [];
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!(k in after)) out.push(`${k}: removed`);
    else if (!(k in before)) out.push(`${k}: added`);
    else if (before[k] !== after[k]) out.push(`${k}: changed`);
  }
  return out.sort();
}

module.exports = { integritySnapshot, integrityDiff, hashTree };
