/**
 * M6 — the Codex worker adapter (REQ-601 to REQ-604): a stub `codex` on BUILDER_CODEX_WORKER_BIN, no model, no key.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const codex = require('../scripts/lib/orch-worker-codex.cjs');
const { runWorker } = require('../scripts/lib/worker-runner.cjs');
const { childEnv, neverInherited } = require('../scripts/lib/worker-env.cjs');
const { readVerdict, VERDICT_SCHEMA } = require('../scripts/lib/worker-verdict.cjs');
const STUB = join(here, 'fixtures', 'orch', 'stub-codex.cjs');

const tmp = mkdtempSync(join(tmpdir(), 'kit-codex-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
const fixture = (name, lines) => {
  const f = join(tmp, `${name}.jsonl`);
  writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return f;
};
const POLLUTED = {
  PATH: process.env.PATH, HOME: tmp, LANG: 'C.UTF-8', TERM: 'dumb', TMPDIR: tmp,
  ANTHROPIC_API_KEY: 'stub-not-a-key', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CONFIG_DIR: '/x',
  OPENAI_API_KEY: 'stub', CODEX_HOME: '/y', GEMINI_API_KEY: 'stub', NODE_OPTIONS: '--x', NODE_EXTRA_CA_CERTS: '/c', SSL_CERT_FILE: '/f',
  HTTPS_PROXY: 'http://p', http_proxy: 'http://p', LD_PRELOAD: '/l', XDG_CONFIG_HOME: '/xdg', EDITOR: 'vi',
};
const configDir = join(tmp, 'codex-home');
const DONE = [{ type: 'thread.started', thread_id: 't1' }, { type: 'turn.started' }, { type: 'item.completed', item: { type: 'agent_message', text: '{"verdict":"PASS","summary":"ok","filesTouched":["a.js"],"head":"abc1234","requirements":["REQ-601"]}' } }, { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } }];

async function start(fixtureFile, { passTimeoutMs = 5000, stallTimeoutMs = 5000, extraEnv = {} } = {}) {
  const echo = join(tmp, `echo-${Math.random().toString(36).slice(2)}.json`);
  const env = codex.env(POLLUTED, { configDir, accountEnv: {} });
  Object.assign(env, { BUILDER_STUB_FIXTURE: fixtureFile, BUILDER_STUB_ECHO: echo }, extraEnv);
  const r = await runWorker({ bin: STUB, args: codex.args({ schemaFile: join(tmp, 'schema.json') }), env, cwd: tmp, prompt: 'do the row', passTimeoutMs, stallTimeoutMs, keySourceVerdict: codex.keySourceVerdict });
  return { ...r, echo: JSON.parse(readFileSync(echo, 'utf8')) };
}

describe('REQ-601 — child env from an allowlist', () => {
  test('red: the allowlist and CODEX_HOME reach the child; the polluted variables do not', async () => {
    const r = await start(fixture('done', DONE));
    const names = new Set(r.echo.envNames);
    for (const k of ['PATH', 'HOME', 'LANG', 'TERM', 'TMPDIR', 'CODEX_HOME']) assert.ok(names.has(k), `${k} missing`);
    for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CONFIG_DIR', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'HTTPS_PROXY', 'http_proxy', 'LD_PRELOAD', 'XDG_CONFIG_HOME', 'EDITOR']) assert.ok(!names.has(k), `${k} leaked`);
    assert.equal(r.echo.codexHome, configDir);
  });
  test('the account block passes through, but never a key variable; neverInherited is the pure rule', () => {
    const e = childEnv(POLLUTED, { worker: 'codex', configDir, accountEnv: { OPENAI_BASE_URL: 'http://gw.local' } });
    assert.equal(e.OPENAI_BASE_URL, 'http://gw.local');
    assert.throws(() => childEnv(POLLUTED, { worker: 'codex', configDir, accountEnv: { OPENAI_API_KEY: 'x' } }), /never enters a worker through the environment/);
    assert.throws(() => childEnv(POLLUTED, { worker: 'codex', configDir: 'relative/dir' }), /absolute/);
    for (const k of ['ANTHROPIC_X', 'CLAUDE', 'CLAUDEX', 'OPENAI_Y', 'CODEX_Z', 'GEMINI_K', 'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_DIR', 'ALL_PROXY', 'no_proxy', 'LD_PRELOAD', 'XDG_CONFIG_HOME']) assert.ok(neverInherited(k), k);
    assert.ok(!neverInherited('PATH'));
  });
});

describe('REQ-602 — key source', () => {
  test('red: the login status is the proof: a subscription account on an API-key login stops; unreadable text is unconfirmed', () => {
    assert.equal(codex.preflightKeySource('Logged in using ChatGPT\n', 'subscription').fault, null);
    assert.equal(codex.preflightKeySource('Logged in using ChatGPT\n', 'subscription').source, 'chatgpt');
    assert.match(codex.preflightKeySource('Logged in using an API key\n', 'subscription').fault, /stopped before any model call/);
    assert.match(codex.preflightKeySource('Not logged in\n', 'api-key').fault, /not logged in/i);
    const u = codex.preflightKeySource('codex-cli 0.99 something\n', 'subscription');
    assert.equal(u.source, 'unconfirmed');
    assert.equal(u.fault, null);
    assert.equal(codex.KEY_SOURCE_PROOF, 'unconfirmed');
  });
});

describe('REQ-603 — the runner owns the pass timeout and the stall window', () => {
  test('red: a worker that never exits is FAILED-TIMEOUT and the process is stopped', async () => {
    const r = await start(fixture('hang', [{ type: 'thread.started' }, { _stub: 'hang' }]), { passTimeoutMs: 400, stallTimeoutMs: 5000 });
    assert.equal(r.outcome, 'FAILED-TIMEOUT');
    assert.equal(r.stopped, true);
  });
  test('red: a worker that stops emitting for the stall window is FAILED-STALL', async () => {
    const r = await start(fixture('stall', [{ type: 'thread.started' }, { _stub: 'sleep', ms: 1500 }, { type: 'turn.completed' }]), { passTimeoutMs: 5000, stallTimeoutMs: 300 });
    assert.equal(r.outcome, 'FAILED-STALL');
  });
  test('a worker that finishes is EXITED with its events and code', async () => {
    const r = await start(fixture('done2', DONE));
    assert.equal(r.outcome, 'EXITED');
    assert.equal(r.exitCode, 0);
    assert.equal(r.events.length, 4);
    assert.deepEqual(r.echo.argv.slice(0, 2), ['exec', '--json']);
    assert.ok(r.echo.argv.includes('--output-schema'));
    assert.equal(r.echo.stdin, 'do the row');
  });
});

describe('REQ-604 — the verdict', () => {
  const good = { verdict: 'PASS', summary: 'ok', filesTouched: ['a.js'], head: 'abc1234', requirements: ['REQ-601', 'REQ-602'] };
  test('red: a verdict for the previous commit is FAILED-STALE-VERDICT', () => {
    assert.equal(readVerdict(good, { head: 'def5678', claimed: ['REQ-601'] }).job, 'FAILED-STALE-VERDICT');
  });
  test('red: a verdict without requirements is FAILED naming the field; a missing claimed id is FAILED', () => {
    const { requirements, ...noReq } = good;
    const r = readVerdict(noReq, { head: 'abc1234' });
    assert.equal(r.job, 'FAILED');
    assert.match(r.reason, /requirements/);
    assert.match(readVerdict(good, { head: 'abc1234', claimed: ['REQ-999'] }).reason, /REQ-999/);
    assert.equal(readVerdict({ ...good, verdict: 'MAYBE' }, { head: 'abc1234' }).job, 'FAILED');
  });
  test('red: exit 0 with no verdict is FAILED; a denied tool is INCOMPLETE', () => {
    assert.equal(readVerdict(null, { head: 'abc1234', exitCode: 0 }).job, 'FAILED');
    assert.equal(readVerdict(good, { head: 'abc1234', denials: ['Bash: rm -rf'] }).job, 'INCOMPLETE');
    const ok = readVerdict(good, { head: 'abc1234', claimed: ['REQ-601'] });
    assert.equal(ok.job, 'VERDICT');
    assert.equal(ok.verdict.verdict, 'PASS');
  });
  test('the Codex adapter reads the verdict from the last agent message and the schema names the five fields', () => {
    assert.deepEqual(codex.verdict(DONE), JSON.parse(DONE[2].item.text));
    assert.deepEqual(VERDICT_SCHEMA.required.slice().sort(), ['filesTouched', 'head', 'requirements', 'summary', 'verdict']);
    assert.equal(codex.runSucceeded(DONE, 0), true);
    assert.equal(codex.runSucceeded([{ type: 'turn.failed', error: { message: 'x' } }], 1), false);
  });
});

describe('classifyError — LIMIT, BUDGET, OVERLOAD, AUTH', () => {
  const now = Date.parse('2026-11-17T10:00:00Z');
  test('red: 429 with Retry-After 2400 is LIMIT until now plus 40 min', () => {
    const r = codex.classifyError(['429 Too Many Requests'], { headers: { 'retry-after': '2400' }, now });
    assert.equal(r.kind, 'LIMIT');
    assert.equal(r.until, new Date(now + 2400 * 1000).toISOString());
  });
  test('402 with a reset time is BUDGET; 529 is OVERLOAD; 401 is AUTH; a usage-limit text is LIMIT', () => {
    assert.equal(codex.classifyError(['402 insufficient_quota, resets at 2026-11-18T00:00:00Z'], { now }).kind, 'BUDGET');
    assert.equal(codex.classifyError(['402 insufficient_quota, resets at 2026-11-18T00:00:00Z'], { now }).until, '2026-11-18T00:00:00.000Z');
    assert.equal(codex.classifyError(['529 overloaded_error'], { now }).kind, 'OVERLOAD');
    assert.equal(codex.classifyError(['401 Unauthorized'], { now }).kind, 'AUTH');
    const r = codex.classifyError(["You've hit your usage limit. Try again in 40 minutes."], { now });
    assert.equal(r.kind, 'LIMIT');
    assert.equal(r.until, new Date(now + 40 * 60000).toISOString());
    assert.equal(codex.classifyError(['something else'], { now }).kind, null);
  });
});
