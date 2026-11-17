/**
 * `classifyError` and the retry rule — `scripts/lib/account-errors.cjs`, `scripts/lib/orch-accounts.cjs`
 * (REQ-306, REQ-310; D35, D46).
 *
 * WHY. A headless worker that hits a limit fails at once; the orchestrator must know what the failure means for the
 * ACCOUNT. These tests hold the four kinds and their `until` times to the spec rows, and drive the retry rule with an
 * injected clock, so no test sleeps and no harness runs.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const PACK = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { classifyError, backoffMs, parseResetTime, parseRetryAfter, KINDS, ACCOUNT_KINDS } = require(join(PACK, 'scripts/lib/account-errors.cjs'));
const oa = require(join(PACK, 'scripts/lib/orch-accounts.cjs'));
const ratelimit = require(join(PACK, 'scripts/lib/orch-ratelimit.cjs'));

const NOW = Date.parse('2026-11-17T10:00:00.000Z');
const made = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'acct-err-')); made.push(d); return d; };

describe('classifyError (REQ-306)', () => {
  test('REQ-306 the four kinds and the three account kinds', () => {
    assert.deepEqual(KINDS, ['LIMIT', 'BUDGET', 'OVERLOAD', 'AUTH']);
    assert.deepEqual(ACCOUNT_KINDS, ['LIMIT', 'BUDGET', 'AUTH']);
  });

  test('red: REQ-306 a 429 with Retry-After 2400 is LIMIT until now plus 40 min (AC-306a)', () => {
    const v = classifyError({ status: 429, headers: { 'Retry-After': '2400' }, body: { error: { type: 'rate_limit_error' } } }, { now: NOW });
    assert.equal(v.kind, 'LIMIT');
    assert.equal(v.until, new Date(NOW + 40 * 60000).toISOString());
    const dated = classifyError({ status: 429, headers: { 'retry-after': 'Tue, 17 Nov 2026 11:00:00 GMT' } }, { now: NOW });
    assert.equal(dated.until, '2026-11-17T11:00:00.000Z');
    assert.equal(parseRetryAfter(undefined, NOW), null);
  });

  test('red: REQ-306 a refusal text "usage limit reached, resets at 3pm (Europe/London)" is LIMIT until that time (AC-306b)', () => {
    const v = classifyError({ text: 'Claude usage limit reached, resets at 3pm (Europe/London)' }, { now: NOW });
    assert.equal(v.kind, 'LIMIT');
    assert.equal(v.until, '2026-11-17T15:00:00.000Z', 'London is on GMT in November');
    // a time already past today names tomorrow; a zone with an offset is converted
    assert.equal(parseResetTime('resets at 9:30am (Europe/London)', NOW), '2026-11-18T09:30:00.000Z');
    assert.equal(parseResetTime('usage limit reached, resets at 15:00 (Europe/Berlin)', NOW), '2026-11-17T14:00:00.000Z');
    assert.equal(parseResetTime('resets in 2 hours', NOW), new Date(NOW + 7200000).toISOString());
    assert.equal(parseResetTime('resets at 2026-11-17T12:34:00Z', NOW), '2026-11-17T12:34:00.000Z');
    assert.equal(parseResetTime('no time here', NOW), null);
    assert.equal(parseResetTime('your limit is 5 requests', NOW), null);
  });

  test('red: REQ-306 a 402 with a reset time is BUDGET until that time; a 429 with a budget body is BUDGET, not LIMIT (AC-306c)', () => {
    const v = classifyError({ status: 402, body: { error: { message: 'budget exceeded', resetsAt: '2026-11-18T00:00:00Z' } } }, { now: NOW });
    assert.deepEqual([v.kind, v.until], ['BUDGET', '2026-11-18T00:00:00.000Z']);
    const g = classifyError({ status: 429, body: { error: 'Budget has been exceeded for this key', budgetResetAt: 1763424000 } }, { now: NOW });
    assert.equal(g.kind, 'BUDGET');
    assert.equal(g.until, new Date(1763424000 * 1000).toISOString());
    assert.equal(classifyError({ status: 400, text: 'ExceededBudget: spend limit reached' }, { now: NOW }).kind, 'BUDGET');
    assert.equal(classifyError({ status: 402 }, { now: NOW }).kind, 'BUDGET');
    assert.equal(classifyError({ status: 402 }, { now: NOW }).until, null);
  });

  test('red: REQ-306 a 529 or a 503 is OVERLOAD with the next backoff step as until — never an account state (AC-306d)', () => {
    const v0 = classifyError({ status: 529, body: { error: { type: 'overloaded_error' } } }, { now: NOW, attempt: 0 });
    assert.deepEqual([v0.kind, v0.until], ['OVERLOAD', new Date(NOW + 10000).toISOString()]);
    assert.equal(classifyError({ status: 503 }, { now: NOW, attempt: 2 }).until, new Date(NOW + 40000).toISOString());
    assert.equal(classifyError({ text: 'API Error: 529 overloaded' }, { now: NOW }).kind, 'OVERLOAD');
    assert.deepEqual([0, 1, 2, 3, 4, 5, 9].map(backoffMs), [10000, 20000, 40000, 80000, 160000, 300000, 300000]);
    assert.equal(ACCOUNT_KINDS.includes('OVERLOAD'), false);
    assert.equal(oa.markError(tmp(), 'alpha', v0), null, 'an OVERLOAD is never recorded against the account');
  });

  test('red: REQ-306 a 401, a 403 with an auth body, and an expired credential are AUTH (AC-306e)', () => {
    assert.equal(classifyError({ status: 401 }, { now: NOW }).kind, 'AUTH');
    assert.equal(classifyError({ status: 403, body: { error: { type: 'permission_error', message: 'Invalid API key' } } }, { now: NOW }).kind, 'AUTH');
    const exp = classifyError({ text: 'OAuth token expired. Please run claude auth login' }, { now: NOW });
    assert.equal(exp.kind, 'AUTH');
    assert.equal(exp.until, null);
    assert.equal(classifyError({ status: 403, text: 'Budget exceeded for key' }, { now: NOW }).kind, 'BUDGET', 'a 403 with a budget body is a budget, not auth');
  });

  test('red: a plain job fault is not classified — null, never a guess', () => {
    assert.equal(classifyError({ status: 500, text: 'internal error' }, { now: NOW }), null);
    assert.equal(classifyError({ text: 'RESULT: FAIL tests red' }, { now: NOW }), null);
    assert.equal(classifyError(null), null);
  });

  test("REQ-306 the orchestrator's own global 429 record is written as before (AC-306f)", () => {
    const root = tmp();
    const r = ratelimit.record429(root, { plannedMax: 4, now: NOW, jitter: () => 0 });
    assert.deepEqual([r.lanes, r.consecutive429, r.plannedMax], [2, 1, 4]);
    assert.equal(r.until, new Date(NOW + ratelimit.BASE_MS / 2).toISOString());
    assert.equal(JSON.parse(readFileSync(join(root, 'ratelimit.json'), 'utf8')).lanes, 2);
    assert.deepEqual(oa.load(root).accounts, {}, 'the account record is untouched by the global 429');
  });
});

describe('the per-account record (REQ-306, REQ-310)', () => {
  test('red: LIMIT, BUDGET and AUTH mark the account not ready until `until`; the hold ends when the time passes', () => {
    const root = tmp();
    const v = classifyError({ status: 429, headers: { 'retry-after': '600' } }, { now: NOW });
    oa.markError(root, 'alpha', v, NOW);
    const e = oa.load(root).accounts.alpha;
    assert.equal(e.error.kind, 'LIMIT');
    assert.deepEqual(oa.readinessOf(e, NOW + 60000), { blocked: true, why: `LIMIT until ${v.until}` });
    assert.deepEqual(oa.readinessOf(e, NOW + 601000), { blocked: false, why: null });
    oa.markError(root, 'alpha', { kind: 'AUTH', until: null, reason: '401' }, NOW);
    assert.equal(oa.readinessOf(oa.load(root).accounts.alpha, NOW + 86400000 * 30).blocked, true, 'an AUTH with no time holds until a probe says signed in');
    oa.clearError(root, 'alpha');
    assert.equal(oa.readinessOf(oa.load(root).accounts.alpha, NOW).blocked, false);
  });
});

/** A clock + sleep pair for the retry rule: `sleep` advances the clock and records the wait, nothing blocks. */
function fakeClock(start = NOW) {
  let t = start;
  const waits = [];
  return { now: () => t, sleep: async (ms) => { waits.push(ms); t += ms; }, waits, time: () => t };
}

