'use strict';
/**
 * `classifyError` — one verdict for a provider or gateway error, shared by every worker adapter (plan M3, REQ-306,
 * REQ-310; D35, D46).
 *
 * WHY. A headless worker that hits a limit does not wait: it fails, and the orchestrator has to decide what the
 * failure means for the ACCOUNT. Four kinds cover every exhaustion a provider or a gateway signals:
 *
 *   LIMIT     a plan usage limit: HTTP 429 with Retry-After, or a refusal text that names a reset time
 *             ("usage limit reached, resets at 3pm (Europe/London)"). The account is not ready until that time.
 *   BUDGET    a spend cap: a gateway budget code (400, 402, 403 or 429) with a budget body, or a body that carries
 *             `resetsAt`. The account is not ready until the reset.
 *   OVERLOAD  the provider, not the account: 529, 503 or an "overloaded" body. `until` is the next backoff step,
 *             min(10 s · 2^n, 5 min); the same job retries on the same account with the same prompt. Never an
 *             account state.
 *   AUTH      401, a 403 with an auth body, or an expired credential. Not ready until somebody signs in again
 *             (`until` is the expiry when the text names one, else null = until the next ready assessment).
 *
 * The orchestrator's own global 429 record (orch-ratelimit.cjs) is a different thing and stays as it is: it halves
 * the lane count for the machine. This module only says what one response means for one account.
 *
 * Pure. `classifyError(response, { now, attempt })` reads `{ status, headers, body, text }` — every field optional —
 * and returns `{ kind, until, reason }`, or null when the response is not an exhaustion error (a job fault, a crash,
 * a plain 500). Nothing from the response is copied into the result beyond the numbers it needs.
 */

const KINDS = Object.freeze(['LIMIT', 'BUDGET', 'OVERLOAD', 'AUTH']);
/** The kinds that make an account not ready until `until`. OVERLOAD is not one of them. */
const ACCOUNT_KINDS = Object.freeze(['LIMIT', 'BUDGET', 'AUTH']);
const BUDGET_CODES = Object.freeze([400, 402, 403, 429]);
const OVERLOAD_CODES = Object.freeze([503, 529]);
const BACKOFF_BASE_MS = 10 * 1000;
const BACKOFF_CAP_MS = 5 * 60 * 1000;
/** A 429 that names no reset holds the account this long (the next assessment or Retry-After replaces it). */
const DEFAULT_LIMIT_HOLD_MS = 60 * 60 * 1000;

const BUDGET_TEXT = /\b(budget|spend(ing)? limit|quota (exceeded|reached)|insufficient (credits?|funds)|credit balance|exceeded (your|the|its) (monthly |daily )?(limit|budget|allowance)|max_budget|out of credits?)\b/i;
const OVERLOAD_TEXT = /\b(overloaded(_error)?|over capacity|at capacity|temporarily unavailable|service unavailable)\b/i;
const AUTH_TEXT = /\b(unauthori[sz]ed|authentication|invalid (api[ -]?key|token|credentials?)|api key (is )?(invalid|missing|revoked)|permission denied|forbidden|not (logged|signed) in|sign in again|log in again)\b/i;
const EXPIRED_TEXT = /\b(credential|token|session|login|authentication)s?\b[^.\n]{0,40}\bexpired\b|\bexpired\b[^.\n]{0,40}\b(credential|token|session|login)s?\b/i;
const USAGE_LIMIT_TEXT = /\b(usage limit|rate limit|limit reached|limit exceeded|too many requests|rate_limit_error|hit your limit|out of (usage|messages))\b/i;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/* ---------------------------------------------------------------- times ---- */

/** The n-th OVERLOAD backoff: min(10 s · 2^n, 5 min). n counts from 0. */
const backoffMs = (n) => Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, Math.floor(Number(n) || 0)));

const toMs = (v) => {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && Number.isFinite(Date.parse(v))) return Date.parse(v);
  return NaN;
};
const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

/** `Retry-After`: seconds, or an HTTP date. null when absent or unreadable. */
function parseRetryAfter(value, now) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const s = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return iso(now + Number(s) * 1000);
  const t = Date.parse(s);
  return Number.isFinite(t) ? iso(t) : null;
}

