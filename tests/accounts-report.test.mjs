/**
 * `npx builder-pipeline accounts [--json]` — the readiness report (REQ-204, REQ-205; D7, D25), through cli.js in a temp project
 * with BUILDER_ACCOUNTS_HOME inside it and stub executables on an isolated PATH.
 *
 * WHY. The report is the one place an account owner sees every account's state before a run. Its shape follows
 * `gh auth status`: one block per account. Its exit code is the gate a script can read: 1 when any account is not
 * ready, 0 with --json. With the feature off, or with no account, it says `accounts: not configured` and exits 0 —
 * that line is never a pass. No key value and no environment value may appear in its output.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const PACK = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { paths } = require(join(PACK, 'scripts/lib/account-paths.cjs'));
const made = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

const fakeKey = (tag = 'alpha') => ['sk', 'ant', 'api03'].join('-') + '-' + `${tag}0`.repeat(8);
const assertNoValue = (text, value) => {
  for (let i = 0; i + 8 <= value.length; i += 4) assert.equal(text.includes(value.slice(i, i + 8)), false, `a slice of the key leaked: ${text.slice(0, 300)}`);
};

const HEAD = '# Profile\n\n## 16. Settings\n\n';
const base = (features) => ({
  schema: 2,
  commands: { tier: null, tiers: [], affected: null, typecheck: null },
  models: { strong: 'strong-model', mid: 'mid-model', orchestrator: null },
  features,
});
const text = (block) => `${HEAD}\`\`\`json pipeline-settings\n${JSON.stringify(block, null, 2)}\n\`\`\`\n`;

/** Node stubs on an isolated PATH (a .cmd shim on Windows), as in accounts-probes.test. */
function stubs(bin, bodies) {
  mkdirSync(bin, { recursive: true });
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
}
const claudeStub = (loggedIn) => `if (args[0] === 'auth' && args[1] === 'status') { process.stdout.write(JSON.stringify({ loggedIn: ${loggedIn}, authMethod: 'claude.ai', configDirectory: process.env.CLAUDE_CONFIG_DIR, leaked: process.env.PARENT_SECRET_VAR || 'absent' })); process.exit(${loggedIn ? 0 : 1}); } if (args[0] === '--version') { process.stdout.write('1.2.3\\n'); process.exit(0); } process.exit(2);`;
const codexStub = (text, status) => `if (args[0] === 'login' && args[1] === 'status') { process.stderr.write(${JSON.stringify(text)} + '\\n'); process.exit(${status}); } process.exit(2);`;

