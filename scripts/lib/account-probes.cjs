'use strict';
/**
 * The built-in readiness probes and the fact gatherer behind `assess` (plan M2a, REQ-208, REQ-211, REQ-202, REQ-207,
 * REQ-210; D43, D46, D53).
 *
 * WHY. `accounts.cjs` judges facts; this module gathers them. It is the one place a `claude` or `codex` binary runs for
 * the assessment, and it runs them the way the devbox tool did: per account dir, with the env scrubbed, under a
 * timeout. The parsers are pure over a captured `{ stdout, stderr, status }`, so every probe state is testable with a
 * stub executable and no real harness.
 *
 * PROBES (REQ-208).
 *   claude-code  `claude auth status` prints JSON (`authMethod`, `configDirectory`; exit 1 when signed out). A signed-
 *                out account is still ready when its key file exists AND its settings.json names `apiKeyHelper`
 *                (an api-key account). The key file is tested for presence only; its text is never read here.
 *   codex        `codex login status` prints to STDERR and exits 0 (logged in) or 1 (not logged in): "ChatGPT" or
 *                "API key" names the method. It never prints a plan tier (D43).
 *   antigravity  a models listing (`agy models`, or the account's `readyCommand`) under the timeout: exit 0 with at
 *                least one model listed is ready; the words "sign in" anywhere in the output mean not ready; a timeout
 *                or a missing binary is unmeasured (D53). Antigravity has no key mode and no config dir variable.
 *   gateway      picked by `pays` (the worker is Claude Code or Codex): ready when a wrapper (`bin/<name>` or
 *                `bin/<name>.ps1`) exists, does not carry the CLOSED_MARKER line a closed policy writes (M11), and the
 *                gateway key is present (the key file, or auth.json for Codex) — presence only, never read (D53).
 *
 * EXPIRY (REQ-211). `claude auth status` may expose an expiry field; the Codex `auth.json` holds an access token whose
 * `exp` claim is the expiry. Only the time comes back (`expiresAt`), never a token. The assessment turns an expiry
 * inside `authMinMinutes` into `AUTH until <time>`.
 *
 * ENV (REQ-202). A probe gets an allowlist: PATH, HOME and locale, plus the account's own config dir variable
 * (`CLAUDE_CONFIG_DIR` or `CODEX_HOME`). The parent's ANTHROPIC_*, OPENAI_*, CLAUDE* and CODEX* variables never pass:
 * an inherited key would make the probe answer for the wrong account, and an inherited config dir would nest sessions.
 *
 * SNAPSHOT (REQ-203). `budget.file` names a usage snapshot JSON (absolute, or relative to the accounts home); it is
 * parsed by `accounts.parseGatewaySnapshot`, `budget.key` selecting `keys.<key>`. A missing or unreadable file gives
 * no reading and one note; it never throws.
 *
 * Commands from §16 (`usageCommand`, `versionCommand`, `readyCommand`) are the owner's own templates; they run through the shell in
 * the same env, under the same timeout. Anything that fails, times out or prints nothing readable is `null` to the
 * assessment: unmeasured, never a pass.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { CONFIG_DIR_VAR } = require('./account-paths.cjs');
const { parseUsageText, parseGatewaySnapshot, SIGN_IN } = require('./accounts.cjs');
const codexRateLimits = require('./codex-ratelimits.cjs');

const DEFAULT_TIMEOUT_MS = 12000;
const MAX_OUTPUT = 64 * 1024;
/** Env names a probe may inherit (exact) and prefixes it may inherit. Nothing else passes. */
const ENV_ALLOW = Object.freeze(['PATH', 'Path', 'HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LANGUAGE', 'SHELL', 'TERM', 'SystemRoot', 'ComSpec', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA', 'NO_COLOR']);
const ENV_ALLOW_PREFIX = Object.freeze(['LC_', 'XDG_']);
/** The probes added in M2b beside the two harness probes: the Antigravity worker and the gateway way of paying (D53). */
const FOREIGN_PROBES = Object.freeze(['antigravity', 'gateway']);
/** The Antigravity CLI and its models listing — the one place the binary name lives. */
const ANTIGRAVITY_BIN = 'agy';
const ANTIGRAVITY_MODELS_ARGS = Object.freeze(['models']);
/** The line a refusal wrapper carries when the policy closes a gateway account (written by `accounts install`, M11). */
const CLOSED_MARKER = '# builder-pipeline: closed';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clip = (s) => String(s ?? '').slice(0, MAX_OUTPUT);

/** An ISO time from a unix-seconds number, a milliseconds number or an ISO string; null otherwise. */
function toIso(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v < 1e11 ? v * 1000 : v).toISOString();
  if (typeof v === 'string' && v && Number.isFinite(Date.parse(v))) return new Date(Date.parse(v)).toISOString();
  return null;
}

/* ------------------------------------------------------------------------- env ---- */

/** The scrubbed env for a probe or an account command: the allowlist plus the worker's config dir variable. */
function probeEnv(base = process.env, worker = null, configDir = null) {
  const out = {};
  for (const [k, v] of Object.entries(base || {})) {
    if (v === undefined) continue;
    if (ENV_ALLOW.includes(k) || ENV_ALLOW_PREFIX.some((p) => k.startsWith(p))) out[k] = v;
  }
  const dirVar = CONFIG_DIR_VAR[worker];
  if (dirVar && configDir) out[dirVar] = configDir;
  return out;
}

/* --------------------------------------------------------------------- running ---- */

/** Run a binary with arguments (no shell). Never throws: a missing binary is `{ error: 'not found' }`. */
function runBinary(bin, args, { env, timeoutMs = DEFAULT_TIMEOUT_MS, cwd } = {}) {
  const t0 = Date.now();
  const r = spawnSync(bin, args, { env, cwd, timeout: timeoutMs, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: process.platform === 'win32' });
  return result(r, bin, timeoutMs, Date.now() - t0);
}

/** Run a §16 command template through the shell, scrubbed and timed. */
function runCommand(command, { env, timeoutMs = DEFAULT_TIMEOUT_MS, cwd } = {}) {
  const t0 = Date.now();
  const r = spawnSync(String(command), { env, cwd, timeout: timeoutMs, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: true });
  return result(r, String(command).split(/\s+/)[0], timeoutMs, Date.now() - t0);
}

/*
 * A run past its timeout is a timeout even when spawnSync reports no error: on Windows the shell (cmd.exe) is what
 * the timeout kills, and its grandchild keeps the pipes open until it exits on its own, so spawnSync returns late
 * with a normal-looking status. Any output of such a run is not a reading.
 */
function result(r, name, timeoutMs = DEFAULT_TIMEOUT_MS, elapsedMs = 0) {
  const timedOut = !!(r.error && r.error.code === 'ETIMEDOUT') || r.signal === 'SIGTERM' || elapsedMs >= timeoutMs;
  // Through a shell a missing program is not ENOENT: sh exits 127, cmd.exe exits 9009 and says "is not recognized".
  const notFound = !!(r.error && r.error.code === 'ENOENT') || r.status === 127 || r.status === 9009
    || /is not recognized as an internal or external command/i.test(String(r.stderr || ''));
  return {
    stdout: clip(r.stdout),
    stderr: clip(r.stderr),
    status: notFound ? null : typeof r.status === 'number' ? r.status : null,
    timedOut,
    error: timedOut ? 'timed out' : notFound ? `${name}: not found` : r.error ? String(r.error.code || r.error.message) : null,
  };
}

/* --------------------------------------------------------------- Claude Code ---- */

const CLAUDE_EXPIRY_KEYS = Object.freeze(['expiresAt', 'expires_at', 'tokenExpiresAt', 'expiry', 'expiresIn']);

/** The expiry a `claude auth status` object exposes, as ISO, or null. `expiresIn` is seconds from `now`. */
function claudeExpiry(json, now = Date.now()) {
  if (!isObject(json)) return null;
  for (const k of CLAUDE_EXPIRY_KEYS) {
    if (json[k] === undefined || json[k] === null) continue;
    if (k === 'expiresIn') return typeof json[k] === 'number' ? new Date(Number(new Date(now)) + json[k] * 1000).toISOString() : null;
    const t = toIso(json[k]);
    if (t) return t;
  }
  return null;
}

/**
 * Parse `claude auth status` (pure). `ok` true = signed in, false = signed out, null = no answer.
 * The raw output never comes back: only the fields named here, and a reason the assessment redacts.
 */
function parseClaudeAuthStatus({ stdout = '', stderr = '', status = null, error = null } = {}, now = Date.now()) {
  const base = { worker: 'claude-code', signIn: SIGN_IN['claude-code'], method: null, configDir: null, expiresAt: null };
  if (error) return { ...base, ok: null, reason: `claude auth status: ${error}` };
  let json = null;
  const m = /\{[\s\S]*\}/.exec(stdout);
  if (m) { try { json = JSON.parse(m[0]); } catch { json = null; } }
  if (isObject(json)) {
    const signedIn = json.loggedIn === true || (json.loggedIn === undefined && status === 0 && typeof json.authMethod === 'string');
    const out = {
      ...base,
      method: typeof json.authMethod === 'string' ? json.authMethod : null,
      configDir: typeof json.configDirectory === 'string' ? json.configDirectory : null,
      expiresAt: claudeExpiry(json, now),
      ...(json.leaked !== undefined ? { leaked: json.leaked } : {}),
    };
    if (signedIn && status === 0) return { ...out, ok: true, reason: null };
    if (json.loggedIn === false || status === 1) return { ...out, ok: false, reason: 'signed out' };
    return { ...out, ok: null, reason: `claude auth status: exit ${status}` };
  }
  if (status === 1) return { ...base, ok: false, reason: 'signed out' };
  const tail = `${stdout} ${stderr}`.trim().split(/\r?\n/).pop() || '';
  return { ...base, ok: null, reason: `claude auth status: unreadable output${tail ? ` (${tail.slice(0, 200)})` : ''}` };
}

/** The key-file route: the key file exists (presence only) and the account's settings.json names `apiKeyHelper`. */
function claudeKeyProbe(paths, fsLike = fs) {
  const base = { worker: 'claude-code', signIn: SIGN_IN['claude-code'], method: 'api-key', configDir: paths.configDir, expiresAt: null };
  const hasKey = fsLike.existsSync(paths.keyFile);
  let settings = null;
  try { settings = fsLike.existsSync(paths.settingsFile) ? JSON.parse(fsLike.readFileSync(paths.settingsFile, 'utf8')) : null; } catch { settings = null; }
  const helper = isObject(settings) && typeof settings.apiKeyHelper === 'string' && settings.apiKeyHelper.trim();
  if (hasKey && helper) return { ...base, ok: true, reason: null };
  if (hasKey && !helper) return { ...base, ok: false, reason: 'key file present but settings.json has no apiKeyHelper (run `npx builder accounts key <name>` again)' };
  return { ...base, ok: false, reason: 'signed out' };
}

/**
 * The Claude Code probe: `claude auth status` first; a signed-out or missing CLI falls back to the key-file route.
 * `.credentials.json` is read for its `claudeAiOauth.expiresAt` only when the status output exposes no expiry.
 */
function claudeProbe(account, paths, io) {
  const env = probeEnv(io.env, 'claude-code', paths.configDir);
  const r = parseClaudeAuthStatus(runBinary('claude', ['auth', 'status'], { env, timeoutMs: io.timeoutMs }), io.now);
  if (r.ok === true) {
    if (!r.expiresAt) r.expiresAt = credentialsExpiry(paths, io.fs || fs);
    return r;
  }
  const keyed = claudeKeyProbe(paths, io.fs || fs);
  if (keyed.ok === true) return keyed;
  if (r.ok === false) return keyed.reason === 'signed out' ? r : keyed;
  return r; // unmeasured: the CLI gave no answer and the key route is not set up
}

function credentialsExpiry(paths, fsLike) {
  try {
    const file = `${paths.configDir}/.credentials.json`;
    if (!fsLike.existsSync(file)) return null;
    const j = JSON.parse(fsLike.readFileSync(file, 'utf8'));
    return isObject(j) && isObject(j.claudeAiOauth) ? toIso(j.claudeAiOauth.expiresAt) : null;
  } catch { return null; }
}

/* --------------------------------------------------------------------- Codex ---- */

/** Parse `codex login status`: the text is on stderr, the verdict in the exit code. No plan tier is read (D43). */
function parseCodexLoginStatus({ stdout = '', stderr = '', status = null, error = null } = {}) {
  const base = { worker: 'codex', signIn: SIGN_IN.codex, method: null, expiresAt: null };
  if (error) return { ...base, ok: null, reason: `codex login status: ${error}` };
  const text = `${stderr}\n${stdout}`;
  if (/not logged in/i.test(text) || status === 1) return { ...base, ok: false, reason: 'not logged in' };
  if (status === 0 && /logged in/i.test(text)) {
    const method = /api key/i.test(text) ? 'api-key' : /chatgpt/i.test(text) ? 'chatgpt' : 'unknown';
    return { ...base, ok: true, method, reason: null };
  }
  return { ...base, ok: null, reason: `codex login status: unreadable output (exit ${status})` };
}

/** The `exp` claim of a JWT, as ISO. Only the time comes back; the token is never returned. */
function jwtExpiry(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return isObject(claims) ? toIso(claims.exp) : null;
  } catch { return null; }
}

