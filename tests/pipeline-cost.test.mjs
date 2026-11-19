/**
 * REQ-2011 to REQ-2020 — pipeline cost (specs/pipeline-cost.spec.md). The MEDIUM track (`features.mediumTrack`), the
 * SOLO path (`features.soloTrack`), the report template, and the `--medium` and `--solo` readings of `track-check`.
 * Both features ship experimental-off; their measurement is EXPERIMENTS §25.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const PACK = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(PACK, rel), 'utf8');
const SKILL = read('skills/build-module-pipeline.md');
const REF = existsSync(join(PACK, 'skills/references/sizing.md')) ? read('skills/references/sizing.md') : '';
const BOTH = `${SKILL}\n${REF}`;
const made = [];
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

const git = (cwd, ...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
const write = (dir, rel, text) => {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
};
/** A repository with one base commit: one module under src/, a test and a package.json. Returns { dir, base }. */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-cost-'));
  made.push(dir);
  git(dir, 'init', '-q');
  write(dir, 'src/report/a.ts', 'export const a = 1;\n');
  write(dir, 'test/report.test.ts', 'test("a", () => {});\n');
  write(dir, 'package.json', JSON.stringify({ name: 't', version: '1.0.0', dependencies: { left: '1.0.0' } }, null, 2) + '\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  return { dir, base: git(dir, 'rev-parse', 'HEAD').stdout.trim() };
}
const files = (dir, n) => { for (let i = 0; i < n; i++) write(dir, `src/report/f${i}.ts`, `export const f${i} = ${i};\n`); };
const run = (cwd, args = []) => spawnSync(process.execPath, [join(PACK, 'scripts', 'track-check.mjs'), ...args], { cwd, encoding: 'utf8' });

