'use strict';
/**
 * The worker adapters' entry to the one exhaustion rule, scripts/lib/account-errors.cjs (REQ-306, D46): LIMIT, BUDGET,
 * OVERLOAD or AUTH with `until`. One rule table lives there; this file shapes a worker's error texts for it and fills
 * `until` from a duration or clock time in the text when the rule gives none. Pure; `now` is injected for tests.
 */
const KIND = Object.freeze({ limit: 'LIMIT', budget: 'BUDGET', overload: 'OVERLOAD', auth: 'AUTH' });
const shared = require('./account-errors.cjs');

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

/** The HTTP status a worker's error text names ("429 Too Many Requests", "API Error: 529"), or null. */
const statusIn = (text) => {
  const m = /\b(?:API Error:?\s*)?(4\d\d|5\d\d)\b/.exec(text);
  return m ? Number(m[1]) : null;
};

/**
 * The worker adapters' view of the shared rule: texts in, `{ kind, until, detail }` out (`kind` null = not an
 * exhaustion error). The verdict is account-errors.cjs's; this wrapper only shapes the input (status read from the text,
 * headers passed through) and fills `until` from a duration or clock time in the text when the rule gives none.
 * @param {string[]} texts         error texts (result text, stderr, event errors)
 * @param {{ headers?: object, now?: number }} [o]
 */
function classifyError(texts, { headers = {}, now = Date.now() } = {}) {
  const text = (texts || []).filter(Boolean).map(String).join('\n');
  const r = shared.classifyError({ status: statusIn(text), headers, text }, { now });
  if (!r) return { kind: null, until: null, detail: text.slice(0, 200) };
  let until = r.until ? new Date(r.until).toISOString() : null;
  if (!until) until = clockTime(text, now);
  if (!until) {
    const ms = durationMs(text);
    if (ms !== null) until = new Date(now + ms).toISOString();
  }
  return { kind: r.kind, until, detail: r.reason || text.slice(0, 200) };
}

module.exports = { KIND, classifyError, durationMs, clockTime, statusIn };
