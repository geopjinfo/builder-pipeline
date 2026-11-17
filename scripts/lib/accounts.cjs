'use strict';
/**
 * The readiness assessment — one pure verdict per account (plan M2a, REQ-201 to REQ-203, REQ-206, REQ-207, REQ-209 to
 * REQ-212; D3, D31, D46, D51).
 *
 * WHY. Placement (M3) and the report (M2b) both need the same answer to "may a lane start on this account, and how
 * much of its budget is gone?". The answer is computed here from facts somebody else gathered — probe results, smoke
 * records, version strings and usage readings — so the rule can be tested without a `claude` or `codex` binary and
 * so every caller renders the same line. `scripts/lib/account-probes.cjs` gathers the facts; this module never
 * touches the filesystem or a process.
 *
 * STATES. `ready`, `not ready` (always with a reason) or `unmeasured` (no probe exists or it gave no answer). An
 * unmeasured account is never ready by default (INVARIANTS). Two qualifiers keep an account ready while narrowing
 * it: `read-only: smoke stale` (REQ-206) and `balance unmeasured` (REQ-209, a key account whose spend nobody can
 * read; it sorts last).
 *
 * AUTH. A probe that exposes a credential expiry inside `authMinMinutes` (default 120) or in the past makes the
 * account `not ready` with the reason `AUTH until <ISO time>` and the sign-in command (REQ-211). Placement treats
 * AUTH like LIMIT: not ready until `until`.
 *
 * USAGE. Every reading carries a source — `measured` (a statusline `rate_limits` capture, a gateway snapshot, the
 * account's own `usageCommand`), `estimate` (computed from transcripts or pricing) or `unmeasured` — and the time it
 * was taken. Measured beats estimate; an estimate always renders with the word "estimate"; a model with no pinned
 * rate makes the estimate `unpriced`; no reading renders `unmeasured`, never `0 %` (REQ-212, D51).
 *
 * REDACTION. Every string the assessment carries goes through the outbound guard's secret shapes; a match becomes
 * `<redacted: <kind>>`, so a probe that echoes a key, a token or an env assignment never puts it in a report, a log
 * or a brief (REQ-202).
 */
const { PATTERNS } = require('./outbound-guard.cjs');
const registry = require('./accounts-registry.cjs');

const STATES = Object.freeze(['ready', 'not ready', 'unmeasured']);
const SOURCES = Object.freeze(['measured', 'estimate', 'unmeasured']);
/** The sign-in command per worker, named next to an AUTH or signed-out reason. */
const SIGN_IN = Object.freeze({ 'claude-code': 'claude auth login', codex: 'codex login' });
const RANK = Object.freeze({ ready: 0, unmeasured: 1, 'not ready': 2 });

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Milliseconds for a Date, a number or an ISO string; NaN when unreadable. */
function ms(v) {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return Date.parse(v);
  return NaN;
}
const iso = (v) => (Number.isFinite(ms(v)) ? new Date(ms(v)).toISOString() : null);
/** `HH:MM` (UTC) of a time, for the usage line. */
const hhmm = (v) => (Number.isFinite(ms(v)) ? new Date(ms(v)).toISOString().slice(11, 16) : null);

/** Replace every secret-shaped span with `<redacted: <kind>>`. The text of a match never comes back. */
function redact(text) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  for (const [kind, re] of PATTERNS) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    out = out.replace(g, `<redacted: ${kind}>`);
  }
  return out;
}

/** Redact every string inside a value, recursively. */
function redactDeep(value) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v)]));
  return value;
}

/* ---------------------------------------------------------------- usage readings ---- */

/** The readers an account has, in the order their readings are preferred. [] = unmeasured (REQ-210). */
function readersFor(account) {
  const a = account || {};
  const out = [];
  if (typeof a.usageCommand === 'string' && a.usageCommand.trim()) out.push('usageCommand');
  if (isObject(a.budget) && typeof a.budget.file === 'string' && a.budget.file) out.push('snapshot');
  if (a.worker === 'codex') out.push('codex-ratelimits');
  return out;
}

/**
 * `usageCommand` output: "$X of $Y" anywhere in the text (REQ-203). The reading is measured: the account owner's
 * own tool printed it.
 */
function parseUsageText(text, at) {
  const m = /\$\s*([0-9]+(?:[.,][0-9]+)?)\s*(?:of|\/)\s*\$\s*([0-9]+(?:[.,][0-9]+)?)/i.exec(String(text ?? ''));
  if (!m) return null;
  const used = Number(m[1].replace(',', '.'));
  const limit = Number(m[2].replace(',', '.'));
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return null;
  return { percent: round1((used / limit) * 100), usd: used, limitUsd: limit, source: 'measured', at: iso(at), reader: 'usageCommand' };
}

