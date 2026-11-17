/**
 * The per-account lease — scripts/lib/account-lease.cjs (REQ-108; D32).
 *
 * WHY. `accounts remove` and `accounts migrate` must not change an account a worker is running on. One small API
 * holds the lease (`{ pid, startedAt, lane }`), reads it back and says whether its process is still alive, so the
 * CLI and the adapters never disagree on what "held" means. A lease whose pid is gone is stale: it is reported, not
 * obeyed.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const PACK = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const lease = require(join(PACK, 'scripts/lib/account-lease.cjs'));
const { paths } = require(join(PACK, 'scripts/lib/account-paths.cjs'));
const made = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
const home = () => { const d = mkdtempSync(join(tmpdir(), 'kit-lease-')); made.push(d); return d; };

/** A pid that belonged to a process that has exited. */
function gonePid() {
  const r = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  return r.pid;
}

describe('account-lease', () => {
  test('red: REQ-108 acquire writes { pid, startedAt, lane } at paths.leaseFile; read returns it; release removes it', () => {
    const h = home();
    const r = lease.acquire(h, 'alpha', { pid: process.pid, lane: 'L1' });
    assert.equal(r.ok, true);
    const file = paths(h, 'alpha').leaseFile;
    assert.ok(existsSync(file));
    const on = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(on.pid, process.pid);
    assert.equal(on.lane, 'L1');
    assert.match(on.startedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(lease.read(h, 'alpha'), on);
    assert.equal(lease.release(h, 'alpha'), true);
    assert.equal(existsSync(file), false);
    assert.equal(lease.read(h, 'alpha'), null);
    assert.equal(lease.release(h, 'alpha'), false, 'nothing to release');
  });

  test('red: REQ-108 isLive is true for a running pid and false for a pid that is gone', () => {
    assert.equal(lease.isLive({ pid: process.pid }), true);
    assert.equal(lease.isLive({ pid: gonePid() }), false);
    assert.equal(lease.isLive(null), false);
    assert.equal(lease.isLive({ pid: 'x' }), false);
    // EPERM means the process exists but is not ours: still live.
    assert.equal(lease.isLive({ pid: 1 }, () => { const e = new Error('no'); e.code = 'EPERM'; throw e; }), true);
  });

  test('red: REQ-108 state reports none, live (with the pid) and stale', () => {
    const h = home();
    assert.deepEqual(lease.state(h, 'alpha'), { state: 'none', lease: null });
    lease.acquire(h, 'alpha', { pid: process.pid, lane: 'L2' });
    const live = lease.state(h, 'alpha');
    assert.equal(live.state, 'live');
    assert.equal(live.lease.pid, process.pid);
    writeFileSync(paths(h, 'alpha').leaseFile, JSON.stringify({ pid: gonePid(), startedAt: 'x', lane: 'L3' }));
    assert.equal(lease.state(h, 'alpha').state, 'stale');
    writeFileSync(paths(h, 'alpha').leaseFile, '{ nope');
    assert.equal(lease.state(h, 'alpha').state, 'stale', 'an unreadable lease is never obeyed');
  });

  test('red: REQ-108 acquire refuses while a live lease is held and takes over a stale one', () => {
    const h = home();
    lease.acquire(h, 'alpha', { pid: process.pid, lane: 'L1' });
    const again = lease.acquire(h, 'alpha', { pid: process.pid, lane: 'L2' });
    assert.equal(again.ok, false);
    assert.equal(again.code, 'E_LEASE_HELD');
    assert.match(again.reason, new RegExp(`pid ${process.pid}`));
    writeFileSync(paths(h, 'alpha').leaseFile, JSON.stringify({ pid: gonePid(), startedAt: 'x', lane: 'L3' }));
    const over = lease.acquire(h, 'alpha', { pid: process.pid, lane: 'L4' });
    assert.equal(over.ok, true);
    assert.equal(over.stale, true);
    assert.equal(lease.read(h, 'alpha').lane, 'L4');
  });
});
