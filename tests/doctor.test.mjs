/**
 * `builder doctor` — which kit features each tool supports, partly supports or cannot support, with the reason.
 *
 * WHY. A seat limit Codex cannot hold per agent, or a guard Antigravity never runs, reads as protection unless
 * something says otherwise. doctor says it per tool, from each adapter's own `unconfirmed` list plus the known
 * limits, and is a report: exit 0 whatever it finds.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const PACK = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const lib = require('../adapters/lib/index.cjs');
const made = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

function project() {
  const proj = mkdtempSync(join(tmpdir(), 'kit-doctor-'));
  made.push(proj);
  cpSync(PACK, join(proj, 'builder'), { recursive: true, filter: (src) => !/[\\/](?:\.git|tests|node_modules)(?:[\\/]|$)/.test(`/${relative(PACK, src)}`) });
  return proj;
}
const run = (cwd, args) => {
  const r = spawnSync(process.execPath, ['builder/cli.js', ...args], { cwd, encoding: 'utf8', env: { ...process.env, BUILDER_NO_BASH_CAP: '1' } });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, stdout: r.stdout ?? '' };
};

describe('builder doctor', () => {
  const root = project();

  test('red: codex — the sandbox, apply_patch and hook-agent limits are named, and it exits 0', () => {
    const r = run(root, ['doctor', '--tool', 'codex']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /^\[codex\]/m);
    assert.match(r.out, /partial .*sandbox/i);
    assert.match(r.out, /apply_patch/);
    assert.match(r.out, /unsupported .*reviewer-write-guard/);
    for (const u of lib.codex.unconfirmed) assert.ok(r.out.includes(u), u);
  });

  test('red: antigravity — hooks not written, whole-tool grants, no effort', () => {
    const r = run(root, ['doctor', '--tool', 'antigravity']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /unsupported .*hooks/i);
    assert.match(r.out, /partial .*whole-tool/i);
    assert.match(r.out, /unsupported .*effort/i);
    for (const u of lib.antigravity.unconfirmed) assert.ok(r.out.includes(u), u);
  });

  test('--json gives every feature a status of supported, partial or unsupported', () => {
    const j = JSON.parse(run(root, ['doctor', '--tool', 'claude-code,codex,antigravity,opencode', '--json']).stdout).filter((t) => t.tool);
    assert.deepEqual(j.map((t) => t.tool), ['claude-code', 'codex', 'antigravity', 'opencode']);
    for (const t of j) for (const f of t.features) assert.ok(['supported', 'partial', 'unsupported'].includes(f.status), `${t.tool} ${f.feature}`);
    assert.ok(j[0].features.every((f) => f.status !== 'unsupported'), 'claude-code supports every kit feature');
  });

  test('without --tool it reports the installed tools, or says nothing is installed', () => {
    const fresh = project();
    const none = run(fresh, ['doctor']);
    assert.equal(none.status, 0);
    assert.match(none.out, /no kit install detected/);
    assert.equal(run(fresh, ['unpack', '--tool', 'codex', '--no-extras']).status, 0);
    const r = run(fresh, ['doctor']);
    assert.match(r.out, /^\[codex\]/m);
    assert.doesNotMatch(r.out, /^\[claude-code\]/m);
  });
});

/* ------------------------------------------------------------- accounts rows (REQ-701, REQ-107) ---- */

const SETTINGS = { schema: 2, commands: { tier: null, tiers: [], affected: null, typecheck: null }, models: { strong: 'strong-model', mid: 'mid-model', orchestrator: null } };
const profileText = (features) => `# Profile\n\n## 16. Settings\n\n\`\`\`json pipeline-settings\n${JSON.stringify({ ...SETTINGS, features }, null, 2)}\n\`\`\`\n`;

/** Stub `claude` and `codex` executables first on PATH (the same shape as tests/accounts-probes.test.mjs): no real harness runs. */
function stubs(bodies) {
  const bin = mkdtempSync(join(tmpdir(), 'doctor-bin-'));
  made.push(bin);
  if (process.platform !== 'win32') symlinkSync(process.execPath, join(bin, 'node'));
  for (const [name, body] of Object.entries(bodies)) {
    const script = `const args = process.argv.slice(2);\n${body}\n`;
    if (process.platform === 'win32') {
      writeFileSync(join(bin, `${name}.js`), script);
      writeFileSync(join(bin, `${name}.cmd`), `@"${process.execPath}" "%~dp0${name}.js" %*\r\n`);
      continue;
    }
    writeFileSync(join(bin, name), `#!/usr/bin/env node\n${script}`);
    chmodSync(join(bin, name), 0o755);
  }
  return bin;
}
const CLAUDE_READY = `if (args[0] === 'auth' && args[1] === 'status') { process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })); process.exit(0); } if (args[0] === '--version') { process.stdout.write('1.2.3\\n'); process.exit(0); } process.exit(2);`;
const CODEX_OUT = `if (args[0] === 'login' && args[1] === 'status') { process.stderr.write('Not logged in\\n'); process.exit(1); } process.exit(2);`;

