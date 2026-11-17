/**
 * The readiness assessment — `scripts/lib/accounts.cjs` (REQ-201, REQ-202, REQ-203, REQ-206, REQ-207, REQ-209,
 * REQ-210, REQ-212; D3, D31, D51).
 *
 * WHY. Placement (M3) and the report (M2b) both read one pure assessment per account. These tests hold its states, its
 * usage readers, its rendering and its sorting to the spec rows, and prove that no secret-shaped string survives it.
 * Every fake secret below is built at run time by concatenation, never written as a literal.
 */
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const PACK = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const accounts = require(join(PACK, 'scripts/lib/accounts.cjs'));
const { assess, assessAll, renderLine, renderUsage, redact, parseUsageText, parseGatewaySnapshot, pickReading, readersFor, STATES } = accounts;

const NOW = '2026-11-17T09:30:00.000Z';
const plan = (over = {}) => ({ name: 'alpha', worker: 'claude-code', pays: 'subscription', roles: [], note: 'plan account', budget: { kind: 'percent', soft: 60, hard: 80 }, ...over });
const key = (over = {}) => ({ name: 'charlie', worker: 'claude-code', pays: 'api-key', roles: ['module-tester'], note: 'pay per use', budget: { kind: 'usd', soft: 5, hard: 10 }, ...over });
const ok = { ok: true, method: 'oauth', signIn: 'claude auth login' };

describe('assess: states (REQ-201)', () => {
  test('REQ-201 a passing probe is ready, a failing one not ready with the reason, an absent one unmeasured', () => {
    const ready = assess(plan(), { auth: ok }, null, NOW);
    assert.equal(ready.state, 'ready');
    assert.equal(ready.name, 'alpha');
    assert.equal(ready.note, 'plan account');
    assert.deepEqual(ready.roles, []);
    assert.equal(ready.budget.kind, 'percent');
    assert.equal(ready.budget.hard, 80);
    const down = assess(plan(), { auth: { ok: false, reason: 'signed out', signIn: 'claude auth login' } }, null, NOW);
    assert.equal(down.state, 'not ready');
    assert.equal(down.reason, 'signed out');
    assert.match(renderLine(down), /not ready \(signed out, run claude auth login\)/);
    const none = assess(plan(), {}, null, NOW);
    assert.equal(none.state, 'unmeasured');
    assert.match(none.reason, /no probe/);
    assert.deepEqual(STATES, ['ready', 'not ready', 'unmeasured']);
  });

  test('REQ-201 the orchestrating session itself is ready without a probe', () => {
    const a = assess({ name: 'primary', worker: 'session', pays: 'subscription', roles: [], note: '' }, {}, null, NOW);
    assert.equal(a.state, 'ready');
  });
});

describe('assess: redaction (REQ-202)', () => {
  test('REQ-202 a probe that echoes a secret-shaped string renders the marker and never the string', () => {
    const fake = ['sk', 'ant', 'api03', 'A'.repeat(24)].join('-');
    const a = assess(plan({ note: `helper says ${fake}` }), { auth: { ok: false, reason: `auth failed: ${fake}`, signIn: 'claude auth login' } }, null, NOW);
    const text = JSON.stringify(a) + renderLine(a);
    assert.ok(!text.includes(fake), 'the key text must not survive');
    assert.ok(text.includes('<redacted: Anthropic key>'));
    assert.equal(redact(`token=${fake}`), 'token=<redacted: Anthropic key>');
    assert.equal(redact('plain text'), 'plain text');
  });

  test('REQ-202 an env-style assignment is redacted by kind, never carried', () => {
    const v = ['ANTHROPIC_API_KEY=', 'q'.repeat(12)].join('');
    const a = assess(plan(), { auth: { ok: false, reason: v } }, null, NOW);
    assert.ok(!JSON.stringify(a).includes('q'.repeat(12)));
    assert.match(a.reason, /<redacted: assigned secret>/);
  });
});

