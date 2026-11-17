/**
 * routerHint — advisory account suggestion, risk flag and second-opinion advice for a lane (plan M8b, D15;
 * scripts/lib/router-hint.cjs). Experimental-off: off, nothing of it runs. Advisory: it never changes a placement.
 * Any call that would send task text to an account whose data-recipient decision is not recorded is refused with
 * E_DATA_RECIPIENT first; everything else goes through the outbound guard (scripts/lib/outbound-guard.cjs).
 * Every fake secret below is built at run time by concatenation, never written as a literal.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const hint = require('../scripts/lib/router-hint.cjs');
const profile = require('../scripts/lib/profile.cjs');

const noFs = { read: () => null };
const acct = (name, over) => ({ name, worker: 'claude-code', pays: 'subscription', content: 'any', roles: [], family: 'anthropic', tier: 'strong', baseUrl: null, ...over });
const alpha = acct('alpha');
const bravo = acct('bravo', { worker: 'codex', family: 'openai', tier: 'strong', pays: 'gateway', baseUrl: 'https://gw.example.test/v1' });
const charlie = acct('charlie', { pays: 'api-key', tier: 'mid' });
const pub = acct('pub', { content: 'public', pays: 'free' });
const headless = acct('headless', { roles: ['module-tester', 'module-reviewer'] });
const lane = (over = {}) => ({ name: 'l1', rows: ['R1'], level: 'Standard', track: 'ADDITIVE', dispatch: 'full', ownedFiles: ['src/a.ts'], hotFiles: [], ...over });
const made = [];
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('routerHint is experimental-off and runs nothing while off (M8b)', () => {
  test('red: the loader knows features.routerHint as experimental-off and `features` prints its line', () => {
    assert.equal(profile.FEATURES.routerHint.defaults.state, 'experimental-off');
    const dir = mkdtempSync(join(tmpdir(), 'router-hint-'));
    made.push(dir);
    const r = spawnSync(process.execPath, [join(here, '..', 'scripts', 'features.mjs')], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^routerHint: experimental — not enabled( · decision: .*)?$/m); // REQ-1401 appends the §16 decision
  });

  test('red: off, run() returns the "not enabled" line, suggests nothing and never calls out', async () => {
    let calls = 0;
    const r = await hint.run({ features: { routerHint: { state: 'experimental-off' } } }, { lane: lane(), accounts: [alpha, bravo], call: () => (calls += 1) });
    assert.deepEqual(r, { ran: false, line: 'routerHint: experimental — not enabled' });
    assert.equal(calls, 0);
    const absent = await hint.run({ features: {} }, { lane: lane(), accounts: [alpha, bravo], call: () => (calls += 1) });
    assert.deepEqual(absent, r);
    assert.equal(calls, 0);
  });
});

describe('routerHint advice: account suggestion, risk flag, second opinion — never a placement', () => {
  test('red: the suggestion follows the pays order and skips a content class the project visibility refuses, with a risk flag', () => {
    const r = hint.suggest({ lane: lane(), accounts: [charlie, pub, alpha, bravo], visibility: 'private' });
    assert.equal(r.advisory, true);
    assert.equal(r.account, 'alpha', 'subscription first, api-key last, the public-only account skipped');
    assert.ok(r.risk.some((f) => /content public vs visibility private/.test(f)), r.risk.join('; '));
    assert.match(r.lines.join('\n'), /^routerHint: suggest alpha /m);
    const open = hint.suggest({ lane: lane(), accounts: [pub], visibility: 'public' });
    assert.equal(open.account, 'pub');
    assert.deepEqual(open.risk.filter((f) => /content/.test(f)), []);
    const none = hint.suggest({ lane: lane(), accounts: [headless, pub], visibility: 'private' });
    assert.equal(none.account, null);
    assert.match(none.lines.join('\n'), /routerHint: no account suggestion/);
  });

  test('red: a Full lane carries a risk flag and, with an other-family account at or above the writer\'s tier, a second opinion is advised', () => {
    const full = hint.suggest({ lane: lane({ level: 'Full', track: 'FULL' }), accounts: [alpha, bravo], visibility: 'private' });
    assert.ok(full.risk.some((f) => /level Full/.test(f)), full.risk.join('; '));
    assert.equal(full.secondOpinion.advised, true);
    assert.match(full.secondOpinion.reason, /bravo/);
    assert.match(full.lines.join('\n'), /^routerHint: second opinion advised — /m);
    const noOther = hint.suggest({ lane: lane({ level: 'Full', track: 'FULL' }), accounts: [alpha], visibility: 'private' });
    assert.equal(noOther.secondOpinion.advised, false);
    assert.match(noOther.secondOpinion.reason, /no other-family account at or above tier strong/);
    const plain = hint.suggest({ lane: lane(), accounts: [alpha, bravo], visibility: 'private' });
    assert.equal(plain.secondOpinion.advised, false);
    assert.match(plain.secondOpinion.reason, /Standard/);
  });

  test('red: advisory only — the lane and the accounts come back unchanged and the result names no placement', () => {
    const l = lane({ level: 'Full', track: 'FULL' });
    const before = JSON.stringify([l, alpha, bravo]);
    const r = hint.suggest({ lane: l, accounts: [alpha, bravo], visibility: 'private' });
    assert.equal(JSON.stringify([l, alpha, bravo]), before);
    assert.ok(!('placement' in r) && !('seat' in r) && !('placed' in r));
    assert.ok(!('account' in l) && !('seat' in l));
  });
});

describe('routerHint sends only behind the outbound guard, and never to an unrecorded data recipient', () => {
  const fakeKey = 'sk-ant-' + 'api03-' + 'c'.repeat(30);
  const guardOn = { state: 'on' };

  test('red: a gateway account with no decision-log row is refused with E_DATA_RECIPIENT first, before the guard, and the call never runs', async () => {
    let calls = 0;
    const r = await hint.send({ text: `lane l1 rows R1\nconst k = "${fakeKey}";` }, () => (calls += 1), { account: bravo, decisions: '| D-1 | something else |\n', guard: guardOn, fsLike: noFs });
    assert.equal(r.sent, false);
    assert.equal(r.code, 'E_DATA_RECIPIENT');
    assert.equal(calls, 0);
    assert.match(r.reasons.join('\n'), /account bravo is a data recipient/);
    for (const reason of r.reasons) assert.ok(!reason.includes(fakeKey), 'the reason never carries the secret');
  });

  test('red: with the decision recorded the outbound guard judges the payload: a secret shape is not sent, a clean excerpt is', async () => {
    let calls = 0;
    const decisions = '| D-7 | bravo goes through the gateway host gw.example.test; owner accepted |\n';
    const refused = await hint.send({ text: `const k = "${fakeKey}";` }, () => (calls += 1), { account: bravo, decisions, guard: guardOn, fsLike: noFs });
    assert.equal(refused.sent, false);
    assert.equal(refused.code, 'E_OUTBOUND');
    assert.equal(calls, 0);
    assert.ok(refused.reasons.some((x) => /Anthropic key/.test(x)), refused.reasons.join('; '));
    for (const reason of refused.reasons) assert.ok(!reason.includes(fakeKey));
    const ok = await hint.send({ text: 'lane l1: rows R1, level Standard, files src/a.ts' }, () => 'advice', { account: bravo, decisions, guard: guardOn, fsLike: noFs });
    assert.deepEqual(ok, { sent: true, ok: true, result: 'advice' });
    const sub = await hint.send({ text: 'lane l1' }, () => 'advice', { account: alpha, decisions: '', guard: guardOn, fsLike: noFs });
    assert.equal(sub.sent, true, 'a subscription account with no baseUrl is not a data recipient');
  });

  test('red: with features.outboundGuard off nothing is sent (E_GUARD_OFF) and the call never runs', async () => {
    let calls = 0;
    const r = await hint.send({ text: 'lane l1' }, () => (calls += 1), { account: alpha, decisions: '', guard: { state: 'off' }, fsLike: noFs });
    assert.deepEqual([r.sent, r.code, calls], [false, 'E_GUARD_OFF', 0]);
    const none = await hint.send({ text: 'lane l1' }, () => (calls += 1), { account: alpha, decisions: '', fsLike: noFs });
    assert.deepEqual([none.sent, none.code, calls], [false, 'E_GUARD_OFF', 0]);
  });

  test('red: run() with the feature on prints the advice lines and, with no call, sends nothing', async () => {
    const settings = { visibility: 'private', features: { routerHint: { state: 'experimental-on' }, outboundGuard: { state: 'on' }, handoffPack: { decisionIdPattern: 'D-\\d+' } } };
    const r = await hint.run(settings, { lane: lane({ level: 'Full', track: 'FULL' }), accounts: [alpha, bravo] });
    assert.equal(r.ran, true);
    assert.equal(r.account, 'alpha');
    assert.equal(r.secondOpinion.advised, true);
    assert.equal(r.sent, undefined);
    assert.match(r.lines.join('\n'), /routerHint: suggest alpha/);
    assert.match(r.lines.join('\n'), /advisory only — placement is unchanged/);
  });
});
