'use strict';
/**
 * The child env of a headless worker — an allowlist, never the parent env (plan M6, REQ-601, D42).
 *
 * WHY. An inherited ANTHROPIC_*, CLAUDE*, OPENAI_* or CODEX_* variable makes the worker a nested session, or bills a
 * key the account does not own. NODE_OPTIONS, NODE_EXTRA_CA_CERTS, SSL_CERT_*, *_PROXY, LD_PRELOAD and XDG_CONFIG_HOME
 * redirect or wrap the worker without a trace. So the child gets five inherited variables, the account's own block,
 * and its config dir variable (CLAUDE_CONFIG_DIR or CODEX_HOME). Nothing else.
 *
 * A key never enters through the environment (D20): an account block that names a key variable is refused. Values
 * are copied, never read or printed. Pure.
 */
const path = require('path');
const { CONFIG_DIR_VAR } = require('./account-paths.cjs');

const ALLOW = Object.freeze(['PATH', 'HOME', 'LANG', 'TERM', 'TMPDIR']);
/** What Node and npm need to start at all on Windows; inherited there only. */
const ALLOW_WIN32 = Object.freeze(['Path', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'ComSpec', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP']);
const NEVER = Object.freeze([
  /^ANTHROPIC_/i, /^CLAUDE/i, /^OPENAI_/i, /^CODEX_/i, /^GEMINI_/i,
  /^NODE_OPTIONS$/i, /^NODE_EXTRA_CA_CERTS$/i, /^SSL_CERT_/i, /_PROXY$/i, /^LD_PRELOAD$/i, /^XDG_CONFIG_HOME$/i,
]);
const KEY_VARS = /^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|OPENAI_API_KEY|CODEX_API_KEY|GEMINI_API_KEY|GOOGLE_API_KEY)$/i;

/** Is `name` a variable the child never inherits? */
const neverInherited = (name) => NEVER.some((re) => re.test(name));

/**
 * @param {object} parent      the parent env (process.env)
 * @param {{ worker: 'claude-code'|'codex', configDir: string, accountEnv?: object, platform?: string }} o
 */
function childEnv(parent, { worker, configDir, accountEnv = {}, platform = process.platform }) {
  const dirVar = CONFIG_DIR_VAR[worker];
  if (!dirVar) throw new Error(`worker-env: unknown worker ${JSON.stringify(worker)} (claude-code | codex)`);
  if (typeof configDir !== 'string' || !path.isAbsolute(configDir)) throw new Error(`worker-env: configDir must be an absolute path (got ${JSON.stringify(configDir)})`);
  const out = {};
  const allow = platform === 'win32' ? [...ALLOW, ...ALLOW_WIN32] : ALLOW;
  for (const k of allow) if (parent[k] !== undefined && !neverInherited(k)) out[k] = parent[k];
  for (const [k, v] of Object.entries(accountEnv || {})) {
    if (KEY_VARS.test(k)) throw new Error(`refused: ${k} in the account env block — a key never enters a worker through the environment (npx builder-pipeline accounts key)`);
    if (v === null || v === undefined) continue;
    out[k] = String(v);
  }
  out[dirVar] = configDir;
  return out;
}

module.exports = { ALLOW, ALLOW_WIN32, NEVER, KEY_VARS, neverInherited, childEnv };
