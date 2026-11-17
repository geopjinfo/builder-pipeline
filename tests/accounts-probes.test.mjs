/**
 * The built-in readiness probes — `scripts/lib/account-probes.cjs` (REQ-208, REQ-211, REQ-202, REQ-207, REQ-210;
 * D43, D46).
 *
 * WHY. The assessment is pure; this module is the only place a `claude` or `codex` binary is run for it. Each probe
 * state is a stub executable written into a temp dir and put first on PATH, so no real harness runs here. The stub
 * also prints what it sees of its environment, which proves the scrub: no ANTHROPIC_* or OPENAI_* variable reaches
 * a probe, and the account's config dir does. Every fake credential is built at run time, never written as a literal.
 */
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const PACK = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const probes = require(join(PACK, 'scripts/lib/account-probes.cjs'));
const { paths } = require(join(PACK, 'scripts/lib/account-paths.cjs'));
const { assess } = require(join(PACK, 'scripts/lib/accounts.cjs'));
const made = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

const NOW = '2026-11-17T09:30:00.000Z';
const tmp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); made.push(d); return d; };

/**
 * A bin dir holding Node stubs for `claude` and `codex`; each stub body gets `args` and may print anything. The dir is
 * the WHOLE probe PATH (a `node` link makes the stubs runnable), so a real `claude` or `codex` on this machine never runs.
 */
function stubs(bodies) {
  const bin = tmp('probe-bin-');
  if (process.platform !== 'win32') symlinkSync(process.execPath, join(bin, 'node'));
  for (const [name, body] of Object.entries(bodies)) {
    const script = `const args = process.argv.slice(2);\n${body}\n`;
    if (process.platform === 'win32') {
      // No shebangs on Windows: a .cmd shim runs this Node on the stub's script with the probe's own env.
      writeFileSync(join(bin, `${name}.js`), script);
      writeFileSync(join(bin, `${name}.cmd`), `@"${process.execPath}" "%~dp0${name}.js" %*\r\n`);
      continue;
    }
    const file = join(bin, name);
    writeFileSync(file, `#!/usr/bin/env node\n${script}`);
    chmodSync(file, 0o755);
  }
  return bin;
}
// On Windows cmd.exe (the shell runBinary uses there) needs SystemRoot, ComSpec and PATHEXT; the allowlist passes them.
const winBase = process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec, PATHEXT: process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD' } : {};
const envWith = (bin, extra = {}) => ({ ...winBase, PATH: `${bin}${delimiter}/usr/bin${delimiter}/bin`, HOME: '/home/none', ANTHROPIC_API_KEY: 'parent-secret-value-xyz', OPENAI_API_KEY: 'parent-openai-value', ...extra });
const claudeStub = (json, status = 0) => `if (args[0] === 'auth' && args[1] === 'status') { process.stdout.write(JSON.stringify({ ...${json}, configDirectory: process.env.CLAUDE_CONFIG_DIR, leaked: process.env.ANTHROPIC_API_KEY || 'absent' })); process.exit(${status}); } if (args[0] === '--version') { process.stdout.write('1.2.3\\n'); process.exit(0); } process.exit(2);`;
const codexStub = (stderr, status) => `if (args[0] === 'login' && args[1] === 'status') { process.stderr.write(${JSON.stringify(stderr)} + ' ' + (process.env.OPENAI_API_KEY || 'absent') + ' ' + process.env.CODEX_HOME + '\\n'); process.exit(${status}); } process.exit(2);`;

const account = (over = {}) => ({ name: 'alpha', worker: 'claude-code', pays: 'subscription', roles: [], note: '', ...over });

describe('probe environment (REQ-202)', () => {
  test('REQ-202 the probe env is an allowlist: PATH and HOME pass, ANTHROPIC_*, OPENAI_*, CLAUDE* and CODEX* never do, the config dir is set', () => {
    const env = probes.probeEnv({ PATH: '/bin', HOME: '/h', ANTHROPIC_API_KEY: 'x', ANTHROPIC_BASE_URL: 'y', OPENAI_API_KEY: 'z', CLAUDE_CONFIG_DIR: '/parent', CODEX_HOME: '/parent2', LANG: 'C', RANDOM_VAR: '1' }, 'claude-code', '/cfg');
    assert.deepEqual(Object.keys(env).sort(), ['CLAUDE_CONFIG_DIR', 'HOME', 'LANG', 'PATH']);
    assert.equal(env.CLAUDE_CONFIG_DIR, '/cfg');
    assert.equal(probes.probeEnv({ PATH: '/bin' }, 'codex', '/cx').CODEX_HOME, '/cx');
    assert.equal(probes.probeEnv({ PATH: '/bin' }, 'codex', '/cx').CLAUDE_CONFIG_DIR, undefined);
  });
});

