'use strict';
/**
 * Content policy and settings scan — what gate-launch checks before a lane starts on an account
 * (plan M4, REQ-401 to REQ-404, decisions D5, D23, D40).
 *
 * WHY. An account is a data recipient: whatever the worker reads leaves for that account's provider. The project
 * says how visible it is (§1 `visibility`, machine-read as the top-level `visibility` of the pipeline-settings block,
 * default `private`); an account says what it may see (`content`: public, scratch, any, or a list of path roots).
 * The check fails closed before the launch and a refusal names the class, the key or the path — never file text,
 * never a value (mirrors the outbound guard: never redact and send anyway).
 *
 *   E_CONTENT_PUBLIC  a `public` or `scratch` account asked to launch on a private project (REQ-401)
 *   E_PATH_ROOTS      a claimed file outside the account's path roots, or a worker adapter that cannot apply the
 *                     deny rules the roots need (REQ-402); the message names the path, never its content
 *   E_DATA_RECIPIENT  a free or gateway account, or one with a baseUrl, with no decision-log row whose id matches
 *                     `decisionIdPattern` and whose text names the account or its baseUrl host (REQ-403)
 *   E_SETTINGS        `.claude/settings.json` / `.claude/settings.local.json` of the project and of the lane worktree,
 *                     and the account's own settings file, carry `apiKeyHelper`, an `env.ANTHROPIC_*` or
 *                     `env.CLAUDE_CODE_*` key, a proxy or CA variable, or a hook not recorded in builder.lock.json
 *                     (REQ-404, D40). The account's OWN settings file is kit-written: it may carry `apiKeyHelper`
 *                     (the key probe of REQ-208) and an `env.ANTHROPIC_BASE_URL` equal to the account's `baseUrl`,
 *                     nothing else of that list; an env value shaped like a secret is refused by its kind.
 *
 * Pure over the arguments; `readSettingsFiles` is the one helper that reads files (it returns their text for `check`).
 */
const fs = require('node:fs');
const { PATTERNS } = require('./outbound-guard.cjs');

const CODES = Object.freeze(['E_CONTENT_PUBLIC', 'E_PATH_ROOTS', 'E_DATA_RECIPIENT', 'E_SETTINGS']);
const PUBLIC_ONLY = Object.freeze(['public', 'scratch']);
/** Proxy and CA variables, matched without regard to case (http_proxy is read in lower case by most clients). */
const PROXY_CA_VARS = Object.freeze([
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'FTP_PROXY',
  'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'GIT_SSL_CAINFO',
]);
const PROXY_CA = new Set(PROXY_CA_VARS);
const PATH_TOKEN = /[/\\]|\.(?:cjs|mjs|js|sh|ps1|py)$/i;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const fault = (code, check, message) => ({ code, check, message: `${code}: ${message}` });

/** A project-relative path as forward-slash segments: `./`, `\`, a trailing slash and empty segments dropped. */
const norm = (p) => String(p).replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+$/, '').replace(/\/{2,}/g, '/');
const under = (file, root) => file === root || file.startsWith(`${root}/`);

/** The account's path roots (normalised), or null when its content is a class word. */
function pathRoots(account) {
  if (!account || !Array.isArray(account.content)) return null;
  return account.content.map(norm).filter(Boolean);
}

/** The claimed files that lie outside every root (REQ-402). */
function outsideRoots(files, roots) {
  const rs = roots.map(norm);
  return (files || []).filter((f) => !rs.some((r) => under(norm(f), r)));
}

