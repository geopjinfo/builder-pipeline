'use strict';
/**
 * Key entry and key storage for `accounts key` (plan M10, REQ-1002, REQ-1003, REQ-1005, REQ-1006; D2, D20, D42).
 *
 * WHY. An API key is the one secret the kit touches. It enters through hidden terminal input only (no argv, no
 * environment variable: both leak into shell history, process lists and logs). For a Claude Code account the value
 * goes to ONE file, `accounts/<name>/key`, created with O_CREAT|O_EXCL|O_NOFOLLOW at 0600 inside a 0700 dir, so a
 * symlink planted at the path fails with EEXIST and nothing is written through it. Claude Code then reads it through
 * `apiKeyHelper` (`scripts/account-key.cjs read <name>`), never from the environment. For a Codex account the kit
 * writes nothing: it pipes the value to `codex login --with-api-key` with CODEX_HOME set to the account dir and
 * reports the mode of the auth file Codex wrote.
 *
 * Every write here is temp + rename after an lstat check that refuses a symlink. No function returns, logs or
 * embeds the value in a message. `platform`, `spawn` and `icacls` are injectable so the Windows branch and the Codex
 * login are tested without a real Windows or a real Codex.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const KEY_FLAGS = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0);
const PRINTABLE = /^[\x20-\x7e]+$/;
/** The variables a `codex login` child may inherit. Nothing else leaves this process. */
const CODEX_ENV_ALLOW = Object.freeze(['PATH', 'HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'TERM', 'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS']);

const err = (code, message) => Object.assign(new Error(message), { code });
const octal = (mode) => '0' + (mode & 0o777).toString(8);

/** Why `value` is not an acceptable key, or null. The reason never quotes the value. */
function valueProblem(value) {
  if (typeof value !== 'string' || value.length === 0) return 'E_KEY_EMPTY: no key was entered';
  if (!PRINTABLE.test(value)) return 'E_KEY_CHARS: a key is printable ASCII only (no control characters, no spaces outside 0x20-0x7E, no non-ASCII)';
  return null;
}

/**
 * Read a key from the terminal with echo off. On a TTY: raw mode, Enter ends, Backspace edits, Ctrl-C aborts; the
 * terminal mode is restored on every exit path. Off a TTY: read to EOF, with a notice that echo may be visible.
 * @param {{ stdin?: NodeJS.ReadStream, stderr?: NodeJS.WriteStream, prompt?: string }} [io]
 * @returns {Promise<{ value: string, tty: boolean }>}
 */
function readSecret({ stdin = process.stdin, stderr = process.stderr, prompt = 'API key (hidden): ' } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const finish = (value, tty) => {
      const why = valueProblem(value);
      if (why) return reject(err(why.split(':')[0], why));
      return resolve({ value, tty });
    };
    if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
      stderr.write('accounts key: stdin is not a terminal — reading the key to end of input; echo may be visible\n');
      stdin.setEncoding && stdin.setEncoding('utf8');
      stdin.on('data', (c) => chunks.push(String(c)));
      stdin.on('error', reject);
      stdin.on('end', () => finish(chunks.join('').replace(/\r?\n$/, ''), false));
      stdin.resume && stdin.resume();
      return;
    }
    let value = '';
    let done = false;
    const restore = () => {
      if (done) return;
      done = true;
      try { stdin.setRawMode(false); } catch { /* the terminal is gone */ }
      stdin.removeListener('data', onData);
      stdin.removeListener('error', onError);
      stdin.pause && stdin.pause();
    };
    const onError = (e) => { restore(); stderr.write('\n'); reject(e); };
    const onData = (chunk) => {
      for (const ch of String(chunk)) {
        if (ch === '\u0003') { restore(); stderr.write('\n'); return reject(err('E_KEY_ABORT', 'E_KEY_ABORT: cancelled (Ctrl-C); nothing written')); }
        if (ch === '\r' || ch === '\n') { restore(); stderr.write('\n'); return finish(value, true); }
        if (ch === '\u007f' || ch === '\b') { value = value.slice(0, -1); continue; }
        value += ch;
      }
    };
    stderr.write(prompt);
    stdin.setEncoding && stdin.setEncoding('utf8');
    stdin.setRawMode(true);
    stdin.on('data', onData);
    stdin.on('error', onError);
    stdin.resume && stdin.resume();
  });
}

