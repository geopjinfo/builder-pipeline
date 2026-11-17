/**
 * `npx builder accounts add | note | key | key --remove | remove | list` (REQ-1001 to REQ-1006, REQ-108; D2, D9, D19,
 * D20), every subcommand through cli.js in a temp project with BUILDER_ACCOUNTS_HOME inside the temp dir and a stub
 * `codex` on PATH.
 *
 * WHY. The accounts command is the only way an account and its key enter the kit. Each refusal must carry its code,
 * the profile must change inside the settings block only, the key must never show in any output, and nothing under
 * the accounts home may reach the project's lock or an upgrade backup. Fake keys are built at runtime.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const PACK = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { paths } = require(join(PACK, 'scripts/lib/account-paths.cjs'));
const lease = require(join(PACK, 'scripts/lib/account-lease.cjs'));
const profile = require(join(PACK, 'scripts/lib/profile.cjs'));
const POSIX = process.platform !== 'win32';
const made = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

const fakeKey = (tag = 'alpha') => ['sk', 'ant', 'api03'].join('-') + '-' + `${tag}0`.repeat(8);
const mode = (f) => (statSync(f).mode & 0o777).toString(8);
const assertNoValue = (text, value) => {
  for (let i = 0; i + 8 <= value.length; i += 4) assert.equal(text.includes(value.slice(i, i + 8)), false, `a slice of the key leaked: ${text.slice(0, 300)}`);
};

const HEAD = '# Profile\n\nProse that must stay, byte for byte.\n\n## 16. Settings\n\n';
const TAIL = '\n\nTrailing prose with a `code span` and  two spaces.\n';
const BASE = {
  schema: 2,
  commands: { tier: null, tiers: [], affected: null, typecheck: null },
  models: { strong: 'strong-model', mid: 'mid-model', orchestrator: null },
  features: { accounts: { state: 'off', softLimitPct: 80, usageStaleMinutes: 30, accounts: {} } },
};
const text = (block) => `${HEAD}\`\`\`json pipeline-settings\n${JSON.stringify(block, null, 2)}\n\`\`\`${TAIL}`;

/** A temp project: PIPELINE_PROFILE.md, an accounts home inside it, and a stub codex first on PATH. */
function project(block = BASE) {
  const proj = mkdtempSync(join(tmpdir(), 'kit-accounts-cli-'));
  made.push(proj);
  writeFileSync(join(proj, 'PIPELINE_PROFILE.md'), text(block));
  const home = join(proj, '.accounts-home');
  const bin = join(proj, 'stub-bin');
  mkdirSync(bin, { recursive: true });
  const stub = join(PACK, 'tests', 'fixtures', 'accounts', 'codex-stub.cjs');
  writeFileSync(join(bin, 'codex'), `#!/bin/sh\nexec "${process.execPath}" "${stub}" "$@"\n`, { mode: 0o755 });
  const env = { ...process.env, BUILDER_NO_BASH_CAP: '1', BUILDER_ACCOUNTS_HOME: home, BUILDER_ORCH_DIR: join(proj, '.pipeline', 'orchestrator'), PATH: `${bin}:${process.env.PATH}` };
  const run = (args, opts = {}) => {
    const r = spawnSync(process.execPath, [join(PACK, 'cli.js'), 'accounts', ...args], { cwd: proj, encoding: 'utf8', env: { ...env, ...(opts.env || {}) }, input: opts.input });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const settings = () => profile.parse(readFileSync(join(proj, 'PIPELINE_PROFILE.md'), 'utf8'));
  const accounts = () => settings().settings.features.accounts;
  return { proj, home, run, settings, accounts, profileText: () => readFileSync(join(proj, 'PIPELINE_PROFILE.md'), 'utf8') };
}

describe('accounts add and note (REQ-1001)', () => {
  test('red: REQ-1001 a valid new name lands in §16 (feature on), its dir exists 0700, and the bytes around the block stay', () => {
    const p = project();
    const r = p.run(['add', 'alpha', '--worker', 'claude-code', '--pays', 'api-key', '--content', 'public', '--roles', 'module-tester,module-reviewer', '--family', 'anthropic', '--note', 'the api account', '--budget-hard', '15', '--budget-kind', 'usd']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /accounts add: "alpha" written to PIPELINE_PROFILE\.md §16/);
    const s = p.settings();
    assert.deepEqual(s.errors, []);
    const a = s.settings.features.accounts;
    assert.equal(a.state, 'on');
    assert.equal(a.softLimitPct, 80, 'the other feature keys stay');
    assert.deepEqual(a.accounts.alpha, { worker: 'claude-code', pays: 'api-key', content: 'public', roles: ['module-tester', 'module-reviewer'], family: 'anthropic', note: 'the api account', budget: { kind: 'usd', soft: null, hard: 15 } });
    assert.ok(p.profileText().startsWith(HEAD + '```json pipeline-settings\n'));
    assert.ok(p.profileText().endsWith('```' + TAIL));
    assert.equal(existsSync(`${join(p.proj, 'PIPELINE_PROFILE.md')}.bak`), false, 'add writes no backup: the change is one entry');
    const at = paths(p.home, 'alpha');
    assert.ok(existsSync(at.dir));
    if (POSIX) assert.equal(mode(at.dir), '700');
    assert.deepEqual(readdirSync(join(p.proj)).filter((f) => f.endsWith('.tmp')), [], 'no temp file left');
    // A second account with the defaults, a path-root content list and its own config dir.
    const r2 = p.run(['add', 'bravo', '--worker', 'codex', '--pays', 'subscription', '--content', 'src/,docs/', '--config-dir', 'homes/bravo', '--command', 'codex --brief {brief}']);
    assert.equal(r2.status, 0, r2.out);
    assert.deepEqual(p.accounts().accounts.bravo.content, ['src/', 'docs/']);
    assert.equal(p.accounts().accounts.bravo.configDir, 'homes/bravo');
    assert.ok(existsSync(paths(p.home, 'bravo', { configDir: 'homes/bravo' }).configDir));
    assert.deepEqual(Object.keys(p.accounts().accounts), ['alpha', 'bravo']);
  });

  test('red: REQ-1001 the refusal codes: E_ACCOUNT_EXISTS, E_ACCOUNT_NAME (reserved and outside the rule), E_PAYS_TWICE, E_BASEURL_SUB; nothing written', () => {
    const p = project();
    assert.equal(p.run(['add', 'alpha', '--worker', 'claude-code', '--pays', 'api-key']).status, 0);
    const before = p.profileText();
    const cases = [
      [['add', 'alpha', '--worker', 'codex', '--pays', 'subscription'], 'E_ACCOUNT_EXISTS'],
      [['add', 'list', '--worker', 'codex', '--pays', 'subscription'], 'E_ACCOUNT_NAME'],
      [['add', 'Bravo-1', '--worker', 'codex', '--pays', 'subscription'], 'E_ACCOUNT_NAME'],
      [['add', 'bravo', '--worker', 'codex', '--pays', 'api-key,subscription'], 'E_PAYS_TWICE'],
      [['add', 'bravo', '--worker', 'codex', '--pays', 'api-key', '--pays', 'subscription'], 'E_PAYS_TWICE'],
      [['add', 'bravo', '--worker', 'codex', '--pays', 'subscription', '--base-url', 'https://gateway.example.com'], 'E_BASEURL_SUB'],
    ];
    for (const [args, code] of cases) {
      const r = p.run(args);
      assert.equal(r.status, 1, args.join(' '));
      assert.match(r.stderr, new RegExp(`\\b${code}\\b`), args.join(' '));
      assert.equal(r.stdout, '', 'a refusal prints nothing on stdout');
    }
    assert.equal(p.profileText(), before, 'no refusal touched the profile');
    assert.equal(existsSync(paths(p.home, 'bravo').dir), false);
    // The closed sets are named on a bad value; a missing required flag and an unknown option are refused too.
    assert.match(p.run(['add', 'bravo', '--worker', 'codex', '--pays', 'subscription', '--roles', 'wizard']).stderr, /unknown role "wizard"/);
    assert.match(p.run(['add', 'bravo', '--worker', 'nope', '--pays', 'subscription']).stderr, /one of claude-code \| codex \| session/);
    assert.match(p.run(['add', 'bravo', '--worker', 'codex']).stderr, /--pays/);
    assert.match(p.run(['add', 'bravo', '--worker', 'codex', '--pays', 'free', '--colour', 'red']).stderr, /unknown option/);
  });

  test('red: REQ-1001 note replaces the note; an unknown account is E_ACCOUNT_UNKNOWN', () => {
    const p = project();
    p.run(['add', 'alpha', '--worker', 'claude-code', '--pays', 'api-key', '--note', 'first']);
    const r = p.run(['note', 'alpha', 'second', 'thought']);
    assert.equal(r.status, 0, r.out);
    assert.equal(p.accounts().accounts.alpha.note, 'second thought');
    const u = p.run(['note', 'zulu', 'x']);
    assert.equal(u.status, 1);
    assert.match(u.stderr, /E_ACCOUNT_UNKNOWN/);
    assert.match(p.run(['note', 'alpha']).stderr, /text/);
  });
});

describe('accounts key (REQ-1002, REQ-1003, REQ-1004)', () => {
  test('red: REQ-1002 a piped fake key lands in the key file at 0600; apiKeyHelper points at the kit helper; no slice of the value shows; the profile is unchanged', () => {
    const p = project();
    p.run(['add', 'alpha', '--worker', 'claude-code', '--pays', 'api-key']);
    const before = p.profileText();
    const value = fakeKey();
    const r = p.run(['key', 'alpha'], { input: value + '\n' });
    assert.equal(r.status, 0, r.out);
    assert.match(r.stderr, /echo may be visible/);
    assert.match(r.stdout, /accounts key: "alpha" key stored \(mode 0600\); apiKeyHelper set/);
    assertNoValue(r.out, value);
    const at = paths(p.home, 'alpha');
    assert.equal(readFileSync(at.keyFile, 'utf8'), value);
    if (POSIX) assert.equal(mode(at.keyFile), '600');
    const settings = JSON.parse(readFileSync(at.settingsFile, 'utf8'));
    assert.match(settings.apiKeyHelper, /^node .*account-key\.cjs read alpha$/);
    assertNoValue(JSON.stringify(settings), value);
    assert.equal(p.profileText(), before, 'the profile never changes on key');
    assert.deepEqual(readdirSync(p.proj).sort(), ['.accounts-home', 'PIPELINE_PROFILE.md', 'stub-bin'], 'no lock, no git, no other file in the project');
    // The helper the harness calls returns exactly the value, and nothing else.
    const helper = spawnSync(process.execPath, [join(PACK, 'scripts', 'account-key.cjs'), 'read', 'alpha'], { encoding: 'utf8', env: { ...process.env, BUILDER_ACCOUNTS_HOME: p.home } });
    assert.equal(helper.stdout, value);
    // Rotation: a second key replaces the first, still 0600.
    const next = fakeKey('bravo');
    const r2 = p.run(['key', 'alpha'], { input: next });
    assert.equal(r2.status, 0, r2.out);
    assert.equal(readFileSync(at.keyFile, 'utf8'), next);
    if (POSIX) assert.equal(mode(at.keyFile), '600');
    assertNoValue(r2.out, next);
  });

  test('red: REQ-1002 a planted symlink at the key path fails with EEXIST and writes nothing through it; no argv or env form exists', () => {
    const p = project();
    p.run(['add', 'alpha', '--worker', 'claude-code', '--pays', 'api-key']);
    const at = paths(p.home, 'alpha');
    const victim = join(p.proj, 'victim');
    writeFileSync(victim, 'untouched\n');
    symlinkSync(victim, at.keyFile);
    const value = fakeKey('charlie');
    const r = p.run(['key', 'alpha'], { input: value });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /EEXIST/);
    assert.equal(readFileSync(victim, 'utf8'), 'untouched\n');
    assertNoValue(r.out, value);
    assert.equal(existsSync(at.settingsFile), false, 'the helper setting is written only after the key');
    rmSync(at.keyFile);
    const argvForm = p.run(['key', 'alpha', value], { input: '' });
    assert.equal(argvForm.status, 1);
    assert.match(argvForm.stderr, /never on the command line/);
    assertNoValue(argvForm.out, value);
    assert.equal(existsSync(at.keyFile), false);
    const envForm = p.run(['key', 'alpha', '--env', 'MY_KEY'], { input: '' });
    assert.equal(envForm.status, 1);
    assert.equal(existsSync(at.keyFile), false);
    // An empty entry, a non-printable entry, an account that cannot take a key.
    assert.match(p.run(['key', 'alpha'], { input: '' }).stderr, /E_KEY_EMPTY/);
    assert.match(p.run(['key', 'alpha'], { input: 'ab\tcd' }).stderr, /E_KEY_CHARS/);
    assert.match(p.run(['key', 'zulu'], { input: value }).stderr, /E_ACCOUNT_UNKNOWN/);
    p.run(['add', 'bravo', '--worker', 'codex', '--pays', 'subscription']);
    assert.match(p.run(['key', 'bravo'], { input: value }).stderr, /E_KEY_PAYS/);
    p.run(['add', 'self', '--worker', 'session', '--pays', 'subscription']);
    assert.match(p.run(['key', 'self'], { input: value }).stderr, /E_KEY_WORKER/);
  });

  test('red: REQ-1003 a Codex account: store forced to file, the stub gets the value on stdin under CODEX_HOME, the auth mode is reported, the kit holds no copy; key --remove runs codex logout', { skip: !POSIX && 'sh stub' }, () => {
    const p = project();
    p.run(['add', 'bravo', '--worker', 'codex', '--pays', 'api-key', '--family', 'openai']);
    const at = paths(p.home, 'bravo');
    const value = fakeKey('delta');
    const r = p.run(['key', 'bravo'], { input: value + '\n' });
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /codex login --with-api-key.*auth\.json mode 0600/);
    assertNoValue(r.out, value);
    assert.match(readFileSync(at.codexConfigFile, 'utf8'), /^cli_auth_credentials_store = "file"$/m);
    const calls = JSON.parse(readFileSync(join(at.configDir, 'stub-calls.json'), 'utf8'));
    assert.deepEqual(calls[0].argv, ['login', '--with-api-key']);
    assert.ok(calls[0].envNames.includes('CODEX_HOME'));
    assert.equal(calls[0].envNames.includes('BUILDER_ACCOUNTS_HOME'), false, 'the env is the allowlist only');
    assert.equal(existsSync(at.keyFile), false, 'the kit wrote no key file for a Codex account');
    const holders = [];
    const walk = (d) => { for (const n of readdirSync(d, { withFileTypes: true })) { const f = join(d, n.name); if (n.isDirectory()) walk(f); else if (readFileSync(f, 'utf8').includes(value)) holders.push(relative(p.proj, f)); } };
    walk(p.proj);
    assert.deepEqual(holders, [relative(p.proj, at.codexAuthFile)], 'only the harness store holds the value');
    const rm = p.run(['key', 'bravo', '--remove']);
    assert.equal(rm.status, 0, rm.out);
    assert.match(rm.stdout, /codex logout/);
    assert.equal(existsSync(at.codexAuthFile), false);
    assert.deepEqual(JSON.parse(readFileSync(join(at.configDir, 'stub-calls.json'), 'utf8'))[1].argv, ['logout']);
  });

  test('red: REQ-1004 key --remove deletes the key file and the helper setting only; remove deletes wrapper, key and the §16 entry and keeps the profile folder', () => {
    const p = project();
    p.run(['add', 'alpha', '--worker', 'claude-code', '--pays', 'api-key']);
    p.run(['add', 'bravo', '--worker', 'codex', '--pays', 'subscription']);
    const at = paths(p.home, 'alpha');
    assert.equal(p.run(['key', 'alpha'], { input: fakeKey('echo') }).status, 0);
    // Other settings keys stay through the helper's removal.
    const s = JSON.parse(readFileSync(at.settingsFile, 'utf8'));
    s.env = { KEEP: '1' };
    writeFileSync(at.settingsFile, JSON.stringify(s));
    writeFileSync(at.smokeFile, '{}');
    const rm = p.run(['key', 'alpha', '--remove']);
    assert.equal(rm.status, 0, rm.out);
    assert.equal(existsSync(at.keyFile), false);
    assert.deepEqual(JSON.parse(readFileSync(at.settingsFile, 'utf8')), { env: { KEEP: '1' } });
    assert.ok(existsSync(at.smokeFile), 'nothing else under the account dir is touched');
    assert.deepEqual(Object.keys(p.accounts().accounts), ['alpha', 'bravo'], 'key --remove leaves §16 alone');
    assert.equal(p.run(['key', 'alpha', '--remove']).status, 0, 'a second --remove is a no-op, not an error');
    // remove: the wrappers, the key and the §16 entry go; the folder (and its settings) stay.
    assert.equal(p.run(['key', 'alpha'], { input: fakeKey('foxtrot') }).status, 0);
    mkdirSync(dirname(at.wrapperSh), { recursive: true });
    writeFileSync(at.wrapperSh, '#!/bin/sh\n');
    writeFileSync(at.wrapperPs1, '# wrapper\n');
    const before = p.profileText();
    const r = p.run(['remove', 'alpha']);
    assert.equal(r.status, 0, r.out);
    assert.equal(existsSync(at.wrapperSh), false);
    assert.equal(existsSync(at.wrapperPs1), false);
    assert.equal(existsSync(at.keyFile), false);
    assert.ok(existsSync(at.dir), 'the profile folder stays');
    assert.ok(existsSync(at.settingsFile));
    assert.deepEqual(Object.keys(p.accounts().accounts), ['bravo']);
    assert.deepEqual(p.settings().errors, []);
    assert.notEqual(p.profileText(), before);
    assert.ok(p.profileText().startsWith(HEAD) && p.profileText().endsWith(TAIL));
    assert.match(p.run(['remove', 'alpha']).stderr, /E_ACCOUNT_UNKNOWN/);
  });
});