describe('REQ-2018 — track-check --medium and --solo', () => {
  test('red: AC-2018a five files in one module → MEDIUM with the broken SMALL limit as the reading, exit 3', () => {
    const { dir, base } = repo();
    files(dir, 5);
    const r = run(dir, ['--since', base, '--medium']);
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.equal(r.stdout.trim(), 'MEDIUM: 5 source files in 1 module — 5 source files changed, limit 4');
  });
  test('red: AC-2018b two files plus one new migration → MEDIUM, the migration is the reading, exit 3', () => {
    const { dir, base } = repo();
    files(dir, 2);
    write(dir, 'src/report/migrations/001-table.sql', 'create table t (id int);\n');
    const r = run(dir, ['--since', base, '--medium']);
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.match(r.stdout, /^MEDIUM: 3 source files in 1 module — new migration src\/report\/migrations\/001-table\.sql$/m);
  });
  test('red: AC-2018c seven files → ESCALATE with the MEDIUM limit, exit 1', () => {
    const { dir, base } = repo();
    files(dir, 7);
    const r = run(dir, ['--since', base, '--medium']);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.equal(r.stdout.trim(), 'ESCALATE: 7 source files changed, limit 6');
  });
  test('red: AC-2018d five files and a new dependency → ESCALATE, exit 1', () => {
    const { dir, base } = repo();
    files(dir, 5);
    write(dir, 'package.json', JSON.stringify({ name: 't', version: '1.0.0', dependencies: { left: '1.0.0', right: '2.0.0' } }, null, 2) + '\n');
    const r = run(dir, ['--since', base, '--medium']);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /^ESCALATE: dependency change in package\.json \(added right\)$/m);
    assert.doesNotMatch(r.stdout, /MEDIUM/);
  });
  test('red: two new migrations is more than one addition → ESCALATE under --medium', () => {
    const { dir, base } = repo();
    write(dir, 'src/report/migrations/001.sql', 'a\n');
    write(dir, 'src/report/migrations/002.sql', 'b\n');
    const r = run(dir, ['--since', base, '--medium']);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /^ESCALATE: 2 new migrations, limit 1$/m);
  });
  test('red: AC-2018e two files → SMALL wins under --medium, exit 0', () => {
    const { dir, base } = repo();
    files(dir, 2);
    const r = run(dir, ['--since', base, '--medium']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.stdout.trim(), 'SMALL: 2 source files in 1 module');
  });
  test('red: AC-2018f one file → SOLO under --solo, exit 0', () => {
    const { dir, base } = repo();
    write(dir, 'src/report/a.ts', 'export const a = 2;\n');
    const r = run(dir, ['--since', base, '--solo']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.stdout.trim(), 'SOLO: 1 source file in 1 module');
  });
  test('red: AC-2018g three files → SMALL under --solo, exit 0', () => {
    const { dir, base } = repo();
    files(dir, 3);
    const r = run(dir, ['--since', base, '--solo']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.stdout.trim(), 'SMALL: 3 source files in 1 module');
  });
  test('red: AC-2018h a new migration is never SOLO: without --medium it escalates as before', () => {
    const { dir, base } = repo();
    write(dir, 'src/report/migrations/001.sql', 'a\n');
    const r = run(dir, ['--since', base, '--solo']);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.equal(r.stdout.trim(), 'ESCALATE: new migration src/report/migrations/001.sql');
  });
  test('red: AC-2018i --medium 8 raises the MEDIUM limit; --json carries the track', () => {
    const { dir, base } = repo();
    files(dir, 7);
    const r = run(dir, ['--since', base, '--medium', '8']);
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.match(r.stdout, /^MEDIUM: 7 source files in 1 module/);
    const j = run(dir, ['--since', base, '--medium', '8', '--json']);
    assert.equal(j.status, 3);
    const out = JSON.parse(j.stdout);
    assert.equal(out.track, 'MEDIUM');
    assert.equal(out.mediumMaxFiles, 8);
    assert.deepEqual(out.reasons, ['7 source files changed, limit 4']);
  });
  test('red: --solo and --medium together: SOLO, SMALL, MEDIUM or ESCALATE in that order', () => {
    const { dir, base } = repo();
    files(dir, 5);
    const r = run(dir, ['--since', base, '--solo', '--medium']);
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.match(r.stdout, /^MEDIUM: 5 source files/);
  });
  test('red: AC-2018j without the flags five files still ESCALATE at the SMALL limit, exit 1', () => {
    const { dir, base } = repo();
    files(dir, 5);
    const r = run(dir, ['--since', base]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.equal(r.stdout.trim(), 'ESCALATE: 5 source files changed, limit 4');
  });
  test('red: a bad --medium value is a usage error, exit 2', () => {
    const { dir, base } = repo();
    const r = run(dir, ['--since', base, '--medium', '0']);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /--medium/);
  });
  test('red: judge() with medium and solo limits, unit', () => {
    const lib = require('../scripts/lib/track-check.cjs');
    const five = ['src/a/1.ts', 'src/a/2.ts', 'src/a/3.ts', 'src/a/4.ts', 'src/a/5.ts'];
    const m = lib.judge({ files: five, modules: ['a'], dependency: [], migrations: [], maxFiles: 4, medium: 6 });
    assert.equal(m.track, 'MEDIUM');
    assert.deepEqual(m.reasons, ['5 source files changed, limit 4']);
    assert.equal(lib.render(m), 'MEDIUM: 5 source files in 1 module — 5 source files changed, limit 4');
    const s = lib.judge({ files: ['src/a/1.ts'], modules: ['a'], dependency: [], migrations: [], maxFiles: 4, solo: 2 });
    assert.equal(s.track, 'SOLO');
    assert.equal(lib.render(s), 'SOLO: 1 source file in 1 module');
    assert.equal(lib.judge({ files: ['src/a/1.ts'], modules: ['a'], dependency: [], migrations: [], maxFiles: 4 }).track, 'SMALL');
    assert.equal(lib.exitCode('SOLO'), 0);
    assert.equal(lib.exitCode('SMALL'), 0);
    assert.equal(lib.exitCode('MEDIUM'), 3);
    assert.equal(lib.exitCode('ESCALATE'), 1);
  });
});

describe('REQ-2019 — track-check stays a free check; the skill scopes the flags to the features', () => {
  test('red: AC-2019 the script and its library never load profile.feature; the skill scopes --medium and --solo', () => {
    for (const rel of ['scripts/track-check.mjs', 'scripts/lib/track-check.cjs']) assert.doesNotMatch(read(rel), /profile\.feature|featureFor|not configured/, rel);
    assert.match(BOTH, /`features\.mediumTrack`[^\n]*--medium|--medium[^\n]*`features\.mediumTrack`/);
    assert.match(BOTH, /`features\.soloTrack`[^\n]*--solo|--solo[^\n]*`features\.soloTrack`/);
  });
});

