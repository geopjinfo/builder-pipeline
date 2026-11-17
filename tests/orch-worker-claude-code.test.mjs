/**
 * M6 — the Claude Code worker adapter's account mode (REQ-601, REQ-603 to REQ-605), on the stub worker.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const claude = require('../scripts/lib/orch-worker-claude-code.cjs');
const { runWorker } = require('../scripts/lib/worker-runner.cjs');
const { readVerdict, VERDICT_SCHEMA } = require('../scripts/lib/worker-verdict.cjs');
const STUB = join(here, 'fixtures', 'orch', 'stub-worker.cjs');
const HOOK = join(here, '..', 'hooks', 'claude-code', 'lane-gate.cjs');

const tmp = mkdtempSync(join(tmpdir(), 'kit-claude-worker-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
const fixture = (name, lines) => {
  const f = join(tmp, `${name}.jsonl`);
  writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return f;
};
const configDir = join(tmp, 'acct-config');
const settingsFile = join(tmp, 'pin.json');
writeFileSync(settingsFile, '{}');
const POLLUTED = { PATH: process.env.PATH, HOME: tmp, LANG: 'C', TERM: 'dumb', TMPDIR: tmp, ANTHROPIC_API_KEY: 'stub-not-a-key', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', CLAUDE_CODE_ENTRYPOINT: 'cli', NODE_OPTIONS: '--x', HTTPS_PROXY: 'http://p' };
const INIT = { type: 'system', subtype: 'init', apiKeySource: 'none' };
const RESULT = (extra = {}) => ({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, structured_output: { verdict: 'PASS', summary: 'ok', filesTouched: [], head: 'abc1234', requirements: ['REQ-603'] }, ...extra });

const launch = (over = {}) => claude.launchArgs({ model: 'm', maxTurns: 20, settingsFile, schema: VERDICT_SCHEMA, ...over });

async function start(fixtureFile, { passTimeoutMs = 5000, stallTimeoutMs = 5000, expected = 'none' } = {}) {
  const echo = join(tmp, `echo-${Math.random().toString(36).slice(2)}.json`);
  const env = claude.accountEnv(POLLUTED, { configDir, accountEnv: {} });
  Object.assign(env, { BUILDER_STUB_FIXTURE: fixtureFile, BUILDER_STUB_ECHO: echo });
  const r = await runWorker({ bin: STUB, args: launch(), env, cwd: tmp, prompt: 'brief', passTimeoutMs, stallTimeoutMs, keySourceVerdict: (events) => claude.keySourceVerdict(events, expected) });
  return { ...r, echo: JSON.parse(readFileSync(echo, 'utf8')) };
}

describe('REQ-603 — the launch command', () => {
  test('red: it carries --max-turns, --permission-mode, --permission-prompts none, --settings and --json-schema', () => {
    const a = launch();
    const at = (f) => a[a.indexOf(f) + 1];
    assert.equal(at('--max-turns'), '20');
    assert.equal(at('--permission-mode'), 'dontAsk');
    assert.equal(at('--permission-prompts'), 'none');
    assert.equal(at('--settings'), settingsFile);
    assert.deepEqual(JSON.parse(at('--json-schema')).required.slice().sort(), ['filesTouched', 'head', 'requirements', 'summary', 'verdict']);
    assert.ok(!a.includes('--bare'));
    assert.ok(!a.includes('--dangerously-skip-permissions'));
    assert.throws(() => launch({ maxTurns: null }), /maxTurns/);
    assert.throws(() => launch({ settingsFile: 'pin.json' }), /absolute/);
  });
});

describe('REQ-601 — account env', () => {
  test('red: the child sees the allowlist and CLAUDE_CONFIG_DIR only; ANTHROPIC_BASE_URL and the key are gone', async () => {
    const r = await start(fixture('ok', [INIT, RESULT()]));
    const names = new Set(r.echo.envNames);
    for (const k of ['PATH', 'HOME', 'CLAUDE_CONFIG_DIR']) assert.ok(names.has(k), k);
    for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_ENTRYPOINT', 'NODE_OPTIONS', 'HTTPS_PROXY']) assert.ok(!names.has(k), `${k} leaked`);
    assert.equal(r.echo.configDir, configDir);
    assert.equal(r.outcome, 'EXITED');
    assert.equal(readVerdict(claude.structuredVerdict(r.events), { head: 'abc1234', claimed: ['REQ-603'] }).job, 'VERDICT');
  });
  test('red: a worker on the wrong key source is stopped before any model call', async () => {
    const r = await start(fixture('wrongkey', [{ type: 'system', subtype: 'init', apiKeySource: 'ANTHROPIC_API_KEY' }, { _stub: 'sleep', ms: 300 }, { _stub: 'model_call' }, RESULT()]));
    assert.equal(r.outcome, 'STOPPED-KEY-SOURCE');
    assert.match(r.keyFault, /apiKeySource/);
  });
});

describe('REQ-603 — timers on the Claude adapter too', () => {
  test('red: never exits → FAILED-TIMEOUT; silent → FAILED-STALL', async () => {
    const t = await start(fixture('hang', [INIT, { _stub: 'sleep', ms: 60000 }]), { passTimeoutMs: 400, stallTimeoutMs: 10000 });
    assert.equal(t.outcome, 'FAILED-TIMEOUT');
    const s = await start(fixture('stall', [INIT, { _stub: 'sleep', ms: 1500 }, RESULT()]), { passTimeoutMs: 10000, stallTimeoutMs: 300 });
    assert.equal(s.outcome, 'FAILED-STALL');
  });
});

describe('REQ-604 — the structured verdict', () => {
  test('red: exit 0 with no structured output is FAILED; permission_denials is INCOMPLETE; another head is stale', () => {
    const none = readVerdict(claude.structuredVerdict([INIT, { type: 'result', subtype: 'success', is_error: false, result: 'done' }]), { head: 'abc1234', exitCode: 0 });
    assert.equal(none.job, 'FAILED');
    const ev = [INIT, RESULT({ permission_denials: [{ tool_name: 'Bash', tool_input: { command: 'rm' } }] })];
    assert.equal(readVerdict(claude.structuredVerdict(ev), { head: 'abc1234', denials: claude.denials(ev) }).job, 'INCOMPLETE');
    assert.equal(readVerdict(claude.structuredVerdict([INIT, RESULT()]), { head: 'ffffff1' }).job, 'FAILED-STALE-VERDICT');
  });
});

describe('REQ-605 — the gate hook in the settings pin', () => {
  test('red: a gate that exits 1 makes the hook exit 2 with the gate output as the reason', () => {
    const gate = join(tmp, 'gate.cjs');
    writeFileSync(gate, "process.stdout.write('1 test failed: bowling\\n'); process.exit(1);\n");
    const r = spawnSync(process.execPath, [HOOK, '--gate', `${JSON.stringify(process.execPath)} ${JSON.stringify(gate)}`, '--marker', claude.KIT_HOOK_MARKER], { input: '{"hook_event_name":"TaskCompleted"}', encoding: 'utf8', cwd: tmp });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /1 test failed: bowling/);
    const pass = join(tmp, 'pass.cjs');
    writeFileSync(pass, 'process.exit(0);\n');
    assert.equal(spawnSync(process.execPath, [HOOK, '--gate', `${JSON.stringify(process.execPath)} ${JSON.stringify(pass)}`], { input: '{}', encoding: 'utf8', cwd: tmp }).status, 0);
  });
  test('red: every kit hook entry carries the marker, both events are present, and the entries are removable', () => {
    const hooks = claude.gateHookEntries({ gateCommand: 'npm test', hookScript: HOOK });
    assert.deepEqual(Object.keys(hooks).sort(), ['Stop', 'TaskCompleted']);
    for (const event of Object.keys(hooks)) for (const group of hooks[event]) for (const h of group.hooks) assert.ok(h.command.includes(claude.KIT_HOOK_MARKER), `${event}: no marker`);
    const merged = { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }, ...hooks.Stop], TaskCompleted: hooks.TaskCompleted };
    const left = claude.removeKitHooks(merged);
    assert.deepEqual(left, { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] });
  });
});