function doctorWith(features, bodies, extra = []) {
  const proj = project();
  writeFileSync(join(proj, 'PIPELINE_PROFILE.md'), profileText(features));
  const bin = stubs(bodies);
  const home = mkdtempSync(join(tmpdir(), 'doctor-home-'));
  made.push(home);
  const env = { ...process.env, BUILDER_NO_BASH_CAP: '1', BUILDER_ACCOUNTS_HOME: home, PATH: `${bin}${delimiter}${process.env.PATH || ''}` };
  const go = (args) => {
    const toolArgs = extra.length ? extra : ['--tool', 'claude-code']; // the first --tool wins, so a caller's list replaces the default
    const r = spawnSync(process.execPath, ['builder/cli.js', 'doctor', ...toolArgs, ...args], { cwd: proj, encoding: 'utf8', env });
    return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, stdout: r.stdout ?? '' };
  };
  return { text: go([]), json: go(['--json']) };
}
const accountRows = (json) => {
  const section = JSON.parse(json.stdout).find((t) => t.section === 'accounts');
  assert.ok(section, 'the --json report carries an accounts section');
  assert.equal(section.advisory, true);
  return section.rows;
};

describe('builder doctor accounts rows (REQ-701, REQ-107)', () => {
  test('red: REQ-701 one advisory row per configured account with the readiness reason; exit 0 even when an account is not ready', () => {
    const accounts = { alpha: { worker: 'claude-code', pays: 'subscription', versionCommand: 'claude --version' }, bravo: { worker: 'codex', pays: 'subscription' } };
    const { text, json } = doctorWith({ accounts: { state: 'on', accounts } }, { claude: CLAUDE_READY, codex: CODEX_OUT });
    assert.equal(text.status, 0, text.out);
    assert.match(text.out, /^\[accounts\]/m);
    assert.match(text.out, /^ {2}advisory {4}accounts — alpha \(claude-code\): ready\b/m, text.out);
    assert.match(text.out, /^ {2}advisory {4}accounts — bravo \(codex\): not ready \(not logged in, run codex login\)/m, text.out);
    assert.match(text.out, /v 1\.2\.3/);
    assert.equal(json.status, 0, json.out);
    const rows = accountRows(json);
    assert.deepEqual(rows.map((r) => [r.account, r.worker, r.state, r.status]), [['alpha', 'claude-code', 'ready', 'advisory'], ['bravo', 'codex', 'not ready', 'advisory']]);
    assert.match(rows[1].note, /not logged in/);
    for (const r of rows) assert.equal(r.feature, 'accounts');
  });

  test('red: REQ-107 a 1.0 profile (seats, limits, credit) gets the one legacy row and the exit code is unchanged', () => {
    const orchestrator = { state: 'off', seats: ['secondary', 'primary'], limits: { secondary: 70, primary: 50 }, credit: { enabled: false } };
    const { text, json } = doctorWith({ orchestrator }, {});
    assert.equal(text.status, 0, text.out);
    const legacy = text.out.split('\n').filter((l) => /legacy seats/.test(l));
    assert.equal(legacy.length, 1, text.out);
    assert.match(legacy[0], /^ {2}advisory {4}accounts — profile: legacy seats, run npx builder-pipeline accounts migrate$/);
    assert.equal(json.status, 0, json.out);
    const rows = accountRows(json);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].note, 'profile: legacy seats, run npx builder-pipeline accounts migrate');
    assert.equal(rows[0].state, 'legacy');
  });

  test('red: REQ-701 with no accounts configured, one advisory "accounts: not configured" row, never a pass', () => {
    const { text, json } = doctorWith({}, {});
    assert.equal(text.status, 0, text.out);
    assert.match(text.out, /^ {2}advisory {4}accounts — accounts: not configured$/m, text.out);
    assert.doesNotMatch(text.out, /legacy seats/);
    const rows = accountRows(json);
    assert.deepEqual(rows.map((r) => r.note), ['accounts: not configured']);
  });
});

