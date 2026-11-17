'use strict';
/**
 * Accounts inside the orchestrator — the readiness record, the budget warning, the retry runner and the decision-log
 * row (plan M3, REQ-303, REQ-306 to REQ-310, REQ-313; D31, D46, D49).
 *
 * WHY a file beside the run state. 1.0 run states are read by 2.0 and never written back in the old shape (REQ-311),
 * and an account's readiness is a fact about the MACHINE's accounts, not about one run: a LIMIT on an account stops
 * every run's placement on it. So the per-account record lives in `<orch root>/accounts-readiness.json`:
 *
 *   accounts.<name>.state / reason / until / assessedAt   the last readiness assessment (accounts.cjs)
 *   accounts.<name>.usage                                 the reading placement trusts: { percent, usd, source, at }
 *   accounts.<name>.error                                 { kind: LIMIT|BUDGET|AUTH, until, reason, at } from a
 *                                                         worker's classified error; cleared once `until` passes
 *                                                         (or, for AUTH with no time, once a probe says signed in)
 *
 * `refresh()` runs the full readiness assessment (every probe, every usage reader) and writes the record. The orch
 * command that places a lane calls it before every placement (REQ-307); every other command calls it when the last
 * assessment is older than `usageStaleMinutes` (REQ-309). The probes themselves are injectable, so the tests run no
 * harness.
 *
 * `runWithRetry()` is the D46 rule over one job: LIMIT, BUDGET or AUTH marks the account and moves the job ONCE to
 * the next ready account its roles and content class allow, telling the person once; OVERLOAD retries the same
 * prompt on the same account after min(10 s · 2^n, 5 min), at most `overloadRetries` times, then FAILED-OVERLOAD
 * with the account still ready. The clock and the sleep are injected.
 */
const fs = require('fs');
const path = require('path');
const { readJson, writeJsonAtomic, withLock } = require('./orch-store.cjs');
const registry = require('./accounts-registry.cjs');
const errors = require('./account-errors.cjs');

const FILE = 'accounts-readiness.json';
const file = (root) => path.join(root, FILE);
const lockFile = (root) => path.join(root, 'accounts-readiness.lock');
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const ms = (v) => (v instanceof Date ? v.getTime() : typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN);
const iso = (v) => (Number.isFinite(ms(v)) ? new Date(ms(v)).toISOString() : null);

/* ---------------------------------------------------------------- record ---- */

function load(root) {
  const j = readJson(file(root), null);
  return isObject(j) && isObject(j.accounts) ? j : { accounts: {}, updatedAt: null };
}

/** Merge `patch` into the account's record under the lock. */
function record(root, name, patch, at = Date.now()) {
  return withLock(lockFile(root), () => {
    const j = load(root);
    j.accounts[name] = { ...(j.accounts[name] || {}), ...patch };
    j.updatedAt = iso(at);
    writeJsonAtomic(file(root), j);
    return j.accounts[name];
  });
}

/** A classified worker error for an account. Only LIMIT, BUDGET and AUTH are recorded; OVERLOAD is not an account state. */
function markError(root, name, verdict, at = Date.now()) {
  if (!verdict || !errors.isAccountKind(verdict.kind)) return null;
  return record(root, name, { error: { kind: verdict.kind, until: verdict.until || null, reason: verdict.reason || null, at: iso(at) } }, at);
}

const clearError = (root, name, at = Date.now()) => record(root, name, { error: null }, at);

/** Is the error record still in force at `at`? An AUTH with no time holds until a probe says signed in. */
function errorHolds(err, at = Date.now()) {
  if (!isObject(err) || !err.kind) return false;
  if (!err.until) return true;
  return ms(err.until) > ms(at);
}

/**
 * What the record says about placing on this account now: { blocked, why, warn }. `why` names the kind and its time
 * (`LIMIT until 2026-…`), the assessment's reason (`not ready (signed out)`), or null.
 */