/** A temp project with a profile, an accounts home inside it and the stubs as the whole PATH. */
function project(features, bodies = {}) {
  const proj = mkdtempSync(join(tmpdir(), 'kit-accounts-report-'));
  made.push(proj);
  if (features !== null) writeFileSync(join(proj, 'PIPELINE_PROFILE.md'), text(base(features)));
  const home = join(proj, '.accounts-home');
  const bin = join(proj, 'stub-bin');
  stubs(bin, bodies);
  const sys = process.platform === 'win32' ? process.env.PATH : `/usr/bin${delimiter}/bin`;
  const env = {
    PATH: `${bin}${delimiter}${sys}`, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec, PATHEXT: process.env.PATHEXT,
    BUILDER_NO_BASH_CAP: '1', BUILDER_ACCOUNTS_HOME: home, BUILDER_ORCH_DIR: join(proj, '.pipeline', 'orchestrator'), PARENT_SECRET_VAR: 'parent-env-value-never-printed',
  };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const run = (args) => {
    const r = spawnSync(process.execPath, [join(PACK, 'cli.js'), 'accounts', ...args], { cwd: proj, encoding: 'utf8', env });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  return { proj, home, run };
}

const alpha = { worker: 'claude-code', pays: 'subscription', content: 'any', roles: [], note: 'the plan account', versionCommand: 'claude --version' };
const bravo = { worker: 'codex', pays: 'subscription', content: 'public', roles: ['module-tester', 'module-reviewer'], note: 'the codex account' };

describe('accounts: not configured (REQ-205)', () => {
  test('red: REQ-205 features.accounts off, no profile, or no account: prints "accounts: not configured" and exits 0 — never a pass', () => {
    const off = project({ accounts: { state: 'off', accounts: { alpha } } });
    const r = off.run([]);
    assert.equal(r.status, 0, r.out);
    assert.equal(r.stdout.trim(), 'accounts: not configured');
    assert.equal(off.run(['--json']).status, 0);
    assert.equal(off.run(['--json']).stdout.trim(), 'accounts: not configured');
    const none = project({ accounts: { state: 'on', accounts: {} } });
    assert.equal(none.run([]).status, 0);
    assert.match(none.run([]).stdout, /^accounts: not configured/m);
    const noProfile = project(null);
    assert.equal(noProfile.run([]).status, 0, noProfile.run([]).out);
    assert.match(noProfile.run([]).stdout, /^accounts: not configured/m);
    assert.ok(!/ready/.test(noProfile.run([]).stdout));
  });
});

describe('the report (REQ-204, REQ-205)', () => {
  test('red: REQ-204 REQ-205 one block per account in the gh auth status shape; every account ready and the orchestrator off: exit 0', () => {
    const p = project({ orchestrator: { state: 'off' }, accounts: { state: 'on', accounts: { alpha, bravo } } }, { claude: claudeStub(true), codex: codexStub('Logged in using ChatGPT', 0) });
    const r = p.run([]);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /^accounts: 2 ready$/m);
    const blocks = r.stdout.trim().split(/\n(?=\S)/).filter((b) => !b.startsWith('accounts:'));
    assert.equal(blocks.length, 2, r.stdout);
    assert.match(blocks[0], /^alpha\b.*claude-code.*subscription/);
    assert.match(blocks[0], /\n\s+ready\b/);
    assert.match(blocks[0], /content:\s+any/);
    assert.match(blocks[0], /roles:\s+all/);
    assert.match(blocks[0], /usage:\s+unmeasured/);
    assert.match(blocks[0], /version:\s+1\.2\.3/);
    assert.match(blocks[0], /key:\s+absent/);
    assert.match(blocks[0], /lease:\s+none/);
    assert.match(blocks[0], /note:\s+the plan account/);
    assert.match(blocks[1], /^bravo\b.*codex/);
    assert.match(blocks[1], /roles:\s+module-tester, module-reviewer/);
    assert.match(blocks[1], /usage:\s+unmeasured/);
    assert.match(blocks[1], /version:\s+unmeasured/);
    assert.ok(!r.out.includes('0 %'), 'no reading never renders as 0 %');
    assert.ok(!r.out.includes('parent-env-value'), 'the parent env never reaches the report');
  });

  test('red: REQ-205 a not-ready account makes the exit 1 and names the reason and the sign-in; the not-ready block sorts last; --json exits 0 with the assessment shape', () => {
    const p = project({ accounts: { state: 'on', accounts: { bravo, alpha } } }, { claude: claudeStub(true), codex: codexStub('Not logged in', 1) });
    const r = p.run([]);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stdout, /^accounts: 1 of 2 not ready \(bravo: not ready\)$/m);
    const blocks = r.stdout.trim().split(/\n(?=\S)/).filter((b) => !b.startsWith('accounts:'));
    assert.match(blocks[0], /^alpha\b/, 'ready first');
    assert.match(blocks[1], /^bravo\b/);
    assert.match(blocks[1], /not ready \(not logged in, run codex login\)/);
    const j = p.run(['--json']);
    assert.equal(j.status, 0, j.out);
    const rows = JSON.parse(j.stdout);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((a) => a.name), ['alpha', 'bravo']);
    assert.equal(rows[1].state, 'not ready');
    assert.equal(rows[1].reason, 'not logged in');
    assert.equal(rows[1].signIn, 'codex login');
    assert.equal(rows[0].state, 'ready');
    assert.equal(rows[0].budget.used.source, 'unmeasured');
    assert.equal(rows[0].key.present, false);
    assert.equal(rows[0].lease.state, 'none');
    for (const k of ['name', 'worker', 'pays', 'state', 'reason', 'qualifier', 'budget', 'version', 'note', 'roles', 'key', 'lease']) assert.ok(k in rows[0], k);
    // --json after the subcommand position too, and an unknown option is refused.
    assert.equal(p.run(['--json']).status, 0);
    assert.equal(p.run(['--colour']).status, 1);
    assert.match(p.run(['--colour']).stderr, /unknown/);
  });

  test('red: REQ-205 an unmeasured account (no probe answer) is not a pass: exit 1; a key file shows as present, never its value', () => {
    const p = project({ accounts: { state: 'on', accounts: { alpha: { ...alpha, pays: 'api-key' } } } }, { claude: claudeStub(false) });
    const value = fakeKey('report');
    const at = paths(p.home, 'alpha');
    mkdirSync(at.dir, { recursive: true });
    writeFileSync(at.keyFile, value, { mode: 0o600 });
    writeFileSync(at.settingsFile, JSON.stringify({ apiKeyHelper: 'node helper read alpha' }));
    const r = p.run([]);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /key:\s+present \(key/);
    assert.match(r.stdout, /content:\s+any/);
    assertNoValue(r.out, value);
    assertNoValue(p.run(['--json']).stdout, value);
    rmSync(at.settingsFile);
    rmSync(at.keyFile);
    const down = p.run([]);
    assert.equal(down.status, 1, down.out);
    assert.match(down.stdout, /not ready \(signed out, run claude auth login\)/);
    const un = project({ accounts: { state: 'on', accounts: { charlie: { worker: 'antigravity', pays: 'subscription' } } } }, {});
    const u = un.run([]);
    assert.equal(u.status, 1, u.out);
    assert.match(u.stdout, /unmeasured \(.*not found/);
  });

  test('red: REQ-205 list is still the registry view and runs no probe; the report runs them', () => {
    const p = project({ accounts: { state: 'on', accounts: { bravo } } }, { codex: `process.stderr.write('probe ran\\n'); process.exit(1);` });
    const l = p.run(['list']);
    assert.equal(l.status, 0, l.out);
    assert.ok(!l.out.includes('not logged in'));
    assert.match(p.run([]).stdout, /bravo/);
    assert.equal(p.run([]).status, 1);
  });
});