/** The credential expiry a Codex `auth.json` exposes (`tokens.expires_at`, else the access token's `exp`), or null. */
function codexAuthExpiry(text) {
  let j;
  try { j = JSON.parse(String(text ?? '')); } catch { return null; }
  const tokens = isObject(j) && isObject(j.tokens) ? j.tokens : null;
  if (!tokens) return null;
  return toIso(tokens.expires_at) || toIso(tokens.expiresAt) || jwtExpiry(tokens.access_token) || jwtExpiry(tokens.id_token);
}

function codexProbe(account, paths, io) {
  const env = probeEnv(io.env, 'codex', paths.configDir);
  const r = parseCodexLoginStatus(runBinary('codex', ['login', 'status'], { env, timeoutMs: io.timeoutMs }));
  r.configDir = paths.configDir;
  if (r.ok === true && r.method !== 'api-key') {
    const fsLike = io.fs || fs;
    try { if (fsLike.existsSync(paths.codexAuthFile)) r.expiresAt = codexAuthExpiry(fsLike.readFileSync(paths.codexAuthFile, 'utf8')); } catch { r.expiresAt = null; }
  }
  return r;
}

/* --------------------------------------------------------------- Antigravity ---- */

/**
 * Parse a models listing (pure). The words "sign in" anywhere mean not ready; exit 0 with at least one non-empty line
 * on stdout is ready; anything else is no answer. The listing itself never comes back.
 */
