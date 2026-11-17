/**
 * REQ-1812 — size-check (specs/repo-hygiene.spec.md, M19). LARGE in the tree exits 1 (D89); an LFS pointer is not
 * large; `allow` suppresses by path; `history: true` reports LARGE-HISTORY with the first commit that added the blob.
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
const PACK = join(dirname(fileURLToPath(import.meta.url)), '..');
const lib = require('../scripts/lib/size-check.cjs');
const made = [];
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

const git = (cwd, ...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
const write = (dir, rel, text) => {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
};
const profile = (features) => `# Profile\n\n## 16\n\n\`\`\`json pipeline-settings\n${JSON.stringify({ schema: 2, features })}\n\`\`\`\n`;
const run = (cwd, args = []) => spawnSync(process.execPath, [join(PACK, 'scripts', 'size-check.mjs'), ...args], { cwd, encoding: 'utf8', env: { ...process.env, BUILDER_CONFIG: '' } });

/** main: a 2 MB blob added then deleted two commits ago; a 600 KB file and an LFS pointer tracked now. */
function sized(features) {
  const dir = mkdtempSync(join(tmpdir(), 'size-check-'));
  made.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  write(dir, 'README.md', '# x\n');
  write(dir, 'big.bin', 'B'.repeat(2 * 1024 * 1024));
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'add big');
  git(dir, 'rm', '-q', 'big.bin');
  git(dir, 'commit', '-q', '-m', 'drop big');
  write(dir, 'assets/medium.dat', 'M'.repeat(600 * 1024));
  write(dir, 'model.onnx', 'version https://git-lfs.github.com/spec/v1\noid sha256:' + 'a'.repeat(64) + '\nsize 123456789\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'medium and a pointer');
  if (features) write(dir, 'PIPELINE_PROFILE.md', profile(features));
  return dir;
}

describe('REQ-1812 — LARGE, LARGE-HISTORY, the pointer and allow', () => {
  test('red: AC-1812 one LARGE with the size in KB, one LARGE-HISTORY with the adding commit, exit 1', () => {
    const dir = sized({ sizeCheck: { state: 'on', maxFileKb: 512, history: true } });
    const adding = git(dir, 'log', '--diff-filter=A', '--format=%h', '--', 'big.bin').stdout.trim();
    const r = run(dir);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /^LARGE\s+assets\/medium\.dat — 600 KB \(limit 512 KB\)$/m);
    assert.match(r.stdout, new RegExp(`^LARGE-HISTORY\\s+big\\.bin — 2048 KB, added in ${adding}( .*)?$`, 'm'));
    assert.match(r.stdout, /^size-check: FAIL — 1 large file\(s\) in the tree, 1 in history \(reported\)/m);
  });

  test('red: AC-1812b the LFS pointer is not LARGE; history off reports nothing from history; allow clears the tree finding → exit 0', () => {
    const dir = sized({ sizeCheck: { state: 'on', maxFileKb: 512, allow: ['assets/*'] } });
    const r = run(dir);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout, /model\.onnx/);
    assert.doesNotMatch(r.stdout, /LARGE-HISTORY/);
    assert.match(r.stdout, /^size-check: PASS — 0 large file\(s\) in the tree/m);
  });

  test('red: off → not configured, exit 3; --defaults runs with 512 KB; --max-kb overrides; a bad value is usage (2)', () => {
    const dir = sized();
    const off = run(dir);
    assert.equal(off.status, 3);
    assert.equal(off.stdout.trim(), 'sizeCheck: not configured');
    const dflt = run(dir, ['--defaults']);
    assert.equal(dflt.status, 1, dflt.stdout);
    assert.match(dflt.stdout, /^sizeCheck: not configured — checking with defaults$/m);
    const wide = run(dir, ['--defaults', '--max-kb', '1024']);
    assert.equal(wide.status, 0, wide.stdout);
    assert.equal(run(dir, ['--defaults', '--max-kb', 'lots']).status, 2);
  });

  test('isLfsPointer and the KB rounding are exact', () => {
    assert.equal(lib.isLfsPointer(Buffer.from('version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 9\n')), true);
    assert.equal(lib.isLfsPointer(Buffer.from('B'.repeat(10))), false);
    assert.equal(lib.kb(600 * 1024), 600);
    assert.equal(lib.kb(600 * 1024 + 1), 601);
  });
});
