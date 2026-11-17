'use strict';
/**
 * Where an account's files live — the one layout every accounts module shares (plan M1, REQ-108).
 *
 * WHY. The readiness probes (M2a), the content policy (M4), the worker adapters (M6) and the accounts command (M10)
 * all need the same answer to "where is this account's config dir, key file, lease and settings?". One pure module
 * answers it, so a key is never looked for in two places and a lease is never held in one place and checked in
 * another.
 *
 * LAYOUT. Accounts live OUTSIDE the project: a Claude Code config dir or a Codex home holds credentials, so it is
 * never committed. The home is `$BUILDER_ACCOUNTS_HOME`, else `<os home>/.builder-pipeline`. Under it:
 *
 *   accounts/<name>/            the account dir (0700): CLAUDE_CONFIG_DIR or CODEX_HOME for the worker
 *   accounts/<name>/settings.json   the account's own Claude Code settings (apiKeyHelper, env block) — kit-written
 *   accounts/<name>/key             the API key, 0600, written only by `accounts key` (never read here)
 *   accounts/<name>/lease.json      { pid, startedAt, lane } while a worker runs on the account
 *   accounts/<name>/smoke.json      the last smoke-test result and its time
 *   accounts/<name>/srt-settings.json  the sandbox-runtime profile (M11)
 *   accounts.lock.json          wrappers and composed settings the kit wrote (D38: not builder.lock.json)
 *   bin/<name>, bin/<name>.ps1  the wrappers (M11)
 *
 * An account whose §16 entry names `configDir` uses that dir instead of accounts/<name>; the other files still
 * live under accounts/<name>. Pure: no filesystem access.
 */
const path = require('path');
const os = require('os');

const HOME_DIR_NAME = '.builder-pipeline';
const ENV_HOME = 'BUILDER_ACCOUNTS_HOME';
const NAME_RULE = /^[a-z][a-z0-9]{0,15}$/;
/** Names the CLI uses as subcommands or flags; never an account. */
const RESERVED = Object.freeze(['all', 'none', 'add', 'note', 'key', 'remove', 'list', 'migrate', 'install', 'policy', 'usage-snapshot', 'session', 'help']);

/** The accounts home: `$BUILDER_ACCOUNTS_HOME`, else `~/.builder-pipeline`. */
function home(env = process.env, osHome = os.homedir()) {
  const v = env && env[ENV_HOME];
  return v && String(v).trim() ? path.resolve(String(v)) : path.join(osHome, HOME_DIR_NAME);
}

/** Why `name` is not an account name, or null. */
function nameProblem(name) {
  if (typeof name !== 'string' || !NAME_RULE.test(name)) return `an account name matches ${NAME_RULE} (got ${JSON.stringify(name)})`;
  if (RESERVED.includes(name)) return `"${name}" is a reserved name (${RESERVED.join(', ')})`;
  return null;
}

function accountDir(homeDir, name) {
  const why = nameProblem(name);
  if (why) throw new Error(`account-paths: ${why}`);
  return path.join(homeDir, 'accounts', name);
}

/** Every path of one account. `account.configDir` (from §16) overrides the config dir only. */
function paths(homeDir, name, account = {}) {
  const dir = accountDir(homeDir, name);
  const configDir = account && typeof account.configDir === 'string' && account.configDir ? path.resolve(homeDir, account.configDir) : dir;
  return Object.freeze({
    name,
    dir,
    configDir,
    settingsFile: path.join(configDir, 'settings.json'),
    codexConfigFile: path.join(configDir, 'config.toml'),
    codexAuthFile: path.join(configDir, 'auth.json'),
    keyFile: path.join(dir, 'key'),
    leaseFile: path.join(dir, 'lease.json'),
    smokeFile: path.join(dir, 'smoke.json'),
    srtSettingsFile: path.join(dir, 'srt-settings.json'),
    wrapperSh: path.join(homeDir, 'bin', name),
    wrapperPs1: path.join(homeDir, 'bin', `${name}.ps1`),
  });
}

const lockFile = (homeDir) => path.join(homeDir, 'accounts.lock.json');

/** The variable a worker reads its config dir from. */
const CONFIG_DIR_VAR = Object.freeze({ 'claude-code': 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME' });

module.exports = { HOME_DIR_NAME, ENV_HOME, NAME_RULE, RESERVED, CONFIG_DIR_VAR, home, nameProblem, accountDir, paths, lockFile };