function parseAntigravityModels({ stdout = '', stderr = '', status = null, error = null, timedOut = false } = {}, command = `${ANTIGRAVITY_BIN} ${ANTIGRAVITY_MODELS_ARGS.join(' ')}`) {
  const base = { worker: 'antigravity', signIn: null, method: null, configDir: null, expiresAt: null };
  if (/sign[ -]?in/i.test(`${stdout}\n${stderr}`)) return { ...base, ok: false, reason: `sign in needed: the models call says "sign in" (sign in through the Antigravity app, then retry)` };
  if (timedOut) return { ...base, ok: null, reason: `${command}: timed out` };
  if (error) return { ...base, ok: null, reason: `${command}: ${error}` };
  const models = String(stdout).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (status === 0 && models.length) return { ...base, ok: true, method: 'app', reason: null, models: models.length };
  if (status === 0) return { ...base, ok: null, reason: `${command}: exit 0 but no model listed` };
  return { ...base, ok: null, reason: `${command}: exit ${status}` };
}

/** The Antigravity probe: the account's `readyCommand` when set, else the built-in models listing, under the timeout. */
function antigravityProbe(account, paths, io) {
  const env = probeEnv(io.env, 'antigravity', paths.configDir);
  const own = typeof account.readyCommand === 'string' && account.readyCommand.trim() ? account.readyCommand.trim() : null;
  const r = own ? runCommand(own, { env, timeoutMs: io.timeoutMs }) : runBinary(ANTIGRAVITY_BIN, [...ANTIGRAVITY_MODELS_ARGS], { env, timeoutMs: io.timeoutMs });
  return { ...parseAntigravityModels(r, own || undefined), configDir: paths.configDir };
}

