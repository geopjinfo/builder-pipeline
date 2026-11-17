/**
 * M11 — `accounts install`: wrappers, composed settings, the lock and its backups, the refusal wrapper, srt settings
 * (REQ-1101, REQ-1102, REQ-1103, REQ-1106, REQ-1109; D19, D38, D41, D52). Temp project, accounts home inside it, no real
 * tool, no real key.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const PACK = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const wrappers = require(join(PACK, 'scripts/lib/account-wrappers.cjs'));
const lock = require(join(PACK, 'scripts/lib/accounts-lock.cjs'));
const { paths } = require(join(PACK, 'scripts/lib/account-paths.cjs'));
const POSIX = process.platform !== 'win32';
const made = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

const ACCOUNTS = {
  sub: { worker: 'claude-code', pays: 'subscription', family: 'anthropic' },
  gw: { worker: 'claude-code', pays: 'gateway', family: 'anthropic', baseUrl: 'http://127.0.0.1:20128' },
  free: { worker: 'claude-code', pays: 'free', family: 'other', content: 'public', baseUrl: 'http://127.0.0.1:20128' },
  apikey: { worker: 'claude-code', pays: 'api-key', family: 'anthropic' },
  cx: { worker: 'codex', pays: 'gateway', family: 'openai', baseUrl: 'http://127.0.0.1:20128' },
};
const POLICY = readFileSync(join(PACK, 'tests/fixtures/gateway/omniroute-3.8/policy.json'), 'utf8');
const block = (accounts, extra = {}) => ({
  schema: 2,
  commands: { tier: null, tiers: [], affected: null, typecheck: null },
  models: { strong: 'strong-model', mid: 'mid-model', orchestrator: null },
  features: { accounts: { state: 'on', accounts, gateway: { kind: 'omniroute', version: '3.8', baseUrl: 'http://127.0.0.1:20128' }, ...extra } },
});

function project(accounts = ACCOUNTS, { policy = POLICY } = {}) {
  const proj = mkdtempSync(join(tmpdir(), 'kit-install-'));
  made.push(proj);
  writeFileSync(join(proj, 'PIPELINE_PROFILE.md'), `# P\n\n\`\`\`json pipeline-settings\n${JSON.stringify(block(accounts), null, 2)}\n\`\`\`\n`);
  const home = join(proj, '.accounts-home');
  mkdirSync(join(home, 'gateway'), { recursive: true });
  if (policy !== null) writeFileSync(join(home, 'gateway', 'policy.json'), policy);
  const env = { ...process.env, BUILDER_NO_BASH_CAP: '1', BUILDER_ACCOUNTS_HOME: home, HOME: join(proj, 'fake-home') };
  mkdirSync(join(proj, 'fake-home'));
  const run = (args, opts = {}) => {
    const r = spawnSync(process.execPath, [join(PACK, 'cli.js'), ...args], { cwd: proj, encoding: 'utf8', env: { ...env, ...(opts.env || {}) } });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  return { proj, home, run, env };
}
const sh = (home, name) => readFileSync(paths(home, name).wrapperSh, 'utf8');
const ps1 = (home, name) => readFileSync(paths(home, name).wrapperPs1, 'utf8');

describe('REQ-1101 — one wrapper pair per account', () => {
  test('red: four kinds → four wrapper pairs; only gateway and free mention the base URL; no wrapper exports a key variable', () => {
    const p = project();
    const r = p.run(['accounts', 'install']);
    assert.equal(r.status, 0, r.out);
    for (const n of Object.keys(ACCOUNTS)) {
      assert.ok(existsSync(paths(p.home, n).wrapperSh), `${n} sh`);
      assert.ok(existsSync(paths(p.home, n).wrapperPs1), `${n} ps1`);
      if (POSIX) assert.equal((readFileSync(paths(p.home, n).wrapperSh).length > 0) && ((await_mode(paths(p.home, n).wrapperSh)) & 0o111) !== 0, true, `${n} executable`);
      for (const text of [sh(p.home, n), ps1(p.home, n)]) {
        assert.ok(!/export ANTHROPIC_AUTH_TOKEN|export ANTHROPIC_API_KEY|\$env:ANTHROPIC_AUTH_TOKEN\s*=|\$env:ANTHROPIC_API_KEY\s*=/.test(text), `${n} exports a key variable`);
        assert.ok(text.includes(wrappers.KIT_MARKER), `${n} carries the kit marker`);
      }
    }
    const settingsOf = (n) => JSON.parse(readFileSync(paths(p.home, n).settingsFile, 'utf8'));
    // base URL: in the composed settings of gateway and free accounts only, never in a subscription or api-key one
    assert.equal(settingsOf('gw').env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:20128');
    assert.equal(settingsOf('free').env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:20128');
    assert.equal(settingsOf('sub').env && settingsOf('sub').env.ANTHROPIC_BASE_URL, undefined);
    assert.equal(settingsOf('apikey').env && settingsOf('apikey').env.ANTHROPIC_BASE_URL, undefined);
    for (const n of ['sub', 'apikey']) assert.ok(!sh(p.home, n).includes('127.0.0.1') && !ps1(p.home, n).includes('127.0.0.1'), `${n} wrapper names a base URL`);
    // the token path: apiKeyHelper for gateway and api-key accounts, never for a subscription account
    assert.match(settingsOf('gw').apiKeyHelper, /account-key\.cjs.* read gw$/);
    assert.match(settingsOf('apikey').apiKeyHelper, /account-key\.cjs.* read apikey$/);
    assert.equal(settingsOf('sub').apiKeyHelper, undefined);
    // model aliases through ANTHROPIC_DEFAULT_*_MODEL on the gateway account
    for (const k of ['ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL']) assert.ok(settingsOf('gw').env[k], k);
    // the codex gateway account: config.toml with a model_providers entry whose env_key is the budget-capped key variable
    const toml = readFileSync(paths(p.home, 'cx').codexConfigFile, 'utf8');
    assert.match(toml, /\[model_providers\.gateway\]/);
    assert.match(toml, /env_key\s*=\s*"BUILDER_GATEWAY_KEY"/);
    assert.match(toml, /base_url\s*=\s*"http:\/\/127\.0\.0\.1:20128\/v1"/);
    assert.ok(sh(p.home, 'cx').includes('CODEX_HOME='), 'the codex wrapper sets CODEX_HOME');
    // the denylist is unset in every wrapper and the account dir is set
    for (const n of ['sub', 'gw', 'free', 'apikey']) {
      assert.match(sh(p.home, n), /ANTHROPIC_\*\|CLAUDE\*\|OPENAI_\*\|CODEX_\*\|GEMINI_\*/);
      assert.match(sh(p.home, n), new RegExp(`CLAUDE_CONFIG_DIR=.*${n}`));
    }
    assert.match(r.stdout, /mcpServers|registration/i, 'the free-model MCP registration is printed');
  });
  test('the ps1 wrapper mirrors the sh one: denylist removed, account dir set, no key exported', () => {
    const p = project({ gw: ACCOUNTS.gw });
    assert.equal(p.run(['accounts', 'install']).status, 0);
    const t = ps1(p.home, 'gw');
    assert.match(t, /Remove-Item .*Env:/);
    assert.match(t, /\$env:CLAUDE_CONFIG_DIR\s*=/);
    assert.ok(!/\$env:ANTHROPIC_AUTH_TOKEN|\$env:ANTHROPIC_API_KEY/.test(t));
  });
});

