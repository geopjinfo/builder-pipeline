/**
 * deps-check (specs/repo-hygiene.spec.md REQ-1821, D90): the project's own package manager, run through the profile
 * commands, answers for the lockfile, the install tree and the audit; the import reader answers for unused
 * dependencies. A command that is absent is UNMEASURABLE, never a pass. Each test names its acceptance criterion.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const PACK = join(here, '..');
const script = join(PACK, 'scripts', 'deps-check.mjs');
const lib = require('../scripts/lib/deps-check.cjs');
const made = [];
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

const project = () => {
  const dir = mkdtempSync(join(tmpdir(), 'builder-deps-check-'));
  made.push(dir);
  return dir;
};
const write = (dir, rel, text) => {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
};
const settings = (features) => JSON.stringify({ schema: 2, features }, null, 2);
const run = (cwd, args = [], env = {}) => spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', env: { ...process.env, BUILDER_CONFIG: '', ...env } });

const LS = { name: 'app', problems: ['missing: left-pad@1.0.0, required by app', 'extraneous: debug@4.3.4'], dependencies: {} };
const AUDIT = { auditReportVersion: 2, vulnerabilities: {}, metadata: { vulnerabilities: { info: 0, low: 1, moderate: 2, high: 3, critical: 0, total: 6 } } };

/** A stub `npm` on PATH (a shell script and a .cmd, so the platform shell finds one) that prints the recorded JSON. */
const stubNpm = (dir) => {
  const bin = join(dir, 'stub-bin');
  mkdirSync(bin, { recursive: true });
  write(dir, 'stub-bin/ls.json', JSON.stringify(LS));
  write(dir, 'stub-bin/audit.json', JSON.stringify(AUDIT));
  const sh = `#!/bin/sh\ncase "$1" in\n  ls) cat "$(dirname "$0")/ls.json"; exit 1;;\n  audit) cat "$(dirname "$0")/audit.json"; exit 1;;\n  *) echo "stub npm: unknown $1" >&2; exit 2;;\nesac\n`;
  writeFileSync(join(bin, 'npm'), sh);
  chmodSync(join(bin, 'npm'), 0o755);
  writeFileSync(join(bin, 'npm.cmd'), `@echo off\r\nif "%1"=="ls" (type "%~dp0ls.json" & exit /b 1)\r\nif "%1"=="audit" (type "%~dp0audit.json" & exit /b 1)\r\necho stub npm: unknown %1 1>&2\r\nexit /b 2\r\n`);
  return { PATH: `${bin}${delimiter}${process.env.PATH}`, Path: `${bin}${delimiter}${process.env.Path ?? process.env.PATH}` };
};
const app = (dir) => {
  write(dir, 'package.json', JSON.stringify({ name: 'app', version: '1.0.0', dependencies: { 'left-pad': '^1', debug: '^4', '@types/node': '^20', 'never-imported': '^1' } }));
  write(dir, 'package-lock.json', '{}\n');
  write(dir, 'src/a.js', "const lp = require('left-pad');\nimport('debug/src/node');\n");
  write(dir, 'src/b.mjs', "import { x } from 'node:fs';\nexport { y } from './a.js';\n");
};

describe('REQ-1821 — deps-check through the project package manager', () => {
  test('red: AC-1821 LS-PROBLEM and AUDIT-high counts match the stub; exit 1', () => {
    const dir = project();
    app(dir);
    const env = stubNpm(dir);
    write(dir, 'builder.config.json', settings({ depsCheck: { state: 'on', unused: { roots: ['src'] } } }));
    const r = run(dir, [], env);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /^LS-PROBLEM missing: left-pad@1\.0\.0/m);
    assert.match(r.stdout, /^LS-PROBLEM extraneous: debug@4\.3\.4/m);
    assert.match(r.stdout, /^AUDIT-high 3/m);
    assert.match(r.stdout, /^AUDIT-moderate 2/m);
    assert.match(r.stdout, /^AUDIT-low 1/m);
    assert.doesNotMatch(r.stdout, /NO-LOCKFILE/);
    assert.match(r.stdout, /deps-check: FAIL — 2 LS-PROBLEM, 3 at or above high/);
  });

  test('red: AC-1821b one UNUSED-DEP (never-imported); @types/node pairs with the node builtins; a missing stub is UNMEASURABLE with exit 0', () => {
    const dir = project();
    app(dir);
    const env = stubNpm(dir);
    write(dir, 'builder.config.json', settings({ depsCheck: { state: 'on', unused: { roots: ['src'] } } }));
    const r = run(dir, [], env);
    assert.match(r.stdout, /^UNUSED-DEP never-imported/m);
    assert.doesNotMatch(r.stdout, /UNUSED-DEP left-pad|UNUSED-DEP debug|UNUSED-DEP @types\/node/);
    write(dir, 'builder.config.json', settings({ depsCheck: { state: 'on', listCommand: 'builder-no-such-pm ls --json', auditCommand: 'builder-no-such-pm audit --json' } }));
    const u = run(dir);
    assert.equal(u.status, 0, u.stdout + u.stderr);
    assert.match(u.stdout, /^UNMEASURABLE list: .*builder-no-such-pm/m);
    assert.match(u.stdout, /^UNMEASURABLE audit: /m);
    assert.match(u.stdout, /deps-check: UNMEASURABLE/);
    assert.doesNotMatch(u.stdout, /PASS/);
  });

  test('AC-1821: NO-LOCKFILE when lockfile is true and none sits beside the manifest; format lines counts by pattern', () => {
    const dir = project();
    app(dir);
    rmSync(join(dir, 'package-lock.json'));
    const env = stubNpm(dir);
    write(dir, 'builder.config.json', settings({ depsCheck: { state: 'on', format: 'lines', pattern: 'missing|high' } }));
    const r = run(dir, [], env);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /^NO-LOCKFILE package\.json: no package-lock\.json/m);
    assert.match(r.stdout, /^LS-LINE .*missing/m);
    assert.match(r.stdout, /^AUDIT-LINE .*high/m);
  });

  test('AC-1821: the pure readers', () => {
    assert.deepEqual(lib.lsProblems(LS), LS.problems);
    assert.deepEqual(lib.auditCounts(AUDIT), { info: 0, low: 1, moderate: 2, high: 3, critical: 0 });
    assert.equal(lib.atOrAbove({ info: 0, low: 1, moderate: 2, high: 3, critical: 0 }, 'high'), 3);
    assert.equal(lib.atOrAbove({ info: 0, low: 1, moderate: 2, high: 0, critical: 0 }, 'moderate'), 2);
    assert.equal(lib.packageOf('@scope/pkg/sub'), '@scope/pkg');
    assert.equal(lib.packageOf('debug/src/node'), 'debug');
    assert.equal(lib.packageOf('./rel'), null);
    assert.deepEqual(lib.specifiers("import a from 'x';\nimport('y/z');\nconst b = require(\"w\");\nexport * from 'v';\nimport 'side';\nimport fs from 'node:fs';\nimport r from './rel';").sort(), ['./rel', 'node:fs', 'side', 'v', 'w', 'x', 'y/z']);
  });

  test('AC-1821: off prints "depsCheck: not configured" and exits 3; a bad format is refused by the profile', () => {
    const dir = project();
    app(dir);
    const off = run(dir);
    assert.equal(off.status, 3, off.stdout + off.stderr);
    assert.equal(off.stdout.trim(), 'depsCheck: not configured');
    write(dir, 'builder.config.json', settings({ depsCheck: { state: 'on', format: 'yarn' } }));
    const bad = run(dir);
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /features\.depsCheck\.format: one of "npm" \| "lines"/);
  });
});
