/**
 * The kit's version has one home, package.json. `cli.js --version` reads it, and the newest released CHANGELOG
 * heading must agree with it, so a release cannot be cut with the three saying different things.
 *
 * A release candidate is a release: `1.0.0-rc.1` is a valid version, and its CHANGELOG heading is `## [1.0.0-rc.1]`.
 * `## [Unreleased]` is never a release heading.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const PACK = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Semver 2.0.0 core plus an optional prerelease (no build metadata: a tag carries none). */
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/;

/** The newest released version in a CHANGELOG: the first `## [x.y.z(-pre)]` heading, or null. */
function newestReleased(changelog) {
  const m = /^## \[([^\]]+)\]/gm;
  for (const h of changelog.matchAll(m)) if (SEMVER.test(h[1])) return h[1];
  return null;
}

describe('version — one source of truth', () => {
  test('red: a release candidate is a valid version and a release heading; Unreleased and junk are not', () => {
    for (const v of ['1.0.0', '0.16.0', '1.0.0-rc.1', '1.0.0-rc.12', '2.1.0-beta']) assert.match(v, SEMVER, v);
    for (const v of ['1.0', 'v1.0.0', '1.0.0-', '1.0.0-rc.01', '01.0.0', '1.0.0+build.1', 'Unreleased']) assert.doesNotMatch(v, SEMVER, v);
    assert.equal(newestReleased('# C\n\n## [Unreleased]\n\n## [1.0.0-rc.1] - 2026-11-15\n\n## [0.16.0]\n'), '1.0.0-rc.1');
    assert.equal(newestReleased('## [Unreleased]\n'), null);
  });

  test('cli --version prints package.json version, and it is the newest released CHANGELOG heading', () => {
    const pkg = JSON.parse(readFileSync(join(PACK, 'package.json'), 'utf8'));
    assert.match(pkg.version, SEMVER);
    const r = spawnSync(process.execPath, [join(PACK, 'cli.js'), '--version'], { encoding: 'utf8' });
    assert.equal(r.stdout.trim(), pkg.version);
    const released = newestReleased(readFileSync(join(PACK, 'CHANGELOG.md'), 'utf8'));
    assert.ok(released, 'no released version heading in CHANGELOG.md');
    assert.equal(released, pkg.version, 'package.json version and the newest CHANGELOG release differ');
  });
});