describe('leases (REQ-108)', () => {
  test('red: REQ-108 remove and migrate refuse under a live lease and name the pid', () => {
    // Legacy seat keys, so migrate has something to rewrite (the orchestrator is off: a warning, not a refusal).
    const p = project({ ...BASE, features: { ...BASE.features, orchestrator: { state: 'off', seats: ['primary'], limits: { primary: 50 } } } });
    p.run(['add', 'alpha', '--worker', 'claude-code', '--pays', 'api-key']);
    lease.acquire(p.home, 'alpha', { pid: process.pid, lane: 'L7' });
    const r = p.run(['remove', 'alpha']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /E_LEASE_HELD/);
    assert.match(r.stderr, new RegExp(`pid ${process.pid}`));
    assert.deepEqual(Object.keys(p.accounts().accounts), ['alpha']);
    const m = p.run(['migrate']);
    assert.equal(m.status, 1);
    assert.match(m.stderr, new RegExp(`E_LEASE_HELD.*pid ${process.pid}`));
    lease.release(p.home, 'alpha');
    assert.equal(p.run(['remove', 'alpha']).status, 0);
  });

  test('red: REQ-108 a lease whose pid is gone is reported as stale and the command proceeds', () => {
    const p = project();
    p.run(['add', 'alpha', '--worker', 'claude-code', '--pays', 'api-key']);
    const gone = spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid;
    writeFileSync(paths(p.home, 'alpha').leaseFile, JSON.stringify({ pid: gone, startedAt: 'x', lane: 'L8' }));
    const r = p.run(['remove', 'alpha']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /stale lease/);
    assert.match(r.stdout, new RegExp(`pid ${gone}`));
    assert.deepEqual(Object.keys(p.accounts().accounts), []);
    assert.equal(existsSync(paths(p.home, 'alpha').leaseFile), false, 'the stale lease is cleared');
  });
});

