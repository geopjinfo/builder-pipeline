/**
 * D3 — the hooks find the kit when it is installed as a package (node_modules/@geopjinfo/builder-pipeline), and run
 * its code only when the committed builder.lock.json + package-lock.json vouch for it: the script hashes come from the
 * tarball package-lock.json's integrity names (npm's cache), never from node_modules.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { dirname, join, relative } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const PACK = join(dirname(fileURLToPath(import.meta.url)), '..');
const BOARD = join(PACK, 'tests', 'fixtures', 'board', 'tasks', 'sample.md');
const made = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

const git = (cwd, ...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8' });

function project(kitAt = 'node_modules/@geopjinfo/builder-pipeline') {
  const proj = mkdtempSync(join(tmpdir(), 'kit-pkg-'));
  made.push(proj);
  const kit = join(proj, ...kitAt.split('/'));
  mkdirSync(kit, { recursive: true });
  cpSync(PACK, kit, { recursive: true, filter: (src) => !/[\\/](?:\.git|tests|node_modules)(?:[\\/]|$)/.test(`/${relative(PACK, src)}`) });
  return { proj, kit, cli: join(kit, 'cli.js') };
}
const run = (cli, cwd, args, env = {}) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
const out = (r) => `${r.stdout}${r.stderr}`;

/** Every file under a folder (posix, relative to `root`), skipping the kit itself. */
function files(root, from = root) {
  const acc = [];
  if (!existsSync(from)) return acc;
  for (const e of readdirSync(from, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'builder' || e.name === '.git') continue;
    const p = join(from, e.name);
    if (e.isDirectory()) acc.push(...files(root, p));
    else acc.push(relative(root, p).split('\\').join('/'));
  }
  return acc;
}

/** A ustar archive of { name: Buffer } (names < 100 bytes, or split into the 155-byte prefix). */
function tar(entries) {
  const blocks = [];
  for (const [name, body] of Object.entries(entries)) {
    const h = Buffer.alloc(512);
    let base = name;
    let prefix = '';
    if (Buffer.byteLength(name) > 99) {
      const cut = name.lastIndexOf('/', 154);
      prefix = name.slice(0, cut);
      base = name.slice(cut + 1);
    }
    h.write(base, 0);
    h.write('0000644\0', 100);
    h.write('0000000\0', 108);
    h.write('0000000\0', 116);
    h.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124);
    h.write('00000000000\0', 136);
    h.write('        ', 148);
    h.write('0', 156);
    h.write('ustar\0', 257);
    h.write('00', 263);
    h.write(prefix, 345);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(h, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

/**
 * "Publish" the installed kit: its scripts/ and package.json as a tarball in a private npm cache (cacache layout),
 * and a package-lock.json that records its integrity — what `npm i` leaves behind.
 */
function publish(proj, kit, { tamperTarball = false } = {}) {
  const entries = { 'package/package.json': readFileSync(join(kit, 'package.json')) };
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else entries[`package/${relative(kit, p).split('\\').join('/')}`] = readFileSync(p);
    }
  };
  walk(join(kit, 'scripts'));
  if (tamperTarball) entries['package/scripts/lib/board-freshness.cjs'] = Buffer.concat([entries['package/scripts/lib/board-freshness.cjs'], Buffer.from('\n// forged\n')]);
  const tgz = gzipSync(tar(entries));
  const digest = createHash('sha512').update(tgz).digest();
  const cache = join(proj, '.npm-cache');
  const hex = digest.toString('hex');
  mkdirSync(join(cache, '_cacache', 'content-v2', 'sha512', hex.slice(0, 2), hex.slice(2, 4)), { recursive: true });
  writeFileSync(join(cache, '_cacache', 'content-v2', 'sha512', hex.slice(0, 2), hex.slice(2, 4), hex.slice(4)), tgz);
  const integrity = `sha512-${digest.toString('base64')}`;
  writeFileSync(
    join(proj, 'package-lock.json'),
    JSON.stringify({ name: 'p', lockfileVersion: 3, packages: { '': { name: 'p' }, 'node_modules/@geopjinfo/builder-pipeline': { version: '0.0.0', integrity } } }, null, 2),
  );
  return { cache, integrity };
}

