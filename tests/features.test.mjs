import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'scripts', 'features.mjs');
const made = [];
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

const project = (profileText) => {
  const dir = mkdtempSync(join(tmpdir(), 'builder-features-'));
  made.push(dir);
  if (profileText !== undefined) writeFileSync(join(dir, 'PIPELINE_PROFILE.md'), profileText);
  return dir;
};
const block = (obj) => `# PIPELINE_PROFILE — inventory service\n\n## 16. Pipeline settings\n\n\`\`\`json pipeline-settings\n${JSON.stringify(obj, null, 2)}\n\`\`\`\n`;
const run = (cwd) => spawnSync(process.execPath, [cli], { cwd, encoding: 'utf8' });

describe('features', () => {
  test('no profile: says defaults are in use, prints every feature line, exits 0', () => {
    const r = run(project());
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^no PIPELINE_PROFILE\.md — defaults in use$/m);
    assert.match(r.stdout, /^claims: on$/m);
    assert.match(r.stdout, /^contractOracle: not configured$/m);
    assert.match(r.stdout, /^fixLane: not configured/m);
    assert.match(r.stdout, /^livePage: experimental — not enabled · decision: not yet measured \(\d{4}-\d{2}-\d{2}\)/m);
  });

  test('red: REQ-801 familyReview is experimental-off by default: the loader knows it and its line says "not enabled" (AC-801a)', () => {
    const r = run(project());
    assert.equal(r.status, 0, r.stdout + r.stderr);
    // REQ-1401 appends the EXPERIMENTS §16 decision to each line; the flag line itself is unchanged
    assert.match(r.stdout, /^familyReview: experimental — not enabled( · decision: .*)?$/m);
    assert.match(r.stdout, /^routerHint: experimental — not enabled( · decision: .*)?$/m);
    const on = run(project(block({ schema: 2, features: { familyReview: { state: 'experimental-on' } } })));
    assert.equal(on.status, 0, on.stdout);
    assert.match(on.stdout, /^familyReview: experimental — enabled; its measurement is owed/m);
  });

  test('a profile without the settings block is said, and defaults apply', () => {
    const r = run(project('# PIPELINE_PROFILE — prose only\n'));
    assert.equal(r.status, 0);
    assert.match(r.stdout, /has no pipeline-settings block — defaults in use/);
  });

  test('an off feature prints "<name>: not configured"', () => {
    const r = run(project(block({ schema: 2, features: { claims: { state: 'off' }, handoffPack: { state: 'off' } } })));
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /^claims: not configured$/m);
    assert.match(r.stdout, /^handoffPack: not configured$/m);
    assert.match(r.stdout, /^features: profile valid$/m);
  });

  test('red: an invalid profile prints its errors and exits 1', () => {
    const r = run(project(block({ schema: 2, features: { contractOracle: { state: 'on' }, claimz: { state: 'on' } } })));
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /features\.contractOracle\.spec: required while the feature is on/);
    assert.match(r.stdout, /features\.claimz: unknown feature/);
    assert.match(r.stdout, /features: INVALID/);
  });

  test('red: unparseable settings JSON exits 1', () => {
    const r = run(project('```json pipeline-settings\n{ nope\n```\n'));
    assert.equal(r.status, 1);
    assert.match(r.stdout, /not valid JSON/);
  });
});

describe('REQ-1401 — the decision beside each experimental flag', () => {
  test('red: every experimental line carries the decision from EXPERIMENTS.md', () => {
    const r = run(project());
    const lines = r.stdout.split(/\r?\n/).filter((l) => /: experimental/.test(l));
    assert.ok(lines.length >= 10, lines.join('\n'));
    for (const l of lines) assert.match(l, / · decision: (keep|drop|not yet measured) \(\d{4}-\d{2}-\d{2}\)/, l);
  });
});

describe('features — repo hygiene (M18)', () => {
  test('red: AC-1801 branchSweep and runSweep are listed, off by default; a bad remote is refused with the allowed set', () => {
    const r = run(project());
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^branchSweep: not configured$/m);
    assert.match(r.stdout, /^runSweep: not configured$/m);
    const bad = run(project(block({ schema: 2, features: { branchSweep: { state: 'off', remote: 'delete' } } })));
    assert.notEqual(bad.status, 0);
    assert.match(bad.stdout + bad.stderr, /branchSweep\.remote.*list, off/);
  });
});

describe('REQ-1501 — features.capacity is in the table, default off (AC-1501c)', () => {
  test('red: the loader knows the feature and its line says not configured', () => {
    const r = run(project(block({ schema: 2 })));
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^capacity: not configured$/m);
  });
});