/** The host of a URL, or null. */
function hostOf(url) {
  try {
    return new URL(String(url)).hostname || null;
  } catch (_) {
    return null;
  }
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** An account is a data recipient when a provider other than the subscription's own receives its prompts. */
const isDataRecipient = (a) => a.pays === 'free' || a.pays === 'gateway' || !!a.baseUrl;

/** Does one decision-log line carry an id matching `pattern` AND name the account (whole word) or its baseUrl host? */
function hasDecision(text, { name, host, pattern }) {
  let id;
  try {
    id = new RegExp(pattern);
  } catch (_) {
    id = /D-\d+/;
  }
  const names = [new RegExp(`(?<![a-z0-9])${escapeRe(name)}(?![a-z0-9])`, 'i')];
  if (host) names.push(new RegExp(`(?<![a-z0-9.-])${escapeRe(host)}(?![a-z0-9-])`, 'i'));
  return String(text || '')
    .split(/\r?\n/)
    .some((line) => id.test(line) && names.some((re) => re.test(line)));
}

/**
 * Read the settings files that exist. `entries` = [{ file, role }] (role: project | worktree | account).
 * @returns {Array<{ file: string, role: string, text: string }>}
 */
function readSettingsFiles(entries) {
  const out = [];
  for (const e of entries || []) {
    let text;
    try {
      text = fs.readFileSync(e.file, 'utf8');
    } catch (_) {
      continue;
    }
    out.push({ file: e.file, role: e.role || 'project', text });
  }
  return out;
}

/** Why an env KEY is refused in a settings file, or null. Keys only: a value is never read here. */
function envKeyClass(key) {
  if (/^ANTHROPIC_/i.test(key)) return 'a provider routing or auth variable (env.ANTHROPIC_*)';
  if (/^CLAUDE_CODE_/i.test(key)) return 'a harness behaviour variable (env.CLAUDE_CODE_*)';
  if (PROXY_CA.has(String(key).toUpperCase())) return 'a proxy or CA variable';
  return null;
}

/** Is a hook command's script one the lock records (a path token equal to, or ending in, a lock key)? */
function hookRecorded(command, lockFiles) {
  if (typeof command !== 'string' || !command.trim()) return false;
  const keys = (lockFiles || []).map(norm);
  if (!keys.length) return false;
  const tokens = command
    .split(/\s+/)
    .map((t) => t.replace(/^["']+|["']+$/g, '').replace(/^"?\$\{?CLAUDE_PROJECT_DIR\}?"?\/?/, '').replace(/^["']+/, ''))
    .filter((t) => t && PATH_TOKEN.test(t))
    .map(norm);
  return tokens.some((t) => keys.some((k) => t === k || t.endsWith(`/${k}`)));
}

/**
 * Scan one settings file (REQ-404). Returns faults naming the key and the file, never a value.
 * @param {{ file: string, role: string, text: string }} entry
 * @param {{ account?: object, lockFiles?: string[], secretPatterns?: Array<[string, RegExp]> }} ctx
 */
function scanSettings(entry, ctx = {}) {
  const faults = [];
  const where = (key) => `${entry.file}: ${key}`;
  const say = (key, why) => faults.push(fault('E_SETTINGS', 'settings', `${where(key)} — ${why}; a launch never inherits a routing, auth, proxy, CA or hook setting from a settings file (remove the key, or move it into the account's own settings where the kit allows it)`));
  let s;
  try {
    s = JSON.parse(entry.text);
  } catch (_) {
    faults.push(fault('E_SETTINGS', 'settings', `${entry.file}: not valid JSON — the settings scan fails closed on a file it cannot read`));
    return faults;
  }
  if (!isObject(s)) {
    faults.push(fault('E_SETTINGS', 'settings', `${entry.file}: not a JSON object — the settings scan fails closed`));
    return faults;
  }
  const own = entry.role === 'account';
  const account = ctx.account || {};
  if (s.apiKeyHelper !== undefined && !own) say('apiKeyHelper', 'a key helper');
  if (s.env !== undefined) {
    if (!isObject(s.env)) say('env', 'not an object');
    else {
      for (const [k, v] of Object.entries(s.env)) {
        const cls = envKeyClass(k);
        if (cls) {
          const ownRoute = own && k === 'ANTHROPIC_BASE_URL' && account.baseUrl && typeof v === 'string' && norm(v) === norm(account.baseUrl);
          if (!ownRoute) say(`env.${k}`, cls);
          continue;
        }
        if (own && typeof v === 'string') {
          const hit = (ctx.secretPatterns || PATTERNS).find(([, re]) => re.test(v));
          if (hit) say(`env.${k}`, `holds a secret-shaped value (${hit[0]}); a key lives in the account's key file, never in settings`);
        }
      }
    }
  }
  if (s.hooks !== undefined) {
    if (!isObject(s.hooks)) say('hooks', 'not an object');
    else {
      for (const [event, matchers] of Object.entries(s.hooks)) {
        if (!Array.isArray(matchers)) {
          say(`hooks.${event}`, 'a hook not recorded in builder.lock.json (unreadable shape)');
          continue;
        }
        matchers.forEach((m, i) => {
          const list = isObject(m) && Array.isArray(m.hooks) ? m.hooks : null;
          if (!list) {
            say(`hooks.${event}[${i}]`, 'a hook not recorded in builder.lock.json (unreadable shape)');
            return;
          }
          list.forEach((h, j) => {
            const ok = isObject(h) && h.type === 'command' && hookRecorded(h.command, ctx.lockFiles);
            if (!ok) say(`hooks.${event}[${i}].hooks[${j}]`, 'a hook not recorded in builder.lock.json');
          });
        });
      }
    }
  }
  return faults;
}

/**
 * The deny-rule paths for a path-root account: every tracked entry beside the root chain, as `./x/**` for a folder
 * and `./x` for a file; nothing at or under a root. Pure over the tracked file list.
 */
function denyPathsFor(files, roots) {
  const rs = roots.map(norm).filter(Boolean);
  const all = (files || []).map(norm);
  const chain = new Set(['']);
  for (const r of rs) {
    const segs = r.split('/');
    for (let i = 1; i < segs.length; i++) chain.add(segs.slice(0, i).join('/'));
  }
  const out = [];
  const seen = new Set();
  for (const dir of [...chain].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))) {
    const prefix = dir ? `${dir}/` : '';
    const children = new Map(); // name → isDir
    for (const f of all) {
      if (!f.startsWith(prefix)) continue;
      const rest = f.slice(prefix.length);
      const cut = rest.indexOf('/');
      const name = cut === -1 ? rest : rest.slice(0, cut);
      if (!name) continue;
      children.set(name, children.get(name) || cut !== -1);
    }
    for (const [name, isDir] of [...children].sort((a, b) => a[0].localeCompare(b[0]))) {
      const full = prefix + name;
      if (chain.has(full) || rs.some((r) => under(full, r) || under(r, full))) continue;
      if (seen.has(full)) continue;
      seen.add(full);
      out.push(isDir ? `./${full}/**` : `./${full}`);
    }
  }
  return out;
}

