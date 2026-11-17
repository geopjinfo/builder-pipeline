/**
 * docs-check (specs/repo-hygiene.spec.md REQ-1822, D92): paths, links, anchors and `run <name>` commands in Markdown
 * under `features.docsCheck.roots` resolve; external URLs are never fetched. Each test names its acceptance criterion.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const PACK = join(here, '..');
const script = join(PACK, 'scripts', 'docs-check.mjs');
const lib = require('../scripts/lib/docs-check.cjs');
const made = [];
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

const project = () => {
  const dir = mkdtempSync(join(tmpdir(), 'builder-docs-check-'));
  made.push(dir);
  return dir;
};
const write = (dir, rel, text) => {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
};
const run = (cwd, args = [], env = {}) => spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', env: { ...process.env, BUILDER_CONFIG: '', ...env } });
const settings = (features) => JSON.stringify({ schema: 2, features }, null, 2);

const docs = (dir) => {
  write(dir, 'src/index.js', 'module.exports = 1;\n');
  write(dir, 'docs/setup.md', '# Setup\n\n## Install the kit\n\nText.\n');
  write(dir, 'README.md', [
    '# Project',
    '',
    'The entry point is `src/index.js`. Read [setup](docs/setup.md) and [the install step](docs/setup.md#install-the-kit).',
    'Then see [the missing page](docs/missing.md) and [a missing anchor](docs/setup.md#no-such-heading).',
    'A remote link: [the registry](https://example.invalid/never-fetched).',
    '',
    '```sh',
    'npx builder-pipeline run claims-check --files',
    'npx builder-pipeline run no-such-script',
    '```',
    '',
  ].join('\n'));
};

describe('REQ-1822 — docs-check over the Markdown under roots', () => {
  test('red: AC-1822 one broken link, one missing anchor, one unknown script at their lines; fetch never called; exit 1', () => {
    const dir = project();
    docs(dir);
    write(dir, 'builder.config.json', settings({ docsCheck: { state: 'on', roots: ['README.md', 'docs'] } }));
    const r = run(dir);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /^BROKEN-LINK README\.md:4: docs\/missing\.md/m);
    assert.match(r.stdout, /^BROKEN-ANCHOR README\.md:4: docs\/setup\.md#no-such-heading/m);
    assert.match(r.stdout, /^UNKNOWN-SCRIPT README\.md:9: no-such-script/m);
    assert.doesNotMatch(r.stdout, /example\.invalid/, 'the external URL is not a finding');
    assert.doesNotMatch(r.stdout, /BROKEN-PATH/, 'src/index.js resolves');
    assert.match(r.stdout, /docs-check: FAIL — 3 findings? in 2 files/);
  });

  test('AC-1822: the lib never calls the injected fetch, and a clean tree has no finding', () => {
    const dir = project();
    docs(dir);
    let calls = 0;
    const files = lib.markdownFiles(dir, ['docs']);
    const result = lib.check(files.map((p) => ({ path: p, text: lib.read(dir, p) })), { root: dir, scripts: new Set(['claims-check']), fetch: () => { calls++; throw new Error('a fetch happened'); } });
    assert.equal(calls, 0);
    assert.deepEqual(result.findings, []);
  });

  test('AC-1822: a GitHub slug for a heading with code, punctuation and a repeat', () => {
    assert.deepEqual(lib.headingSlugs('# A `b` c!\n\n## A `b` c!\n\n### Install the kit (step 2)\n'), ['a-b-c', 'a-b-c-1', 'install-the-kit-step-2']);
  });

  test('AC-1822: ignorePaths suppresses by file path and by target', () => {
    const dir = project();
    docs(dir);
    write(dir, 'builder.config.json', settings({ docsCheck: { state: 'on', roots: ['README.md'], ignorePaths: ['^docs/missing', 'no-such-heading', 'no-such-script'] } }));
    const r = run(dir);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /docs-check: PASS/);
  });

  test('AC-1822: off prints "docsCheck: not configured" and exits 3; named files run with defaults', () => {
    const dir = project();
    docs(dir);
    const off = run(dir);
    assert.equal(off.status, 3, off.stdout + off.stderr);
    assert.equal(off.stdout.trim(), 'docsCheck: not configured');
    const named = run(dir, ['docs/setup.md']);
    assert.equal(named.status, 0, named.stdout + named.stderr);
    assert.match(named.stdout, /^docsCheck: not configured — checking docs\/setup\.md with defaults/m);
  });

  test('AC-1822: a flag without a value and an unknown flag exit 2', () => {
    const dir = project();
    assert.equal(run(dir, ['--bogus']).status, 2);
  });
});