describe('usage readers (REQ-203, REQ-210, REQ-212)', () => {
  test('REQ-203 usageCommand text "$X of $Y" parses to a percent', () => {
    const r = parseUsageText('Used $4.20 of $10.00 this month', NOW);
    assert.equal(r.percent, 42);
    assert.equal(r.usd, 4.2);
    assert.equal(r.limitUsd, 10);
    assert.equal(r.source, 'measured');
    assert.equal(r.at, NOW);
    assert.equal(parseUsageText('no numbers here', NOW), null);
    assert.equal(parseUsageText('$3 of $0', NOW), null);
  });

  test('REQ-203 the gateway snapshot JSON (spend, maxBudget, budgetResetAt) parses to a percent and an until', () => {
    const r = parseGatewaySnapshot({ spend: 2.5, maxBudget: 10, budgetResetAt: '2026-12-01T00:00:00.000Z' }, NOW);
    assert.equal(r.percent, 25);
    assert.equal(r.usd, 2.5);
    assert.equal(r.until, '2026-12-01T00:00:00.000Z');
    assert.equal(r.source, 'measured');
    const keyed = parseGatewaySnapshot({ keys: { bravo: { spend: 1, maxBudget: 4 } } }, NOW, 'bravo');
    assert.equal(keyed.percent, 25);
    assert.equal(parseGatewaySnapshot({ spend: 'x' }, NOW), null);
    assert.equal(parseGatewaySnapshot(null, NOW), null);
  });

  test('REQ-203 a Claude plan account has no reader: unmeasured, never 0 %', () => {
    assert.deepEqual(readersFor(plan()), []);
    const a = assess(plan(), { auth: ok }, null, NOW);
    assert.equal(a.budget.used.source, 'unmeasured');
    assert.equal(a.budget.used.percent, null);
    assert.equal(renderUsage(a.budget.used), 'unmeasured');
    assert.ok(!renderLine(a).includes('0 %'));
  });

  test('REQ-210 each kind of account names its readers; an account with none says unmeasured', () => {
    assert.deepEqual(readersFor(plan({ usageCommand: 'usage-tool' })), ['usageCommand']);
    assert.deepEqual(readersFor({ ...plan(), worker: 'codex' }), ['codex-ratelimits']);
    assert.deepEqual(readersFor(key({ pays: 'gateway', budget: { kind: 'usd', soft: 1, hard: 2, file: 'snap.json', key: 'charlie' } })), ['snapshot']);
    const all = assessAll({ features: { accounts: { state: 'on', accounts: { alpha: plan(), bravo: { ...plan(), worker: 'codex', pays: 'subscription' } } } } },
      { alpha: { probes: { auth: ok } }, bravo: { probes: { auth: ok }, usage: [{ percent: 30, source: 'measured', at: NOW, reader: 'codex-ratelimits' }] } }, NOW);
    const byName = Object.fromEntries(all.map((a) => [a.name, a]));
    assert.equal(byName.bravo.budget.used.percent, 30);
    assert.equal(byName.bravo.budget.used.reader, 'codex-ratelimits');
    assert.equal(byName.alpha.budget.used.source, 'unmeasured');
  });

  test('REQ-212 a measured reading beats an estimate and renders with its time', () => {
    const readings = [{ percent: 40, source: 'estimate', at: NOW }, { percent: 42, source: 'measured', at: '2026-11-17T09:14:00.000Z' }];
    assert.equal(pickReading(readings).percent, 42);
    const a = assess(plan(), { auth: ok }, readings, NOW);
    assert.equal(a.budget.used.percent, 42);
    assert.equal(a.budget.used.source, 'measured');
    assert.equal(renderUsage(a.budget.used), '42 % (measured 09:14)');
    assert.match(renderLine(a), /42 % \(measured 09:14\)/);
  });

  test('REQ-212 only an estimate renders with the word estimate; no reading renders unmeasured; no rate is unpriced', () => {
    const a = assess(plan(), { auth: ok }, [{ percent: 40, source: 'estimate', at: NOW }], NOW);
    assert.equal(renderUsage(a.budget.used), '~40 % (estimate 09:30)');
    assert.equal(renderUsage(assess(plan(), { auth: ok }, [], NOW).budget.used), 'unmeasured');
    const usd = assess(key(), { auth: ok }, [{ usd: 3.2, source: 'estimate', at: NOW }], NOW);
    assert.equal(renderUsage(usd.budget.used), '~$3.20 (estimate 09:30)');
    const unpriced = assess(key(), { auth: ok }, [{ usd: null, source: 'estimate', unpriced: true, model: 'some-model', at: NOW }], NOW);
    assert.equal(renderUsage(unpriced.budget.used), 'unpriced (estimate 09:30)');
    assert.equal(unpriced.budget.used.unpriced, true);
    // A reading that claims a percent of 0 from nowhere is unmeasured, never 0 %.
    assert.equal(renderUsage(assess(plan(), { auth: ok }, [{ percent: 0, source: 'unmeasured' }], NOW).budget.used), 'unmeasured');
  });
});