describe('accounts list (REQ-1005)', () => {
  test('red: REQ-1005 one line per account: worker, pays, content, roles, key present/absent (never the value), lease state and key mode; 0644 reads not ready', () => {
    const p = project();
    assert.match(p.run(['list']).stdout, /^features\.accounts: not configured/m, 'off and empty: not configured, never a pass');
    p.run(['add', 'alpha', '--worker', 'claude-code', '--pays', 'api-key', '--roles', 'module-tester']);
    p.run(['add', 'bravo', '--worker', 'codex', '--pays', 'subscription', '--content', 'public']);
    const value = fakeKey('golf');
    p.run(['key', 'alpha'], { input: value });
    lease.acquire(p.home, 'bravo', { pid: process.pid, lane: 'L9' });
    const r = p.run(['list']);
    assert.equal(r.status, 0, r.out);
    assertNoValue(r.out, value);
    const lines = r.stdout.trim().split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^alpha\s+claude-code\s+api-key\s+any\s+module-tester\s+key present \(mode 0600\)\s+lease none\s+ready$/);
    assert.match(lines[1], /^bravo\s+codex\s+subscription\s+public\s+all\s+key absent\s+lease live \(pid \d+, lane L9\)\s+/);
    const j = p.run(['list', '--json']);
    const rows = JSON.parse(j.stdout);
    assert.equal(rows.length, 2);
    assert.deepEqual(Object.keys(rows[0]).sort(), ['content', 'key', 'lease', 'name', 'pays', 'ready', 'roles', 'worker']);
    assert.equal(rows[0].key.present, true);
    assert.equal(rows[0].key.mode, POSIX ? '0600' : null);
    assert.equal(rows[0].ready, true);
    assert.equal(rows[1].lease.state, 'live');
    assert.equal(rows[1].lease.pid, process.pid);
    assert.equal(rows[1].key.present, false);
    assertNoValue(j.stdout, value);
    if (POSIX) {
      chmodSync(paths(p.home, 'alpha').keyFile, 0o644);
      const bad = p.run(['list']);
      assert.match(bad.stdout, /^alpha\s.*not ready \(key file mode 0644\)$/m);
      assert.equal(JSON.parse(p.run(['list', '--json']).stdout)[0].ready, false);
    }
  });
});

