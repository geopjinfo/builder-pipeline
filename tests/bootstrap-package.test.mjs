/**
 * D1 — the setup prompt runs `npx github:<owner>/builder-pipeline#<tag> bootstrap`: the kit then runs from the npx
 * cache, outside the project. builder-init's later `npx builder-pipeline …` resolves the project's own bin, so unless bootstrap
 * adds the kit to the project, that bare name fetches the newest registry release, not the tag the prompt named.
 *
 * Bootstrap run from outside the project adds the kit as a devDependency at the spec npx fetched (read from the npx
 * root's package.json), then runs `npm install --save-dev <spec>` when npm is on PATH — mocked here by a stub, so the
 * test needs no network — or tells the human to run `npm install` when it is not.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const PACK = join(dirname(fileURLToPath(import.meta.url)), '..');
const NAME = JSON.parse(readFileSync(join(PACK, 'package.json'), 'utf8')).name;
const SPEC = 'github:geopjinfo/builder-pipeline#v9.9.9';
const made = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
const tmp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); made.push(d); return d; };

/** The kit as npx leaves it: <cache>/node_modules/<name>/, with the cache's package.json naming the spec it fetched. */
function npxCache(spec = SPEC) {
  const cache = tmp('kit-npx-');
  writeFileSync(join(cache, 'package.json'), JSON.stringify({ dependencies: { [NAME]: spec } }));
  const kit = join(cache, 'node_modules', ...NAME.split('/'));
  mkdirSync(kit, { recursive: true });
  cpSync(PACK, kit, { recursive: true, filter: (src) => !/[\\/](?:\.git|tests|node_modules|logs)(?:[\\/]|$)/.test(`/${relative(PACK, src)}`) });
  return join(kit, 'cli.js');
}

/** A folder holding a fake `npm` that records its arguments (and nothing else on PATH: no real npm is reachable). */
function npmStub({ present = true } = {}) {
  const dir = tmp('kit-npm-');
  if (present) {
    writeFileSync(join(dir, 'npm.cmd'), '@echo off\r\necho %*>> "%~dp0calls.txt"\r\nexit /b 0\r\n');
    writeFileSync(join(dir, 'npm'), '#!/bin/sh\necho "$@" >> "${0%/*}/calls.txt"\nexit 0\n');
    chmodSync(join(dir, 'npm'), 0o755);
  }
  return dir;
}
const calls = (stub) => (existsSync(join(stub, 'calls.txt')) ? readFileSync(join(stub, 'calls.txt'), 'utf8').replace(/"/g, '') : ''); // npm.cmd sees each argument quoted

function bootstrap(cli, proj, stub, args = []) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^path$/i.test(k) && !/^npm_/i.test(k)));
  env.PATH = stub;
  const r = spawnSync(process.execPath, [cli, 'bootstrap', ...args], { cwd: proj, encoding: 'utf8', env: { ...env, BUILDER_NO_BASH_CAP: '1' } });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}
const pkg = (proj) => JSON.parse(readFileSync(join(proj, 'package.json'), 'utf8'));

describe('D1 — bootstrap from the npx cache adds the kit to the project', () => {
  test('red: an empty folder (no package.json, no node_modules) gets the devDependency and npm installs it', () => {
    const cli = npxCache();
    const proj = tmp('kit-empty-');
    const stub = npmStub();
    const r = bootstrap(cli, proj, stub);
    assert.equal(r.status, 0, r.out);
    assert.equal(pkg(proj).devDependencies[NAME], SPEC);
    assert.match(calls(stub), new RegExp(`install --save-dev "?${SPEC.replace(/[.#/]/g, '\\$&')}"?`));
    assert.ok(existsSync(join(proj, '.claude', 'skills', 'builder-init', 'SKILL.md')));
  });

  test('red: no npm on PATH: the dependency is written and the human is told to run npm install', () => {
    const cli = npxCache();
    const proj = tmp('kit-nonpm-');
    const r = bootstrap(cli, proj, npmStub({ present: false }));
    assert.equal(r.status, 0, r.out);
    assert.equal(pkg(proj).devDependencies[NAME], SPEC);
    assert.match(r.out, /npm install/);
  });

  test('an existing package.json keeps its fields; a kit already listed and installed is left alone', () => {
    const cli = npxCache();
    const proj = tmp('kit-pkg-');
    writeFileSync(join(proj, 'package.json'), JSON.stringify({ name: 'ours', type: 'module', scripts: { test: 'x' } }, null, 2));
    const stub = npmStub();
    assert.equal(bootstrap(cli, proj, stub).status, 0);
    const p = pkg(proj);
    assert.equal(p.name, 'ours');
    assert.equal(p.type, 'module');
    assert.deepEqual(p.scripts, { test: 'x' });
    assert.equal(p.devDependencies[NAME], SPEC);

    mkdirSync(join(proj, 'node_modules', ...NAME.split('/')), { recursive: true });
    writeFileSync(join(proj, 'node_modules', ...NAME.split('/'), 'package.json'), '{}');
    rmSync(join(stub, 'calls.txt'), { force: true });
    const again = bootstrap(cli, proj, stub);
    assert.equal(again.status, 0, again.out);
    assert.equal(calls(stub), '', 'nothing to install');
    assert.match(again.out, /already/);
  });

  test('--dry-run writes no package.json and runs no npm', () => {
    const cli = npxCache();
    const proj = tmp('kit-dry-');
    const stub = npmStub();
    const r = bootstrap(cli, proj, stub, ['--dry-run']);
    assert.equal(r.status, 0, r.out);
    assert.ok(!existsSync(join(proj, 'package.json')));
    assert.equal(calls(stub), '');
    assert.match(r.out, /would add/);
  });

  test('the kit inside the project (package or folder layout) adds nothing', () => {
    const proj = tmp('kit-inside-');
    const kit = join(proj, 'node_modules', ...NAME.split('/'));
    mkdirSync(kit, { recursive: true });
    cpSync(PACK, kit, { recursive: true, filter: (src) => !/[\\/](?:\.git|tests|node_modules|logs)(?:[\\/]|$)/.test(`/${relative(PACK, src)}`) });
    const stub = npmStub();
    assert.equal(bootstrap(join(kit, 'cli.js'), proj, stub).status, 0);
    assert.ok(!existsSync(join(proj, 'package.json')));
    assert.equal(calls(stub), '');
  });
});

