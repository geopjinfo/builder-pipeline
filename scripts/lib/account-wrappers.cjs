'use strict';
/**
 * The wrappers and composed settings of an account — `npx builder accounts install` (plan M11, REQ-1101, REQ-1103,
 * REQ-1106, REQ-1109; D19, D38, D41, D52). Pure composition: the install step (accounts-lock.cjs) writes the plan.
 *
 * WHY. A person switches account by running `<accounts home>/bin/<name>` instead of `claude` or `codex`. The wrapper
 * does four things and nothing else: it unsets the denylist (worker-env.cjs NEVER, as shell patterns), checks the
 * sandbox-runtime settings when present, points the tool at the account's own config dir, and starts the tool. The
 * token never crosses the wrapper: a Claude account reads it through `apiKeyHelper` in its settings.json; a Codex
 * gateway account binds `model_providers.gateway.env_key` to one budget-capped key the wrapper exports under its own
 * name. No wrapper exports ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY. A subscription account's settings never name a
 * base URL. The free lane's combo is resolved at write time from the gateway policy: a policy that closes it yields
 * a refusal wrapper that only explains why (marker line `# builder-pipeline: closed`); an unreadable policy leaves a
 * working wrapper alone.
 */
const fs = require('fs');
const path = require('path');
const { helperCommand } = require('./account-secrets.cjs');
const { CONFIG_DIR_VAR } = require('./account-paths.cjs');

const KIT_MARKER = 'builder-pipeline: wrapper v1';
const CLOSED_MARKER = '# builder-pipeline: closed';
const DENY_SH = 'ANTHROPIC_*|CLAUDE*|OPENAI_*|CODEX_*|GEMINI_*|NODE_OPTIONS|NODE_EXTRA_CA_CERTS|SSL_CERT_*|*_PROXY|*_proxy|LD_PRELOAD|XDG_CONFIG_HOME';
const DENY_PS1_RE = '^(ANTHROPIC_|CLAUDE|OPENAI_|CODEX_|GEMINI_|NODE_OPTIONS$|NODE_EXTRA_CA_CERTS$|SSL_CERT_|.*_PROXY$|LD_PRELOAD$|XDG_CONFIG_HOME$)';
const GATEWAY_KEY_VAR = 'BUILDER_GATEWAY_KEY';
const DEFAULT_API_HOST = 'https://api.anthropic.com';
const TEMPLATES = path.join(__dirname, '..', '..', 'templates');
const q1 = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const fill = (text, vars) => text.replace(/@([A-Z0-9_]+)@/g, (m, k) => (k in vars ? vars[k] : m)).replace(/\n{3,}/g, '\n\n');
const template = (f) => fs.readFileSync(path.join(TEMPLATES, f), 'utf8');

/** The kind of an account for composition: its `pays`. */
const kindOf = (a) => a.pays;

/** Resolve the gateway policy for an account: { combo, aliases } | { closed: reason } | { unreadable: true }. */
function resolvePolicy(policyText, account) {
  if (policyText === null || policyText === undefined) return { unreadable: true, reason: 'no gateway policy file' };
  let d;
  try {
    d = JSON.parse(policyText);
  } catch (_) {
    return { unreadable: true, reason: 'the gateway policy is not JSON' };
  }
  const p = d && d.profile;
  const prof = d && d.profiles && d.profiles[p];
  if (!prof) return { unreadable: true, reason: `the gateway policy names no profile "${p}"` };
  const paid = (d.pool && Array.isArray(d.pool.paid) ? d.pool.paid : []).filter((m) => typeof m === 'string');
  const pick = (re) => paid.find((m) => re.test(m)) || null;
  const aliases = { opus: pick(/opus/i), sonnet: pick(/sonnet/i), haiku: pick(/haiku/i) };
  const kind = kindOf(account);
  if (kind === 'free') {
    if (prof.freeAllowed !== true) return { closed: `profile "${p}" has freeAllowed false — edit the gateway policy, run npx builder accounts policy apply, then npx builder accounts install` };
    return { combo: `claude-auto-cheap-${p}`, aliases: null };
  }
  if (kind === 'gateway') {
    if (prof.claudeApiAllowed !== true) return { closed: `profile "${p}" has claudeApiAllowed false — edit the gateway policy, run npx builder accounts policy apply, then npx builder accounts install` };
    const combo = `claude-${prof.default || 'auto-balanced'}-${p}`;
    return { combo, aliases: aliases.sonnet ? aliases : null };
  }
  return { combo: null, aliases: null };
}