function readinessOf(entry, at = Date.now()) {
  if (!isObject(entry)) return { blocked: false, why: null };
  if (errorHolds(entry.error, at)) return { blocked: true, why: `${entry.error.kind} until ${entry.error.until || 'the next sign-in'}` };
  if (entry.state === 'not ready') {
    if (entry.until && ms(entry.until) <= ms(at)) return { blocked: false, why: null }; // the AUTH window passed; the next assessment decides
    return { blocked: true, why: `not ready (${entry.reason || 'no reason'})` };
  }
  return { blocked: false, why: null };
}

/* --------------------------------------------------------------- refresh ---- */

/** The usage reading placement trusts, from an assessment's `budget.used`. null when unmeasured. */
function readingOf(assessment) {
  const u = assessment && assessment.budget && assessment.budget.used;
  if (!u || u.source === 'unmeasured' || !u.at) return null;
  const out = { source: u.source, at: u.at, unpriced: !!u.unpriced };
  if (typeof u.percent === 'number') out.pct = u.percent;
  if (typeof u.usd === 'number') out.usd = u.usd;
  if (typeof u.limitUsd === 'number') out.limitUsd = u.limitUsd;
  if (u.until) out.until = u.until;
  return out.pct === undefined && out.usd === undefined && !out.unpriced ? null : out;
}

/** The age (minutes) of the OLDEST assessment on record (one stale account makes the record stale), or Infinity. */
function assessmentAgeMinutes(j, at = Date.now()) {
  const times = Object.values(j.accounts || {}).map((e) => ms(e && e.assessedAt)).filter(Number.isFinite);
  if (!times.length) return Infinity;
  return (ms(at) - Math.min(...times)) / 60000;
}

/**
 * Run the full readiness assessment over every account and write the record.
 * @param {string} root        the orch root
 * @param {object} settings    merged settings (features.accounts)
 * @param {{ force?: boolean, now?: any, env?: object, home?: string, collect?: Function, log?: Function }} [opts]
 *   force    run even when the last assessment is fresh (the command places a lane, REQ-307)
 *   collect  (account, paths, io) → { probes, usage } — the gatherer; default account-probes.cjs
 * @returns {{ ran: boolean, assessments: object[], ageMinutes: number }}
 */
function refresh(root, settings, opts = {}) {
  const f = (settings && settings.features && settings.features.accounts) || {};
  const cfg = { ...registry.FEATURE_DEFAULTS, ...f };
  const at = Number.isFinite(ms(opts.now)) ? ms(opts.now) : Date.now();
  const before = load(root);
  const age = assessmentAgeMinutes(before, at);
  if (!registry.accountsOn(settings)) return { ran: false, assessments: [], ageMinutes: age };
  if (!opts.force && age <= cfg.usageStaleMinutes) return { ran: false, assessments: assessmentsFrom(before), ageMinutes: age };
  const accountPaths = require('./account-paths.cjs');
  const collect = opts.collect || require('./account-probes.cjs').collect;
  const { assessAll } = require('./accounts.cjs');
  const home = opts.home || accountPaths.home(opts.env || process.env);
  const readings = {};
  for (const a of registry.list(settings)) {
    try {
      readings[a.name] = collect(a, accountPaths.paths(home, a.name, a), { env: opts.env || process.env, now: at });
    } catch (e) {
      readings[a.name] = { probes: { auth: { ok: null, reason: `probe threw: ${e.message}` } }, usage: null };
    }
  }
  const assessments = assessAll(settings, readings, at);
  withLock(lockFile(root), () => {
    const j = load(root);
    for (const a of assessments) {
      const prev = j.accounts[a.name] || {};
      let error = prev.error || null;
      if (error && (!errorHolds(error, at) || (error.kind === 'AUTH' && !error.until && a.state === 'ready'))) error = null;
      j.accounts[a.name] = { ...prev, state: a.state, reason: a.reason, qualifier: a.qualifier || null, until: a.until || null, assessedAt: iso(at), usage: readingOf(a) || prev.usage || null, error, assessment: a };
    }
    j.updatedAt = iso(at);
    writeJsonAtomic(file(root), j);
  });
  if (opts.log) for (const a of assessments) opts.log(a);
  return { ran: true, assessments, ageMinutes: age };
}