describe('the key file is never in a lock or an upgrade backup (REQ-1004)', () => {
  test('red: REQ-1004 after unpack and upgrade with BUILDER_ACCOUNTS_HOME inside the project, no lock and no backup lists a file under the accounts home', () => {
    const proj = mkdtempSync(join(tmpdir(), 'kit-accounts-lock-'));
    made.push(proj);
    const kit = join(proj, 'node_modules', '@geopjinfo', 'builder-pipeline');
    mkdirSync(kit, { recursive: true });
    cpSync(PACK, kit, { recursive: true, filter: (src) => !/[\\/](?:\.git|tests|node_modules)(?:[\\/]|$)/.test(`/${relative(PACK, src)}`) });
    const home = join(proj, '.accounts-home');
    const env = { ...process.env, BUILDER_NO_BASH_CAP: '1', BUILDER_ACCOUNTS_HOME: home };
    const cli = (args, input) => spawnSync(process.execPath, [join(kit, 'cli.js'), ...args], { cwd: proj, encoding: 'utf8', env, input });
    assert.equal(cli(['unpack', '--tool', 'claude-code']).status, 0);
    assert.equal(cli(['accounts', 'add', 'alpha', '--worker', 'claude-code', '--pays', 'api-key']).status, 0);
    const value = fakeKey('hotel');
    assert.equal(cli(['accounts', 'key', 'alpha'], value).status, 0);
    const keyFile = paths(home, 'alpha').keyFile;
    assert.ok(existsSync(keyFile));
    // A local edit to a kit-owned file, so --force has something to back up.
    writeFileSync(join(proj, '.claude', 'agents', 'module-builder.md'), readFileSync(join(proj, '.claude', 'agents', 'module-builder.md'), 'utf8') + '\nlocal edit\n');
    const up = cli(['upgrade', '--tool', 'claude-code', '--force']);
    assert.equal(up.status, 0, `${up.stdout}${up.stderr}`);
    const lock = readFileSync(join(proj, 'builder.lock.json'), 'utf8');
    assert.equal(lock.includes('.accounts-home'), false, 'builder.lock.json lists nothing under the accounts home');
    assert.equal(lock.includes('accounts/alpha'), false);
    assertNoValue(lock, value);
    const backups = join(proj, '.builder');
    const listed = [];
    const walk = (d) => { if (!existsSync(d)) return; for (const n of readdirSync(d, { withFileTypes: true })) { const f = join(d, n.name); if (n.isDirectory()) walk(f); else listed.push(relative(proj, f)); } };
    walk(backups);
    assert.ok(listed.length > 0, 'an upgrade --force backed something up');
    assert.deepEqual(listed.filter((f) => f.includes('.accounts-home') || f.endsWith('/key')), [], 'no backup copies a file under the accounts home');
    for (const f of listed) assertNoValue(readFileSync(join(proj, f), 'utf8'), value);
    const accountsLock = join(home, 'accounts.lock.json');
    if (existsSync(accountsLock)) {
      const al = readFileSync(accountsLock, 'utf8');
      assert.equal(/accounts\/alpha\/key/.test(al), false);
      assertNoValue(al, value);
    }
    assert.equal(readFileSync(keyFile, 'utf8'), value, 'the key file itself is untouched by upgrade');
  });
});