/**
 * The policy check (REQ-401 to REQ-404). Ordered faults, `[]` when the launch may go on; `account` null = no policy.
 * @param {object|null} account   a registry account with its name (accounts-registry list())
 * @param {{ visibility?: string, decisionIdPattern?: string, decisionsPath?: string, lockFiles?: string[], canDeny?: boolean, secretPatterns?: Array }} project
 * @param {string[]} claimedFiles  the lane's owned and hot files (project-relative)
 * @param {string|null} decisions  the decision log's text (null or '' = no log)
 * @param {Array<{ file: string, role: string, text: string }>} settingsFiles  from readSettingsFiles
 * @returns {Array<{ code: string, check: string, message: string }>}
 */
function check(account, project = {}, claimedFiles = [], decisions = '', settingsFiles = []) {
  if (!account) return [];
  const faults = [];
  const name = account.name || '(unnamed)';
  const visibility = project.visibility === 'public' ? 'public' : 'private';
  // REQ-401
  if (PUBLIC_ONLY.includes(account.content) && visibility !== 'public') {
    faults.push(fault('E_CONTENT_PUBLIC', 'content', `account ${name} is content "${account.content}" and the project is visibility ${visibility} — a ${account.content}-only account never launches on a private project (set "visibility": "public" in PIPELINE_PROFILE.md §16 when the project is public, or place the lane on an account whose content is "any")`));
  }
  // REQ-402
  const roots = pathRoots(account);
  if (roots) {
    const outside = outsideRoots(claimedFiles, roots);
    for (const f of outside) faults.push(fault('E_PATH_ROOTS', 'path-roots', `${norm(f)} lies outside the path roots of account ${name} (${roots.join(', ')}) — the lane is not placed on this account`));
    if (project.canDeny === false) faults.push(fault('E_PATH_ROOTS', 'path-roots', `account ${name} has path roots (${roots.join(', ')}) and its worker ${account.worker} has no adapter here that applies deny rules outside them — the launch is refused`));
  }
  // REQ-403
  if (isDataRecipient(account)) {
    const host = account.baseUrl ? hostOf(account.baseUrl) : null;
    const pattern = project.decisionIdPattern || 'D-\\d+';
    if (!hasDecision(decisions, { name, host, pattern })) {
      const why = `pays ${account.pays}${host ? `, baseUrl host ${host}` : ''}`;
      faults.push(fault('E_DATA_RECIPIENT', 'data-recipient', `account ${name} is a data recipient (${why}) with no decision-log entry — add a row to ${project.decisionsPath || 'DECISIONS.md'} whose id matches ${pattern} and whose text names "${name}"${host ? ` or "${host}"` : ''}, then launch again (a new data recipient is the owner's decision)`));
    }
  }
  // REQ-404
  for (const entry of settingsFiles || []) faults.push(...scanSettings(entry, { account, lockFiles: project.lockFiles, secretPatterns: project.secretPatterns }));
  return faults;
}

module.exports = { CODES, PUBLIC_ONLY, PROXY_CA_VARS, check, scanSettings, readSettingsFiles, pathRoots, outsideRoots, isDataRecipient, hasDecision, hookRecorded, envKeyClass, denyPathsFor, hostOf };
