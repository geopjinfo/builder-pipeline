/**
 * REQ-1813, REQ-1814, REQ-1817 — secret-scan (specs/repo-hygiene.spec.md, M19). The tree scan with the outbound
 * guard's shapes, the tracked .env rule, binary and large files skipped and counted, `allow`, exit 1 on a finding
 * (D89); the history scan over the added lines of target..HEAD; the one exported SHAPES list (D88).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const PACK = join(dirname(fileURLToPath(import.meta.url)), '..');
const lib = require('../scripts/lib/secret-scan.cjs');
const guard = require('../scripts/lib/outbound-guard.cjs');
const made = [];
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

// Fake shapes, built at run time so this file never holds a key-looking literal.
const AWS = `AKIA${'Q'.repeat(16)}`;
const GH = `ghp_${'a1B2'.repeat(10)}`;
const git = (cwd, ...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
const write = (dir, rel, text) => {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
};
const profile = (features) => `# Profile\n\n## 16\n\n\`\`\`json pipeline-settings\n${JSON.stringify({ schema: 2, features })}\n\`\`\`\n`;
const run = (cwd, args = []) => spawnSync(process.execPath, [join(PACK, 'scripts', 'secret-scan.mjs'), ...args], { cwd, encoding: 'utf8', env: { ...process.env, BUILDER_CONFIG: '' } });

function leaky(features) {
  const dir = mkdtempSync(join(tmpdir(), 'secret-scan-'));
  made.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  write(dir, 'src/config.js', `const region = 'eu-west-1';\nconst key = '${AWS}';\n`);
  write(dir, '.env', 'DB_PASSWORD_PLACEHOLDER=unset\n');
  write(dir, 'bin/blob.dat', Buffer.from([0, 1, 2, 3, 0, 255]).toString('latin1'));
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  if (features) write(dir, 'PIPELINE_PROFILE.md', profile(features));
  return dir;
}

describe('REQ-1813 — the tree scan', () => {
  test('red: AC-1813 an AWS key shape and a tracked .env are two findings with kind and line; the key text is absent; exit 1', () => {
    const dir = leaky({ secretScan: { state: 'on' } });
    const r = run(dir);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /^SECRET\s+src\/config\.js:2 — AWS access key$/m);
    assert.match(r.stdout, /^ENV-FILE\s+\.env — a tracked env file$/m);
    assert.ok(!(r.stdout + r.stderr).includes(AWS), 'the matched text never prints');
    assert.match(r.stdout, /^secret-scan: FAIL — 2 finding\(s\) · 1 binary file\(s\) skipped/m);
  });

  test('red: AC-1813b the file and the env file in allow → exit 0; a 2 MB text file is skipped and counted', () => {
    const dir = leaky({ secretScan: { state: 'on', allow: ['src/config.js', '.env'] } });
    write(dir, 'data/dump.txt', `${'x'.repeat(2 * 1024 * 1024)}\n${AWS}\n`);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'dump');
    const r = run(dir);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^secret-scan: PASS — 0 finding\(s\) · 1 binary file\(s\) skipped, 1 over 1 MB skipped/m);
    assert.ok(!r.stdout.includes(AWS));
  });

  test('red: roots narrows the scan; off → not configured, exit 3; --defaults runs the defaults', () => {
    const dir = leaky({ secretScan: { state: 'on', roots: ['bin'] } });
    const narrow = run(dir);
    assert.equal(narrow.status, 1, narrow.stdout); // the tracked .env is reported whatever the roots
    assert.doesNotMatch(narrow.stdout, /config\.js/);
    const dflt = run(leaky(), ['--defaults']);
    assert.equal(dflt.status, 1);
    assert.match(dflt.stdout, /^secretScan: not configured — checking with defaults$/m);
    const off = run(leaky());
    assert.equal(off.status, 3);
    assert.equal(off.stdout.trim(), 'secretScan: not configured');
  });

  test('scanText names the kind and the line, never the text; the private-key header is a shape', () => {
    const header = ['-----BEGIN RSA', 'PRIVATE', 'KEY-----'].join(' '); // built at run time: no literal shape in this file
    const hits = lib.scanText(`ok\n${header}\n${GH}\n`);
    assert.deepEqual(hits.map((h) => [h.kind, h.line]), [['private key', 2], ['GitHub token', 3]]);
    assert.equal(JSON.stringify(hits).includes(GH), false);
  });
});

describe('REQ-1814 — the history scan', () => {
  test('red: AC-1814 a key added and removed in two commits names the adding commit and the kind, prints the rotate sentence, exit 1', () => {
    const dir = leaky({ secretScan: { state: 'on', allow: ['src/config.js', '.env'], history: true } });
    git(dir, 'checkout', '-q', '-b', 'feature');
    write(dir, 'notes.md', `token: ${GH}\n`);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'oops');
    const adding = git(dir, 'rev-parse', '--short', 'HEAD').stdout.trim();
    write(dir, 'notes.md', 'token: (rotated)\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'remove');
    const r = run(dir, ['--target', 'main']);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, new RegExp(`^SECRET-HISTORY\\s+${adding} notes\\.md — GitHub token$`, 'm'));
    assert.match(r.stdout, /^Rotate the key\. The history rewrite is a decision for a person\.$/m);
    assert.ok(!(r.stdout + r.stderr).includes(GH));
  });

  test('red: maxCommits bounds the walk and the summary says how many commits were read', () => {
    const dir = leaky({ secretScan: { state: 'on', allow: ['src/config.js', '.env'], history: true, maxCommits: 1 } });
    git(dir, 'checkout', '-q', '-b', 'feature');
    write(dir, 'notes.md', `token: ${GH}\n`);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'oops');
    write(dir, 'notes.md', 'token: (rotated)\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'remove');
    const r = run(dir, ['--target', 'main']);
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /history: 1 commit\(s\) read \(maxCommits 1\)/);
  });
});

describe('REQ-1817 — one SHAPES list (D88)', () => {
  const SOURCES = ['scripts/lib/secret-scan.cjs', 'hooks/secret-scan-precommit.sh', 'hooks/claude-code/secret-write-guard.cjs'];
  test('red: AC-1817 the guard exports SHAPES; the scan and the two hooks import it and hold no regular expression of a known shape', () => {
    assert.ok(Array.isArray(guard.SHAPES) && guard.SHAPES.length >= 10);
    assert.ok(guard.SHAPES.every(([kind, re]) => typeof kind === 'string' && re instanceof RegExp));
    assert.equal(guard.SHAPES, guard.PATTERNS);
    const tells = ['AKIA', 'ghp', 'sk-ant', 'xox', 'AIza', 'eyJ', 'PRIVATE KEY', 'github_pat'];
    for (const rel of SOURCES) {
      const text = readFileSync(join(PACK, rel), 'utf8');
      assert.match(text, /SHAPES/, `${rel} imports SHAPES`);
      const literals = text.match(/\/(?:\\.|[^/\n])+\/[gimsuy]*/g) || [];
      const copies = literals.filter((l) => tells.some((t) => l.includes(t)));
      assert.deepEqual(copies, [], `${rel} holds its own copy of a shape`);
    }
  });
});
