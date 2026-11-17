/**
 * dead-code (specs/repo-hygiene.spec.md REQ-1823, REQ-1824, D91; EXPERIMENTS §23): orphan files on a ratchet bank and
 * stale TODO markers by git blame. Experimental-off: off, nothing of it runs. Each test names its acceptance criterion.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const PACK = join(here, '..');
const script = join(PACK, 'scripts', 'dead-code.mjs');
const features = join(PACK, 'scripts', 'features.mjs');
const lib = require('../scripts/lib/dead-code.cjs');
const made = [];
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

const git = (cwd, args, env = {}) => spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Test Author', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 'Test Author', GIT_COMMITTER_EMAIL: 't@example.invalid', ...env } });
const project = () => {
  const dir = mkdtempSync(join(tmpdir(), 'builder-dead-code-'));
  made.push(dir);
  git(dir, ['init', '-q']);
  return dir;
};
const write = (dir, rel, text) => {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
};
const settings = (features) => JSON.stringify({ schema: 2, features }, null, 2);
const run = (cwd, args = [], env = {}) => spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', env: { ...process.env, BUILDER_CONFIG: '', ...env } });
const on = (extra = {}) => settings({ deadCode: { state: 'experimental-on', roots: ['src'], extensions: ['.js'], baseline: 'dead-code.bank.json', ...extra } });

const sources = (dir) => {
  write(dir, 'package.json', JSON.stringify({ name: 'app', main: 'src/index.js' }));
  write(dir, 'src/index.js', "const used = require('./used');\nmodule.exports = used;\n");
  write(dir, 'src/used.js', 'module.exports = 1;\n');
  write(dir, 'src/orphan.js', 'module.exports = 2;\n');
  write(dir, 'src/index.test.js', "require('./index');\n");
};

describe('REQ-1823 — ORPHAN files on a ratchet bank', () => {
  test('red: AC-1823 one ORPHAN REFUSED with an empty bank, exit 1; banked, exit 0; off, "deadCode: not configured"', () => {
    const dir = project();
    sources(dir);
    write(dir, 'builder.config.json', on());
    const r = run(dir);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /^ORPHAN REFUSED src\/orphan\.js/m);
    assert.doesNotMatch(r.stdout, /ORPHAN REFUSED src\/(index|used|index\.test)\.js/);
    assert.match(r.stdout, /dead-code: REFUSED — 1 new ORPHAN/);
    assert.ok(!existsSync(join(dir, 'dead-code.bank.json')), 'a refusal never writes the bank');

    write(dir, 'dead-code.bank.json', JSON.stringify({ items: ['src/orphan.js'], count: 1 }, null, 2));
    const banked = run(dir);
    assert.equal(banked.status, 0, banked.stdout + banked.stderr);
    assert.match(banked.stdout, /^ORPHAN src\/orphan\.js \(in the bank\)/m);
    assert.match(banked.stdout, /dead-code: PASS/);

    rmSync(join(dir, 'builder.config.json'));
    const off = run(dir);
    assert.equal(off.status, 3, off.stdout + off.stderr);
    assert.match(off.stdout, /^deadCode: not configured/);
    assert.equal(off.stdout.trim().split('\n').length, 1, 'off, nothing of it runs');
  });

  test('AC-1823: a removed orphan shrinks the bank (drain), and an `entries` glob is never an orphan', () => {
    const dir = project();
    sources(dir);
    write(dir, 'src/cli.js', 'console.log(1);\n');
    write(dir, 'dead-code.bank.json', JSON.stringify({ items: ['src/orphan.js', 'src/gone.js'], count: 2 }, null, 2));
    write(dir, 'builder.config.json', on({ entries: ['src/cli*.js'] }));
    const r = run(dir);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^DRAINED src\/gone\.js/m);
    assert.doesNotMatch(r.stdout, /ORPHAN.*src\/cli\.js/);
    const bank = JSON.parse(readFileSync(join(dir, 'dead-code.bank.json'), 'utf8'));
    assert.deepEqual(bank.items, ['src/orphan.js']);
    assert.equal(bank.count, 1);
  });

  test('AC-1823: the pure orphan rule — entries from package.json main, bin and exports, the test pattern, and imports with and without an extension', () => {
    const files = ['src/index.js', 'src/used.js', 'src/orphan.js', 'src/a.test.js', 'src/bin.js', 'src/exp.js', 'src/dir/index.js'];
    const texts = { 'src/index.js': "require('./used'); import x from './dir';", 'src/used.js': '', 'src/orphan.js': '', 'src/a.test.js': "require('./index.js')", 'src/bin.js': '', 'src/exp.js': '', 'src/dir/index.js': '' };
    const manifest = { main: 'src/index.js', bin: { app: './src/bin.js' }, exports: { '.': './src/exp.js' } };
    const r = lib.orphans({ files, read: (f) => texts[f], manifest, entries: [], testPattern: lib.DEFAULT_TEST_PATTERN, extensions: ['.js'] });
    assert.deepEqual(r, ['src/orphan.js']);
  });
});

describe('REQ-1824 — STALE-TODO by git blame', () => {
  test('red: AC-1824 a marker committed 400 days ago is STALE-TODO with the age in days and no author; exit 0', () => {
    const dir = project();
    sources(dir);
    write(dir, 'src/used.js', '// TODO: remove this shim\nmodule.exports = 1;\n');
    const old = new Date(Date.now() - 400 * 86400000).toISOString();
    git(dir, ['add', '-A']);
    const c = git(dir, ['commit', '-q', '-m', 'old'], { GIT_AUTHOR_DATE: old, GIT_COMMITTER_DATE: old });
    assert.equal(c.status, 0, c.stderr);
    write(dir, 'src/index.js', "const used = require('./used');\n// FIXME: fresh marker\nmodule.exports = used;\n");
    write(dir, 'dead-code.bank.json', JSON.stringify({ items: ['src/orphan.js'], count: 1 }, null, 2));
    write(dir, 'builder.config.json', on({ todoDays: 90 }));
    const r = run(dir);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^STALE-TODO src\/used\.js:1: TODO, (399|400|401) days old — move it to the deferred registry or delete it/m);
    assert.doesNotMatch(r.stdout, /Test Author|example\.invalid/, 'the author is never printed');
    assert.doesNotMatch(r.stdout, /STALE-TODO src\/index\.js/, 'an uncommitted or fresh marker is not stale');
    assert.match(r.stdout, /dead-code: PASS — .*1 STALE-TODO/);
  });

  test('AC-1824: the marker reader finds TODO, FIXME, HACK and XXX as words only', () => {
    assert.deepEqual(lib.markers('// TODO x\n# FIXME y\n/* HACK */\nconst XXX_LIMIT = 1; // not a marker\nxxx\n').map((m) => `${m.line}:${m.kind}`), ['1:TODO', '2:FIXME', '3:HACK']);
  });
});

describe('REQ-1825 — `features` prints the §23 decision for deadCode', () => {
  test('AC-1825: the deadCode line carries the EXPERIMENTS §23 decision', () => {
    const dir = project();
    const r = spawnSync(process.execPath, [features], { cwd: dir, encoding: 'utf8', env: { ...process.env, BUILDER_CONFIG: '' } });
    assert.match(r.stdout, /^deadCode: experimental-off — not enabled; its measurement is EXPERIMENTS\.md §23 · decision: (keep|drop|not yet measured) \(\d{4}-\d{2}-\d{2}\)/m);
  });
});
