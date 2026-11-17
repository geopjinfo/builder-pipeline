/**
 * Key entry and storage — scripts/lib/account-secrets.cjs and scripts/account-key.cjs (REQ-1002, REQ-1003, REQ-1005,
 * REQ-1006; D2, D20, D42).
 *
 * WHY. The key is the one secret the kit touches. It must enter hidden, land in one file with the strictest flags,
 * never pass through a symlink, never show in a message, and be refused for reading when the file is wider than
 * 0600. Every fake value here is built at runtime by concatenation, never as a literal that matches a key shape.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const PACK = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const secrets = require(join(PACK, 'scripts/lib/account-secrets.cjs'));
const { paths } = require(join(PACK, 'scripts/lib/account-paths.cjs'));
const { PATTERNS } = require(join(PACK, 'scripts/lib/outbound-guard.cjs'));
const WIN = JSON.parse(readFileSync(join(PACK, 'tests/fixtures/accounts/windows-paths.json'), 'utf8'));
const POSIX = process.platform !== 'win32';
const made = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
const home = () => { const d = mkdtempSync(join(tmpdir(), 'kit-secrets-')); made.push(d); return d; };
/** A fake Anthropic-shaped key, assembled at runtime so no literal in this file matches a secret shape. */
const fakeKey = (tag = 'alpha') => ['sk', 'ant', 'api03'].join('-') + '-' + `${tag}0`.repeat(8);
const mode = (f) => (statSync(f).mode & 0o777).toString(8);
const assertNoValue = (text, value) => {
  for (let i = 0; i + 8 <= value.length; i += 4) assert.equal(text.includes(value.slice(i, i + 8)), false, `a slice of the key leaked: ${text.slice(0, 200)}`);
};

/** A fake TTY: isTTY, setRawMode recorded, data pushed by the test. */
function fakeTty() {
  const s = new EventEmitter();
  s.isTTY = true;
  s.raw = [];
  s.setRawMode = (on) => { s.raw.push(on); return s; };
  s.setEncoding = () => s;
  s.resume = () => s;
  s.pause = () => s;
  return s;
}
/**
 * Plant a symlink; false when this platform refuses (Windows without the privilege). The symlink assertions then do
 * not apply: nothing can plant a link there either.
 */
function trySymlink(target, link) {
  try { symlinkSync(target, link); return true; } catch (e) { if (process.platform === 'win32' && (e.code === 'EPERM' || e.code === 'ENOSYS')) return false; throw e; }
}
/** The fixture codex stub as a `codex` command in `bin`: a shebang file on POSIX, a `.js` + `.cmd` shim on Windows. */
function stubCodex(bin) {
  mkdirSync(bin, { recursive: true });
  const stub = join(PACK, 'tests', 'fixtures', 'accounts', 'codex-stub.cjs');
  if (process.platform === 'win32') {
    writeFileSync(join(bin, 'codex.js'), readFileSync(stub, 'utf8'));
    writeFileSync(join(bin, 'codex.cmd'), `@"${process.execPath}" "%~dp0codex.js" %*\r\n`);
    return join(bin, 'codex.cmd');
  }
  const codex = join(bin, 'codex');
  writeFileSync(codex, `#!/bin/sh\nexec "${process.execPath}" "${stub}" "$@"\n`, { mode: 0o755 });
  return codex;
}
const sink = () => { const w = { text: '' }; w.write = (t) => { w.text += t; return true; }; return w; };

