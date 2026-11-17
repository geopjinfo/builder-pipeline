/**
 * builder.lock.json records what the kit last wrote to each KIT-OWNED file. An upgrade that meets a kit-owned file
 * changed since then keeps it (a local edit) instead of overwriting it; `--force` overwrites after the backup.
 * Project-owned files are never locked. An install from before the lock upgrades as it always did.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const PACK = join(dirname(fileURLToPath(import.meta.url)), '..');
const made = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

function project() {
  const proj = mkdtempSync(join(tmpdir(), 'kit-lock-'));
  made.push(proj);
  const kit = join(proj, 'node_modules', 'builder-pipeline');
  mkdirSync(kit, { recursive: true });
  cpSync(PACK, kit, { recursive: true, filter: (src) => !/[\\/](?:\.git|tests|node_modules)(?:[\\/]|$)/.test(`/${relative(PACK, src)}`) });
  return { proj, kit, cli: join(kit, 'cli.js') };
}
const run = (cli, cwd, args) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });
const AGENT = '.claude/agents/module-builder.md';

describe('builder.lock.json — local edits to kit-owned files survive an upgrade', () => {
  test('red: unpack writes a lock listing kit-owned files with sha256, and no project-owned file', () => {
    const { proj, cli } = project();
    assert.equal(run(cli, proj, ['unpack', '--tool', 'claude-code']).status, 0);
    const lock = JSON.parse(readFileSync(join(proj, 'builder.lock.json'), 'utf8'));
    assert.match(lock.kit, /^\d+\.\d+\.\d+/);
    assert.match(lock.files[AGENT], /^[0-9a-f]{64}$/);
    assert.equal(lock.files['PIPELINE_PROFILE.md'], undefined, 'the profile is the project\'s');
  });

  test('red: a locally edited kit-owned file is kept on upgrade and reported; --force overwrites it', () => {
    const { proj, kit, cli } = project();
    run(cli, proj, ['unpack', '--tool', 'claude-code']);
    appendFileSync(join(proj, AGENT), '\nLOCAL NOTE\n');
    appendFileSync(join(kit, 'agents', 'module-builder.md'), '\nkit change in a new release\n');
    const up = run(cli, proj, ['upgrade', '--tool', 'claude-code']);
    assert.equal(up.status, 0, up.stderr);
    assert.match(up.stdout, /kept \(local edit\)/);
    assert.match(readFileSync(join(proj, AGENT), 'utf8'), /LOCAL NOTE/);
    const forced = run(cli, proj, ['upgrade', '--tool', 'claude-code', '--force']);
    assert.equal(forced.status, 0, forced.stderr);
    const now = readFileSync(join(proj, AGENT), 'utf8');
    assert.doesNotMatch(now, /LOCAL NOTE/);
    assert.match(now, /kit change in a new release/);
  });

  test('control: an unedited kit-owned file upgrades normally, and an install with no lock upgrades as before', () => {
    const { proj, kit, cli } = project();
    run(cli, proj, ['unpack', '--tool', 'claude-code']);
    appendFileSync(join(kit, 'agents', 'module-builder.md'), '\nkit change\n');
    let up = run(cli, proj, ['upgrade', '--tool', 'claude-code']);
    assert.doesNotMatch(up.stdout, /kept \(local edit\)/);
    assert.match(readFileSync(join(proj, AGENT), 'utf8'), /kit change/);
    rmSync(join(proj, 'builder.lock.json'));
    appendFileSync(join(proj, AGENT), '\nedit with no lock\n');
    appendFileSync(join(kit, 'agents', 'module-builder.md'), '\nsecond kit change\n');
    up = run(cli, proj, ['upgrade', '--tool', 'claude-code']);
    assert.match(readFileSync(join(proj, AGENT), 'utf8'), /second kit change/);
    assert.ok(existsSync(join(proj, 'builder.lock.json')), 'the lock is written from then on');
  });

  test('control: --dry-run writes no lock', () => {
    const { proj, cli } = project();
    writeFileSync(join(proj, '.keep'), '');
    run(cli, proj, ['unpack', '--tool', 'claude-code', '--dry-run']);
    assert.ok(!existsSync(join(proj, 'builder.lock.json')));
  });
});