/**
 * A gateway usage snapshot: `{ spend, maxBudget, budgetResetAt }` (LiteLLM-style names), or `{ keys: { <key>: {...} } }`
 * indexed by `budget.key` (REQ-203). `until` is the budget reset.
 */
function parseGatewaySnapshot(json, at, key = null) {
  if (!isObject(json)) return null;
  let row = json;
  if (key) row = isObject(json.keys) && isObject(json.keys[key]) ? json.keys[key] : isObject(json[key]) ? json[key] : null;
  if (!isObject(row)) return null;
  const spend = num(row.spend);
  const max = num(row.maxBudget);
  if (spend === null) return null;
  const percent = max !== null && max > 0 ? round1((spend / max) * 100) : null;
  return { percent, usd: spend, limitUsd: max, until: iso(row.budgetResetAt), source: 'measured', at: iso(row.at ?? at), reader: 'snapshot' };
}

const round1 = (n) => Math.round(n * 10) / 10;

/** The reading placement should trust: measured beats estimate; a newer reading beats an older one of the same source. */
function pickReading(readings) {
  const list = (Array.isArray(readings) ? readings : readings ? [readings] : []).filter(isObject);
  const usable = list.filter((r) => r.source === 'measured' || r.source === 'estimate');
  usable.sort((a, b) => SOURCES.indexOf(a.source) - SOURCES.indexOf(b.source) || (ms(b.at) || 0) - (ms(a.at) || 0));
  return usable[0] || null;
}

/** The `budget.used` block: the chosen reading normalised, or the unmeasured marker. Never 0 % from nowhere. */
function used(reading) {
  const r = reading && pickReading([reading]);
  if (!r) return { percent: null, usd: null, source: 'unmeasured', at: null, until: null, reader: null, unpriced: false };
  const unpriced = r.unpriced === true || (r.source === 'estimate' && num(r.percent) === null && num(r.usd) === null);
  return {
    percent: unpriced ? null : num(r.percent),
    usd: unpriced ? null : num(r.usd),
    source: r.source,
    at: iso(r.at),
    until: iso(r.until),
    reader: typeof r.reader === 'string' ? r.reader : null,
    unpriced,
    ...(num(r.limitUsd) !== null ? { limitUsd: r.limitUsd } : {}),
    ...(typeof r.model === 'string' ? { model: r.model } : {}),
  };
}

/** `42 % (measured 09:14)`, `~40 % (estimate 09:30)`, `~$3.20 (estimate)`, `unpriced (estimate)`, `unmeasured`. */
function renderUsage(u) {
  if (!u || u.source === 'unmeasured') return 'unmeasured';
  const when = hhmm(u.at);
  const tag = `(${u.source}${when ? ` ${when}` : ''})`;
  const tilde = u.source === 'estimate' ? '~' : '';
  if (u.unpriced) return `unpriced ${tag}`;
  if (num(u.percent) !== null) return `${tilde}${u.percent} % ${tag}`;
  if (num(u.usd) !== null) return `${tilde}$${u.usd.toFixed(2)} ${tag}`;
  return 'unmeasured';
}

/* ------------------------------------------------------------------- assessment ---- */

/**
 * Assess one account from gathered facts. Pure.
 * @param {object} account    an account with its `name` (see accounts-registry `list()`)
 * @param {object} probes     { auth: null | { ok: boolean|null, reason?, method?, expiresAt?, signIn? },
 *                              smoke: null | { ok: boolean, at: ISO }, version: null | { version: string } }
 * @param {object|object[]} usage  readings { percent?, usd?, source, at?, until?, reader?, unpriced?, model? }
 * @param {Date|number|string} now
 * @param {{ authMinMinutes?: number, smokeMaxAgeHours?: number }} [settings]  from features.accounts
 */