describe('readSecret (REQ-1002)', () => {
  test('red: REQ-1002 on a TTY it switches to raw mode, echoes nothing, honours Backspace, ends on Enter and restores the terminal', async () => {
    const stdin = fakeTty();
    const stderr = sink();
    const p = secrets.readSecret({ stdin, stderr, prompt: 'key: ' });
    const value = fakeKey();
    stdin.emit('data', value.slice(0, 10));
    stdin.emit('data', 'ZZ\u007f\u007f');
    stdin.emit('data', value.slice(10) + '\r');
    const r = await p;
    assert.equal(r.value, value);
    assert.equal(r.tty, true);
    assert.deepEqual(stdin.raw, [true, false], 'raw mode on, then restored');
    assert.equal(stderr.text, 'key: \n', 'the prompt and a newline: no echo');
    assertNoValue(stderr.text, value);
  });

  test('red: REQ-1002 Ctrl-C restores the terminal and rejects with E_KEY_ABORT; a stream error restores it too', async () => {
    const stdin = fakeTty();
    const p = secrets.readSecret({ stdin, stderr: sink() });
    stdin.emit('data', 'abc\u0003');
    await assert.rejects(p, (e) => e.code === 'E_KEY_ABORT');
    assert.deepEqual(stdin.raw, [true, false]);
    const s2 = fakeTty();
    const p2 = secrets.readSecret({ stdin: s2, stderr: sink() });
    s2.emit('error', new Error('tty gone'));
    await assert.rejects(p2, /tty gone/);
    assert.deepEqual(s2.raw, [true, false]);
  });

  test('red: REQ-1002 off a TTY it reads to EOF and says echo may be visible', async () => {
    const stdin = new EventEmitter();
    stdin.isTTY = false;
    const stderr = sink();
    const p = secrets.readSecret({ stdin, stderr });
    const value = fakeKey('bravo');
    stdin.emit('data', value.slice(0, 5));
    stdin.emit('data', value.slice(5) + '\n');
    stdin.emit('end');
    const r = await p;
    assert.equal(r.value, value);
    assert.equal(r.tty, false);
    assert.match(stderr.text, /echo may be visible/);
  });

  test('red: REQ-1002 printable ASCII only; an empty entry is refused; the reason never quotes the value', async () => {
    for (const [bad, code] of [['', 'E_KEY_EMPTY'], ['abc\tdef', 'E_KEY_CHARS'], ['k\u00e9y', 'E_KEY_CHARS'], ['a\u001bb', 'E_KEY_CHARS']]) {
      const stdin = new EventEmitter();
      stdin.isTTY = false;
      const p = secrets.readSecret({ stdin, stderr: sink() });
      stdin.emit('data', bad);
      stdin.emit('end');
      await assert.rejects(p, (e) => { assert.equal(e.code, code); assert.equal(e.message.includes('abc'), false); return true; });
    }
    assert.equal(secrets.valueProblem(fakeKey()), null);
  });
});

