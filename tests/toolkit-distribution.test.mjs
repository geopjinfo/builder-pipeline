/**
 * Distribution (specs/toolkit-distribution.spec.md, lane M13 of 2.0.0): the licence, the package name and bins, the
 * README badges computed from source, the verifiable proof statement and the npm publish routine. Each test names the
 * acceptance criterion it asserts (AC-5nn → REQ-5nn in the spec).
 *
 *   REQ-501…502  LICENSE (MIT) and the matching package.json field; LICENSE ships
 *   REQ-503…504  name `builder-pipeline`, two bins; no shipped file names the old scoped package; both install forms
 *   REQ-505…508  scripts/readme-badges.cjs: badges() from source, check(), --write, the README never drifts
 *   REQ-509      the proof statement; no "proven on" / "15+" / "shipped modules" claim ships
 *   REQ-510      RELEASING.md: badge command, npm pack --dry-run, npm publish, tag = registry version, first is 2.0.0
 *   REQ-511…512  built-ins only; --write refuses a file without the block, or a missing file, and writes nothing
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { shippedFiles } from './genericity.test.mjs';

const require = createRequire(import.meta.url);
const PACK = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(PACK, rel), 'utf8');
const pkg = JSON.parse(read('package.json'));
const made = [];
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), 'builder-dist-'));
  made.push(d);
  return d;
};

describe('REQ-501…502 — the licence', () => {
  test('AC-501: LICENSE is the MIT text with a copyright line', () => {
    const lines = read('LICENSE').split(/\r?\n/);
    assert.equal(lines[0], 'MIT License');
    assert.ok(lines.some((l) => /^Copyright \(c\) \d{4} \S+/.test(l)), 'no "Copyright (c) YEAR HOLDER" line');
  });

  test('AC-502: package.json license is MIT, equals the LICENSE heading, and LICENSE ships', () => {
    assert.equal(pkg.license, 'MIT');
    assert.equal(pkg.license, read('LICENSE').split(/\r?\n/)[0].split(' ')[0]);
    assert.ok(pkg.files.includes('LICENSE'), 'LICENSE missing from "files"');
  });
});

describe('REQ-503…504 — the package name', () => {
  test('AC-503: the package is builder-pipeline with the bins builder-pipeline and builder', () => {
    assert.equal(pkg.name, 'builder-pipeline');
    assert.equal(pkg.bin['builder-pipeline'], 'cli.js');
    assert.equal(pkg.bin.builder, 'cli.js');
  });

  test('AC-504: no shipped file names the old scoped package (CHANGELOG history excepted)', () => {
    const hits = [];
    for (const rel of shippedFiles(PACK)) {
      if (rel === 'CHANGELOG.md') continue;
      const buf = readFileSync(join(PACK, rel));
      if (buf.includes(0)) continue;
      buf.toString('utf8').split(/\r?\n/).forEach((line, i) => { if (line.includes(['@geopjinfo', 'builder-pipeline'].join('/'))) hits.push(`${rel}:${i + 1}`); });
    }
    assert.deepEqual(hits, []);
  });

  test('AC-505: the README gives the git-tag form and the registry form, and dates the registry listing', () => {
    const readme = read('README.md');
    assert.ok(readme.includes('npm i -D github:geopjinfo/builder-pipeline#'), 'git-tag install form missing');
    assert.match(readme, /npm i -D builder-pipeline\b/, 'registry install form missing');
    assert.ok(readme.includes('starts with 2.0.0'), 'the registry listing start is not stated');
  });
});
