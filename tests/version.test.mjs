/**
 * The kit's version has one home, package.json. `cli.js --version` reads it, and the newest released CHANGELOG
 * heading must agree with it, so a release cannot be cut with the three saying different things.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const PACK = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('version — one source of truth', () => {
  test('cli --version prints package.json version, and it is the newest released CHANGELOG heading', () => {
    const pkg = JSON.parse(readFileSync(join(PACK, 'package.json'), 'utf8'));
    assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
    const r = spawnSync(process.execPath, [join(PACK, 'cli.js'), '--version'], { encoding: 'utf8' });
    assert.equal(r.stdout.trim(), pkg.version);
    const released = /^## \[(\d+\.\d+\.\d+)\]/m.exec(readFileSync(join(PACK, 'CHANGELOG.md'), 'utf8'));
    assert.ok(released, 'no released version heading in CHANGELOG.md');
    assert.equal(released[1], pkg.version, 'package.json version and the newest CHANGELOG release differ');
  });
});