describe('writeKeyFile and the helper (REQ-1002)', () => {
  test('red: REQ-1002 the key file is created 0600 in a 0700 dir with O_EXCL|O_NOFOLLOW; a rotation keeps 0600 and leaves no temp file', () => {
    const h = home();
    const p = paths(h, 'alpha');
    const value = fakeKey();
    const first = secrets.writeKeyFile(p.keyFile, value);
    assert.equal(first.rotated, false);
    assert.equal(readFileSync(p.keyFile, 'utf8'), value);
    if (POSIX) {
      assert.equal(mode(p.keyFile), '600');
      assert.equal(mode(p.dir), '700');
      assert.equal(first.mode, '0600');
    }
    assert.ok(secrets.KEY_FLAGS & (fsConstants().O_EXCL), 'O_EXCL in the flags');
    assert.ok(secrets.KEY_FLAGS & (fsConstants().O_NOFOLLOW || 0x20000), 'O_NOFOLLOW in the flags');
    const next = fakeKey('charlie');
    const second = secrets.writeKeyFile(p.keyFile, next);
    assert.equal(second.rotated, true);
    assert.equal(readFileSync(p.keyFile, 'utf8'), next);
    if (POSIX) assert.equal(mode(p.keyFile), '600');
    assert.deepEqual(readdirSync(p.dir), ['key'], 'no temp file left behind');
  });

  test('red: REQ-1002 a symlink planted at the key path fails with EEXIST and nothing is written through it', () => {
    const h = home();
    const p = paths(h, 'alpha');
    mkdirSync(p.dir, { recursive: true, mode: 0o700 });
    const target = join(h, 'victim');
    writeFileSync(target, 'untouched\n');
    if (!trySymlink(target, p.keyFile)) return; // no symlinks on this Windows: nothing can be planted
    assert.throws(() => secrets.writeKeyFile(p.keyFile, fakeKey()), (e) => e.code === 'EEXIST');
    assert.equal(readFileSync(target, 'utf8'), 'untouched\n');
    assert.ok(lstatSync(p.keyFile).isSymbolicLink(), 'the link itself is left for the owner to inspect');
    assert.deepEqual(readdirSync(p.dir), ['key']);
    // A symlink planted at the temp path of a rotation is refused the same way.
    rmSync(p.keyFile);
    secrets.writeKeyFile(p.keyFile, fakeKey());
    symlinkSync(target, `${p.keyFile}.${process.pid}.tmp`);
    assert.throws(() => secrets.writeKeyFile(p.keyFile, fakeKey('delta')), (e) => e.code === 'EEXIST');
    assert.equal(readFileSync(target, 'utf8'), 'untouched\n');
  });

  test('red: REQ-1002 editJson adds apiKeyHelper by temp + rename, keeps the other keys, and refuses a symlinked settings file', () => {
    const h = home();
    const p = paths(h, 'alpha');
    mkdirSync(p.configDir, { recursive: true });
    writeFileSync(p.settingsFile, JSON.stringify({ env: { KEEP: '1' } }));
    const helper = secrets.helperCommand(PACK, 'alpha');
    assert.match(helper, /^node .*account-key\.cjs read alpha$/);
    assert.ok(helper.includes(join(PACK, 'scripts', 'account-key.cjs').replace(/\\/g, '\\')), 'absolute path to the kit helper');
    secrets.editJson(p.settingsFile, (s) => { s.apiKeyHelper = helper; });
    const on = JSON.parse(readFileSync(p.settingsFile, 'utf8'));
    assert.deepEqual(on, { env: { KEEP: '1' }, apiKeyHelper: helper });
    if (POSIX) assert.equal(mode(p.settingsFile), '600');
    assert.deepEqual(readdirSync(p.configDir), ['settings.json']);
    secrets.editJson(p.settingsFile, (s) => { delete s.apiKeyHelper; });
    assert.deepEqual(JSON.parse(readFileSync(p.settingsFile, 'utf8')), { env: { KEEP: '1' } });
    rmSync(p.settingsFile);
    writeFileSync(join(h, 'victim.json'), '{}');
    if (!trySymlink(join(h, 'victim.json'), p.settingsFile)) return;
    assert.throws(() => secrets.editJson(p.settingsFile, (s) => { s.x = 1; }), (e) => e.code === 'EEXIST');
    assert.equal(readFileSync(join(h, 'victim.json'), 'utf8'), '{}');
  });
});

describe('scripts/account-key.cjs read (REQ-1002, REQ-1005)', () => {
  const helper = join(PACK, 'scripts', 'account-key.cjs');
  const read = (h, name) => spawnSync(process.execPath, [helper, 'read', name], { encoding: 'utf8', env: { ...process.env, BUILDER_ACCOUNTS_HOME: h } });

  test('red: REQ-1002 prints the key file to stdout only; refuses an absent key, a bad name and a bad usage without naming a value', () => {
    const h = home();
    const value = fakeKey('echo');
    secrets.writeKeyFile(paths(h, 'alpha').keyFile, value);
    const r = read(h, 'alpha');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, value);
    assert.equal(r.stderr, '');
    const none = read(h, 'bravo');
    assert.equal(none.status, 2);
    assert.match(none.stderr, /no key for account "bravo".*npx builder accounts key bravo/);
    assert.equal(none.stdout, '');
    assert.equal(read(h, 'Bad_Name').status, 2);
    assert.equal(spawnSync(process.execPath, [helper], { encoding: 'utf8' }).status, 2);
  });

  test('red: REQ-1005 a key file wider than 0600 is refused on POSIX (on Windows the mode check is skipped), and a symlinked key path always', () => {
    const h = home();
    const p = paths(h, 'alpha');
    const value = fakeKey();
    secrets.writeKeyFile(p.keyFile, value);
    chmodSync(p.keyFile, 0o644);
    const r = read(h, 'alpha');
    if (POSIX) {
      assert.equal(r.status, 2);
      assert.match(r.stderr, /mode 0644 is wider than 0600/);
      assert.equal(r.stdout, '');
    } else {
      // Windows: stat modes carry no owner-only meaning; the helper reads, the folder ACL rules (REQ-1005).
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, value);
    }
    rmSync(p.keyFile);
    writeFileSync(join(h, 'victim'), fakeKey('foxtrot'));
    if (!trySymlink(join(h, 'victim'), p.keyFile)) return;
    const s = read(h, 'alpha');
    assert.equal(s.status, 2);
    assert.match(s.stderr, /is a symlink/);
    assert.equal(s.stdout, '');
  });
});