/* ------------------------------------------------------------------- gateway ---- */

/**
 * The gateway probe (picked by `pays`, not by worker): the wrapper exists, is not a refusal wrapper, and the gateway
 * key is present. The key file is tested for presence only; the wrapper is read for the marker line only.
 */
function gatewayProbe(account, paths, io) {
  const fsLike = (io && io.fs) || fs;
  const base = { worker: account.worker, signIn: null, method: 'gateway', configDir: paths.configDir, expiresAt: null };
  const wrappers = [paths.wrapperSh, paths.wrapperPs1].filter((f) => fsLike.existsSync(f));
  if (!wrappers.length) return { ...base, ok: false, signIn: 'npx builder accounts install', reason: `no wrapper at ${paths.wrapperSh}` };
  for (const w of wrappers) {
    let text = '';
    try { text = fsLike.readFileSync(w, 'utf8'); } catch { text = ''; }
    if (text.split(/\r?\n/).some((l) => l.trim() === CLOSED_MARKER)) return { ...base, ok: false, reason: `closed by policy (${path.basename(w)} is a refusal wrapper)` };
  }
  const keyFile = account.worker === 'codex' ? paths.codexAuthFile : paths.keyFile;
  if (!fsLike.existsSync(keyFile)) return { ...base, ok: false, signIn: `npx builder accounts key ${account.name}`, reason: `gateway key absent (${path.basename(keyFile)})` };
  return { ...base, ok: true, reason: null };
}

