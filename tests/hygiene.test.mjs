/**
 * hygiene — the runner and the completion gate (specs/repo-hygiene.spec.md, M21, REQ-1831, REQ-1832, REQ-1844; D87,
 * D99). The runner collects the checks' own findings and exit codes; the gate maps them onto the seven rows. Each test
 * names its AC.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const lib = require('../scripts/lib/hygiene.cjs');
const CLI = join(here, '..', 'scripts', 'hygiene.mjs');
const AWS_SHAPE = `AKIA${'Q'.repeat(16)}`;

const temps = [];
after(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const profile = (repo, features) => writeFileSync(join(repo, 'PIPELINE_PROFILE.md'), `\`\`\`json pipeline-settings\n${JSON.stringify({ schema: 2, features })}\n\`\`\`\n`);
const run = (cwd, args) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: { ...process.env, BUILDER_ORCH_DIR: join(cwd, '.no-orch') } });
  return { status: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout };
};

/** A repo with a tracked key shape in config.js, tracked junk under .pipeline/, and a .cursorrules in a second commit. */
function rig() {
  const parent = realpathSync.native(mkdtempSync(join(tmpdir(), 'hygiene-')));
  temps.push(parent);
  const repo = join(parent, 'app');
  mkdirSync(join(repo, '.pipeline', 'x'), { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 'T');
  writeFileSync(join(repo, 'README.md'), '# App\n');
  writeFileSync(join(repo, '.gitignore'), '.pipeline/\nnode_modules/\n');
  writeFileSync(join(repo, 'config.js'), `const k = '${AWS_SHAPE}';\n`);
  writeFileSync(join(repo, '.pipeline', 'x', 'run.jsonl'), '{}\n');
  for (const f of ['README.md', '.gitignore', 'config.js']) git(repo, 'add', f);
  git(repo, 'add', '-f', '.pipeline/x/run.jsonl'); // tracked although ignored: the TRACKED-JUNK the ignore check reports
  git(repo, 'commit', '-q', '-m', 'first');
  const base = git(repo, 'rev-parse', 'HEAD');
  writeFileSync(join(repo, '.cursorrules'), 'rules\n');
  writeFileSync(join(repo, 'other.js'), `const k2 = '${AWS_SHAPE.replace(/Q/g, 'R')}';\n`);
  git(repo, 'add', '.cursorrules', 'other.js');
  git(repo, 'commit', '-q', '-m', 'second');
  return { repo, base };
}

describe('hygiene — parse (pure)', () => {
  test('red: AC-1831 finding lines are the upper-case kind lines; verdict words and prose are not; the first line says not configured', () => {
    const p = lib.parse('ignoreCheck: not configured\n');
    assert.equal(p.notConfigured, true);
    const q = lib.parse('secretScan: not configured — checking with defaults\nSECRET          a/b.js:12 — assigned secret\nKEEP   main   target\nsecret-scan: FAIL — 1 finding\n');
    assert.equal(q.notConfigured, false, 'the standalone first line is a run, not an off check');
    assert.deepEqual(q.findings.map((f) => [f.kind, f.path]), [['SECRET', 'a/b.js']]);
  });
});

describe('hygiene — the runner (CLI)', () => {
  test('red: AC-1831 secretScan and ignoreCheck on: two check blocks with findings, the other checks not configured, exit 1; the record is written', () => {
    const { repo } = rig();
    profile(repo, { secretScan: { state: 'on' }, ignoreCheck: { state: 'on' } });
    const r = run(repo, ['--json']);
    assert.equal(r.status, 1, r.out);
    const j = JSON.parse(r.stdout);
    const by = Object.fromEntries(j.checks.map((c) => [c.name, c]));
    assert.equal(by.secretScan.state, 'findings');
    assert.equal(by.secretScan.hard, true);
    assert.equal(by.secretScan.findings.length, 2, JSON.stringify(by.secretScan));
    assert.equal(by.ignoreCheck.state, 'findings');
    assert.equal(by.ignoreCheck.hard, false, 'ignore-check is soft');
    assert.match(by.ignoreCheck.findings[0].kind, /TRACKED-JUNK/);
    for (const n of ['branchSweep', 'runSweep', 'sizeCheck', 'depsCheck', 'docsCheck', 'attributionCheck', 'artifactCheck']) assert.equal(by[n].state, 'not configured', n);
    assert.ok(j.checks.every((c) => !JSON.stringify(c).includes(AWS_SHAPE)), 'no finding carries the secret text');
    const text = run(repo, []);
    assert.equal(text.status, 1);
    assert.match(text.stdout, /^secret-scan: 2 finding\(s\) — hard, fails the run$/m);
    assert.match(text.stdout, /^ignore-check: 1 finding\(s\)$/m);
    assert.match(text.stdout, /^sizeCheck: not configured$/m);
    assert.match(text.stdout, /^hygiene: 2 check\(s\) ran, 3 finding\(s\) — hard: secret-scan$/m);
    const record = JSON.parse(readFileSync(join(repo, '.pipeline', 'hygiene', 'last.json'), 'utf8'));
    assert.equal(record.exit, 1);
  });
  test('red: AC-1831b every check off: exit 3 and one line per feature, never a pass', () => {
    const { repo } = rig();
    profile(repo, {});
    const r = run(repo, []);
    assert.equal(r.status, 3, r.out);
    for (const c of lib.CHECKS) assert.match(r.stdout, new RegExp(`^${c.name}: (not configured|experimental-off)`, 'm'), c.name);
    assert.match(r.stdout, /^hygiene: no check is on .* \(exit 3, never a pass\)$/m);
    assert.doesNotMatch(r.stdout, /PASS/);
  });
  test('red: AC-1832 --since REF: one secret finding (the one added after REF) and one line naming the checks that ignore --since; --check narrows the run', () => {
    const { repo, base } = rig();
    profile(repo, { secretScan: { state: 'on' }, runSweep: { state: 'on' } });
    const r = run(repo, ['--since', base, '--json']);
    assert.equal(r.status, 1, r.out);
    const j = JSON.parse(r.stdout);
    const secret = j.checks.find((c) => c.name === 'secretScan');
    assert.equal(secret.findings.length, 1, JSON.stringify(secret.findings));
    assert.equal(secret.findings[0].path, 'other.js');
    assert.match(secret.sinceNote, /narrowed to the files changed since/);
    const sweep = j.checks.find((c) => c.name === 'runSweep');
    assert.match(sweep.sinceNote, /--since does not apply/);
    const text = run(repo, ['--since', base]);
    assert.match(text.stdout, /^run-sweep: 0 finding\(s\) · judges the whole tree; --since does not apply$/m);
    const only = run(repo, ['--check', 'run-sweep', '--json']);
    assert.equal(only.status, 0, only.out);
    assert.deepEqual(JSON.parse(only.stdout).checks.map((c) => c.name), ['runSweep']);
    assert.equal(run(repo, ['--check', 'nope']).status, 2);
    assert.equal(run(repo, ['--bogus']).status, 2);
    assert.equal(run(repo, ['--gate', '--apply']).status, 2);
  });
});

describe('hygiene — the completion gate (CLI)', () => {
  test('red: AC-1844 artifactCheck, attributionCheck and secretScan on, one tracked .cursorrules: file scope FAIL, secrets FAIL here (a key shape is tracked), commit PASS, staging PASS, separation PASS, ignore rules PASS, delivery NOT CONFIGURED; exit 1', () => {
    const { repo } = rig();
    profile(repo, { artifactCheck: { state: 'on' }, attributionCheck: { state: 'on', target: 'main' }, secretScan: { state: 'on', allow: ['config.js', 'other.js'] } });
    const r = run(repo, ['--gate', '--json']);
    assert.equal(r.status, 1, r.out);
    const g = JSON.parse(r.stdout);
    const row = Object.fromEntries(g.rows.map((x) => [x.gate, x]));
    assert.deepEqual(g.rows.map((x) => x.gate), ['file scope', 'ignore rules', 'secrets', 'staging', 'commit', 'delivery', 'separation']);
    assert.equal(row['file scope'].result, 'FAIL');
    assert.match(row['file scope'].findings[0], /ASSISTANT-FILE +\.cursorrules/);
    assert.equal(row.secrets.result, 'PASS', 'the two key files are allowed');
    assert.equal(row.commit.result, 'PASS');
    assert.equal(row.staging.result, 'PASS');
    assert.equal(row['ignore rules'].result, 'PASS', 'artifactCheck on configures the row; no assistant .gitignore line');
    assert.equal(row.delivery.result, 'NOT CONFIGURED');
    assert.equal(row.separation.result, 'PASS');
    const text = run(repo, ['--gate']);
    assert.match(text.stdout, /^FAIL +file scope/m);
    assert.match(text.stdout, /^NOT CONFIGURED +delivery/m);
    assert.match(text.stdout, /^gate: FAIL — 1 row\(s\) fail; the task is not Done$/m);
    assert.ok(existsSync(join(repo, '.pipeline', 'hygiene', 'gate.json')));
    // a staged junk file turns the staging row: the index is read when it is not empty
    writeFileSync(join(repo, 'notes.tmp'), 'x\n');
    git(repo, 'add', 'notes.tmp');
    const staged = JSON.parse(run(repo, ['--gate', '--json']).stdout);
    const st = staged.rows.find((x) => x.gate === 'staging');
    assert.equal(st.result, 'FAIL');
    assert.match(st.findings[0], /SCRATCH-FILE +notes\.tmp/);
    assert.match(st.note, /--staged over the index/);
  });
  test('red: AC-1844b every gate check off: seven NOT CONFIGURED rows, exit 3, no PASS', () => {
    const { repo } = rig();
    profile(repo, { runSweep: { state: 'on' } });
    const r = run(repo, ['--gate']);
    assert.equal(r.status, 3, r.out);
    const rows = r.stdout.split(/\r?\n/).filter((l) => /^NOT CONFIGURED/.test(l));
    assert.equal(rows.length, 7, r.stdout);
    assert.doesNotMatch(r.stdout, /PASS/);
    assert.match(r.stdout, /never a pass \(exit 3\)/);
  });
  test('red: AC-1844 a clean tree with the gate checks on passes with exit 0; a trailer in a commit since BASE fails the commit row', () => {
    const { repo, base } = rig();
    git(repo, 'rm', '-q', '--cached', '.cursorrules');
    git(repo, 'commit', '-q', '-m', 'drop the rules file');
    profile(repo, { artifactCheck: { state: 'on' }, attributionCheck: { state: 'on', target: 'main' }, secretScan: { state: 'on', allow: ['config.js', 'other.js'] }, ignoreCheck: { state: 'on', allow: ['.pipeline/**'] }, sizeCheck: { state: 'on' } });
    const ok = run(repo, ['--gate']);
    assert.equal(ok.status, 0, ok.out);
    assert.match(ok.stdout, /^gate: PASS — every configured row passes$/m);
    assert.doesNotMatch(ok.stdout, /NOT CONFIGURED/);
    writeFileSync(join(repo, 'z.txt'), 'z\n');
    git(repo, 'add', 'z.txt');
    git(repo, 'commit', '-q', '-m', 'z', '-m', 'Co-Authored-By: Claude <noreply@anthropic.com>');
    git(repo, 'checkout', '-q', '-b', 'feature/z');
    const bad = run(repo, ['--gate', '--since', base, '--json']);
    assert.equal(bad.status, 1, bad.out);
    const commit = JSON.parse(bad.stdout).rows.find((x) => x.gate === 'commit');
    assert.equal(commit.result, 'FAIL');
    assert.match(commit.findings[0], /^TRAILER/);
  });
});
