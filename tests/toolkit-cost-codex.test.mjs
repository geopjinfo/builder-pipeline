/**
 * The Codex transcript cost reader (specs/toolkit-cost-codex.spec.md). Each test names the acceptance criterion it
 * asserts (AC-6nn → REQ-6nn in the spec).
 *
 *   REQ-601…602  `features.costAccounting.reader` accepts `codex`; anything else is refused at load
 *   REQ-603      the sessions directory: --transcripts, CODEX_HOME/sessions, ~/.codex/sessions; recursive rollout-*.jsonl
 *   REQ-604…606  the record layer: typed records in file order, rate_limits surfaced raw, unrecognised shapes reported
 *   REQ-607…611  the cost layer: deltas of cumulative totals per model, window filter, decreasing total refused,
 *                unpriced never $0, --rates prices through pricing.cost()
 *   REQ-612…614  cost-window branches on the reader; seat-peaks / orchestrator-check say unmeasurable and why;
 *                `features` prints the same line
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const PACK = join(here, '..');
const script = (name) => join(PACK, 'scripts', `${name}.mjs`);
const profile = require('../scripts/lib/profile.cjs');
const codex = require('../scripts/lib/codex-usage.cjs');

const FIXTURES = join(here, 'fixtures', 'codex-sessions');
const SESSIONS = join(FIXTURES, 'sessions');
const DECREASING = join(FIXTURES, 'decreasing');
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
const sessionA = walk(SESSIONS).find((f) => basename(f).includes('aaaaaaaa'));
const sessionB = walk(SESSIONS).find((f) => basename(f).includes('bbbbbbbb'));
const textA = readFileSync(sessionA, 'utf8');

const made = [];
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = (label) => {
  const dir = mkdtempSync(join(tmpdir(), `builder-cost-${label}-`));
  made.push(dir);
  return dir;
};
const settings = (over = {}) => JSON.stringify({ schema: 2, ...over }, null, 2);
const profileText = (over) => `# PIPELINE_PROFILE — fixture\n\n## 16. Pipeline settings\n\n\`\`\`json pipeline-settings\n${settings(over)}\n\`\`\`\n`;
const project = (over) => {
  const dir = tmp('project');
  writeFileSync(join(dir, 'PIPELINE_PROFILE.md'), profileText(over));
  return dir;
};
const run = (cwd, name, args = [], env = {}) =>
  spawnSync(process.execPath, [script(name), ...args], { cwd, encoding: 'utf8', env: { ...process.env, HOME: cwd, CODEX_HOME: '', CLAUDE_CODE_SESSION_ID: '', ...env } });
const on = (reader) => ({ costAccounting: { state: 'on', reader } });
const WINDOW = ['--since', '2026-11-16T00:00:00Z', '--until', '2026-11-18T00:00:00Z'];
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `expected ${expected}, got ${actual}`);

describe('REQ-601…602 — the reader value', () => {
  test('AC-601: reader "codex" is accepted', () => {
    const { errors } = profile.parse(profileText({ features: on('codex') }));
    assert.deepEqual(errors, []);
  });

  test('AC-602: red: any other reader is refused and the error names both accepted values', () => {
    const { errors } = profile.parse(profileText({ features: on('gemini') }));
    assert.equal(errors.length, 1, errors.join('\n'));
    assert.match(errors[0], /features\.costAccounting\.reader/);
    assert.match(errors[0], /claude-code/);
    assert.match(errors[0], /codex/);
  });
});

describe('REQ-603 — where the sessions are', () => {
  test('AC-603: --transcripts wins, then CODEX_HOME/sessions, then ~/.codex/sessions', () => {
    assert.equal(codex.sessionsDir('/explicit/dir', { CODEX_HOME: '/codex-home' }), '/explicit/dir');
    assert.equal(codex.sessionsDir(null, { CODEX_HOME: '/codex-home' }), join('/codex-home', 'sessions'));
    assert.match(codex.sessionsDir(null, {}), /[\\/]\.codex[\\/]sessions$/);
  });

  test('AC-604: the walk finds every rollout-*.jsonl under YYYY/MM/DD and nothing else', () => {
    const files = codex.jsonlFiles(SESSIONS).map((f) => basename(f)).sort();
    assert.deepEqual(files, [basename(sessionA), basename(sessionB)].sort());
    assert.deepEqual(codex.jsonlFiles(join(FIXTURES, 'no-such-dir')), []);
  });
});

describe('REQ-604…606 — the record layer', () => {
  test('AC-605: records come back typed, in file order', () => {
    const recs = codex.records(textA);
    assert.deepEqual(
      recs.map((r) => r.kind),
      ['session_meta', 'turn_context', 'token_count', 'token_count', 'other', 'token_count', 'turn_context', 'token_count'],
    );
    assert.equal(recs[0].sessionId, 'aaaaaaaa-0000-4000-8000-000000000001');
    assert.equal(recs[0].timestamp, '2026-11-16T10:00:00.000Z');
    assert.equal(recs[1].model, 'model-alpha');
    assert.equal(recs[6].model, 'model-beta');
    assert.equal(recs[4].type, 'turn_complete');
    assert.equal(recs[2].total.inputTokens, 1000);
    assert.equal(recs[2].total.cachedInputTokens, 400);
    assert.equal(recs[2].last.outputTokens, 200);
    assert.equal(codex.parseLine(''), null);
  });

  test('AC-606: a token_count surfaces payload.rate_limits unchanged, null when absent', () => {
    const recs = codex.records(textA);
    const raw = JSON.parse(textA.split('\n')[3]).payload.rate_limits;
    assert.deepEqual(recs[3].rateLimits, raw);
    assert.equal(recs[3].rateLimits.primary.used_percent, 12.5);
    assert.equal(recs[2].rateLimits, null);
  });

  test('AC-607: red: three unrecognised shapes are reported with line numbers, never summed', () => {
    const lines = textA.split('\n').filter(Boolean);
    const bad = [
      lines[0],
      'this is not json',
      JSON.stringify({ timestamp: '2026-11-16T10:00:02.000Z', payload: {} }),
      lines[1],
      JSON.stringify({ timestamp: '2026-11-16T10:00:03.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: '1000', cached_input_tokens: 0, output_tokens: 1 } }, rate_limits: null } }),
      lines[2],
    ].join('\n') + '\n';
    const recs = codex.records(bad);
    const unrec = recs.filter((r) => r.kind === 'unrecognised');
    assert.deepEqual(unrec.map((r) => r.line), [2, 3, 5]);
    assert.match(unrec[0].reason, /not JSON/);
    assert.match(unrec[1].reason, /type/);
    assert.match(unrec[2].reason, /input_tokens/);
    const summary = codex.sessionUsage(recs);
    assert.equal(summary.measurable, true);
    assert.equal(summary.turns, 1);
    assert.equal(summary.outputTokens, 200);
    assert.equal(summary.unrecognised, 3);
  });

  test('AC-608: a cut last line is torn, and the complete lines are still summed', () => {
    const lines = textA.split('\n').filter(Boolean);
    const torn = lines.slice(0, 3).join('\n') + '\n' + lines[3].slice(0, 80);
    const recs = codex.records(torn);
    assert.equal(recs.at(-1).kind, 'torn');
    assert.equal(recs.at(-1).line, 4);
    const summary = codex.sessionUsage(recs);
    assert.equal(summary.measurable, true);
    assert.equal(summary.turns, 1);
    assert.equal(summary.outputTokens, 200);
  });
});

describe('REQ-607…611 — the cost layer', () => {
  test('AC-609: deltas of the cumulative total, per model; a repeated total adds zero', () => {
    const s = codex.sessionUsage(codex.records(textA));
    assert.equal(s.measurable, true);
    assert.equal(s.turns, 3);
    const byModel = Object.fromEntries(s.perModel.map((m) => [m.model, m]));
    assert.equal(byModel['model-alpha'].promptTokens, 3000);
    assert.equal(byModel['model-alpha'].outputTokens, 500);
    assert.equal(byModel['model-alpha'].turns, 2);
    assert.equal(byModel['model-beta'].promptTokens, 3000);
    assert.equal(byModel['model-beta'].outputTokens, 600);
    assert.equal(byModel['model-beta'].turns, 1);
    assert.equal(s.model, 'model-alpha');
    assert.equal(s.firstTs, '2026-11-16T10:00:05.000Z');
    assert.equal(s.lastTs, '2026-11-16T10:00:20.000Z');
    assert.equal(s.durationMs, 15000);
  });

  test('AC-610: the priced fields follow DL-5 (input minus cached, cached as cache read, cache write, output as output)', () => {
    const s = codex.sessionUsage(codex.records(textA));
    const byModel = Object.fromEntries(s.perModel.map((m) => [m.model, m]));
    assert.deepEqual(
      [byModel['model-alpha'].inputTokens, byModel['model-alpha'].cacheReadTokens, byModel['model-alpha'].cacheWriteTokens, byModel['model-alpha'].outputTokens],
      [1400, 1600, 100, 500],
    );
    assert.deepEqual(
      [byModel['model-beta'].inputTokens, byModel['model-beta'].cacheReadTokens, byModel['model-beta'].cacheWriteTokens, byModel['model-beta'].outputTokens],
      [1500, 1500, 150, 600],
    );
    assert.equal(s.inputTokens, 2900);
    assert.equal(s.cacheReadTokens, 3100);
    assert.equal(s.cacheWriteTokens, 250);
    assert.equal(s.outputTokens, 1100);
    assert.equal(s.reasoningTokens, 300);
  });

  test('AC-611: a delta outside the window is not summed', () => {
    const s = codex.sessionUsage(codex.records(textA), { since: '2026-11-16T10:00:15Z', until: '2026-11-16T10:01:00Z' });
    assert.deepEqual(s.perModel.map((m) => m.model), ['model-beta']);
    assert.equal(s.turns, 1);
    assert.equal(s.outputTokens, 600);
    assert.equal(s.firstTs, '2026-11-16T10:00:20.000Z');
    const none = codex.sessionUsage(codex.records(textA), { since: '2027-01-01', until: '2027-01-02' });
    assert.equal(none.turns, 0);
  });

  test('AC-612: red: a decreasing cumulative total makes the session unmeasurable, with the line number', () => {
    const text = readFileSync(codex.jsonlFiles(DECREASING)[0], 'utf8');
    const s = codex.sessionUsage(codex.records(text));
    assert.equal(s.measurable, false);
    assert.match(s.reason, /line 5/);
    assert.match(s.reason, /decreas/);
  });

  test('AC-613: cost-window prints the unmeasurable session and exits 0', () => {
    const dir = project({ features: on('codex') });
    const r = run(dir, 'cost-window', [...WINDOW, '--transcripts', DECREASING]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^unmeasurable: .*rollout-2026-11-16T12-00-00-cccccccc.*\.jsonl: .*line 5/m);
    assert.match(r.stdout, /^TOTAL \$0\.00$/m);
    assert.doesNotMatch(r.stdout, /unmeasurable with this harness/);
  });

  test('AC-614: red: with no rate for the models, every session is unpriced and the total is partial, never $0 alone', () => {
    const dir = project({ features: on('codex') });
    const json = run(dir, 'cost-window', [...WINDOW, '--transcripts', SESSIONS, '--json']);
    assert.equal(json.status, 0, json.stdout + json.stderr);
    const out = JSON.parse(json.stdout);
    assert.equal(out.partial, true);
    assert.equal(out.unpriced, 2);
    assert.equal(out.total, 0);
    assert.equal(out.reader, 'codex');
    const table = run(dir, 'cost-window', [...WINDOW, '--transcripts', SESSIONS]);
    assert.equal(table.status, 0, table.stdout + table.stderr);
    for (const line of table.stdout.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| Seat'))) {
      assert.match(line, /\$0\.00 \(\+1 unpriced\)/, line);
    }
    assert.match(table.stdout, /^TOTAL \$0\.00 — PARTIAL: 2 dispatch\(es\) unpriced$/m);
    assert.match(table.stdout, /\| reviewer \|/);
    assert.match(table.stdout, /\| codex-session \|/);
  });

  test('AC-615: a --rates table prices Codex usage through pricing.cost()', () => {
    const dir = project({ features: on('codex') });
    const rates = join(dir, 'rates.cjs');
    writeFileSync(
      rates,
      `'use strict';
const RATES = {
  'model-alpha': { input: 1, output: 10, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2 },
  'model-beta': { input: 2, output: 20, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 },
  'model-gamma': { input: 1, output: 1, cacheRead: 1, cacheWrite5m: 1, cacheWrite1h: 1 },
};
const t = (v) => (typeof v === 'number' ? v : 0);
function cost(model, u = {}) {
  const r = RATES[model];
  if (!r) return null;
  return (t(u.inputTokens) * r.input + t(u.outputTokens) * r.output + t(u.cacheReadTokens) * r.cacheRead + t(u.cacheWriteTokens) * r.cacheWrite5m) / 1e6;
}
module.exports = { cost, version: 'fixture-rates', rates: RATES };
`,
    );
    const r = run(dir, 'cost-window', [...WINDOW, '--transcripts', SESSIONS, '--rates', rates, '--json']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.partial, false);
    assert.equal(out.unpriced, 0);
    assert.equal(out.rates, 'fixture-rates');
    // alpha (1400·1 + 500·10 + 1600·0.1 + 100·1.25) + beta (1500·2 + 600·20 + 1500·0.2 + 150·2.5) + gamma (500 + 100), per 1M.
    close(out.total, (6685 + 15675 + 600) / 1e6);
  });
});

describe('REQ-612…614 — the scripts that branch on the reader', () => {
  test('AC-616: the Claude Code path is unchanged', () => {
    const dir = project({ features: on('claude-code') });
    const r = run(dir, 'cost-window', WINDOW);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^window 2026-11-16T00:00:00Z → 2026-11-18T00:00:00Z/m);
    assert.doesNotMatch(r.stdout, /unmeasurable/);
    assert.doesNotMatch(r.stdout, /codex/);
  });

  test('AC-617: a reader that is neither is refused by the loader before anything is read', () => {
    const dir = project({ features: on('other') });
    const r = run(dir, 'cost-window', WINDOW);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /features\.costAccounting\.reader/);
  });

  test('AC-618: seat-peaks says unmeasurable, names the codex reader and a reason, exit 0', () => {
    const dir = project({ features: on('codex') });
    const r = run(dir, 'seat-peaks', []);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout.trim(), /^seat peaks: unmeasurable with this harness \(reader "codex": .+\)$/);
  });

  test('AC-619: orchestrator-check says unmeasurable, names the codex reader and a reason, exit 0', () => {
    const dir = project({ models: { orchestrator: 'model-alpha' }, features: { ...on('codex'), orchestratorModel: { state: 'on' } } });
    const r = run(dir, 'orchestrator-check', []);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout.trim(), /^orchestrator model: unmeasurable with this harness \(reader "codex": .+\)$/);
  });

  test('AC-620: `features` prints costAccounting: on for the codex reader and the profile is valid', () => {
    const dir = project({ features: on('codex') });
    const r = run(dir, 'features', []);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^costAccounting: on$/m);
    assert.match(r.stdout, /^features: profile valid$/m);
  });

  test('AC-621: collect() gives one row per session file with its seat and summary', () => {
    const { sessions, unmeasurable, coverage } = codex.collect(SESSIONS);
    assert.equal(unmeasurable.length, 0);
    assert.equal(coverage.total, 2);
    assert.equal(coverage.truncated, false);
    const rows = Object.fromEntries(sessions.map((s) => [s.sessionId, s]));
    assert.equal(rows['aaaaaaaa-0000-4000-8000-000000000001'].seat, 'codex-session');
    assert.equal(rows['aaaaaaaa-0000-4000-8000-000000000001'].file, sessionA);
    assert.equal(rows['aaaaaaaa-0000-4000-8000-000000000001'].summary.turns, 3);
    assert.equal(rows['bbbbbbbb-0000-4000-8000-000000000002'].seat, 'reviewer');
    assert.equal(rows['bbbbbbbb-0000-4000-8000-000000000002'].summary.outputTokens, 100);
    const bad = codex.collect(DECREASING);
    assert.equal(bad.sessions.length, 0);
    assert.equal(bad.unmeasurable.length, 1);
    assert.match(bad.unmeasurable[0].reason, /line 5/);
  });
});
