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
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  test('AC-503: the package is builder-pipeline with the one bin builder-pipeline (the `builder` bin went in 2.0.0, DL-2)', () => {
    assert.equal(pkg.name, 'builder-pipeline');
    assert.deepEqual(pkg.bin, { 'builder-pipeline': 'cli.js' });
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

  test('AC-505: the README gives the git-tag form only and the pinned command (DL-11, REQ-2028)', () => {
    const readme = read('README.md');
    assert.ok(readme.includes('npm i -D github:geopjinfo/builder-pipeline#'), 'git-tag install form missing');
    assert.doesNotMatch(readme, /npm i -D builder-pipeline\b/, 'the registry install form is back; the name is not registered (DL-11)');
    assert.match(readme, /npx --no-install builder-pipeline --version/);
  });
});

describe('REQ-505…508, REQ-511…512 — README badges from source', () => {
  const lib = require('../scripts/readme-badges.cjs');
  const script = join(PACK, 'scripts', 'readme-badges.cjs');
  const run = (args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  /** Count the numbered rows of the phase table independently of the library. */
  const phaseRows = () => {
    const lines = read('skills/build-module-pipeline.md').split(/\r?\n/);
    const start = lines.indexOf('## Phase order');
    assert.ok(start > 0, 'no ## Phase order section');
    let n = 0;
    for (let i = start + 1; i < lines.length && !lines[i].startsWith('## '); i++) {
      const m = /^\|\s*([^|]*?)\s*\|/.exec(lines[i]);
      if (m && m[1] !== '#' && !/^-+$/.test(m[1]) && m[1] !== '—') n++;
    }
    return n;
  };
  const drifted = () => read('README.md').replace(/pipeline-\d+_phases/, 'pipeline-10_phases');

  test('AC-506: every badge value comes from its source', () => {
    const markup = lib.badges();
    const phases = phaseRows();
    assert.ok(phases >= 8, `phase table has ${phases} rows`);
    assert.ok(markup.includes(`/pipeline-${phases}_phases-`), `phases: ${markup}`);
    const agentFiles = readdirSync(join(PACK, 'agents')).filter((n) => n.endsWith('.md')).length;
    assert.ok(markup.includes(`/personas-${agentFiles}_agents-`), `personas: ${markup}`);
    const tools = (/^const TOOLS = \{\n([\s\S]*?)^\};/m.exec(read('cli.js')) || [])[1].split('\n').filter((l) => /^\s*'?[\w-]+'?:\s*\{/.test(l)).length;
    assert.ok(tools >= 3, `TOOLS has ${tools} keys`);
    assert.ok(markup.includes(`/--tool_targets-${tools}-`), `tool targets: ${markup}`);
    assert.equal(pkg.engines.node, '>=18');
    assert.ok(markup.includes('/node-%E2%89%A518-'), `node: ${markup}`);
    assert.equal(pkg.dependencies, undefined);
    assert.ok(markup.includes('/CLI_dependencies-zero-'), `deps: ${markup}`);
    assert.ok(markup.includes('/install-npm-'), `install: ${markup}`);
    assert.ok(markup.startsWith('<p align="center">\n') && markup.endsWith('\n</p>'));
  });

  test('AC-507: check() names the drifted badge', () => {
    const out = lib.check(drifted());
    assert.equal(out.length, 1, out.join('\n'));
    assert.match(out[0], /^pipeline:/);
  });

  test('AC-508: check() on a matching block returns nothing', () => {
    const text = `# T\n\n${lib.badges()}\n\nbody\n`;
    assert.deepEqual(lib.check(text), []);
  });

  test('AC-509: --write FILE rewrites only the badge block', () => {
    const dir = scratch();
    const file = join(dir, 'README.md');
    writeFileSync(file, `# Changed first line\n${drifted().split('\n').slice(1).join('\n')}`);
    const r = run(['--write', file]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const after = readFileSync(file, 'utf8');
    assert.deepEqual(lib.check(after), []);
    assert.equal(after.split('\n')[0], '# Changed first line');
    assert.equal(after.split('\n').length, read('README.md').split('\n').length);
  });

  test('AC-510: without --write, a drifted file exits 1 and names the badge', () => {
    const dir = scratch();
    const file = join(dir, 'README.md');
    writeFileSync(file, drifted());
    const r = run([file]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /^readme-badges: pipeline:/m);
  });

  test('AC-511: the repository README carries the generated badges', () => {
    assert.deepEqual(lib.check(read('README.md')), []);
  });

  test('AC-515: the script requires Node built-ins only and loads', () => {
    const src = read('scripts/readme-badges.cjs');
    const mods = [...src.matchAll(/require\((['"])([^'"]+)\1\)/g)].map((m) => m[2]);
    assert.ok(mods.length > 0);
    for (const m of mods) assert.ok(m.startsWith('node:') || m.startsWith('.'), `not a built-in: ${m}`);
    assert.equal(typeof lib.badges, 'function');
  });

  test('AC-516: --write on a file with no badge block is refused and writes nothing', () => {
    const dir = scratch();
    const file = join(dir, 'plain.md');
    writeFileSync(file, '# No badges here\n\nbody\n');
    const r = run(['--write', file]);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /no badge block/);
    assert.equal(readFileSync(file, 'utf8'), '# No badges here\n\nbody\n');
  });

  test('AC-517: --write on a missing file is refused and creates nothing', () => {
    const file = join(scratch(), 'missing.md');
    const r = run(['--write', file]);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /no such file/);
    assert.ok(!existsSync(file));
  });
});

describe('REQ-509…510 — the proof statement and the release routine', () => {
  test('AC-512: the README states what can be verified', () => {
    const readme = read('README.md');
    assert.ok(readme.includes('Built and used by its author on one production backend.'));
    assert.ok(readme.includes('Published measurements start with 2.0.0'));
  });

  test('AC-513: no shipped Markdown document makes an unverifiable claim', () => {
    const hits = [];
    for (const rel of shippedFiles(PACK).filter((f) => f.endsWith('.md'))) {
      if (rel === 'CHANGELOG.md') continue;
      read(rel).split(/\r?\n/).forEach((line, i) => {
        if (/proven on|15\+|shipped modules/.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    assert.deepEqual(hits, []);
  });

  test('AC-514: RELEASING.md names the badge command and the npm publish steps', () => {
    const rel = read('RELEASING.md');
    assert.ok(rel.includes('readme-badges.cjs --write'));
    assert.ok(rel.includes('npm pack --dry-run'));
    assert.ok(rel.includes('npm publish --access public'));
    assert.ok(rel.includes('first registry release is 2.0.0'));
    assert.match(rel, /tag and the registry version must match/);
  });
});