/** The offset (ms) of `tz` at `utcMs`, via Intl; NaN for an unknown zone. */
function tzOffsetMs(utcMs, tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(new Date(utcMs));
    const g = (k) => Number(parts.find((p) => p.type === k).value);
    const asUtc = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') % 24, g('minute'), g('second'));
    return asUtc - utcMs;
  } catch (_) {
    return NaN;
  }
}

/** The instant of wall-clock `hh:mm` in `tz` on the same local day as `now`, moved to the next day when already past. */
function nextWallClock(now, hh, mm, tz) {
  const off0 = tzOffsetMs(now, tz);
  if (!Number.isFinite(off0)) return null;
  const local = new Date(now + off0);
  let guess = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), hh, mm, 0) - off0;
  guess -= tzOffsetMs(guess, tz) - off0; // a DST edge between now and the target
  if (guess <= now) {
    guess += 86400000;
    guess -= tzOffsetMs(guess, tz) - tzOffsetMs(guess - 86400000, tz);
  }
  return iso(guess);
}

/**
 * A reset time named in a refusal text: "resets at 3pm (Europe/London)", "reset at 15:30 UTC", "resets in 2 hours",
 * "try again at 14:00", or an ISO time after "resets at". null when the text names none.
 */
function parseResetTime(text, now = Date.now()) {
  const t = String(text ?? '');
  const rel = /\b(?:resets?|retry|try again|available)\s+(?:in|after)\s+(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)\b/i.exec(t);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2].toLowerCase();
    const ms = /^h/.test(unit) ? n * 3600000 : /^m/.test(unit) ? n * 60000 : n * 1000;
    return iso(now + ms);
  }
  const isoM = /\b(?:resets?|reset time|try again|available|until)\s*(?:at|:)?\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)/i.exec(t);
  if (isoM && Number.isFinite(Date.parse(isoM[1]))) return iso(Date.parse(isoM[1]));
  const abs = /\b(?:resets?|reset time|try again|available|until)\s*(?:at|:)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?(?!\s*(?:seconds?|minutes?|hours?|%))/i.exec(t);
  if (!abs) return null;
  let hh = Number(abs[1]);
  const mm = Number(abs[2] || 0);
  const ap = abs[3] ? abs[3].toLowerCase().replace(/\./g, '') : null;
  if (!ap && !abs[2]) return null; // a bare number is not a time
  if (ap === 'pm' && hh < 12) hh += 12;
  if (ap === 'am' && hh === 12) hh = 0;
  if (hh > 23 || mm > 59) return null;
  const zone = /\(([A-Za-z_]+\/[A-Za-z_+-]+)\)|\b(UTC|GMT|Z)\b|\b([A-Z][A-Za-z_]+\/[A-Za-z_+-]+)\b/.exec(t.slice(abs.index));
  const tz = zone ? zone[1] || zone[3] || 'UTC' : 'UTC';
  return nextWallClock(now, hh, mm, tz);
}

/* ------------------------------------------------------------- response ---- */

const header = (headers, name) => {
  if (!isObject(headers)) return undefined;
  const k = Object.keys(headers).find((h) => h.toLowerCase() === name.toLowerCase());
  return k === undefined ? undefined : headers[k];
};

/** Every text the response carries, joined (the body as JSON when it is an object). */
function textOf(r) {
  const parts = [];
  if (typeof r.text === 'string') parts.push(r.text);
  if (typeof r.body === 'string') parts.push(r.body);
  else if (isObject(r.body)) parts.push(JSON.stringify(r.body));
  return parts.join('\n');
}

/** A reset time the body carries: `resetsAt`, `resets_at`, `budgetResetAt`, `reset_at`, `retryAt` — at the top or under `error`. */
function bodyReset(body) {
  if (!isObject(body)) return null;
  const rows = [body, isObject(body.error) ? body.error : null].filter(Boolean);
  for (const row of rows) {
    for (const k of ['resetsAt', 'resets_at', 'budgetResetAt', 'budget_reset_at', 'reset_at', 'resetAt', 'retryAt', 'retry_at']) {
      if (typeof row[k] === 'number' && row[k] > 1e9 && row[k] < 1e11) return iso(row[k] * 1000); // unix seconds
      const ms = toMs(row[k]);
      if (Number.isFinite(ms)) return iso(ms);
    }
  }
  return null;
}