const await_mode = (f) => require('node:fs').statSync(f).mode;

describe('REQ-1102 — accounts.lock.json and backups', () => {
  test('red: every written file is in the lock with its sha; a changed wrapper is backed up before an overwrite; a foreign file is kept', () => {
    const p = project({ gw: ACCOUNTS.gw });
    assert.equal(p.run(['accounts', 'install']).status, 0);
    const l = lock.read(p.home);
    const rel = (f) => f.slice(p.home.length + 1).split('\\').join('/');
    for (const f of [paths(p.home, 'gw').wrapperSh, paths(p.home, 'gw').wrapperPs1, paths(p.home, 'gw').settingsFile, paths(p.home, 'gw').srtSettingsFile]) assert.ok(l.files[rel(f)] && /^[0-9a-f]{64}$/.test(l.files[rel(f)].sha256), `${rel(f)} in the lock`);
    // a second run changes nothing
    const again = p.run(['accounts', 'install']);
    assert.match(again.stdout, /unchanged/);
    assert.equal(readdirSync(join(p.home)).filter((f) => f === 'backups').length, 0, 'no backup when nothing changed');
    // the wrapper changed since the kit wrote it (a local edit): the next write backs it up first
    writeFileSync(paths(p.home, 'gw').wrapperSh, sh(p.home, 'gw') + '\n# a local edit\n');
    writeFileSync(join(p.home, 'gateway', 'policy.json'), POLICY.replace('"monthlyLimitUsd": 100', '"monthlyLimitUsd": 50'));
    const r = p.run(['accounts', 'install', '--force']);
    assert.equal(r.status, 0, r.out);
    const backups = readdirSync(join(p.home, 'backups'), { recursive: true }).filter((f) => String(f).includes('gw'));
    assert.ok(backups.length >= 1, 'a backup of the edited wrapper exists');
    assert.ok(!sh(p.home, 'gw').includes('# a local edit'));
    // without --force a locally edited kit file is kept and named
    writeFileSync(paths(p.home, 'gw').wrapperSh, sh(p.home, 'gw') + '\n# another edit\n');
    const kept = p.run(['accounts', 'install']);
    assert.match(kept.stdout, /kept \(local edit\)/);
    assert.ok(sh(p.home, 'gw').includes('# another edit'));
    // nothing armed in a live tool config: no file outside the accounts home was written
    assert.equal(existsSync(join(p.proj, 'fake-home', '.claude')), false);
    assert.equal(existsSync(join(p.proj, '.claude')), false);
    assert.equal(existsSync(join(p.proj, 'builder.lock.json')), false, 'the project lock is not the accounts lock (D38)');
  });
});

