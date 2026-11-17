/**
 * No real-looking key anywhere (REQ-1007, REQ-104; D9, D18).
 *
 * WHY. A kit that handles keys is one careless fixture away from shipping one. This test scans, with the outbound
 * guard's key shapes, (1) every shipped file, (2) every file under tests/fixtures, (3) the accounts home and the
 * captured stdio of one real `accounts add` + `accounts key` run with a fake key built at runtime. The one place the
 * value may live is the key file itself (that is its job), so that path alone is excluded. The "assigned secret"
 * heuristic is left out on purpose: it matches identifiers such as API_KEY_VAR = 'ANTHROPIC_API_KEY' in code and in
 * synthetic stream fixtures, which are names, not keys. The fakes in every accounts test are built by concatenation,
 * so a literal that matches here is a planted secret, and the failure names the file.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const PACK = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { PATTERNS } = require(join(PACK, 'scripts/lib/outbound-guard.cjs'));
const { paths } = require(join(PACK, 'scripts/lib/account-paths.cjs'));
const KEY_SHAPES = PATTERNS.filter(([kind]) => kind !== 'assigned secret');
const made = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

/** Every file under `dir` (absolute), skipping .git and node_modules. */
function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.isFile()) acc.push(p);
  }
  return acc;
}

/** `file:line [kind]` for every key-shape hit in `text`; the matched text is never returned. */
export function hitsIn(text, label) {
  const out = [];
  String(text).split(/\r?\n/).forEach((line, i) => {
    for (const [kind, re] of KEY_SHAPES) if (re.test(line)) out.push(`${label}:${i + 1} [${kind}]`);
  });
  return out;
}

/** Scan files (absolute paths), labelling each relative to `root`; `skip` are absolute paths that may hold a key. */
export function scanFiles(files, root, skip = []) {
  const hits = [];
  for (const f of files) {
    if (skip.includes(f)) continue;
    const buf = readFileSync(f);
    if (buf.includes(0)) continue; // binary
    hits.push(...hitsIn(buf.toString('utf8'), relative(root, f).split('\\').join('/')));
  }
  return hits;
}

/** Every file the package ships: package.json "files" (folders walked) plus the files npm always adds. */
function shippedFiles(root) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const out = new Set([join(root, 'package.json')]);
  for (const always of ['README.md', 'CHANGELOG.md', 'LICENSE', 'LICENSE.md']) if (existsSync(join(root, always))) out.add(join(root, always));
  for (const entry of pkg.files || []) {
    const abs = join(root, entry.replace(/\/$/, ''));
    if (!existsSync(abs)) continue;
    if (statSync(abs).isDirectory()) walk(abs).forEach((f) => out.add(f));
    else out.add(abs);
  }
  return [...out].sort();
}

const fakeKey = (tag) => ['sk', 'ant', 'api03'].join('-') + '-' + `${tag}0`.repeat(8);

describe('secret shapes (REQ-1007)', () => {
  test('red: REQ-1007 no shipped file holds a key shape', () => {
    assert.deepEqual(scanFiles(shippedFiles(PACK), PACK), []);
  });

  test('red: REQ-1007 no fixture under tests/fixtures holds a key shape', () => {
    assert.deepEqual(scanFiles(walk(join(PACK, 'tests', 'fixtures')), PACK), []);
  });

  test('red: REQ-1007 a run of accounts add + key leaves the value in the key file only: not in the temp HOME, the profile or the captured stdio', () => {
    const proj = mkdtempSync(join(tmpdir(), 'kit-secret-shapes-'));
    made.push(proj);
    const home = join(proj, 'home');
    mkdirSync(home);
    writeFileSync(join(proj, 'PIPELINE_PROFILE.md'), '# P\n\n```json pipeline-settings\n' + JSON.stringify({ schema: 2, commands: { tier: null, tiers: [], affected: null, typecheck: null }, models: { strong: 'a', mid: 'b', orchestrator: null } }, null, 2) + '\n```\n');
    const env = { ...process.env, BUILDER_NO_BASH_CAP: '1', BUILDER_ACCOUNTS_HOME: home, HOME: home, USERPROFILE: home };
    const cli = (args, input) => spawnSync(process.execPath, [join(PACK, 'cli.js'), 'accounts', ...args], { cwd: proj, encoding: 'utf8', env, input });
    const value = fakeKey('kilo');
    let stdio = '';
    for (const [args, input] of [[['add', 'alpha', '--worker', 'claude-code', '--pays', 'api-key'], undefined], [['key', 'alpha'], value], [['list'], undefined], [['list', '--json'], undefined], [['key', 'alpha', '--remove'], undefined], [['key', 'alpha'], value]]) {
      const r = cli(args, input);
      assert.equal(r.status, 0, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
      stdio += `\n--- ${args.join(' ')}\n${r.stdout}${r.stderr}`;
    }
    const keyFile = paths(home, 'alpha').keyFile;
    assert.equal(readFileSync(keyFile, 'utf8'), value, 'the key file is the one legitimate holder');
    assert.deepEqual(scanFiles(walk(proj), proj, [keyFile]), [], 'nothing but the key file holds a key shape');
    assert.deepEqual(hitsIn(stdio, 'stdio'), [], 'the captured stdio holds no key shape');
    assert.equal(stdio.includes(value.slice(0, 12)), false);
  });

  test('red: REQ-1007 a planted key shape in a fixture-like tree fails naming the file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kit-planted-'));
    made.push(dir);
    mkdirSync(join(dir, 'fixtures', 'deep'), { recursive: true });
    writeFileSync(join(dir, 'fixtures', 'clean.json'), JSON.stringify({ apiKeySource: 'ANTHROPIC_API_KEY', note: 'no key here' }));
    writeFileSync(join(dir, 'fixtures', 'deep', 'planted.txt'), `token: ${fakeKey('lima')}\n`);
    writeFileSync(join(dir, 'fixtures', 'deep', 'jwt.txt'), ['eyJ' + 'a'.repeat(12), 'eyJ' + 'b'.repeat(12), 'c'.repeat(12)].join('.') + '\n');
    const hits = scanFiles(walk(dir), dir);
    assert.deepEqual(hits, ['fixtures/deep/jwt.txt:1 [JWT]', 'fixtures/deep/planted.txt:1 [Anthropic key]']);
    for (const h of hits) assert.equal(h.includes('lima'), false, 'a hit names the file and the kind, never the text');
  });

  test('control: this file and the accounts tests hold no literal key shape (fakes are built at runtime)', () => {
    const own = readdirSync(join(PACK, 'tests')).filter((f) => /^(account|accounts|secret)-.*\.test\.mjs$/.test(f)).map((f) => join(PACK, 'tests', f));
    assert.ok(own.length >= 4, own.join(', '));
    assert.deepEqual(scanFiles(own, PACK), []);
    assert.ok(statSync(join(PACK, 'tests', 'fixtures', 'accounts', 'codex-stub.cjs')).isFile());
  });
});