describe('D3 — the hooks find the kit in the package', () => {
  /**
   * A committed project with the kit installed as a package. The lock's package record is anchored to the
   * package-lock.json integrity (the published tarball), never to what node_modules holds.
   */
  function installed({ before } = {}) {
    const p = project();
    git(p.proj, 'init', '-q');
    writeFileSync(join(p.proj, '.gitignore'), 'node_modules/\n.npm-cache/\n');
    const { cache } = publish(p.proj, p.kit);
    if (before) before(p);
    const u = run(p.cli, p.proj, ['unpack', '--tool', 'claude-code'], { npm_config_cache: cache });
    assert.equal(u.status, 0, out(u));
    git(p.proj, 'add', '-A');
    git(p.proj, 'commit', '-q', '-m', 'setup');
    const lock = JSON.parse(readFileSync(join(p.proj, 'builder.lock.json'), 'utf8'));
    return { ...p, lock, unpack: u };
  }
  const hook = (proj, file, input) =>
    spawnSync(process.execPath, [join(proj, '.claude', 'hooks', file)], { cwd: proj, input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: proj } });

  test('red: the lock records the package from the tarball package-lock.json names', () => {
    const { lock } = installed();
    assert.equal(lock.package.verified, true, JSON.stringify(lock.package));
    assert.match(lock.package.integrity, /^sha512-/);
    assert.match(lock.package.files['scripts/lib/profile.cjs'], /^[0-9a-f]{64}$/);
  });

  test('red: node_modules tampered BEFORE unpack is never vouched for — the hooks do not run it', () => {
    const { proj, lock, unpack } = installed({
      before: ({ kit }) => writeFileSync(join(kit, 'scripts', 'lib', 'board-freshness.cjs'), `${readFileSync(join(kit, 'scripts', 'lib', 'board-freshness.cjs'), 'utf8')}\n// planted\n`),
    });
    assert.equal(lock.package.verified, false);
    assert.equal(lock.package.files, undefined, 'no hash is taken from node_modules');
    assert.match(lock.package.reason, /node_modules differs from the published tarball: scripts\/lib\/board-freshness\.cjs/);
    assert.match(unpack.stdout, /could not be verified/);
    const r = hook(proj, 'board-render.cjs', { tool_name: 'Write', tool_input: { file_path: join(proj, 'x.md') } });
    assert.match(r.stderr, /not run — .*not verified/);
  });

  test('red: no integrity to anchor to (no package-lock.json) — not verified, not run', () => {
    const { proj, lock } = installed({ before: ({ proj: pr }) => rmSync(join(pr, 'package-lock.json')) });
    assert.equal(lock.package.verified, false);
    const r = hook(proj, 'board-render.cjs', { tool_name: 'Write', tool_input: { file_path: join(proj, 'x.md') } });
    assert.match(r.stderr, /not run/);
  });

  test('red: a cache entry swapped for other bytes (a tarball matching tampered files) is refused', () => {
    const { lock } = installed({
      before: ({ proj: pr, kit }) => {
        const { integrity } = JSON.parse(readFileSync(join(pr, 'package-lock.json'), 'utf8')).packages['node_modules/@geopjinfo/builder-pipeline'];
        const hex = Buffer.from(integrity.slice(7), 'base64').toString('hex');
        const real = join(pr, '.npm-cache', '_cacache', 'content-v2', 'sha512', hex.slice(0, 2), hex.slice(2, 4), hex.slice(4));
        const forged = publish(pr, kit, { tamperTarball: true });
        const fhex = Buffer.from(forged.integrity.slice(7), 'base64').toString('hex');
        // the forged tarball's bytes under the REAL integrity's name, and the real package-lock entry back
        writeFileSync(real, readFileSync(join(pr, '.npm-cache', '_cacache', 'content-v2', 'sha512', fhex.slice(0, 2), fhex.slice(2, 4), fhex.slice(4))));
        const fresh = join(kit, 'scripts', 'lib', 'board-freshness.cjs');
        writeFileSync(fresh, Buffer.concat([readFileSync(fresh), Buffer.from('\n// forged\n')]));
        const pl = JSON.parse(readFileSync(join(pr, 'package-lock.json'), 'utf8'));
        pl.packages['node_modules/@geopjinfo/builder-pipeline'].integrity = integrity;
        writeFileSync(join(pr, 'package-lock.json'), JSON.stringify(pl));
      },
    });
    assert.equal(lock.package.verified, false);
    assert.match(lock.package.reason, /not in the npm cache/);
  });

  test('red: a package-lock.json changed after the commit no longer vouches', () => {
    const { proj } = installed();
    const pl = join(proj, 'package-lock.json');
    writeFileSync(pl, readFileSync(pl, 'utf8').replace('sha512-', 'sha512-A'));
    const r = hook(proj, 'board-render.cjs', { tool_name: 'Write', tool_input: { file_path: join(proj, 'x.md') } });
    assert.match(r.stderr, /not run/);
  });

  test('red: board-render loads its libraries from the package', () => {
    const { proj } = installed();
    const r = hook(proj, 'board-render.cjs', { tool_name: 'Write', tool_input: { file_path: join(proj, 'x.md') } });
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.stderr, /not found|not run/, r.stderr);
  });

  test('red: board-render renders a stale board through the package script', () => {
    const { proj } = installed();
    copyFileSync(BOARD, join(proj, 'tasks', 'rooms.md'));
    mkdirSync(join(proj, '.pipeline', 'rooms'), { recursive: true });
    writeFileSync(join(proj, '.pipeline', 'rooms', 'run.jsonl'), `${JSON.stringify({ ts: new Date().toISOString(), kind: 'phase', phase: 'P1', status: 'start' })}\n`);
    const r = hook(proj, 'board-render.cjs', { tool_name: 'Write', tool_input: { file_path: join(proj, 'tasks', 'rooms.md') } });
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.stderr, /not found|not run/, r.stderr);
    assert.ok(existsSync(join(proj, 'tasks', 'rooms.html')), `the page was rendered: ${r.stderr}`);
  });

  test('red: instruction-lint runs the package lint on an instruction-file edit', () => {
    const { proj } = installed();
    const prof = join(proj, 'PIPELINE_PROFILE.md');
    writeFileSync(prof, `# Profile\n\n\`\`\`json pipeline-settings\n${JSON.stringify({ schema: 2, features: { instructionLint: { state: 'on', files: ['CLAUDE.md'] } } })}\n\`\`\`\n`);
    writeFileSync(join(proj, 'CLAUDE.md'), `${readFileSync(join(proj, 'CLAUDE.md'), 'utf8')}\nRead \`docs/never-written.md\` first.\n`);
    git(proj, 'add', '-A');
    git(proj, 'commit', '-q', '-m', 'lint on');
    const r = hook(proj, 'instruction-lint-on-edit.cjs', { tool_name: 'Edit', tool_input: { file_path: join(proj, 'CLAUDE.md') } });
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.stdout, /not run|not found/, r.stdout);
    const lint = run(join(proj, 'node_modules', '@geopjinfo', 'builder-pipeline', 'cli.js'), proj, ['run', 'instruction-lint', '--files', 'CLAUDE.md']);
    assert.equal(lint.status, 1, `the lint itself fails on the dead path: ${out(lint)}`);
    assert.match(r.stdout, /"decision":"block"/, `the lint ran and failed on the dead path: ${r.stdout}`);
    assert.match(r.stdout, /never-written/);
  });

  test('red: a package file changed after the lock was committed is not run', () => {
    const { proj, kit } = installed();
    const lib = join(kit, 'scripts', 'lib', 'board-freshness.cjs');
    writeFileSync(lib, `${readFileSync(lib, 'utf8')}\n// edited\n`);
    const r = hook(proj, 'board-render.cjs', { tool_name: 'Write', tool_input: { file_path: join(proj, 'x.md') } });
    assert.equal(r.status, 0);
    assert.match(r.stderr, /not run/);
    assert.match(r.stderr, /board-freshness\.cjs/);
  });

  test('red: an uncommitted lock does not vouch for the package', () => {
    const { proj } = installed();
    const lockAbs = join(proj, 'builder.lock.json');
    writeFileSync(lockAbs, readFileSync(lockAbs, 'utf8').replace('"kit"', '"kit" ') );
    const r = hook(proj, 'board-render.cjs', { tool_name: 'Write', tool_input: { file_path: join(proj, 'x.md') } });
    assert.match(r.stderr, /not run/);
  });

  test('red: registry-read-guard names the package run form', () => {
    const { proj } = installed();
    const prof = join(proj, 'PIPELINE_PROFILE.md');
    writeFileSync(prof, readFileSync(prof, 'utf8').replace('"registryGuard":    { "state": "off", "seats": [] }', '"registryGuard":    { "state": "on", "seats": ["module-builder"] }'));
    git(proj, 'add', '-A');
    git(proj, 'commit', '-q', '-m', 'guard on');
    const r = hook(proj, 'registry-read-guard.cjs', { tool_name: 'Read', agent_type: 'module-builder', tool_input: { file_path: join(proj, 'DEFERRED_TASKS.md') } });
    assert.match(out(r), /Blocked Read/, out(r));
    assert.doesNotMatch(out(r), /node scripts\//);
    assert.match(out(r), /npx builder run ledger-row registry/);
  });
});
