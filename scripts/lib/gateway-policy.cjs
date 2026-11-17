'use strict';
/**
 * The gateway policy — `accounts policy show | dry-run | apply` and `accounts usage-snapshot` (plan M11, REQ-1104,
 * REQ-1105, REQ-1108; D8, D43).
 *
 * The policy file (<accounts home>/gateway/policy.json, no secrets) says what the gateway should hold: a budget, the
 * model pool, pricing rows, one profile and the key names. An adapter (scripts/lib/gateways/) turns it into a request
 * plan against the gateway's current objects. The client is Node fetch only: `redirect: 'error'`, plain http to
 * loopback only, the management token from a 0600 file owned by the user, and every error reduced to an allowlist of
 * fields (method, path, status) — never a body, a header or a token. `apply` is idempotent and records a marker with
 * the policy's sha256, the gateway version and a copy of the policy, which `builder verify` reads for drift (REQ-1108)
 * without touching the network.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { adapter, KNOWN } = require('./gateways/index.cjs');

const DEFAULT_KIND = 'omniroute';
const DEFAULT_VERSION = '3.8';
const TIMEOUT_MS = 20000;
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\]|::1)$/i;

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const gatewayDir = (home) => path.join(home, 'gateway');
const defaults = (home, cfg = {}) => ({
  kind: cfg.kind || DEFAULT_KIND,
  version: String(cfg.version || DEFAULT_VERSION),
  baseUrl: cfg.baseUrl || 'http://127.0.0.1:20128',
  tokenFile: cfg.tokenFile || path.join(gatewayDir(home), 'mgmt.token'),
  policyFile: cfg.policyFile || path.join(gatewayDir(home), 'policy.json'),
  appliedFile: cfg.appliedFile || path.join(gatewayDir(home), 'policy.applied.json'),
});

/** Why `url` may not be used, or null: plain http reaches loopback only. */
function urlFault(url) {
  let u;
  try {
    u = new URL(url);
  } catch (_) {
    return `baseUrl ${JSON.stringify(url)} is not a URL`;
  }
  if (u.protocol === 'https:') return null;
  if (u.protocol !== 'http:') return `baseUrl ${url}: only http (loopback) or https`;
  return LOOPBACK.test(u.hostname) ? null : `baseUrl ${url}: plain http is allowed to loopback only (127.0.0.1, localhost, ::1)`;
}

/** The first problem of a policy document, or null. */
function validatePolicy(d) {
  const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
  if (!d || typeof d !== 'object') return 'policy: not an object';
  if (!d.budget || !isNum(d.budget.monthlyLimitUsd) || d.budget.monthlyLimitUsd <= 0) return 'policy: budget.monthlyLimitUsd must be a number above 0';
  if (!isNum(d.budget.warningThreshold) || d.budget.warningThreshold < 0 || d.budget.warningThreshold > 1) return 'policy: budget.warningThreshold must be between 0 and 1';
  if (typeof d.budget.resetTime !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(d.budget.resetTime)) return 'policy: budget.resetTime must be HH:MM';
  if (!d.pool || !Array.isArray(d.pool.paid) || !Array.isArray(d.pool.free)) return 'policy: pool.paid and pool.free must be lists';
  if (typeof d.profile !== 'string' || !d.profiles || !d.profiles[d.profile]) return 'policy: profile must name an entry of profiles';
  const prof = d.profiles[d.profile];
  if (typeof prof.claudeApiAllowed !== 'boolean' || typeof prof.freeAllowed !== 'boolean' || typeof prof.default !== 'string') return `policy: profiles.${d.profile} needs claudeApiAllowed, freeAllowed and default`;
  return null;
}