describe('assessKey and ensureOwnerDir (REQ-1005, REQ-1006)', () => {
  test('red: REQ-1005 absent; POSIX: 0600 ready, 0644 not ready naming the mode; Windows: mode skipped, ACL or mode unverified reported; never the value', () => {
    const h = home();
    const p = paths(h, 'alpha');
    assert.deepEqual(secrets.assessKey(p.keyFile), { present: false, ready: false, mode: null, acl: null, reason: 'key absent' });
    const value = fakeKey('golf');
    secrets.writeKeyFile(p.keyFile, value);
    const ok = secrets.assessKey(p.keyFile);
    assert.equal(ok.ready, true);
    chmodSync(p.keyFile, 0o644);
    const bad = secrets.assessKey(p.keyFile);
    assert.equal(bad.present, true);
    if (POSIX) {
      assert.equal(ok.mode, '0600');
      assert.equal(bad.ready, false);
      assert.equal(bad.reason, 'not ready (key file mode 0644)');
    } else {
      assert.equal(ok.mode, null, 'no POSIX mode on Windows');
      assert.equal(bad.ready, true, 'chmod means nothing on Windows: the mode check is skipped');
      assert.equal(typeof bad.acl, 'string');
      assert.match(bad.reason, /ACL |mode unverified/);
    }
    assertNoValue(JSON.stringify(bad), value);
  });

  test('red: REQ-1006 Windows (fake platform): the dir gets icacls /inheritance:r /grant:r; without icacls the report says mode unverified', () => {
    const h = home();
    const dir = join(h, 'accounts', 'alpha');
    const calls = [];
    const icacls = (args, target) => { calls.push([target, ...args]); return { available: true, status: 0, stdout: '', stderr: '' }; };
    const r = secrets.ensureOwnerDir(dir, { platform: 'win32', run: icacls, user: WIN.user });
    assert.ok(existsSync(dir));
    assert.deepEqual(calls, [[dir, '/inheritance:r', '/grant:r', `${WIN.user}:(OI)(CI)F`]]);
    assert.match(r.acl, /owner-only ACL \(icacls/);
    const none = secrets.ensureOwnerDir(join(h, 'accounts', 'bravo'), { platform: 'win32', run: () => ({ available: false }) });
    assert.equal(none.acl, 'mode unverified');
    // The fixture's Windows paths pass through to icacls as given.
    const winCalls = [];
    secrets.ensureOwnerDir(join(h, 'w'), { platform: 'win32', run: (args, target) => { winCalls.push(target); return { available: false }; } });
    assert.equal(winCalls.length, 1);
  });

  test('red: REQ-1006 Windows (fake platform): assessKey skips the mode check and reports the ACL, or mode unverified', () => {
    const h = home();
    const p = paths(h, 'alpha');
    secrets.writeKeyFile(p.keyFile, fakeKey('hotel'));
    if (POSIX) chmodSync(p.keyFile, 0o644); // would be "not ready" on POSIX; on Windows the bits mean nothing
    const withAcl = secrets.assessKey(p.keyFile, { platform: 'win32', icacls: () => ({ available: true, status: 0, stdout: WIN.icaclsOutput.join('\n').split(WIN.accounts.alpha.keyFile).join(p.keyFile) }) });
    assert.equal(withAcl.ready, true);
    assert.equal(withAcl.mode, null);
    assert.equal(withAcl.acl, 'HOST\\alpha:(F)');
    assert.match(withAcl.reason, /ACL HOST\\alpha:\(F\)/);
    const noTool = secrets.assessKey(p.keyFile, { platform: 'win32', icacls: () => ({ available: false }) });
    assert.equal(noTool.acl, 'mode unverified');
    assert.match(noTool.reason, /mode unverified/);
  });
});

describe('codex login through the stub (REQ-1003)', () => {
  test('red: REQ-1003 the store is forced to file, the value reaches the stub on stdin under CODEX_HOME, the env is scrubbed, and the auth mode is reported', () => {
    const h = home();
    const codex = stubCodex(join(h, 'bin'));
    const p = paths(h, 'bravo');
    mkdirSync(p.configDir, { recursive: true });
    writeFileSync(p.codexConfigFile, 'model = "stub"\ncli_auth_credentials_store = "keyring"\n');
    const value = fakeKey('india');
    const env = { ...process.env, LEAK_ME: 'x', OPENAI_API_KEY: 'not-for-the-child', ANTHROPIC_API_KEY: 'nor-this' };
    const r = secrets.codexLogin({ configDir: p.configDir, configFile: p.codexConfigFile, authFile: p.codexAuthFile, value, env, codexBin: codex });
    assert.equal(r.ok, true, r.stderr);
    assert.equal(r.status, 0);
    assert.equal(readFileSync(p.codexConfigFile, 'utf8'), 'model = "stub"\ncli_auth_credentials_store = "file"\n');
    const calls = JSON.parse(readFileSync(join(p.configDir, 'stub-calls.json'), 'utf8'));
    assert.deepEqual(calls[0].argv, ['login', '--with-api-key']);
    assert.ok(calls[0].envNames.includes('CODEX_HOME'));
    for (const k of ['LEAK_ME', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'BUILDER_ACCOUNTS_HOME']) assert.equal(calls[0].envNames.includes(k), false, k);
    assert.equal(JSON.parse(readFileSync(p.codexAuthFile, 'utf8')).OPENAI_API_KEY, value, 'the stub (the harness) wrote the key');
    assert.equal(r.auth.present, true);
    if (POSIX) assert.equal(r.auth.mode, '0600');
    else assert.equal(typeof r.auth.acl, 'string', 'Windows: the ACL is reported instead of a mode');
    // The kit wrote no file holding the value: only the harness's own auth.json does.
    const holders = [];
    const walk = (d) => { for (const n of readdirSync(d, { withFileTypes: true })) { const f = join(d, n.name); if (n.isDirectory()) walk(f); else if (readFileSync(f, 'utf8').includes(value)) holders.push(f); } };
    walk(h);
    assert.deepEqual(holders, [p.codexAuthFile]);
    // A bare name is found on PATH too (a .cmd shim on Windows), and a missing name resolves to nothing.
    assert.equal(secrets.resolveBin('codex', { PATH: join(h, 'bin') + delimiter + '/nowhere', PATHEXT: '.COM;.EXE;.BAT;.CMD' }), codex);
    assert.equal(secrets.resolveBin('codex-zz', { PATH: join(h, 'bin'), PATHEXT: '.COM;.EXE;.BAT;.CMD' }), null);
    assertNoValue(r.stdout + r.stderr + JSON.stringify(r.auth), value);
    const out = secrets.codexLogout({ configDir: p.configDir, env, codexBin: codex });
    assert.equal(out.ok, true);
    assert.equal(existsSync(p.codexAuthFile), false);
  });

  test('red: REQ-1003 a missing codex binary is a named refusal, and the kit never writes the key itself', () => {
    const h = home();
    const p = paths(h, 'bravo');
    const value = fakeKey('juliet');
    assert.throws(() => secrets.codexLogin({ configDir: p.configDir, configFile: p.codexConfigFile, authFile: p.codexAuthFile, value, env: {}, codexBin: join(h, 'no-such-codex') }), (e) => e.code === 'E_CODEX_MISSING');
    assert.equal(existsSync(p.codexAuthFile), false);
    assert.equal(readFileSync(p.codexConfigFile, 'utf8'), 'cli_auth_credentials_store = "file"\n');
  });

  test('scrubEnv keeps only the allowlist plus CODEX_HOME', () => {
    const e = secrets.scrubEnv({ PATH: '/x', HOME: '/h', OPENAI_API_KEY: 'k', FOO: 'bar' }, '/cfg');
    assert.deepEqual(e, { PATH: '/x', HOME: '/h', CODEX_HOME: '/cfg' });
  });
});

test('control: no literal in this test file matches a secret shape (fakes are built at runtime)', () => {
  const text = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  for (const [kind, re] of PATTERNS) if (kind !== 'assigned secret') assert.equal(re.test(text), false, kind);
});

/** fs.constants, read here so the flags assertion names what it checks. */
function fsConstants() { return require('node:fs').constants; }