const acct = (name, over = {}) => ({ name, roles: [], content: 'any', ...over });

describe('runWithRetry (REQ-310)', () => {
  test('red: REQ-310 a 429 on A and a ready B — the job runs on B, A shows the limit time, and the person is told once (AC-310a)', async () => {
    const clock = fakeClock();
    const lines = [];
    const marked = [];
    const runs = [];
    const r = await oa.runWithRetry({
      job: { id: 'j1', role: 'module-tester', content: 'public' },
      account: acct('alpha'),
      candidates: [acct('alpha'), acct('bravo', { roles: ['module-reviewer'] }), acct('charlie', { content: 'scratch' }), acct('delta')],
      runOnce: async (a) => { runs.push(a.name); return a.name === 'alpha' ? { ok: false, response: { status: 429, headers: { 'retry-after': '1800' } } } : { ok: true, result: 'RESULT: PASS' }; },
      now: clock.now, sleep: clock.sleep, report: (l) => lines.push(l), onAccountError: (a, v) => marked.push([a.name, v.kind, v.until]),
    });
    assert.equal(r.status, 'COMPLETE');
    assert.equal(r.account, 'delta', 'bravo lacks the role and charlie the content class');
    assert.deepEqual(runs, ['alpha', 'delta']);
    assert.deepEqual(marked, [['alpha', 'LIMIT', new Date(NOW + 1800000).toISOString()]]);
    assert.equal(lines.length, 1, 'told once');
    assert.match(lines[0], /^RETRY j1: alpha LIMIT until 2026-11-17T10:30:00\.000Z — once more on delta$/);
    assert.deepEqual(clock.waits, [], 'an account move never sleeps');
  });

  test('red: REQ-310 a second account failure after the one retry is FAILED-<kind>; with no other account the job fails at once', async () => {
    const clock = fakeClock();
    const r = await oa.runWithRetry({
      job: { id: 'j2' }, account: acct('alpha'), candidates: [acct('bravo')],
      runOnce: async () => ({ ok: false, response: { status: 401 } }), now: clock.now, sleep: clock.sleep,
    });
    assert.equal(r.status, 'FAILED-AUTH');
    assert.equal(r.attempts.length, 2);
    const alone = await oa.runWithRetry({ job: { id: 'j3' }, account: acct('alpha'), candidates: [], runOnce: async () => ({ ok: false, response: { status: 402 } }), now: clock.now, sleep: clock.sleep });
    assert.equal(alone.status, 'FAILED-BUDGET');
    assert.match(alone.reason, /no other ready account/);
    assert.equal(alone.attempts.length, 1);
  });

  test('red: REQ-310 a stub that returns 529 three times then succeeds — one account, three backoff waits, no move (AC-310b)', async () => {
    const clock = fakeClock();
    let n = 0;
    const lines = [];
    const marked = [];
    const r = await oa.runWithRetry({
      job: { id: 'j4' }, account: acct('alpha'), candidates: [acct('bravo')],
      runOnce: async () => (++n <= 3 ? { ok: false, response: { status: 529 } } : { ok: true }),
      now: clock.now, sleep: clock.sleep, report: (l) => lines.push(l), onAccountError: (a) => marked.push(a.name),
    });
    assert.equal(r.status, 'COMPLETE');
    assert.equal(r.account, 'alpha');
    assert.equal(r.moved, false);
    assert.deepEqual(clock.waits, [10000, 20000, 40000]);
    assert.deepEqual(marked, [], 'OVERLOAD never marks the account');
    assert.equal(lines.filter((l) => /^OVERLOAD j4: alpha 529 — retry \d of 4 in \d+ s on alpha, same prompt$/.test(l)).length, 3);
    assert.equal(n, 4);
  });

  test('red: REQ-310 after overloadRetries (default 4) the job is FAILED-OVERLOAD and the account stays ready; the cap is min(10 s · 2^n, 5 min)', async () => {
    const clock = fakeClock();
    const marked = [];
    const r = await oa.runWithRetry({ job: { id: 'j5' }, account: acct('alpha'), candidates: [acct('bravo')], runOnce: async () => ({ ok: false, response: { status: 503 } }), now: clock.now, sleep: clock.sleep, onAccountError: (a) => marked.push(a.name) });
    assert.equal(r.status, 'FAILED-OVERLOAD');
    assert.deepEqual(clock.waits, [10000, 20000, 40000, 80000]);
    assert.equal(r.attempts.length, 5);
    assert.deepEqual(marked, []);
    const six = fakeClock();
    const r6 = await oa.runWithRetry({ job: { id: 'j6' }, account: acct('alpha'), overloadRetries: 6, runOnce: async () => ({ ok: false, response: { status: 529 } }), now: six.now, sleep: six.sleep });
    assert.equal(r6.status, 'FAILED-OVERLOAD');
    assert.deepEqual(six.waits, [10000, 20000, 40000, 80000, 160000, 300000]);
    const none = await oa.runWithRetry({ job: { id: 'j7' }, account: acct('alpha'), overloadRetries: 0, runOnce: async () => ({ ok: false, response: { status: 529 } }), now: six.now, sleep: six.sleep });
    assert.equal(none.status, 'FAILED-OVERLOAD');
    assert.equal(none.attempts.length, 1);
  });

  test('red: a job fault (no exhaustion kind) is FAILED with no retry and no account mark', async () => {
    const clock = fakeClock();
    const marked = [];
    const r = await oa.runWithRetry({ job: { id: 'j8' }, account: acct('alpha'), candidates: [acct('bravo')], runOnce: async () => ({ ok: false, response: { status: 500, text: 'boom' } }), now: clock.now, sleep: clock.sleep, onAccountError: (a) => marked.push(a.name) });
    assert.equal(r.status, 'FAILED');
    assert.equal(r.attempts.length, 1);
    assert.deepEqual(marked, []);
  });
});

