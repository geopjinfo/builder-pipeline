'use strict';
/**
 * Rate limits (HTTP 429) — one global record for the machine.
 *
 *   - a 429 / rate_limit_error in a worker's result or stderr is `rate-limit`: never billing (and an unknown error
 *     is never billing either — orch-credit.cjs classifyFailure)
 *   - on a 429: ONE global back-off (exponential, capped, with bounded "equal jitter": a delay in [step/2, step]),
 *     and the allowed lane count halves (min 1)
 *   - after each clean finish the count grows back by one, up to the planned max
 *   - a 429 on the last account of a chain never moves work to another runner: the same task retries after the
 *     back-off
 *
 * WHY global: every lane and credit job on a machine draws on the same accounts. Per-lane back-off lets the other
 * lanes keep hammering the limit that the first one just hit.
 *
 * Global = one file: <orch root>/ratelimit.json, written under its lock. The pure functions (backoffMs, on429,
 * onCleanFinish, laneCap) take and return plain state; the file helpers wrap them.
 */
const path = require('path');
const { readJson, writeJsonAtomic, withLock } = require('./orch-store.cjs');

const RATE_LIMIT_PATTERNS = Object.freeze([/\b429\b/, /rate_limit_error/i, /\brate[ -]limit(ed)?\b/i]);
const BASE_MS = 60 * 1000;
const CAP_MS = 15 * 60 * 1000;
const DEFAULT_PLANNED_MAX = 2;

const isRateLimit = (text) => RATE_LIMIT_PATTERNS.some((re) => re.test(String(text || '')));

/** The back-off for the n-th consecutive 429: step = min(CAP, BASE·2^(n-1)); delay in [step/2, step]. */
function backoffMs(attempt, { jitter = Math.random } = {}) {
  const step = Math.min(CAP_MS, BASE_MS * 2 ** (Math.max(1, attempt) - 1));
  const j = Math.min(1, Math.max(0, Number(jitter()) || 0)); // a bad jitter source can never widen the bound
  return Math.round(step / 2 + (step / 2) * j);
}

function on429(s, { plannedMax = DEFAULT_PLANNED_MAX, now = Date.now(), jitter = Math.random } = {}) {
  const planned = (s && s.plannedMax) || plannedMax;
  const lanes = Math.max(1, Math.floor(((s && s.lanes) || planned) / 2));
  const consecutive429 = ((s && s.consecutive429) || 0) + 1;
  const until = new Date(now + backoffMs(consecutive429, { jitter })).toISOString();
  return { plannedMax: planned, lanes, consecutive429, until, last429At: new Date(now).toISOString() };
}

function onCleanFinish(s, { plannedMax = DEFAULT_PLANNED_MAX } = {}) {
  const planned = (s && s.plannedMax) || plannedMax;
  return { ...(s || {}), plannedMax: planned, lanes: Math.min(planned, ((s && s.lanes) || planned) + 1), consecutive429: 0 };
}

/** The lane cap at `at`: { lanes, holdUntil } — holdUntil set while the global back-off runs. null = no 429 seen. */
function laneCap(s, at = Date.now()) {
  if (!s) return null;
  return { lanes: s.lanes, holdUntil: s.until && Date.parse(s.until) > at ? s.until : null };
}

const file = (root) => path.join(root, 'ratelimit.json');
const load = (root) => readJson(file(root), null);
const mutate = (root, fn) =>
  withLock(path.join(root, 'ratelimit.lock'), () => {
    const s = fn(load(root));
    writeJsonAtomic(file(root), s);
    return s;
  });

const record429 = (root, opts) => mutate(root, (s) => on429(s, opts));
/** A clean finish only writes when a 429 was ever recorded (no file = nothing to grow back). */
const recordCleanFinish = (root, opts) => (load(root) ? mutate(root, (s) => onCleanFinish(s, opts)) : null);

module.exports = { RATE_LIMIT_PATTERNS, BASE_MS, CAP_MS, DEFAULT_PLANNED_MAX, isRateLimit, backoffMs, on429, onCleanFinish, laneCap, load, record429, recordCleanFinish };