const assessmentsFrom = (j) => Object.values(j.accounts || {}).map((e) => e && e.assessment).filter(Boolean);

/* ------------------------------------------------------------ budget warn ---- */

/**
 * `budget warn <used> of <cap>` when the reading is at or above the soft limit (REQ-313, D49); null otherwise.
 * Percent: soft = budget.soft, else softLimitPct; cap shown = hard (else the soft limit). USD: soft = budget.soft only.
 */
function budgetWarn(reading, budget, softLimitPct = registry.FEATURE_DEFAULTS.softLimitPct) {
  if (!reading) return null;
  const b = isObject(budget) ? budget : {};
  if (typeof reading.usd === 'number' && b.kind === 'usd') {
    const soft = typeof b.soft === 'number' ? b.soft : null;
    const cap = typeof b.hard === 'number' ? b.hard : typeof reading.limitUsd === 'number' ? reading.limitUsd : null;
    if (soft !== null && reading.usd >= soft) return `budget warn $${reading.usd.toFixed(2)} of ${cap !== null ? `$${cap.toFixed(2)}` : 'no cap'}`;
    return null;
  }
  if (typeof reading.pct === 'number') {
    const soft = typeof b.soft === 'number' ? b.soft : b.kind === 'usd' ? null : softLimitPct;
    const cap = typeof b.hard === 'number' ? b.hard : null;
    if (soft !== null && reading.pct >= soft) return `budget warn ${reading.pct} % of ${cap !== null ? `${cap} %` : `${soft} % soft`}`;
  }
  return null;
}

/* -------------------------------------------------------------- the retry ---- */

/** May this account take the job? Roles: empty = any, else the job's role must be listed. Content: `any`, or the job's class. */
function allows(account, job = {}) {
  const a = account || {};
  if (job.role && Array.isArray(a.roles) && a.roles.length && !a.roles.includes(job.role)) return false;
  if (job.content && a.content && a.content !== 'any') {
    if (Array.isArray(a.content)) return Array.isArray(job.content) ? job.content.every((c) => a.content.includes(c)) : a.content.includes(job.content);
    if (a.content !== job.content) return false;
  }
  return true;
}

/**
 * Run one job under the D46 retry rule (REQ-310).
 * @param {object} o
 *   job             { id, role?, content?, … } — passed to runOnce unchanged (the same prompt every time)
 *   account         the account the job starts on ({ name, roles, content })
 *   candidates      the other READY accounts in placement order; the first one `allows()` takes the one retry
 *   runOnce         async (account, job) → { ok: boolean, response?: { status, headers, body, text }, … }
 *   classify        (response, { now, attempt }) → { kind, until, reason } | null   (default classifyError)
 *   now             () → ms; sleep(ms) → Promise   (injected clocks)
 *   overloadRetries default 4 (features.accounts.overloadRetries)
 *   report(line)    the status line; the account move is told once
 *   onAccountError(account, verdict)  called for LIMIT, BUDGET, AUTH (the caller marks the account)
 */