/** lstat without throwing: null when the path is absent. */
function lstatOrNull(p) {
  try { return fs.lstatSync(p); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

/** Refuse a symlink at `p` (the planted-link attack): EEXIST, nothing written through it. */
function refuseSymlink(p, what) {
  const st = lstatOrNull(p);
  if (st && st.isSymbolicLink()) throw err('EEXIST', `EEXIST: ${what} ${p} is a symlink — refusing to write through it`);
  return st;
}

/**
 * Create `dir` for the owner only. POSIX: mode 0700 (set even when the dir exists). Windows: the mode bits mean
 * nothing, so `icacls <dir> /inheritance:r /grant:r <user>:(OI)(CI)F` is applied when icacls is available, else the
 * report says "mode unverified" (REQ-1006). `run` is injectable (a fake icacls in tests).
 * @returns {{ acl: string }}
 */
function ensureOwnerDir(dir, { platform = process.platform, run = runIcacls, user = process.env.USERNAME } = {}) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (platform !== 'win32') {
    fs.chmodSync(dir, 0o700);
    return { acl: 'mode 0700' };
  }
  const who = user || 'the current user';
  const r = run(['/inheritance:r', '/grant:r', `${user || '%USERNAME%'}:(OI)(CI)F`], dir);
  if (!r || !r.available) return { acl: 'mode unverified' };
  return { acl: r.status === 0 ? `owner-only ACL (icacls, ${who})` : `mode unverified (icacls exit ${r.status})` };
}

/** Run icacls on `target` with `args`; `{ available: false }` when the tool is not on this machine. */
function runIcacls(args, target) {
  const r = spawnSync('icacls', [target, ...args], { encoding: 'utf8' });
  if (r.error && r.error.code === 'ENOENT') return { available: false };
  return { available: true, status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/**
 * Write the key file: O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW, mode 0600, in a 0700 dir. A first write opens the final
 * path with those flags (a planted symlink fails with EEXIST). A rotation writes a temp file with the same flags and
 * renames it over the old key after an lstat check that refuses a symlink.
 * @returns {{ rotated: boolean, mode: string }}
 */
function writeKeyFile(keyFile, value, opts = {}) {
  const why = valueProblem(value);
  if (why) throw err(why.split(':')[0], why);
  ensureOwnerDir(path.dirname(keyFile), opts);
  const existing = refuseSymlink(keyFile, 'the key path');
  const target = existing ? `${keyFile}.${process.pid}.tmp` : keyFile;
  if (existing) refuseSymlink(target, 'the temp key path');
  const fd = fs.openSync(target, KEY_FLAGS, 0o600);
  try {
    fs.writeSync(fd, value, null, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
  if (existing) {
    // The link check again, right before the rename: the window between lstat and rename is as small as it gets.
    refuseSymlink(keyFile, 'the key path');
    fs.renameSync(target, keyFile);
  }
  if (process.platform !== 'win32') fs.chmodSync(keyFile, 0o600);
  return { rotated: Boolean(existing), mode: octal(fs.statSync(keyFile).mode) };
}

/** Delete the key file if present (and never follow a link: a symlink is unlinked, not its target). */
function removeKeyFile(keyFile) {
  if (!lstatOrNull(keyFile)) return false;
  fs.unlinkSync(keyFile);
  return true;
}

/**
 * Edit a JSON settings file in place: lstat check (a symlink is refused), `mutate(obj)` over the parsed object (or
 * `{}`), then temp + rename at 0600. Returns the new object.
 */
function editJson(file, mutate, { mode = 0o600 } = {}) {
  ensureOwnerDir(path.dirname(file));
  const st = refuseSymlink(file, 'the settings path');
  let obj = {};
  if (st) {
    const text = fs.readFileSync(file, 'utf8');
    try { obj = text.trim() ? JSON.parse(text) : {}; } catch (e) { throw err('E_SETTINGS_JSON', `${file}: not valid JSON (${e.message}) — fix or remove it first`); }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw err('E_SETTINGS_JSON', `${file}: must hold a JSON object`);
  }
  const out = mutate(obj) || obj;
  const tmp = `${file}.${process.pid}.tmp`;
  refuseSymlink(tmp, 'the temp settings path');
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n', { mode });
  refuseSymlink(file, 'the settings path');
  fs.renameSync(tmp, file);
  return out;
}

/** The `apiKeyHelper` command for `name`: the kit's helper by absolute path, so it runs from any cwd. */
function helperCommand(kitRoot, name) {
  const helper = path.join(kitRoot, 'scripts', 'account-key.cjs');
  const q = (s) => (/\s/.test(s) ? `"${s}"` : s);
  return `node ${q(helper)} read ${name}`;
}

/**
 * Assess a key file without reading it (REQ-1005, REQ-1006). POSIX: present and mode 0600 → ready; wider → not ready
 * with the mode named. Windows: the mode check is skipped; the ACL is reported through icacls when available, else
 * "mode unverified".
 * @returns {{ present: boolean, ready: boolean, mode: string | null, acl: string | null, reason: string }}
 */
function assessKey(keyFile, { platform = process.platform, icacls = runIcacls } = {}) {
  const st = lstatOrNull(keyFile);
  if (!st) return { present: false, ready: false, mode: null, acl: null, reason: 'key absent' };
  if (st.isSymbolicLink()) return { present: true, ready: false, mode: null, acl: null, reason: 'key path is a symlink' };
  if (platform === 'win32') {
    const r = icacls([], keyFile);
    const acl = r && r.available && r.status === 0 ? aclSummary(r.stdout, keyFile) : 'mode unverified';
    return { present: true, ready: true, mode: null, acl, reason: acl === 'mode unverified' ? 'key present (mode check skipped on Windows; mode unverified)' : `key present (ACL ${acl})` };
  }
  const mode = octal(st.mode);
  if (st.mode & 0o077) return { present: true, ready: false, mode, acl: null, reason: `not ready (key file mode ${mode})` };
  return { present: true, ready: true, mode, acl: null, reason: `key present (mode ${mode})` };
}

/** One line from icacls output: the principals granted (`DOMAIN\user:(F)`), without the path. */
function aclSummary(stdout, target) {
  const grants = String(stdout || '').split(/\r?\n/).map((l) => l.split(target).join('').trim()).filter((l) => /^.+:\(?[A-Z,()]+\)?$/.test(l));
  return grants.length ? grants.join(' ') : 'reported by icacls';
}

/** The environment a codex child gets: an allowlist over `env`, plus CODEX_HOME. */
function scrubEnv(env, codexHome) {
  const out = {};
  for (const k of CODEX_ENV_ALLOW) if (env[k] !== undefined) out[k] = env[k];
  out.CODEX_HOME = codexHome;
  return out;
}

/** Set `cli_auth_credentials_store = "file"` in config.toml (create the file, or replace the line). */
function forceFileStore(configFile) {
  ensureOwnerDir(path.dirname(configFile));
  refuseSymlink(configFile, 'the codex config path');
  const line = 'cli_auth_credentials_store = "file"';
  let text = fs.existsSync(configFile) ? fs.readFileSync(configFile, 'utf8') : '';
  if (/^\s*cli_auth_credentials_store\s*=.*$/m.test(text)) text = text.replace(/^\s*cli_auth_credentials_store\s*=.*$/m, line);
  else text = `${line}\n${text}`;
  const tmp = `${configFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, configFile);
}

/**
 * Sign a Codex account in with an API key (REQ-1003): CODEX_HOME = the account's config dir, the credentials store
 * forced to "file", the value piped to `codex login --with-api-key` on stdin. The kit writes no key. Reports the
 * exit status and the mode of the auth file Codex wrote.
 */
function codexLogin({ configDir, configFile, authFile, value, env = process.env, codexBin = 'codex', spawn = spawnSync, platform = process.platform, icacls = runIcacls }) {
  const why = valueProblem(value);
  if (why) throw err(why.split(':')[0], why);
  ensureOwnerDir(configDir, { platform });
  forceFileStore(configFile);
  const r = spawn(codexBin, ['login', '--with-api-key'], { input: value, encoding: 'utf8', env: scrubEnv(env, configDir), stdio: ['pipe', 'pipe', 'pipe'] });
  if (r.error) throw err('E_CODEX_MISSING', `codex: ${r.error.code === 'ENOENT' ? 'not found on PATH — install the Codex CLI first' : r.error.message}`);
  const auth = assessKey(authFile, { platform, icacls });
  return { ok: r.status === 0 && auth.present, status: r.status, auth, stdout: String(r.stdout || ''), stderr: String(r.stderr || '') };
}

/** `codex logout` under the account's CODEX_HOME (REQ-1003, REQ-1004). */
function codexLogout({ configDir, env = process.env, codexBin = 'codex', spawn = spawnSync }) {
  const r = spawn(codexBin, ['logout'], { encoding: 'utf8', env: scrubEnv(env, configDir), stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error) return { ok: false, status: null, reason: r.error.code === 'ENOENT' ? 'codex not found on PATH' : r.error.message };
  return { ok: r.status === 0, status: r.status, stdout: String(r.stdout || ''), stderr: String(r.stderr || '') };
}

module.exports = {
  KEY_FLAGS, CODEX_ENV_ALLOW, valueProblem, readSecret, ensureOwnerDir, runIcacls, writeKeyFile, removeKeyFile, editJson, helperCommand,
  assessKey, scrubEnv, forceFileStore, codexLogin, codexLogout, octal, refuseSymlink,
};