describe('smoke, version and key accounts (REQ-206, REQ-207, REQ-209)', () => {
  test('REQ-206 a smoke pass 3 days old with 48 h allowed is ready (read-only: smoke stale)', () => {
    const old = new Date(Date.parse(NOW) - 3 * 24 * 3600 * 1000).toISOString();
    const a = assess(plan({ smokeCommand: 'smoke-tool' }), { auth: ok, smoke: { ok: true, at: old } }, null, NOW, { smokeMaxAgeHours: 48 });
    assert.equal(a.state, 'ready');
    assert.equal(a.readOnly, true);
    assert.match(renderLine(a), /ready \(read-only: smoke stale\)/);
    const fresh = assess(plan({ smokeCommand: 'smoke-tool' }), { auth: ok, smoke: { ok: true, at: NOW } }, null, NOW, { smokeMaxAgeHours: 48 });
    assert.equal(fresh.readOnly, false);
    assert.equal(renderLine(fresh).includes('read-only'), false);
    const never = assess(plan({ smokeCommand: 'smoke-tool' }), { auth: ok }, null, NOW);
    assert.equal(never.readOnly, true);
    const none = assess(plan(), { auth: ok, smoke: { ok: true, at: old } }, null, NOW);
    assert.equal(none.readOnly, false, 'no smokeCommand: the smoke rule does not apply');
  });

  test('REQ-207 the version comes from versionCommand, else unmeasured', () => {
    assert.equal(assess(plan({ versionCommand: 'claude --version' }), { auth: ok, version: { version: '1.2.3' } }, null, NOW).version, '1.2.3');
    assert.equal(assess(plan(), { auth: ok }, null, NOW).version, 'unmeasured');
  });

  test('REQ-209 a key account whose balance cannot be read is ready (balance unmeasured) and sorts last', () => {
    const settings = { features: { accounts: { state: 'on', accounts: { charlie: key(), alpha: plan(), bravo: plan({ name: 'bravo' }) } } } };
    const all = assessAll(settings, {
      charlie: { probes: { auth: ok } },
      alpha: { probes: { auth: { ok: false, reason: 'signed out' } } },
      bravo: { probes: { auth: ok }, usage: [{ percent: 10, source: 'measured', at: NOW }] },
    }, NOW);
    assert.deepEqual(all.map((a) => a.name), ['bravo', 'alpha', 'charlie']);
    const c = all[2];
    assert.equal(c.state, 'ready');
    assert.match(renderLine(c), /ready \(balance unmeasured\)/);
    assert.equal(c.budget.used.source, 'unmeasured');
  });
});

describe('assessAll (REQ-201, REQ-211)', () => {
  test('REQ-201 assessAll covers every account, ready first, and reads the feature settings', () => {
    const settings = { features: { accounts: { state: 'on', smokeMaxAgeHours: 1, authMinMinutes: 120, accounts: { alpha: plan({ smokeCommand: 's' }), bravo: plan({ name: 'bravo' }) } } } };
    const all = assessAll(settings, { alpha: { probes: { auth: ok, smoke: { ok: true, at: '2026-11-17T07:00:00.000Z' } } }, bravo: { probes: { auth: ok } } }, NOW);
    assert.equal(all.length, 2);
    assert.equal(all.find((a) => a.name === 'alpha').readOnly, true);
    assert.deepEqual(assessAll({ features: {} }, {}, NOW), []);
  });

  test('REQ-211 an expiry inside authMinMinutes is not ready (AUTH until <time>, run <sign-in>) and carries until', () => {
    const soon = '2026-11-17T10:00:00.000Z';
    const a = assess(plan(), { auth: { ...ok, expiresAt: soon } }, null, NOW, { authMinMinutes: 120 });
    assert.equal(a.state, 'not ready');
    assert.equal(a.reason, `AUTH until ${soon}`);
    assert.equal(a.until, soon);
    assert.match(renderLine(a), /not ready \(AUTH until 2026-11-17T10:00:00\.000Z, run claude auth login\)/);
    const far = assess(plan(), { auth: { ...ok, expiresAt: '2026-11-18T10:00:00.000Z' } }, null, NOW, { authMinMinutes: 120 });
    assert.equal(far.state, 'ready');
    assert.equal(far.until, null);
    const past = assess({ ...plan(), worker: 'codex' }, { auth: { ok: true, expiresAt: '2026-11-17T09:00:00.000Z' } }, null, NOW);
    assert.equal(past.state, 'not ready');
    assert.match(renderLine(past), /run codex login/);
  });
});