async function runWithRetry(o) {
  const { job = {}, account, candidates = [], runOnce, classify = errors.classifyError, now = Date.now, sleep = (t) => new Promise((r) => setTimeout(r, t)), overloadRetries = registry.FEATURE_DEFAULTS.overloadRetries, report = () => {}, onAccountError = () => {} } = o;
  const id = job.id || 'job';
  let acc = account;
  let overload = 0;
  let moved = false;
  const attempts = [];
  const done = (status, extra = {}) => ({ status, account: acc.name, attempts, overloadRetries: overload, moved, ...extra });
  for (;;) {
    const r = await runOnce(acc, job);
    const at = now();
    attempts.push({ account: acc.name, ok: !!(r && r.ok), at: iso(at) });
    if (r && r.ok) return done('COMPLETE', { result: r });
    const verdict = classify((r && r.response) || r || {}, { now: at, attempt: overload });
    if (!verdict) return done('FAILED', { result: r, reason: 'job fault — no retry' });
    attempts[attempts.length - 1].kind = verdict.kind;
    if (verdict.kind === 'OVERLOAD') {
      if (overload >= overloadRetries) return done('FAILED-OVERLOAD', { result: r, reason: `${overloadRetries} overload retries spent; ${acc.name} stays ready` });
      const wait = Math.max(0, ms(verdict.until) - at);
      overload += 1;
      report(`OVERLOAD ${id}: ${acc.name} ${verdict.reason} — retry ${overload} of ${overloadRetries} in ${Math.round(wait / 1000)} s on ${acc.name}, same prompt`);
      await sleep(wait);
      continue;
    }
    onAccountError(acc, verdict);
    if (moved) return done(`FAILED-${verdict.kind}`, { result: r, reason: `${acc.name} ${verdict.kind}${verdict.until ? ` until ${verdict.until}` : ''} after one retry` });
    const next = candidates.find((c) => c && c.name !== acc.name && allows(c, job));
    if (!next) return done(`FAILED-${verdict.kind}`, { result: r, reason: `${acc.name} ${verdict.kind}${verdict.until ? ` until ${verdict.until}` : ''} — no other ready account for role ${job.role || 'any'}` });
    report(`RETRY ${id}: ${acc.name} ${verdict.kind}${verdict.until ? ` until ${verdict.until}` : ''} — once more on ${next.name}`);
    moved = true;
    acc = next;
    overload = 0;
  }
}

/* ----------------------------------------------------------- decision log ---- */

const DECISIONS_HEADER = '# DECISIONS — rulings log\n\n| Id | Date | Module/scope | Decision | Why (one line) | Full ADR |\n|----|------|--------------|----------|----------------|----------|\n';
const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

/** Append one row to the project's decision log (`paths.decisions`); the file is created with its header when absent. */
function appendDecision(decisionsFile, { id, date, scope = 'orchestrator', decision, why }) {
  const d = date || new Date().toISOString().slice(0, 10);
  const row = `| ${cell(id || `D-orch-${Date.now().toString(36)}`)} | ${d} | ${cell(scope)} | ${cell(decision)} | ${cell(why)} | — |`;
  let text = '';
  try {
    text = fs.readFileSync(decisionsFile, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    fs.mkdirSync(path.dirname(decisionsFile), { recursive: true });
    text = DECISIONS_HEADER;
  }
  fs.writeFileSync(decisionsFile, `${text.replace(/\s*$/, '')}\n${row}\n`);
  return row;
}

/** The decision-log entry a cap raise needs (REQ-313): the account, the field, the old and the new value. */
const raiseEntry = (name, field, from, to) => `${name} budget.${field} ${from} → ${to}`;

/** Does a decision-log line carry the account, the field and both values? Whole tokens, any order, one line. */
function decisionCovers(text, { name, field, from, to }) {
  const tok = (s) => new RegExp(`(^|[^A-Za-z0-9_.])${String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])`);
  return String(text ?? '').split(/\r?\n/).some((line) => tok(name).test(line) && new RegExp(`\\b${field}\\b`, 'i').test(line) && tok(from).test(line) && tok(to).test(line));
}

/**
 * Hard caps or soft limits raised in §16 since the run recorded them (REQ-313). `recorded` and `current` are account
 * lists; a raise is a higher `budget.hard` or `budget.soft` (null → number counts as a raise of "none").
 */
function raisedCaps(recorded = [], current = []) {
  const out = [];
  for (const r of recorded) {
    const c = current.find((x) => x.name === r.name);
    if (!c) continue;
    for (const field of ['hard', 'soft']) {
      const from = r.budget && typeof r.budget[field] === 'number' ? r.budget[field] : null;
      const to = c.budget && typeof c.budget[field] === 'number' ? c.budget[field] : null;
      if (to !== null && (from === null || to > from)) out.push({ name: r.name, field, from: from === null ? 'none' : from, to });
    }
  }
  return out;
}

module.exports = {
  FILE, file, load, record, markError, clearError, errorHolds, readinessOf, readingOf, assessmentAgeMinutes, refresh,
  budgetWarn, allows, runWithRetry, appendDecision, raiseEntry, decisionCovers, raisedCaps,
};
