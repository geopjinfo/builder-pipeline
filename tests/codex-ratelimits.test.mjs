/**
 * The Codex session `rate_limits` reader — `scripts/lib/codex-ratelimits.cjs` (REQ-203, REQ-212; D43, D51).
 *
 * WHY. Codex prints no usage percentage on a headless surface, but every session rollout under `<CODEX_HOME>/sessions`
 * carries `token_count` events with the account's `rate_limits` windows. The newest record is a measured reading; no
 * record is unmeasured, never 0 %.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const PACK = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { read, parseRateLimits, newestSession } = require(join(PACK, 'scripts/lib/codex-ratelimits.cjs'));
const made = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

const home = () => { const d = mkdtempSync(join(tmpdir(), 'codex-home-')); made.push(d); return d; };
const line = (o) => `${JSON.stringify(o)}\n`;
const AT = '2026-11-17T09:14:00.000Z';
const tokenCount = (rate_limits, timestamp = AT) => line({ timestamp, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 10 } }, rate_limits } });

function session(h, rel, text, ageSeconds) {
  const file = join(h, 'sessions', rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  const t = (Date.now() - ageSeconds * 1000) / 1000;
  utimesSync(file, t, t);
  return file;
}

describe('codex-ratelimits', () => {
  test('REQ-203 the last token_count record of the newest session gives a measured percent, an until and a time', () => {
    const h = home();
    session(h, '2026/11/16/rollout-old.jsonl', tokenCount({ primary: { used_percent: 90, window_minutes: 300, resets_in_seconds: 60 } }, '2026-11-16T09:00:00.000Z'), 3600);
    session(h, '2026/11/17/rollout-new.jsonl',
      line({ timestamp: AT, type: 'session_meta', payload: { id: 'x' } }) +
      tokenCount({ primary: { used_percent: 12, window_minutes: 300, resets_in_seconds: 3600 } }, '2026-11-17T09:00:00.000Z') +
      tokenCount({ primary: { used_percent: 42, window_minutes: 300, resets_in_seconds: 3600 }, secondary: { used_percent: 10, window_minutes: 10080, resets_at: 1763856000 } }), 10);
    const r = read(h);
    assert.equal(r.percent, 42);
    assert.equal(r.source, 'measured');
    assert.equal(r.reader, 'codex-ratelimits');
    assert.equal(r.at, AT);
    assert.equal(r.until, '2026-11-17T10:14:00.000Z');
    assert.equal(r.windows.primary.used_percent, 42);
    assert.equal(r.windows.secondary.until, new Date(1763856000 * 1000).toISOString());
    assert.match(newestSession(h), /rollout-new\.jsonl$/);
  });

  test('REQ-212 the window closest to its limit binds: a higher secondary percent is the reading', () => {
    const text = tokenCount({ primary: { used_percent: 20, resets_in_seconds: 100 }, secondary: { used_percent: 75, resets_at: '2026-11-20T00:00:00.000Z' } });
    const r = parseRateLimits(text);
    assert.equal(r.percent, 75);
    assert.equal(r.until, '2026-11-20T00:00:00.000Z');
  });

  test('REQ-203 no sessions, no token_count record or an unreadable file read as null (unmeasured), never 0', () => {
    const empty = home();
    assert.equal(read(empty), null);
    assert.equal(newestSession(empty), null);
    const h = home();
    session(h, '2026/11/17/rollout.jsonl', line({ timestamp: AT, type: 'event_msg', payload: { type: 'agent_message' } }) + 'not json\n', 1);
    assert.equal(read(h), null);
    assert.equal(parseRateLimits(''), null);
    assert.equal(parseRateLimits(tokenCount({ primary: { used_percent: 'n/a' } })), null);
    assert.equal(read(join(h, 'missing-dir')), null);
  });
});