describe('REQ-2011 to REQ-2016 — the skill text: the MEDIUM track and the SOLO path', () => {
  const row = (name) => SKILL.split('\n').find((l) => new RegExp(`^\\| \\*\\*${name}\\*\\* \\|`).test(l)) || '';
  test('red: AC-2011 the track table has a MEDIUM row behind features.mediumTrack with its limits and triggers', () => {
    const r = row('MEDIUM');
    assert.ok(r, 'no MEDIUM row in the track table');
    assert.match(r, /`features\.mediumTrack`/);
    assert.match(r, /\b6 production source files/);
    assert.match(r, /one module/);
    assert.match(r, /one addition/);
    for (const w of ['migration', 'table', 'public operation', 'dependency', 'permission key', 'protected path']) assert.ok(r.includes(w), `MEDIUM row lacks "${w}"`);
    assert.match(r, /references\/sizing\.md/);
    // the rows keep the chain's order in the table
    const names = SKILL.split('\n').filter((l) => /^\| \*\*[A-Z]+\*\* \|/.test(l)).map((l) => /^\| \*\*([A-Z]+)\*\*/.exec(l)[1]);
    assert.ok(names.indexOf('SMALL') < names.indexOf('MEDIUM') && names.indexOf('MEDIUM') < names.indexOf('SOLO'), names.join(','));
  });
  test('red: AC-2012a the sizing reference holds the MEDIUM steps', () => {
    assert.match(REF, /^## .*MEDIUM/m);
    assert.match(REF, /one `module-builder` dispatch/);
    assert.match(REF, /one auditor dispatch/);
    assert.match(REF, /`security-auditor`/);
    assert.match(REF, /`invariant-auditor`/);
    assert.match(REF, /one re-dispatch/);
    assert.match(REF, /Open findings/);
    assert.match(REF, /skipped \(MEDIUM\)/);
    assert.match(REF, /track-check\.mjs --since <base> --medium/);
  });
  test('red: AC-2012b the MEDIUM phase list skips P1, P5, P6, P6.5, runs P3 as the orchestrator and P4 as one auditor', () => {
    const line = REF.split('\n').find((l) => /^Phases: .*\(MEDIUM\)/.test(l)) || '';
    assert.ok(line, 'no MEDIUM Phases: example line');
    for (const p of ['1 skipped (MEDIUM)', '3 run (orchestrator', '5 skipped (MEDIUM)', '6 skipped (MEDIUM)', '6.5 skipped (MEDIUM)', '4 run (1 auditor']) assert.ok(line.includes(p), `MEDIUM Phases: line lacks "${p}"`);
  });
  test('red: AC-2013 a broken MEDIUM limit continues as ADDITIVE; the chain has six steps; off means no row', () => {
    assert.match(SKILL, /SOLO → SMALL → MEDIUM → FIX → ADDITIVE → FULL/);
    assert.match(REF, /SOLO → SMALL → MEDIUM → FIX → ADDITIVE → FULL/);
    assert.match(REF, /MEDIUM limit[^\n]*ADDITIVE|ADDITIVE[^\n]*MEDIUM limit/);
    assert.match(BOTH, /`features\.mediumTrack` off[^\n]*(no MEDIUM|not offered|is not offered)/i);
  });
  test('red: AC-2014, AC-2016 the SOLO row and rule 1 name features.soloTrack, 2 files, no new behaviour, a red test, no seat', () => {
    const r = row('SOLO');
    assert.match(r, /`features\.soloTrack`/);
    assert.match(r, /\b2 production source files/);
    assert.match(r, /no new behaviour/);
    const rule1 = /1\. \*\*A production-source diff may never go SOLO[^]*?\n2\. /.exec(SKILL)?.[0] || '';
    assert.ok(rule1, 'rule 1 is missing');
    assert.match(rule1, /`features\.soloTrack`/);
    assert.match(REF, /red test first/);
    assert.match(REF, /no seat/);
    assert.match(SKILL, /\*\*Every run dispatches\s+at least one seat\b[^*]*\*\*/);
    assert.match(SKILL, /at least one seat[^\n]*`features\.soloTrack`/);
  });
  test('red: AC-2015 the SOLO steps: track-check --solo, typecheck and every tier once, SMALL means one builder dispatch', () => {
    assert.match(REF, /track-check\.mjs --since <base> --solo/);
    assert.match(REF, /tiers? once/);
    assert.match(REF, /`SMALL:`[^\n]*one `module-builder` dispatch|one `module-builder` dispatch[^\n]*`SMALL:`/);
  });
});

describe('REQ-2017 — the report template', () => {
  const TPL = 'templates/module-report.md';
  test('red: AC-2017a the template opens with Track: and Phases: and has the eight sections', () => {
    assert.ok(existsSync(join(PACK, TPL)), `${TPL} is missing`);
    const lines = read(TPL).split('\n');
    assert.match(lines[0], /^Track: /);
    assert.match(lines[1], /^Phases: /);
    for (const h of ['Verdict', 'Summary', 'Evidence', 'Needs a human', 'Open findings', 'Deferred', 'Handoff pack']) assert.match(read(TPL), new RegExp(`^## ${h}`, 'm'), `no "${h}" section`);
  });
  test('red: AC-2017c the Finish step names the module-report template and keeps its two lines first', () => {
    assert.match(SKILL, /module-report/);
    assert.match(SKILL, /specs\/module-report\.template\.md/);
  });
  test('red: AC-2017b the CLI and both fallback installers copy it once to specs/module-report.template.md', () => {
    assert.match(read('cli.js'), /templates', 'module-report\.md'\), path\.join\('specs', 'module-report\.template\.md'\), own\)/);
    assert.match(read('scripts/unpack.sh'), /templates\/module-report\.md"\s+"specs\/module-report\.template\.md"/);
    assert.match(read('scripts/unpack.ps1'), /templates\\module-report\.md'\)\s+'specs\\module-report\.template\.md'/);
  });
  test('red: AC-2017b unpack installs it, and a second unpack leaves a project edit alone', () => {
    const proj = mkdtempSync(join(tmpdir(), 'kit-report-'));
    made.push(proj);
    const kit = join(proj, 'node_modules', 'builder-pipeline');
    mkdirSync(kit, { recursive: true });
    cpSync(PACK, kit, { recursive: true, filter: (src) => !/[\\/](?:\.git|tests|node_modules)(?:[\\/]|$)/.test(`/${relative(PACK, src)}`) });
    const r = spawnSync(process.execPath, [join(kit, 'cli.js'), 'unpack', '--tool', 'claude-code'], { cwd: proj, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const installed = join(proj, 'specs', 'module-report.template.md');
    assert.ok(existsSync(installed), 'specs/module-report.template.md was not installed');
    assert.match(readFileSync(installed, 'utf8'), /^Track: /);
    writeFileSync(installed, 'Track: mine\nPhases: mine\n');
    const again = spawnSync(process.execPath, [join(kit, 'cli.js'), 'unpack', '--tool', 'claude-code'], { cwd: proj, encoding: 'utf8' });
    assert.equal(again.status, 0, again.stdout + again.stderr);
    assert.equal(readFileSync(installed, 'utf8'), 'Track: mine\nPhases: mine\n', 'a project-owned template was rewritten');
  });
});

describe('REQ-2020 — the two §16 keys', () => {
  const profile = require('../scripts/lib/profile.cjs');
  test('red: AC-2020a mediumTrack and soloTrack are experimental-off with maxFiles 6 and 2, measured in §25', () => {
    assert.deepEqual(profile.FEATURES.mediumTrack.defaults, { state: 'experimental-off', maxFiles: 6 });
    assert.deepEqual(profile.FEATURES.soloTrack.defaults, { state: 'experimental-off', maxFiles: 2 });
    assert.equal(profile.FEATURES.mediumTrack.experiment, '§25');
    assert.equal(profile.FEATURES.soloTrack.experiment, '§25');
  });
  test('red: AC-2020b features prints both lines with the §25 decision', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kit-cost-features-'));
    made.push(dir);
    const r = spawnSync(process.execPath, [join(PACK, 'scripts', 'features.mjs')], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^mediumTrack: experimental-off — not enabled; its measurement is EXPERIMENTS\.md §25 · decision: not yet measured \(\d{4}-\d{2}-\d{2}\)/m);
    assert.match(r.stdout, /^soloTrack: experimental-off — not enabled; its measurement is EXPERIMENTS\.md §25 · decision: not yet measured \(\d{4}-\d{2}-\d{2}\)/m);
  });
  test('red: AC-2020c FEATURES.md, the profile template, GUIDE.md and USAGE.md name both keys; §25 names both flags', () => {
    for (const f of ['FEATURES.md', 'PIPELINE_PROFILE.template.md', 'GUIDE.md', 'USAGE.md']) {
      assert.match(read(f), /mediumTrack/, `${f} lacks mediumTrack`);
      assert.match(read(f), /soloTrack/, `${f} lacks soloTrack`);
    }
    const exp = read('EXPERIMENTS.md');
    assert.match(exp, /^## 25\. [^\n]*`mediumTrack`[^\n]*`soloTrack`/m);
    assert.match(exp, /module-report/);
  });
  test('red: a profile with mediumTrack.maxFiles 10 parses and the feature line stays experimental-off', () => {
    const settings = { schema: 2, features: { mediumTrack: { state: 'experimental-off', maxFiles: 10 } } };
    const f = profile.feature(settings, 'mediumTrack');
    assert.equal(f.enabled, false);
    assert.equal(f.config.maxFiles, 10);
    assert.equal(profile.feature({ schema: 2, features: { soloTrack: { state: 'experimental-on' } } }, 'soloTrack').enabled, true);
  });
});