/** The composed settings.json of a Claude Code account. */
function composeClaudeSettings({ name, account, kitRoot, resolved = {} }) {
  const kind = kindOf(account);
  const s = {};
  if (kind !== 'subscription') s.apiKeyHelper = helperCommand(kitRoot, name);
  if (kind === 'gateway' || kind === 'free') {
    if (!account.baseUrl) throw new Error(`refused: account "${name}" pays by ${kind} and names no baseUrl`);
    const env = { ANTHROPIC_BASE_URL: account.baseUrl, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
    const combo = resolved.combo || null;
    const al = resolved.aliases;
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = (al && al.opus) || combo || 'opus';
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = (al && al.sonnet) || combo || 'sonnet';
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = (al && al.haiku) || combo || 'haiku';
    if (kind === 'gateway') {
      s.promptCacheTtl = '1h';
      env.CLAUDE_CODE_SUBAGENT_MODEL = 'haiku';
      if (al && al.opus && al.sonnet && al.haiku) s.modelOverrides = { 'claude-haiku-5-5': al.haiku, 'claude-sonnet-5-5': al.sonnet, 'claude-opus-5-5': al.opus };
    } else {
      Object.assign(env, { CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '100000', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '16000' });
    }
    s.env = env;
  }
  if (kind === 'subscription' && account.baseUrl) throw new Error(`refused: a subscription account never sets a base URL (${name})`);
  return s;
}

/** The composed config.toml of a Codex account on a gateway: the provider, bound to the key variable the wrapper exports. */
function composeCodexConfig({ name, account, resolved = {} }) {
  const kind = kindOf(account);
  if (kind !== 'gateway' && kind !== 'free') return null;
  if (!account.baseUrl) throw new Error(`refused: account "${name}" pays by ${kind} and names no baseUrl`);
  const model = resolved.combo || 'gateway-default';
  return [
    `# builder-pipeline: wrapper v1 ${name} — written by npx builder accounts install; Codex reads it only under this account's CODEX_HOME.`,
    'model_provider = "gateway"',
    `model = "${model}"`,
    '',
    '[model_providers.gateway]',
    'name                 = "gateway"',
    `base_url             = "${account.baseUrl.replace(/\/$/, '')}/v1"`,
    `env_key              = "${GATEWAY_KEY_VAR}"`,
    'requires_openai_auth = false',
    '',
  ].join('\n');
}

/** Why `obj` is not a sandbox-runtime settings file the wrapper accepts, as a list (empty = fine). */
function srtFaults(obj) {
  const out = [];
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return ['not an object'];
  const KNOWN = ['denyRead', 'allowWrite', 'credentials'];
  for (const k of Object.keys(obj)) if (!KNOWN.includes(k)) out.push(`unknown key: ${k}`);
  for (const k of ['denyRead', 'allowWrite']) if (!Array.isArray(obj[k]) || !obj[k].every((s) => typeof s === 'string')) out.push(`${k}: a list of paths`);
  const c = obj.credentials;
  if (!c || typeof c !== 'object') out.push('credentials: an object { mask, inject }');
  else {
    for (const k of Object.keys(c)) if (!['mask', 'inject'].includes(k)) out.push(`credentials: unknown key: ${k}`);
    for (const k of ['mask', 'inject']) if (!Array.isArray(c[k])) out.push(`credentials.${k}: a list`);
  }
  return out;
}

/** The sandbox-runtime settings of one Claude Code account (REQ-1109). */
function srtSettings({ name, paths: p, otherDirs, osHome, laneWorktree, apiHost = DEFAULT_API_HOST }) {
  return {
    denyRead: [...otherDirs.filter((d) => d !== p.dir), path.join(osHome, '.claude'), path.join(osHome, '.codex')],
    allowWrite: [laneWorktree],
    credentials: {
      mask: [{ file: p.keyFile, name: `account key ${name}` }],
      inject: [{ file: p.keyFile, header: 'x-api-key', hosts: [apiHost] }],
    },
  };
}

/** The refusal wrappers (REQ-1103): they explain why and exit 1; the marker line lets a probe recognise them. */
function refusalSh(name, reason) {
  return `#!/bin/sh\n${CLOSED_MARKER}\n# ${KIT_MARKER} ${name}\necho ${q1(`${name}: this lane is closed: ${reason}`)} >&2\nexit 1\n`;
}
function refusalPs1(name, reason) {
  return `${CLOSED_MARKER}\n# ${KIT_MARKER} ${name}\n[Console]::Error.WriteLine('${`${name}: this lane is closed: ${reason}`.replace(/'/g, "''")}')\nexit 1\n`;
}

/** The sh wrapper of a Claude Code or Codex account. */
function wrapperSh({ name, account, paths: p, kitRoot, resolved = {}, nodeBin = process.execPath, note = '' }) {
  const kind = kindOf(account);
  const claude = account.worker === 'claude-code';
  const needsKey = kind === 'gateway' || kind === 'free' || kind === 'api-key';
  const check = path.join(kitRoot, 'scripts', 'lib', 'srt-check.cjs');
  const vars = {
    NAME: name,
    NOTE: note || `${account.worker} account, pays by ${kind}${account.note ? `: ${account.note}` : ''}`,
    DENYLIST: DENY_SH,
    DIR_VAR: CONFIG_DIR_VAR[account.worker],
    DIR: p.configDir,
    SRT_CHECK: claude ? `srt=${q1(p.srtSettingsFile)}\nif [ -f "$srt" ]; then\n  ${q1(nodeBin)} ${q1(check)} "$srt" || { echo "$name: refusing the launch: $srt is not a valid sandbox-runtime settings file" >&2; exit 1; }\nfi` : '',
    KEY_CHECK: needsKey ? `[ -s ${q1(p.keyFile)} ] || { echo "$name: no key yet: run npx builder accounts key ${name}" >&2; exit 1; }` : '',
    KEY_EXPORT: !claude && needsKey ? `${GATEWAY_KEY_VAR}="$(cat ${q1(p.keyFile)})"; export ${GATEWAY_KEY_VAR}` : '',
    LAUNCH: claude ? `if [ -f "$srt" ] && command -v srt >/dev/null 2>&1; then exec srt --settings "$srt" claude "$@"; fi\nexec claude "$@"` : 'exec codex "$@"',
  };
  return fill(template('account-wrapper.sh'), vars);
}

/** The PowerShell wrapper. */
function wrapperPs1({ name, account, paths: p, kitRoot, nodeBin = process.execPath, note = '' }) {
  const kind = kindOf(account);
  const claude = account.worker === 'claude-code';
  const needsKey = kind === 'gateway' || kind === 'free' || kind === 'api-key';
  const check = path.join(kitRoot, 'scripts', 'lib', 'srt-check.cjs');
  const ps = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const vars = {
    NAME: name,
    NOTE: note || `${account.worker} account, pays by ${kind}${account.note ? `: ${account.note}` : ''}`,
    DENYLIST_RE: DENY_PS1_RE,
    DIR_VAR: CONFIG_DIR_VAR[account.worker],
    DIR: p.configDir.replace(/'/g, "''"),
    SRT_CHECK: claude ? `$srt = ${ps(p.srtSettingsFile)}\nif (Test-Path $srt) { & ${ps(nodeBin)} ${ps(check)} $srt; if ($LASTEXITCODE -ne 0) { [Console]::Error.WriteLine("$name: refusing the launch: $srt is not a valid sandbox-runtime settings file"); exit 1 } }` : '',
    KEY_CHECK: needsKey ? `if (-not (Test-Path ${ps(p.keyFile)})) { [Console]::Error.WriteLine("$name: no key yet: run npx builder accounts key ${name}"); exit 1 }` : '',
    KEY_EXPORT: !claude && needsKey ? `$env:${GATEWAY_KEY_VAR} = (Get-Content -Raw ${ps(p.keyFile)}).Trim()` : '',
    LAUNCH: claude ? `if ((Test-Path $srt) -and (Get-Command srt -ErrorAction SilentlyContinue)) { & srt --settings $srt claude @args } else { & claude @args }` : '& codex @args',
  };
  return fill(template('account-wrapper.ps1'), vars);
}

/** The Antigravity wrapper (REQ-1106): SSH_* dropped only while a session bus is reachable. */
function antigravityWrapperSh({ name, busReachable }) {
  return [
    '#!/bin/sh',
    `# ${KIT_MARKER} ${name} — Antigravity CLI on the login kept in the desktop keyring.`,
    '# agy reads SSH_CONNECTION, SSH_CLIENT or SSH_TTY and then uses a file login store instead of the keyring, so a worker',
    '# started over ssh reports "not signed in". While the session bus is reachable the keyring is too, and the variables',
    '# are dropped for this one process. Without a bus nothing is changed.',
    'bus="/run/user/$(id -u)/bus"',
    'if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ] && [ -S "$bus" ]; then DBUS_SESSION_BUS_ADDRESS="unix:path=$bus"; export DBUS_SESSION_BUS_ADDRESS; fi',
    ...(busReachable ? ['unset SSH_CONNECTION SSH_CLIENT SSH_TTY'] : ['# no session bus at install time: SSH_* kept']),
    'exec agy "$@"',
    '',
  ].join('\n');
}

/**
 * The install plan: every file to write under the accounts home, plus the lines to print (the free-model MCP
 * registration, never written). `existing(file)` says whether a file is already there (for the unreadable-policy rule).
 */
function plan({ settings, home, kitRoot, policyText, osHome, accountPaths, nodeBin = process.execPath }) {
  const accounts = (settings.features && settings.features.accounts && settings.features.accounts.accounts) || {};
  const names = Object.keys(accounts);
  const files = [];
  const notes = [];
  const allDirs = names.map((n) => accountPaths.paths(home, n, accounts[n]).dir);
  for (const name of names) {
    const account = accounts[name];
    if (!['claude-code', 'codex'].includes(account.worker)) continue; // the session itself gets no wrapper
    const p = accountPaths.paths(home, name, account);
    const kind = kindOf(account);
    const resolved = kind === 'gateway' || kind === 'free' ? resolvePolicy(policyText, account) : { combo: null, aliases: null };
    const add = (file, text, mode, kindOfFile) => files.push({ file, text, mode, kind: kindOfFile, account: name });
    if (resolved.unreadable) {
      notes.push(`${name}: the gateway policy is unreadable (${resolved.reason}) — a working wrapper is left alone; a missing one is written with defaults`);
    }
    if (resolved.closed) {
      add(p.wrapperSh, refusalSh(name, resolved.closed), 0o755, 'wrapper');
      add(p.wrapperPs1, refusalPs1(name, resolved.closed), 0o644, 'wrapper');
      continue;
    }
    const keepIfPresent = !!resolved.unreadable;
    const mark = (f) => ({ ...f, keepIfPresent });
    if (account.worker === 'claude-code') {
      files.push(mark({ file: p.settingsFile, text: JSON.stringify(composeClaudeSettings({ name, account, kitRoot, resolved }), null, 2) + '\n', mode: 0o600, kind: 'settings', account: name }));
      files.push(mark({ file: p.srtSettingsFile, text: JSON.stringify(srtSettings({ name, paths: p, otherDirs: allDirs, osHome, laneWorktree: path.join(home, 'lanes', name), apiHost: account.baseUrl || DEFAULT_API_HOST }), null, 2) + '\n', mode: 0o600, kind: 'srt', account: name }));
    } else {
      const toml = composeCodexConfig({ name, account, resolved });
      if (toml) files.push(mark({ file: p.codexConfigFile, text: toml, mode: 0o600, kind: 'codex-config', account: name }));
    }
    files.push(mark({ file: p.wrapperSh, text: wrapperSh({ name, account, paths: p, kitRoot, resolved, nodeBin }), mode: 0o755, kind: 'wrapper', account: name }));
    files.push(mark({ file: p.wrapperPs1, text: wrapperPs1({ name, account, paths: p, kitRoot, nodeBin }), mode: 0o644, kind: 'wrapper', account: name }));
  }
  const mcp = settings.features && settings.features.freeModelMcp;
  const registration = {
    mcpServers: { 'free-model': { command: 'node', args: [path.join(kitRoot, 'tooling', 'experimental', 'free-model-mcp.cjs')], env: {} } },
  };
  notes.push(`free-model MCP registration (printed, never written; ${mcp && mcp.state === 'experimental-on' ? 'experimental-on' : 'experimental-off — switch features.freeModelMcp on first'}):\n${JSON.stringify(registration, null, 2)}`);
  return { files, notes };
}

module.exports = {
  KIT_MARKER, CLOSED_MARKER, DENY_SH, DENY_PS1_RE, GATEWAY_KEY_VAR, DEFAULT_API_HOST,
  kindOf, resolvePolicy, composeClaudeSettings, composeCodexConfig, srtFaults, srtSettings, refusalSh, refusalPs1, wrapperSh, wrapperPs1, antigravityWrapperSh, plan,
};