/* ---------------------------------------------------------------------- map ---- */

/** Built-in probes by worker. The gateway probe is picked by `pays` in `probe()`, whatever the worker. */
const PROBES = Object.freeze({ 'claude-code': claudeProbe, codex: codexProbe, antigravity: antigravityProbe });

/**
 * Run the auth probe for one account.
 * @param {object} account  the account with its name
 * @param {object} paths    account-paths `paths(home, name, account)`
 * @param {{ env?: object, now?: any, timeoutMs?: number, fs?: object }} io
 */
function probe(account, paths, io = {}) {
  const worker = account && account.worker;
  const io2 = { env: io.env || process.env, now: io.now ?? Date.now(), timeoutMs: io.timeoutMs ?? DEFAULT_TIMEOUT_MS, fs: io.fs || fs };
  if (worker === 'session') return { worker, ok: true, method: 'session', reason: null, signIn: null, expiresAt: null };
  if (account && account.pays === 'gateway') return gatewayProbe(account, paths, io2);
  const fn = PROBES[worker];
  if (!fn) return { worker, ok: null, method: null, expiresAt: null, signIn: SIGN_IN[worker] || null, reason: `no built-in probe for worker "${worker}"` };
  return fn(account, paths, io2);
}

/* ------------------------------------------------------------------ gathering ---- */

/** The last smoke record `{ ok, at }` from the account's smokeFile, or null. */
function smokeRecord(paths, fsLike = fs) {
  try {
    if (!fsLike.existsSync(paths.smokeFile)) return null;
    const j = JSON.parse(fsLike.readFileSync(paths.smokeFile, 'utf8'));
    if (!isObject(j)) return null;
    const at = toIso(j.at ?? j.passedAt ?? j.time);
    return at ? { ok: j.ok !== false, at } : null;
  } catch { return null; }
}

/** The first non-empty line of `versionCommand`'s output, or null. */
function versionOf(account, env, timeoutMs) {
  if (typeof account.versionCommand !== 'string' || !account.versionCommand.trim()) return null;
  const r = runCommand(account.versionCommand, { env, timeoutMs });
  if (r.error || r.status !== 0) return null;
  const line = `${r.stdout}\n${r.stderr}`.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
  return line ? { version: line.slice(0, 80) } : null;
}