describe('Claude Code probe (REQ-208, REQ-211)', () => {
  test('REQ-208 signed in: claude auth status JSON gives ready with the auth method and the config dir', () => {
    const bin = stubs({ claude: claudeStub(`{ loggedIn: true, authMethod: 'claude.ai' }`) });
    const home = tmp('acc-home-');
    const p = paths(home, 'alpha', account());
    const r = probes.probe(account(), p, { env: envWith(bin), now: NOW });
    assert.equal(r.ok, true);
    assert.equal(r.method, 'claude.ai');
    assert.equal(r.configDir, p.configDir);
    assert.equal(r.signIn, 'claude auth login');
    assert.equal(r.expiresAt, null);
    assert.ok(!JSON.stringify(r).includes('parent-secret'), 'the parent key never reaches the probe');
    assert.equal(r.leaked, 'absent');
  });

  test('REQ-208 signed out (exit 1) with no key file is not ready (signed out); key file + apiKeyHelper is ready (api-key)', () => {
    const bin = stubs({ claude: claudeStub(`{ loggedIn: false }`, 1) });
    const home = tmp('acc-home-');
    const p = paths(home, 'alpha', account());
    const down = probes.probe(account(), p, { env: envWith(bin), now: NOW });
    assert.equal(down.ok, false);
    assert.equal(down.reason, 'signed out');
    assert.equal(down.signIn, 'claude auth login');
    mkdirSync(p.dir, { recursive: true });
    writeFileSync(p.keyFile, 'not-read-by-the-probe\n');
    writeFileSync(p.settingsFile, JSON.stringify({ apiKeyHelper: `cat ${p.keyFile}` }));
    const up = probes.probe(account({ pays: 'api-key' }), p, { env: envWith(bin), now: NOW });
    assert.equal(up.ok, true);
    assert.equal(up.method, 'api-key');
    assert.ok(!JSON.stringify(up).includes('not-read-by'));
    writeFileSync(p.settingsFile, JSON.stringify({}));
    const half = probes.probe(account({ pays: 'api-key' }), p, { env: envWith(bin), now: NOW });
    assert.equal(half.ok, false);
    assert.match(half.reason, /apiKeyHelper/);
  });

  test('REQ-208 a missing claude binary or unreadable output is unmeasured, never ready', () => {
    const bin = stubs({});
    const p = paths(tmp('acc-home-'), 'alpha', account());
    const r = probes.probe(account(), p, { env: envWith(bin), now: NOW });
    assert.equal(r.ok, null);
    assert.match(r.reason, /claude: not found|not found/);
    const garbage = probes.parseClaudeAuthStatus({ stdout: 'hello', stderr: '', status: 0 });
    assert.equal(garbage.ok, null);
  });

  test('REQ-211 an expiry 30 minutes ahead is not ready (AUTH until <time>, run claude auth login)', () => {
    const soon = new Date(Date.parse(NOW) + 30 * 60000).toISOString();
    const bin = stubs({ claude: claudeStub(`{ loggedIn: true, authMethod: 'claude.ai', expiresAt: '${soon}' }`) });
    const p = paths(tmp('acc-home-'), 'alpha', account());
    const r = probes.probe(account(), p, { env: envWith(bin), now: NOW });
    assert.equal(r.expiresAt, soon);
    const a = assess(account(), { auth: r }, null, NOW, { authMinMinutes: 120 });
    assert.equal(a.state, 'not ready');
    assert.equal(a.reason, `AUTH until ${soon}`);
    assert.equal(a.until, soon);
    assert.equal(a.signIn, 'claude auth login');
  });

  test('REQ-211 a probe output with no expiry leaves the state unchanged', () => {
    const r = probes.parseClaudeAuthStatus({ stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }), stderr: '', status: 0 });
    assert.equal(r.expiresAt, null);
    assert.equal(assess(account(), { auth: r }, null, NOW).state, 'ready');
    const ms = Date.parse(NOW) + 30 * 60000;
    assert.equal(probes.parseClaudeAuthStatus({ stdout: JSON.stringify({ loggedIn: true, expiresAt: ms }), stderr: '', status: 0 }).expiresAt, new Date(ms).toISOString());
  });

  test('REQ-202 a probe that echoes a secret-shaped string reaches the assessment only as the redaction marker', () => {
    const fake = ['sk', 'ant', 'api03', 'B'.repeat(24)].join('-');
    const r = probes.parseClaudeAuthStatus({ stdout: `error: ${fake}`, stderr: '', status: 3 });
    const a = assess(account(), { auth: r }, null, NOW);
    assert.ok(!JSON.stringify(a).includes(fake));
    assert.ok(JSON.stringify(a).includes('<redacted: Anthropic key>'));
  });
});

