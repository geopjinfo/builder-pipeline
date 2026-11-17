'use strict';
/**
 * accounts.lock.json — what the kit last wrote under the accounts home, per file (plan M11, REQ-1102; D19, D38).
 *
 * WHY its own lock. builder.lock.json records the files the kit wrote INTO a project. Wrappers, composed settings and
 * sandbox profiles live outside every project, under the accounts home, so they get their own lock there. The rules
 * are the project lock's: a file whose content still matches the lock is overwritten freely; one changed since (a
 * local edit) is kept and named, or backed up and replaced under --force; a file the kit never wrote is left alone.
 * Nothing here is ever armed in a live tool configuration: the files sit in kit-created dirs only.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { lockFile } = require('./account-paths.cjs');

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const rel = (home, file) => path.relative(home, file).split(path.sep).join('/');

function read(home) {
  try {
    return JSON.parse(fs.readFileSync(lockFile(home), 'utf8'));
  } catch (_) {
    return { files: {} };
  }
}

function write(home, lock) {
  fs.mkdirSync(home, { recursive: true });
  const tmp = `${lockFile(home)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(lock, null, 2) + '\n');
  fs.renameSync(tmp, lockFile(home));
}

/** Copy `file` to <home>/backups/<stamp>/<relative path> before it is overwritten. */
function backup(home, file, stamp) {
  const dst = path.join(home, 'backups', stamp, rel(home, file));
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(file, dst);
  return dst;
}

const writeFile = (file, text, mode) => {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
};

/**
 * Apply a plan: [{ file, text, mode, kind, account, keepIfPresent }].
 * @returns {{ written: string[], unchanged: string[], kept: string[], backedUp: string[], lines: string[] }}
 */
function apply(home, files, { force = false, dry = false, kitVersion = null, now = new Date() } = {}) {
  const lock = read(home);
  lock.files = lock.files || {};
  if (kitVersion) lock.kit = kitVersion;
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const out = { written: [], unchanged: [], kept: [], backedUp: [], lines: [] };
  for (const f of files) {
    const key = rel(home, f.file);
    const exists = fs.existsSync(f.file);
    const current = exists ? fs.readFileSync(f.file, 'utf8') : null;
    const recorded = lock.files[key];
    if (exists && current === f.text) {
      out.unchanged.push(key);
      out.lines.push(`unchanged: ${key}`);
      if (!recorded) lock.files[key] = { sha256: sha256(f.text), kind: f.kind, account: f.account, at: now.toISOString() };
      continue;
    }
    if (exists && f.keepIfPresent) {
      out.kept.push(key);
      out.lines.push(`kept (policy unreadable): ${key}`);
      continue;
    }
    if (exists && (!recorded || recorded.sha256 !== sha256(current))) {
      if (!force) {
        out.kept.push(key);
        out.lines.push(`kept (${recorded ? 'local edit' : 'not written by the kit'}): ${key} — accounts install --force backs it up and replaces it`);
        continue;
      }
      if (!dry) out.backedUp.push(rel(home, backup(home, f.file, stamp)));
      out.lines.push(`backed up and replaced: ${key}`);
    } else if (exists) {
      if (!dry) out.backedUp.push(rel(home, backup(home, f.file, stamp)));
      out.lines.push(`updated: ${key}`);
    } else out.lines.push(`written: ${key}`);
    if (!dry) {
      writeFile(f.file, f.text, f.mode);
      lock.files[key] = { sha256: sha256(f.text), kind: f.kind, account: f.account, at: now.toISOString() };
    }
    out.written.push(key);
  }
  if (!dry) write(home, lock);
  out.lock = lock;
  return out;
}

module.exports = { sha256, read, write, backup, apply };