describe('budget warn and the decision log (REQ-303, REQ-313)', () => {
  test('red: REQ-313 at or above the soft limit the warning reads `budget warn <used> of <cap>`, for percent and USD alike', () => {
    assert.equal(oa.budgetWarn({ pct: 82 }, { kind: 'percent', soft: 80, hard: 85 }), 'budget warn 82 % of 85 %');
    assert.equal(oa.budgetWarn({ pct: 82 }, { kind: 'percent', soft: null, hard: 90 }, 80), 'budget warn 82 % of 90 %', 'softLimitPct is the default soft limit');
    assert.equal(oa.budgetWarn({ pct: 79 }, { kind: 'percent', soft: 80, hard: 85 }), null);
    assert.equal(oa.budgetWarn({ usd: 8.2 }, { kind: 'usd', soft: 8, hard: 10 }), 'budget warn $8.20 of $10.00');
    assert.equal(oa.budgetWarn({ usd: 7.9 }, { kind: 'usd', soft: 8, hard: 10 }), null);
    assert.equal(oa.budgetWarn(null, { kind: 'percent', soft: 80, hard: 85 }), null, 'unmeasured is never a warning');
  });

  test('red: REQ-303 appendDecision adds one row to the project decision log (created with its header when absent) and the raise check reads it', () => {
    const dir = tmp();
    const f = join(dir, 'DECISIONS.md');
    const row = oa.appendDecision(f, { id: 'D-orch-1', date: '2026-11-17', decision: 'lane l1 of run r1 launched on api-key account charlie', why: 'pays per use' });
    assert.match(readFileSync(f, 'utf8'), /\| Id \| Date \| Module\/scope \| Decision \|/);
    assert.ok(readFileSync(f, 'utf8').endsWith(row + '\n'));
    writeFileSync(f, '| D-1 | 2026-11-17 | orchestrator | alpha budget.hard 85 → 90 | more headroom | — |\n');
    assert.equal(oa.decisionCovers(readFileSync(f, 'utf8'), { name: 'alpha', field: 'hard', from: 85, to: 90 }), true);
    assert.equal(oa.decisionCovers(readFileSync(f, 'utf8'), { name: 'alpha', field: 'soft', from: 85, to: 90 }), false);
    assert.equal(oa.decisionCovers(readFileSync(f, 'utf8'), { name: 'alpha', field: 'hard', from: 85, to: 95 }), false);
    assert.equal(oa.raiseEntry('alpha', 'hard', 85, 90), 'alpha budget.hard 85 → 90');
    assert.deepEqual(oa.raisedCaps([{ name: 'alpha', budget: { kind: 'percent', soft: 80, hard: 85 } }], [{ name: 'alpha', budget: { kind: 'percent', soft: 80, hard: 90 } }]), [{ name: 'alpha', field: 'hard', from: 85, to: 90 }]);
    assert.deepEqual(oa.raisedCaps([{ name: 'alpha', budget: { kind: 'percent', soft: 80, hard: 85 } }], [{ name: 'alpha', budget: { kind: 'percent', soft: 70, hard: 85 } }]), [], 'a lower limit needs no entry');
  });
});