describe('Codex probe (REQ-208, REQ-211)', () => {
  test('REQ-208 codex login status is read from stderr and the exit code: ChatGPT login, API key, not logged in', () => {
    const p = paths(tmp('acc-home-'), 'bravo', account({ name: 'bravo', worker: 'codex' }));
    const chatgpt = probes.probe(account({ name: 'bravo', worker: 'codex' }), p, { env: envWith(stubs({ codex: codexStub('Logged in using ChatGPT', 0) })), now: NOW });
    assert.equal(chatgpt.ok, true);
    assert.equal(chatgpt.method, 'chatgpt');
    assert.equal(chatgpt.signIn, 'codex login');
    assert.ok(!JSON.stringify(chatgpt).includes('parent-openai'));
    const keyed = probes.probe(account({ name: 'bravo', worker: 'codex', pays: 'api-key' }), p, { env: envWith(stubs({ codex: codexStub('Logged in using an API key', 0) })), now: NOW });
    assert.equal(keyed.ok, true);
    assert.equal(keyed.method, 'api-key');
    const out = probes.probe(account({ name: 'bravo', worker: 'codex' }), p, { env: envWith(stubs({ codex: codexStub('Not logged in', 1) })), now: NOW });
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'not logged in');
    assert.equal(out.signIn, 'codex login');
    assert.equal(probes.parseCodexLoginStatus({ stdout: '', stderr: '', status: 0 }).tier, undefined, 'no plan tier is ever reported');
  });

  test('REQ-211 the Codex auth.json token expiry is read as expiresAt; no token, no expiry', () => {
    const exp = Math.floor(Date.parse(NOW) / 1000) + 30 * 60;
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const token = [b64({ alg: 'none', typ: 'JWT' }), b64({ exp, sub: 'fixture-subject' }), 'x'.repeat(16)].join('.');
    const home = tmp('acc-home-');
    const acc = account({ name: 'bravo', worker: 'codex' });
    const p = paths(home, 'bravo', acc);
    mkdirSync(p.configDir, { recursive: true });
    writeFileSync(p.codexAuthFile, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: token } }));
    const r = probes.probe(acc, p, { env: envWith(stubs({ codex: codexStub('Logged in using ChatGPT', 0) })), now: NOW });
    assert.equal(r.expiresAt, new Date(exp * 1000).toISOString());
    assert.ok(!JSON.stringify(r).includes(token));
    const a = assess(acc, { auth: r }, null, NOW);
    assert.equal(a.state, 'not ready');
    assert.match(a.reason, /^AUTH until /);
    assert.equal(a.signIn, 'codex login');
    assert.equal(probes.codexAuthExpiry(JSON.stringify({ tokens: {} })), null);
    assert.equal(probes.codexAuthExpiry('{not json'), null);
    assert.equal(probes.codexAuthExpiry(JSON.stringify({ tokens: { expires_at: '2026-11-17T12:00:00.000Z' } })), '2026-11-17T12:00:00.000Z');
  });
});

describe('the probes map and collect (REQ-208, REQ-207, REQ-210)', () => {
  test('REQ-208 Claude Code and Codex probes are built in; antigravity and gateway are extension points left to M2b', () => {
    assert.deepEqual(Object.keys(probes.PROBES).sort(), ['claude-code', 'codex']);
    assert.deepEqual(probes.FOREIGN_PROBES, ['antigravity', 'gateway']);
    const r = probes.probe(account({ worker: 'antigravity' }), paths(tmp('acc-home-'), 'alpha'), { env: {}, now: NOW });
    assert.equal(r.ok, null);
    assert.match(r.reason, /no built-in probe/);
  });

  test('REQ-207 REQ-210 collect runs the probe, the smoke record, versionCommand and every usage reader with a timeout', () => {
    const bin = stubs({
      claude: claudeStub(`{ loggedIn: true, authMethod: 'claude.ai' }`),
      'usage-tool': `process.stdout.write('Used $4.20 of $10.00\\n');`,
      'slow-tool': `setTimeout(() => {}, 5000);`,
    });
    const home = tmp('acc-home-');
    const acc = account({ usageCommand: 'usage-tool', versionCommand: 'claude --version', smokeCommand: 'true' });
    const p = paths(home, 'alpha', acc);
    mkdirSync(p.dir, { recursive: true });
    writeFileSync(p.smokeFile, JSON.stringify({ ok: true, at: '2026-11-17T08:00:00.000Z' }));
    const got = probes.collect(acc, p, { env: envWith(bin), now: NOW, timeoutMs: 4000 });
    assert.equal(got.probes.auth.ok, true);
    assert.deepEqual(got.probes.smoke, { ok: true, at: '2026-11-17T08:00:00.000Z' });
    assert.equal(got.probes.version.version, '1.2.3');
    assert.equal(got.usage.length, 1);
    assert.equal(got.usage[0].percent, 42);
    assert.equal(got.usage[0].reader, 'usageCommand');
    const a = assess(acc, got.probes, got.usage, NOW);
    assert.equal(a.state, 'ready');
    assert.equal(a.version, '1.2.3');
    assert.equal(a.budget.used.percent, 42);
    // No readers, no smoke record, no versionCommand: unmeasured all round, never a pass.
    const bare = probes.collect(account(), paths(tmp('acc-home-'), 'alpha'), { env: envWith(bin), now: NOW });
    assert.deepEqual(bare.usage, []);
    assert.equal(bare.probes.smoke, null);
    assert.equal(bare.probes.version, null);
    // A hanging command times out and reads as nothing, not as a value.
    const slow = probes.runCommand('slow-tool', { env: envWith(bin), timeoutMs: 300 });
    assert.equal(slow.timedOut, true);
    assert.equal(probes.collect(account({ versionCommand: 'slow-tool' }), paths(home, 'alpha'), { env: envWith(bin), now: NOW, timeoutMs: 300 }).probes.version, null);
  });
});
