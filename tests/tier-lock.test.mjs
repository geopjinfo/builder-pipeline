import assert from 'node:assert/strict';
import * as realFs from 'node:fs';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

const require = createRequire(import.meta.url);
const { acquire, TierBusyError } = require('../examples/jest-tier-runner/tier-lock.cjs');

const made = [];
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));
const lockIn = () => {
  const dir = mkdtempSync(join(tmpdir(), 'builder-tier-lock-'));
  made.push(dir);
  return join(dir, 'tier.lock');
};
/** A pid that is not running: the largest the platforms hand out is well below this. */
const DEAD_PID = 2 ** 30;
const staleBody = () => JSON.stringify({ tier: 'integration', pid: DEAD_PID, startedAt: new Date().toISOString() });

describe('example tier lock — atomic create, safe stale reclaim, owned release', () => {
  test('acquire creates the lock; a second acquire while the holder lives is busy; release frees it', () => {
    const lockPath = lockIn();
    const held = acquire('unit', { lockPath });
    assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).pid, process.pid);
    assert.throws(() => acquire('arch', { lockPath }), TierBusyError);
    held.release();
    assert.equal(existsSync(lockPath), false);
  });

  test('a lock whose holder is dead, or whose body is corrupt, is reclaimed', () => {
    const lockPath = lockIn();
    writeFileSync(lockPath, staleBody());
    acquire('unit', { lockPath }).release();
    writeFileSync(lockPath, '{ not json');
    acquire('unit', { lockPath }).release();
    assert.equal(existsSync(lockPath), false);
  });

  test('the create is exclusive: a rival that writes between the check and the create wins, and we are busy', () => {
    const lockPath = lockIn();
    let raced = false;
    const fs = {
      ...realFs,
      writeFileSync(p, body, opts) {
        if (!raced && p === lockPath) {
          raced = true;
          realFs.writeFileSync(p, JSON.stringify({ tier: 'e2e', pid: process.pid, startedAt: new Date().toISOString() }));
        }
        return realFs.writeFileSync(p, body, opts);
      },
    };
    assert.throws(() => acquire('unit', { lockPath, fs }), TierBusyError);
    assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).tier, 'e2e'); // the rival's lock survives
  });

  test('red: a reclaim never deletes a live lock a rival took after we judged the old one stale', () => {
    const lockPath = lockIn();
    writeFileSync(lockPath, staleBody());
    const rival = JSON.stringify({ tier: 'e2e', pid: process.pid, startedAt: new Date().toISOString() });
    let swapped = false;
    const fs = {
      ...realFs,
      renameSync(from, to) {
        // Between our stale judgement and our rename, another reclaimer replaced the stale lock with its own.
        if (!swapped && from === lockPath) {
          swapped = true;
          realFs.writeFileSync(lockPath, rival);
        }
        return realFs.renameSync(from, to);
      },
    };
    assert.throws(() => acquire('unit', { lockPath, fs }), TierBusyError);
    assert.equal(readFileSync(lockPath, 'utf8'), rival); // restored, not deleted
  });

  test('release removes the lock only while it still names this holder', () => {
    const lockPath = lockIn();
    const held = acquire('unit', { lockPath });
    const other = JSON.stringify({ tier: 'e2e', pid: process.pid, startedAt: '2000-01-01T00:00:00.000Z' });
    writeFileSync(lockPath, other); // another run took the path over
    held.release();
    assert.equal(readFileSync(lockPath, 'utf8'), other);
  });
});
