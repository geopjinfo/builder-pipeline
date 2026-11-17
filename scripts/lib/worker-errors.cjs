'use strict';
/**
 * The four exhaustion kinds of a worker's API error (plan M6, REQ-306, D46): LIMIT (a usage window), BUDGET (money),
 * OVERLOAD (the provider, retry in place) and AUTH (the credential). `until` is an ISO time when the text or a
 * Retry-After header gives one, else null. Pure; `now` is injected for tests.
 */
const KIND = Object.freeze({ limit: 'LIMIT', budget: 'BUDGET', overload: 'OVERLOAD', auth: 'AUTH' });

const RULES = Object.freeze([
  [KIND.auth, /\b401\b|unauthori[sz]ed|invalid (api )?key|authentication(_error| failed)|not logged in|login (required|expired)|token (expired|revoked)/i],
  [KIND.budget, /\b402\b|insufficient[_ ]quota|budget (exceeded|reached)|out of credit|credit balance|billing hard limit|spending (cap|limit)/i],
  [KIND.overload, /\b529\b|\b503\b|overloaded|server (is )?busy|temporarily unavailable|capacity/i],
  [KIND.limit, /\b429\b|rate[_ ]limit|usage limit|too many requests|quota exceeded|limit reached|hit your (usage )?limit/i],
]);

/** A duration in text ("in 40 minutes", "2 hours", "1h 20m") as milliseconds, or null. */
function durationMs(text) {
  const m = /\b(?:in|after|for)\s+(?=\d)(?:(\d+)\s*(?:hours?|hrs?|h)\b)?\s*(?:(\d+)\s*(?:minutes?|mins?|m)\b)?\s*(?:(\d+)\s*(?:seconds?|secs?|s)\b)?/i.exec(text);
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  return (Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0)) * 1000;
}

/** A clock time in text ("resets at 3pm", "at 15:30", "resets at 2026-11-18T00:00:00Z") as ISO, or null. */
function clockTime(text, now) {
  const iso = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/.exec(text);
  if (iso) {
    const t = Date.parse(iso[1]);
    if (Number.isFinite(t)) return new Date(t).toISOString();
  }
  const m = /(?:reset|resets|resetting|available|try again)\s+(?:at|from)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i.exec(text);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] || 0);
  if (m[3]) {
    if (/pm/i.test(m[3]) && h < 12) h += 12;
    if (/am/i.test(m[3]) && h === 12) h = 0;
  }
  const d = new Date(now);
  d.setHours(h, min, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.toISOString();
}

/**
 * @param {string[]} texts         error texts (result text, stderr, event errors)
 * @param {{ headers?: object, now?: number }} [o]  response headers when known (Retry-After)
 * @returns {{ kind: string|null, until: string|null, detail: string }}
 */
function classifyError(texts, { headers = {}, now = Date.now() } = {}) {
  const text = (texts || []).filter(Boolean).map(String).join('\n');
  let kind = null;
  for (const [k, re] of RULES) {
    if (re.test(text)) {
      kind = k;
      break;
    }
  }
  if (!kind) return { kind: null, until: null, detail: text.slice(0, 200) };
  let until = null;
  const retry = headers && (headers['retry-after'] ?? headers['Retry-After']);
  if (retry !== undefined && retry !== null && String(retry).trim()) {
    const n = Number(retry);
    until = Number.isFinite(n) ? new Date(now + n * 1000).toISOString() : (Number.isFinite(Date.parse(retry)) ? new Date(Date.parse(retry)).toISOString() : null);
  }
  if (!until) until = clockTime(text, now);
  if (!until) {
    const ms = durationMs(text);
    if (ms !== null) until = new Date(now + ms).toISOString();
  }
  return { kind, until, detail: text.slice(0, 200) };
}

module.exports = { KIND, classifyError, durationMs, clockTime };