/** A pool or provider entry that is a subscription login is refused: a gateway never fronts a subscription (D43). */
function subscriptionFault(d) {
  const all = [...(d.pool && d.pool.paid ? d.pool.paid : []), ...(d.pool && d.pool.free ? d.pool.free : [])];
  const hit = all.find((m) => /^subscription\//i.test(String(m)) || /subscription/i.test(String(m)));
  if (hit) return `policy names a subscription provider (${hit}) — a gateway fronts API keys only; a subscription account is its own account`;
  if (d.providers && Object.values(d.providers).some((p) => p && /subscription/i.test(String(p.auth || p.pays || '')))) return 'policy names a subscription provider in providers — refused';
  return null;
}

class GatewayError extends Error {
  constructor({ method, path: p, status, code }) {
    super(`gateway ${method} ${p}: ${status !== undefined ? `HTTP ${status}` : code || 'request failed'}`);
    this.method = method;
    this.path = p;
    this.status = status;
    this.code = code;
  }
}

/** The management token from a 0600 file owned by the user. */
function readToken(file, { platform = process.platform } = {}) {
  let st;
  try {
    st = fs.statSync(file);
  } catch (_) {
    throw new Error(`no management token file at ${file} (write it with mode 0600)`);
  }
  if (platform !== 'win32') {
    const mode = st.mode & 0o777;
    if (mode !== 0o600) throw new Error(`the management token file ${file} has mode 0${mode.toString(8)}, not 0600 — refused`);
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error(`the management token file ${file} is not owned by this user — refused`);
  }
  const token = fs.readFileSync(file, 'utf8').split(/\r?\n/)[0].trim();
  if (!token) throw new Error(`the management token file ${file} is empty`);
  return token;
}

/** The HTTP client: fetch, no redirects, loopback-only plain http, allowlisted errors. */
function client(cfg, { fetchImpl = globalThis.fetch, platform = process.platform } = {}) {
  const fault = urlFault(cfg.baseUrl);
  if (fault) throw new Error(`refused: ${fault}`);
  if (typeof fetchImpl !== 'function') throw new Error('this Node has no fetch (Node 18 or newer is needed)');
  const base = cfg.baseUrl.replace(/\/$/, '');
  let token = null;
  const call = async (method, p, body) => {
    if (token === null) token = readToken(cfg.tokenFile, { platform });
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await fetchImpl(`${base}${p}`, { method, redirect: 'error', signal: ctl.signal, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (e) {
      throw new GatewayError({ method, path: p, code: /redirect/i.test(String(e && e.message)) || (e && e.cause && /redirect/i.test(String(e.cause.message))) ? 'redirect refused' : (e && e.name === 'AbortError' ? 'timeout' : 'connection failed') });
    } finally {
      clearTimeout(t);
    }
    if (!res.ok) throw new GatewayError({ method, path: p, status: res.status });
    const text = await res.text();
    try {
      return text ? JSON.parse(text) : {};
    } catch (_) {
      throw new GatewayError({ method, path: p, code: 'not JSON' });
    }
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), put: (p, b) => call('PUT', p, b), patch: (p, b) => call('PATCH', p, b) };
}

function readPolicy(file) {
  let d;
  try {
    d = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`cannot read the gateway policy ${file} (${e.code || 'not JSON'})`);
  }
  const bad = validatePolicy(d) || subscriptionFault(d);
  if (bad) throw new Error(`refused: ${bad}`);
  return d;
}

/** The dot paths whose values differ between the policy and the applied copy (REQ-1108). */
function drift(policy, marker) {
  const applied = marker && marker.policy;
  if (!applied) return ['(no applied marker)'];
  const out = [];
  const walk = (a, b, at) => {
    const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
    for (const k of keys) {
      const p = at ? `${at}.${k}` : k;
      const x = a ? a[k] : undefined;
      const y = b ? b[k] : undefined;
      if (x && y && typeof x === 'object' && typeof y === 'object' && !Array.isArray(x) && !Array.isArray(y)) walk(x, y, p);
      else if (JSON.stringify(x) !== JSON.stringify(y)) out.push(p);
    }
  };
  walk(policy, applied, '');
  return out.sort();
}

function readMarker(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

/** show | dry-run | apply. Throws with a redacted message on any failure. */
async function run(action, cfgIn, { home, fetchImpl, platform, now = new Date() } = {}) {
  const cfg = defaults(home, cfgIn);
  const a = adapter(cfg.kind);
  const policy = readPolicy(cfg.policyFile);
  const policyText = fs.readFileSync(cfg.policyFile, 'utf8');
  const c = client(cfg, { fetchImpl, platform });
  const current = await a.readCurrent(c, cfg.version);
  if (action === 'show') return { gateway: cfg.kind, version: cfg.version, capabilities: a.capabilities, ...a.summary(current, cfg.version), policy: { profile: policy.profile, budget: policy.budget, pool: policy.pool } };
  const planned = a.plan(policy, current, cfg.version);
  if (action === 'dry-run') return { gateway: cfg.kind, version: cfg.version, plan: planned };
  if (action !== 'apply') throw new Error(`accounts policy: unknown action "${action}" (show | dry-run | apply)`);
  const created = {};
  const applied = [];
  for (const req of planned) {
    const p = req.path.replace(/\{created:([^}]+)\}/, (m, n) => {
      if (!created[n]) throw new Error(`refused: key ${n} was to be created first, but no id came back`);
      return created[n];
    });
    const res = await c[req.method.toLowerCase()](p, req.body);
    if (req.creates && res && typeof res.id === 'string') created[req.creates] = res.id;
    applied.push({ method: req.method, path: p, why: req.why });
  }
  const marker = { sha256: sha256(policyText), gatewayVersion: await a.gatewayVersion(c, cfg.version), at: now.toISOString(), gateway: cfg.kind, pinned: cfg.version, policy };
  fs.mkdirSync(path.dirname(cfg.appliedFile), { recursive: true });
  fs.writeFileSync(`${cfg.appliedFile}.tmp`, JSON.stringify(marker, null, 2) + '\n');
  fs.renameSync(`${cfg.appliedFile}.tmp`, cfg.appliedFile);
  return { gateway: cfg.kind, version: cfg.version, applied, marker: { sha256: marker.sha256, gatewayVersion: marker.gatewayVersion, at: marker.at } };
}

/** `accounts usage-snapshot`: the shape the assessment reads (keys.<name>: spend, maxBudget, budgetResetAt). */
async function usageSnapshot(cfgIn, { home, out, fetchImpl, platform, now = new Date() } = {}) {
  const cfg = defaults(home, cfgIn);
  const a = adapter(cfg.kind);
  if (!a.capabilities.usage) throw new Error(`gateway ${cfg.kind} reports no usage`);
  const c = client(cfg, { fetchImpl, platform });
  const keys = await a.usage(c, cfg.version);
  const file = out || path.join(gatewayDir(home), 'usage.json');
  const doc = { generatedAt: Math.floor(now.getTime() / 1000), gateway: cfg.kind, keys };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(doc) + '\n', { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
  return { file, keys: Object.keys(keys).length };
}

/** The advisory row for `builder verify`: drift between the policy file and the applied marker, no network. */
function driftRow(home, cfgIn = {}) {
  const cfg = defaults(home, cfgIn);
  if (!fs.existsSync(cfg.policyFile)) return null;
  let policy;
  try {
    policy = JSON.parse(fs.readFileSync(cfg.policyFile, 'utf8'));
  } catch (_) {
    return `gateway policy ${cfg.policyFile} is not JSON`;
  }
  const marker = readMarker(cfg.appliedFile);
  const d = drift(policy, marker);
  if (!d.length) return null;
  return `gateway policy drift: ${d.join(', ')} — run npx builder-pipeline accounts policy dry-run, then npx builder-pipeline accounts policy apply`;
}

module.exports = { KNOWN, DEFAULT_KIND, DEFAULT_VERSION, GatewayError, defaults, urlFault, validatePolicy, subscriptionFault, readToken, client, readPolicy, drift, readMarker, run, usageSnapshot, driftRow, sha256 };