/** The HTTP status: `status`, `statusCode`, `body.error.status`, or the first 3-digit code in an "API Error: 529" text. */
function statusOf(r) {
  for (const v of [r.status, r.statusCode, isObject(r.body) && isObject(r.body.error) ? r.body.error.status : undefined]) {
    const n = Number(v);
    if (Number.isInteger(n) && n >= 100 && n <= 599) return n;
  }
  const m = /\b(?:API Error|HTTP|status(?: code)?|error)[:\s]+(\d{3})\b/i.exec(textOf(r));
  return m ? Number(m[1]) : null;
}

/**
 * Classify one response.
 * @param {{ status?: number, headers?: object, body?: object|string, text?: string }} response
 * @param {{ now?: number|Date|string, attempt?: number }} [opts]  `attempt` is the OVERLOAD retry count so far (n)
 * @returns {{ kind: string, until: string|null, reason: string } | null}
 */
function classifyError(response, opts = {}) {
  const r = isObject(response) ? response : typeof response === 'string' ? { text: response } : {};
  const now = Number.isFinite(toMs(opts.now)) ? toMs(opts.now) : Date.now();
  const attempt = Number(opts.attempt) || 0;
  const status = statusOf(r);
  const text = textOf(r);
  const retryAfter = parseRetryAfter(header(r.headers, 'retry-after'), now);
  const reset = bodyReset(r.body) || parseResetTime(text, now);

  // AUTH first: a 401 is never a budget, whatever the body says.
  if (status === 401) return { kind: 'AUTH', until: reset, reason: '401' };
  if (EXPIRED_TEXT.test(text)) return { kind: 'AUTH', until: reset, reason: 'expired credential' };
  if (status === 403 && AUTH_TEXT.test(text) && !BUDGET_TEXT.test(text)) return { kind: 'AUTH', until: reset, reason: '403 auth' };

  if (OVERLOAD_CODES.includes(status) || OVERLOAD_TEXT.test(text)) {
    return { kind: 'OVERLOAD', until: iso(now + backoffMs(attempt)), reason: status ? String(status) : 'overloaded' };
  }

  const budgetBody = BUDGET_TEXT.test(text) || !!bodyReset(r.body);
  if (status === 402 || (BUDGET_CODES.includes(status) && budgetBody)) {
    return { kind: 'BUDGET', until: reset || retryAfter, reason: `${status}${budgetBody ? ' budget' : ''}` };
  }

  if (status === 429) return { kind: 'LIMIT', until: retryAfter || reset || iso(now + DEFAULT_LIMIT_HOLD_MS), reason: retryAfter ? '429 Retry-After' : reset ? '429 reset time' : '429' };
  if (USAGE_LIMIT_TEXT.test(text) && (reset || retryAfter)) return { kind: 'LIMIT', until: reset || retryAfter, reason: 'usage limit text' };
  if (USAGE_LIMIT_TEXT.test(text)) return { kind: 'LIMIT', until: iso(now + DEFAULT_LIMIT_HOLD_MS), reason: 'usage limit text, no reset time' };

  if (status === 403 && AUTH_TEXT.test(text)) return { kind: 'AUTH', until: reset, reason: '403 auth' };
  if (budgetBody && status === null) return { kind: 'BUDGET', until: reset, reason: 'budget text' };
  if (status === 403) return { kind: 'AUTH', until: reset, reason: '403' };
  return null;
}

/** Does this kind make the account not ready? */
const isAccountKind = (kind) => ACCOUNT_KINDS.includes(kind);

module.exports = { KINDS, ACCOUNT_KINDS, BUDGET_CODES, OVERLOAD_CODES, BACKOFF_BASE_MS, BACKOFF_CAP_MS, DEFAULT_LIMIT_HOLD_MS, classifyError, backoffMs, parseRetryAfter, parseResetTime, isAccountKind };