/**
 * The `budget.file` snapshot reading (REQ-203): `{ reading, note }`. A relative file is resolved against the
 * accounts home (the grandparent of the account dir, as `configDir` is). Nothing here throws.
 */
function snapshotReading(account, paths, io) {
  const b = isObject(account.budget) ? account.budget : {};
  if (typeof b.file !== 'string' || !b.file.trim()) return { reading: null, note: null };
  const fsLike = (io && io.fs) || fs;
  const home = path.dirname(path.dirname(paths.dir));
  const file = path.isAbsolute(b.file) ? b.file : path.resolve(home, b.file);
  const key = typeof b.key === 'string' && b.key.trim() ? b.key.trim() : null;
  let json;
  try {
    if (!fsLike.existsSync(file)) return { reading: null, note: `usage snapshot ${b.file}: not found (budget.file) — usage unmeasured` };
    json = JSON.parse(fsLike.readFileSync(file, 'utf8'));
  } catch (e) {
    return { reading: null, note: `usage snapshot ${b.file}: unreadable (${e && e.message ? e.message.split('\n')[0].slice(0, 80) : 'error'}) — usage unmeasured` };
  }
  let at = null;
  try { at = fsLike.statSync(file).mtime.toISOString(); } catch { at = null; }
  const reading = parseGatewaySnapshot(json, at || io.now, key);
  if (!reading) return { reading: null, note: `usage snapshot ${b.file}: no ${key ? `keys.${key} with a ` : ''}spend number (budget.key) — usage unmeasured` };
  return { reading, note: null };
}

/** Every usage reader the account has, run (REQ-210): usageCommand, the budget.file snapshot, Codex rate_limits. */
function usageReadings(account, paths, io) {
  const out = [];
  const at = new Date(Number(new Date(io.now))).toISOString();
  if (typeof account.usageCommand === 'string' && account.usageCommand.trim()) {
    const r = runCommand(account.usageCommand, { env: io.env, timeoutMs: io.timeoutMs });
    const reading = !r.error && r.status === 0 ? parseUsageText(`${r.stdout}\n${r.stderr}`, at) : null;
    if (reading) out.push(reading);
  }
  const snap = snapshotReading(account, paths, io);
  if (snap.reading) out.push(snap.reading);
  if (account.worker === 'codex') {
    const reading = codexRateLimits.read(paths.configDir);
    if (reading) out.push(reading);
  }
  return out;
}

/**
 * Gather every fact `assess` reads for one account: the auth probe, the smoke record, the version and the usage
 * readings, plus `notes` (a reader that could not read, named; never a throw). Impure by design; the result is plain
 * data for `accounts.assess(account, probes, usage, now)`.
 */
function collect(account, paths, io = {}) {
  const io2 = { env: io.env || process.env, now: io.now ?? Date.now(), timeoutMs: io.timeoutMs ?? DEFAULT_TIMEOUT_MS, fs: io.fs || fs };
  const env = probeEnv(io2.env, account.worker, paths.configDir);
  return {
    probes: {
      auth: probe(account, paths, io2),
      smoke: smokeRecord(paths, io2.fs),
      version: versionOf(account, env, io2.timeoutMs),
    },
    usage: usageReadings(account, paths, { ...io2, env }),
    notes: [snapshotReading(account, paths, io2).note].filter(Boolean),
  };
}

module.exports = {
  DEFAULT_TIMEOUT_MS, ENV_ALLOW, ENV_ALLOW_PREFIX, FOREIGN_PROBES, PROBES, ANTIGRAVITY_BIN, ANTIGRAVITY_MODELS_ARGS, CLOSED_MARKER,
  probeEnv, runBinary, runCommand, probe, collect,
  parseClaudeAuthStatus, claudeKeyProbe, claudeExpiry, parseCodexLoginStatus, codexAuthExpiry, jwtExpiry, smokeRecord,
  parseAntigravityModels, antigravityProbe, gatewayProbe, snapshotReading,
};