describe('REQ-1103 — the refusal wrapper', () => {
  test('red: a policy that closes the free lane writes a wrapper that only explains why, with the exact marker line', () => {
    const closed = POLICY.replace('"freeAllowed": true', '"freeAllowed": false');
    const p = project({ free: ACCOUNTS.free, gw: ACCOUNTS.gw }, { policy: closed });
    assert.equal(p.run(['accounts', 'install']).status, 0);
    const t = sh(p.home, 'free');
    assert.match(t, /^# builder-pipeline: closed$/m);
    assert.match(ps1(p.home, 'free'), /^# builder-pipeline: closed$/m);
    assert.match(t, /freeAllowed/);
    assert.ok(!/claude |CLAUDE_CONFIG_DIR=/.test(t), 'a refusal wrapper launches nothing');
    if (POSIX) {
      const r = spawnSync('sh', [paths(p.home, 'free').wrapperSh], { encoding: 'utf8' });
      assert.equal(r.status, 1);
      assert.match(r.stderr, /closed/);
    }
    // the gateway account resolved its combo at write time
    assert.match(readFileSync(paths(p.home, 'gw').settingsFile, 'utf8'), /claude-haiku-5-5|anthropic\//);
  });
  test('red: an unreadable policy leaves a working wrapper alone', () => {
    const p = project({ free: ACCOUNTS.free });
    assert.equal(p.run(['accounts', 'install']).status, 0);
    const before = sh(p.home, 'free');
    assert.ok(!before.includes('builder-pipeline: closed'));
    writeFileSync(join(p.home, 'gateway', 'policy.json'), '{ not json');
    const r = p.run(['accounts', 'install']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /policy.*unreadable|unreadable.*policy/i);
    assert.equal(sh(p.home, 'free'), before);
  });
});

describe('REQ-1106 — the Antigravity wrapper', () => {
  test('red: SSH_* is dropped only while a session bus is reachable', () => {
    const withBus = wrappers.antigravityWrapperSh({ name: 'agy', busReachable: true });
    const noBus = wrappers.antigravityWrapperSh({ name: 'agy', busReachable: false });
    assert.match(withBus, /unset SSH_CONNECTION SSH_CLIENT SSH_TTY/);
    assert.ok(!/unset SSH_/.test(noBus));
    assert.match(noBus, /exec agy/);
  });
});

describe('REQ-1109 — srt-settings.json per Claude Code account', () => {
  test('red: three accounts: each file denies the two other account dirs and the user\'s ~/.claude and ~/.codex; allowWrite is the lane worktree', () => {
    const p = project({ a1: ACCOUNTS.sub, a2: ACCOUNTS.apikey, a3: ACCOUNTS.gw, cx: ACCOUNTS.cx });
    assert.equal(p.run(['accounts', 'install']).status, 0);
    for (const n of ['a1', 'a2', 'a3']) {
      const s = JSON.parse(readFileSync(paths(p.home, n).srtSettingsFile, 'utf8'));
      const others = ['a1', 'a2', 'a3'].filter((o) => o !== n).map((o) => paths(p.home, o).dir);
      for (const o of others) assert.ok(s.denyRead.includes(o), `${n} denies ${o}`);
      assert.ok(!s.denyRead.includes(paths(p.home, n).dir), `${n} does not deny itself`);
      assert.ok(s.denyRead.some((d) => d.endsWith('.claude')) && s.denyRead.some((d) => d.endsWith('.codex')));
      assert.ok(Array.isArray(s.allowWrite) && s.allowWrite.length === 1);
      assert.equal(s.credentials.mask[0].file, paths(p.home, n).keyFile);
      assert.ok(s.credentials.inject[0].hosts.every((h) => /^https:\/\//.test(h) || /127\.0\.0\.1/.test(h)));
    }
    assert.equal(existsSync(paths(p.home, 'cx').srtSettingsFile), false, 'a codex account gets no srt file');
    assert.match(sh(p.home, 'a1'), /srt-settings\.json/);
    assert.deepEqual(wrappers.srtFaults({ denyRead: [], allowWrite: [], credentials: { mask: [], inject: [] }, bogus: 1 }), ['unknown key: bogus']);
  });
  test('red: an srt-settings.json with an unknown key makes the wrapper refuse the launch naming the file', () => {
    const p = project({ a1: ACCOUNTS.sub });
    assert.equal(p.run(['accounts', 'install']).status, 0);
    const f = paths(p.home, 'a1').srtSettingsFile;
    writeFileSync(f, JSON.stringify({ denyRead: [], allowWrite: [], credentials: { mask: [], inject: [] }, surprise: true }));
    // the check script itself, on every platform; the sh wrapper's refusal where sh exists
    const c = spawnSync(process.execPath, [join(PACK, 'scripts', 'lib', 'srt-check.cjs'), f], { encoding: 'utf8' });
    assert.equal(c.status, 1);
    assert.ok(c.stderr.includes(f) && /surprise/.test(c.stderr), c.stderr);
    if (POSIX) {
      const r = spawnSync('/bin/sh', [paths(p.home, 'a1').wrapperSh, '--version'], { encoding: 'utf8', env: { ...p.env, PATH: '/nonexistent' } });
      assert.notEqual(r.status, 0);
      assert.ok(r.stderr.includes(f), r.stderr);
      assert.match(r.stderr, /surprise/);
    }
  });
});

describe('REQ-1108 — verify shows policy drift as an advisory row', () => {
  test('red: a policy that differs from the applied marker names the drifted keys and the apply command, and writes nothing', () => {
    const p = project({ gw: ACCOUNTS.gw });
    writeFileSync(join(p.home, 'gateway', 'policy.applied.json'), JSON.stringify({ sha256: 'x', gatewayVersion: '3.8.52', at: '2026-11-17T00:00:00Z', policy: JSON.parse(POLICY.replace('"monthlyLimitUsd": 100', '"monthlyLimitUsd": 50')) }));
    const before = readdirSync(p.home, { recursive: true }).join('\n');
    const r = p.run(['verify']);
    assert.match(r.stdout, /ADVISORY\s+gateway policy drift: budget\.monthlyLimitUsd .*accounts policy apply/);
    assert.equal(readdirSync(p.home, { recursive: true }).join('\n'), before, 'verify writes nothing');
  });
});
