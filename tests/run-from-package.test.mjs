/**
 * Installed as a package, the kit's scripts run FROM it — `npx builder-pipeline run <name>` — with the project as the
 * working directory. Unpack copies none of them into the project, the installed prose names the run form, and
 * verify looks for them in the package. A kit copied in as `builder/` still copies them (control).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const PACK = join(dirname(fileURLToPath(import.meta.url)), '..');
const made = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

function project(kitAt) {
  const proj = mkdtempSync(join(tmpdir(), 'kit-run-'));
  made.push(proj);
  const kit = join(proj, ...kitAt.split('/'));
  mkdirSync(kit, { recursive: true });
  cpSync(PACK, kit, { recursive: true, filter: (src) => !/[\\/](?:\.git|tests|node_modules)(?:[\\/]|$)/.test(`/${relative(PACK, src)}`) });
  return { proj, cli: join(kit, 'cli.js') };
}
const run = (cli, cwd, args) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });

describe('builder run — kit scripts run from the package', () => {
  const { proj, cli } = project('node_modules/builder-pipeline');
  const unpacked = run(cli, proj, ['unpack', '--tool', 'claude-code']);

  test('red: a package install copies no kit script and the installed prose says npx builder-pipeline run', () => {
    assert.equal(unpacked.status, 0, unpacked.stderr);
    assert.ok(!existsSync(join(proj, 'scripts', 'board-check-all.mjs')), 'scripts/ copies would drift from the package');
    assert.ok(!existsSync(join(proj, 'scripts', 'oracles')), 'oracle adapters run from the package too');
    const pointer = readFileSync(join(proj, 'CLAUDE.md'), 'utf8');
    assert.match(pointer, /npx --no-install builder-pipeline run features/);
    assert.doesNotMatch(pointer, /node scripts\/features\.mjs/);
  });

  test('red: run lists the scripts, runs one in the project folder, and passes its exit code through', () => {
    const list = run(cli, proj, ['run']);
    assert.equal(list.status, 0, list.stderr);
    assert.match(list.stdout, /^ {2}board-check-all$/m);
    assert.match(list.stdout, /^ {2}experimental\/[\w-]+$/m);
    // A script that reads the working directory sees the project, not the package.
    writeFileSync(join(proj, 'probe.txt'), 'here\n');
    const r = run(cli, proj, ['run', 'features']);
    assert.notEqual(r.status, null);
    assert.doesNotMatch(`${r.stdout}${r.stderr}`, /no kit script/);
  });

  test('red: a name that is a path, or no such script, is refused with exit 1', () => {
    for (const bad of ['../cli', 'lib/profile', 'nope-not-a-script', '/etc/passwd']) {
      const r = run(cli, proj, ['run', bad]);
      assert.equal(r.status, 1, bad);
      assert.match(r.stderr, /no kit script/);
    }
  });

  test('red: verify finds the scripts in the package', () => {
    const r = run(cli, proj, ['verify']);
    assert.match(r.stdout, /PASS.*board scripts installed/);
    assert.match(r.stdout, /PASS.*checkers installed/);
  });

  test('control: a kit copied in as builder/ still copies its scripts into scripts/', () => {
    const c = project('builder');
    const r = run(c.cli, c.proj, ['unpack', '--tool', 'claude-code']);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(c.proj, 'scripts', 'board-check-all.mjs')));
    assert.match(readFileSync(join(c.proj, 'CLAUDE.md'), 'utf8'), /node scripts\/features\.mjs/);
  });
});