function assess(account, probes = {}, usage = null, now = Date.now(), settings = {}) {
  const a = registry.withDefaults(account);
  a.name = account && account.name;
  const p = isObject(probes) ? probes : {};
  const cfg = { ...registry.FEATURE_DEFAULTS, ...(isObject(settings) ? settings : {}) };
  const nowMs = ms(now);
  const signIn = (p.auth && typeof p.auth.signIn === 'string' && p.auth.signIn) || SIGN_IN[a.worker] || null;

  let state;
  let reason = null;
  let until = null;
  const auth = isObject(p.auth) ? p.auth : null;
  if (auth && auth.ok === true) {
    state = 'ready';
  } else if (auth && auth.ok === false) {
    state = 'not ready';
    reason = typeof auth.reason === 'string' && auth.reason ? auth.reason : 'probe failed';
  } else if (a.worker === 'session') {
    // The orchestrating session itself: it is running, so it is signed in. Nothing is spawned on it.
    state = 'ready';
    reason = 'the orchestrating session';
  } else {
    state = 'unmeasured';
    reason = auth && typeof auth.reason === 'string' && auth.reason ? auth.reason : 'no probe';
  }
  // REQ-211: a credential that expires inside authMinMinutes, or has expired, is AUTH until <expiry>.
  const expires = auth ? ms(auth.expiresAt) : NaN;
  if (Number.isFinite(expires) && state !== 'not ready' && expires - nowMs <= cfg.authMinMinutes * 60000) {
    state = 'not ready';
    until = new Date(expires).toISOString();
    reason = `AUTH until ${until}`;
  }

  // REQ-206: with a smokeCommand, writing roles need a pass younger than smokeMaxAgeHours.
  let readOnly = false;
  let smokeNote = null;
  if (typeof a.smokeCommand === 'string' && a.smokeCommand.trim()) {
    const s = isObject(p.smoke) ? p.smoke : null;
    const at = s ? ms(s.at) : NaN;
    if (!s) smokeNote = 'smoke never passed';
    else if (s.ok === false) smokeNote = 'smoke failed';
    else if (!Number.isFinite(at) || nowMs - at > cfg.smokeMaxAgeHours * 3600000) smokeNote = 'smoke stale';
    readOnly = smokeNote !== null;
  }

  const u = used(pickReading(usage));
  const budget = isObject(a.budget) ? a.budget : {};
  const balanceUnmeasured = a.pays === 'api-key' && u.source === 'unmeasured';
  const version = isObject(p.version) && typeof p.version.version === 'string' && p.version.version.trim() ? p.version.version.trim() : 'unmeasured';

  return redactDeep({
    name: a.name,
    worker: a.worker,
    pays: a.pays,
    state,
    reason,
    qualifier: state === 'ready' ? (readOnly ? `read-only: ${smokeNote}` : balanceUnmeasured ? 'balance unmeasured' : null) : null,
    signIn: state === 'not ready' ? signIn : null,
    until,
    readOnly,
    balanceUnmeasured,
    note: typeof a.note === 'string' ? a.note : '',
    roles: Array.isArray(a.roles) ? [...a.roles] : [],
    version,
    readers: readersFor(a),
    budget: { kind: budget.kind ?? null, soft: budget.soft ?? null, hard: budget.hard ?? null, used: u },
  });
}

/** `ready`, `ready (read-only: smoke stale)`, `not ready (AUTH until <time>, run claude auth login)`, `unmeasured (no probe)`. */
function renderState(a) {
  if (a.state === 'ready') return a.qualifier ? `ready (${a.qualifier})` : 'ready';
  const parts = [a.reason || a.state];
  if (a.state === 'not ready' && a.signIn) parts.push(`run ${a.signIn}`);
  return `${a.state} (${parts.join(', ')})`;
}

/** One report line: `<name>  <state>  <usage>  <version>`. */
function renderLine(a) {
  return redact(`${a.name}  ${renderState(a)}  ${renderUsage(a.budget && a.budget.used)}  v ${a.version}`);
}

/** Sort key: ready first, then unmeasured, then not ready; a key account with an unmeasured balance last (REQ-209). */
const rank = (a) => (a.balanceUnmeasured ? 3 : RANK[a.state]);

/**
 * Assess every account in `features.accounts.accounts`.
 * @param {object} settings  merged settings
 * @param {Record<string, { probes?: object, usage?: object|object[] }>} readings  gathered facts per account name
 */
function assessAll(settings, readings = {}, now = Date.now()) {
  const f = (settings && settings.features && settings.features.accounts) || {};
  const entries = isObject(f.accounts) ? Object.entries(f.accounts) : [];
  const list = entries.map(([name, raw], i) => {
    const r = (readings && readings[name]) || {};
    return { i, a: assess({ ...registry.withDefaults(raw), name }, r.probes || {}, r.usage || null, now, f) };
  });
  list.sort((x, y) => rank(x.a) - rank(y.a) || x.i - y.i);
  return list.map((x) => x.a);
}

module.exports = {
  STATES, SOURCES, SIGN_IN,
  assess, assessAll, renderLine, renderState, renderUsage, redact, redactDeep,
  parseUsageText, parseGatewaySnapshot, pickReading, readersFor,
};