describe('REQ-1511 — the capacity advisory row', () => {
  test('red: doctor prints one advisory capacity row; --json carries it; the exit code stays 0 (AC-1511b)', () => {
    const { text, json } = doctorWith({}, {});
    assert.equal(text.status, 0, text.out);
    assert.match(text.out, /^\[capacity\] features\.capacity — advisory, the exit code is unchanged$/m, text.out);
    const rows = text.out.split('\n').filter((l) => /^ {2}advisory {4}capacity — /.test(l));
    assert.equal(rows.length, 1, text.out);
    assert.match(rows[0], /capacity: not configured — signals: memory, cores, (load, )?disk, accounts and the 429 record/);
    assert.equal(json.status, 0, json.out);
    const section = JSON.parse(json.stdout).find((t) => t.section === 'capacity');
    assert.ok(section && section.advisory === true, 'the --json report carries a capacity section');
    assert.equal(section.rows.length, 1);
    assert.equal(section.rows[0].feature, 'capacity');
    assert.equal(section.rows[0].state, 'off');
    const doctor = require('../cli/doctor.cjs');
    assert.match(doctor.capacityRows(process.cwd(), 'win32')[0].note, /load is unmeasured on win32/);
    assert.doesNotMatch(doctor.capacityRows(process.cwd(), 'linux')[0].note, /unmeasured/);
  });
});

describe('builder doctor reporter row (REQ-1613)', () => {
  test('red: the --json report carries an advisory reporter section with one row, and the text report prints it', () => {
    const d = doctorWith({}, {});
    const section = JSON.parse(d.json.stdout).find((t) => t.section === 'reporter');
    assert.ok(section, 'the --json report carries a reporter section');
    assert.equal(section.advisory, true);
    assert.equal(section.rows.length, 1);
    assert.equal(section.rows[0].feature, 'reporter');
    assert.match(section.rows[0].note, /reporter: not configured/);
    assert.match(d.text.out, /\[reporter\] features\.reporter — advisory/);
  });
});

describe('REQ-1703 — doctor --json for the three tools carries both agent rows (AC-1703b)', () => {
  test('red: the capacity and reporter sections appear in one run over claude-code, codex and antigravity', () => {
    const d = doctorWith({}, {}, ['--tool', 'claude-code,codex,antigravity']);
    const report = JSON.parse(d.json.stdout);
    for (const tool of ['claude-code', 'codex', 'antigravity']) assert.ok(report.some((t) => t.tool === tool), `${tool} is reported`);
    const capacity = report.find((t) => t.section === 'capacity');
    const reporter = report.find((t) => t.section === 'reporter');
    assert.ok(capacity && capacity.rows[0].feature === 'capacity', 'the capacity row');
    assert.ok(reporter && reporter.rows[0].feature === 'reporter', 'the reporter row');
  });
});

describe('builder doctor git-hooks rows (REQ-1815, AC-1815b)', () => {
  const gitHooks = require('../cli/git-hooks.cjs');
  const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
  test('red: the --json report carries a git-hooks section with the pre-commit row stating armed, missing and foreign in turn; the text report prints the line', () => {
    const proj = project();
    git(proj, 'init', '-q');
    writeFileSync(join(proj, 'PIPELINE_PROFILE.md'), profileText({}));
    const env = { ...process.env, BUILDER_NO_BASH_CAP: '1', BUILDER_ACCOUNTS_HOME: mkdtempSync(join(tmpdir(), 'doctor-home-')) };
    const go = (args) => spawnSync(process.execPath, ['builder/cli.js', 'doctor', '--tool', 'claude-code', ...args], { cwd: proj, encoding: 'utf8', env });
    const row = () => JSON.parse(go(['--json']).stdout).find((t) => t.section === 'git-hooks').rows.find((r) => r.hook === 'pre-commit');
    assert.equal(row().state, 'missing');
    assert.match(go([]).stdout, /^\[repo\] secret scan pre-commit: missing — /m);
    const target = join(gitHooks.hooksDir(proj), 'pre-commit');
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, gitHooks.preCommitText(join(proj, 'builder')));
    assert.equal(row().state, 'armed');
    writeFileSync(target, '#!/bin/sh\nexit 0\n');
    assert.equal(row().state, 'foreign');
    assert.match(go([]).stdout, /^\[repo\] secret scan pre-commit: foreign — /m);
  });
});
