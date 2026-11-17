/**
 * M11 — the free-model MCP server (REQ-1107; D15, D43): stdio JSON-RPC, 2026-07-28 discovery and the legacy
 * initialize, one tool, loopback only, key read at call time and never printed, outbound guard over the prompt.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const PACK = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const mcp = require(join(PACK, 'tooling/experimental/free-model-mcp.cjs'));
const SERVER = join(PACK, 'tooling/experimental/free-model-mcp.cjs');
const KEY = 'gw-key-for-tests-' + 'z'.repeat(24);

let http;
let base;
const calls = [];
before(async () => {
  http = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      calls.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body || '{}') });
      if (req.url === '/v1/chat/completions' && req.headers.authorization === `Bearer ${KEY}`) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ model: 'example/model-a', choices: [{ message: { content: 'forty-two' }, finish_reason: 'stop' }] }));
      }
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: `bad key ${req.headers.authorization}` }));
    });
  });
  await new Promise((r) => http.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${http.address().port}`;
});
after(() => http && http.close());
const dir = mkdtempSync(join(tmpdir(), 'kit-mcp-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const keyFile = join(dir, 'key');
writeFileSync(keyFile, KEY + '\n', { mode: 0o600 });
const configFile = (over = {}) => {
  const f = join(dir, `cfg-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(f, JSON.stringify({ baseUrl: base, route: 'claude-auto-cheap-hobby', keyFile, promptMaxBytes: 4000, maxTokens: 256, ...over }));
  return f;
};

/** Drive the server process with JSON lines; resolve with the parsed responses. */
function talk(lines, cfg = configFile()) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SERVER], { env: { ...process.env, BUILDER_FREE_MODEL_CONFIG: cfg }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('close', () => resolve(out.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))));
    child.stdin.end(lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  });
}
const call = (id, args, meta) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'ask_free_model', arguments: args, ...(meta ? { _meta: meta } : {}) } });

describe('REQ-1107 — both client generations complete a call', () => {
  test('red: a 2026-07-28 client: server/discover, then a tool call with _meta echoed and a resultType', async () => {
    const res = await talk([{ jsonrpc: '2.0', id: 1, method: 'server/discover', params: { protocolVersion: '2026-07-28' } }, call(2, { prompt: 'what is six times seven' }, { progressToken: 'p1' })]);
    assert.equal(res[0].result.protocolVersion, '2026-07-28');
    assert.equal(res[0].result.tools.length, 1);
    assert.equal(res[0].result.tools[0].name, 'ask_free_model');
    assert.equal(res[1].result.isError, false);
    assert.match(res[1].result.content[0].text, /forty-two/);
    assert.equal(res[1].result.resultType, 'text');
    assert.deepEqual(res[1].result._meta, { progressToken: 'p1' });
    assert.equal(calls.at(-1).body.model, 'claude-auto-cheap-hobby', 'one fixed route');
  });
  test('red: a legacy client: initialize, tools/list, tools/call', async () => {
    const res = await talk([{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, call(3, { prompt: 'again' })]);
    assert.equal(res[0].result.protocolVersion, '2025-06-18');
    assert.equal(res[1].result.tools.length, 1);
    assert.equal(res[2].result.isError, false);
  });
});

describe('REQ-1107 — the boundaries', () => {
  test('red: a secret-shaped prompt is refused naming the kind of match, and the gateway is never called', async () => {
    const n = calls.length;
    const res = await talk([call(1, { prompt: 'use this: sk-ant-' + 'a'.repeat(40) + ' to log in' })]);
    assert.equal(res[0].result.isError, true);
    assert.match(res[0].result.content[0].text, /Anthropic key/);
    assert.ok(!res[0].result.content[0].text.includes('a'.repeat(40)));
    assert.equal(calls.length, n);
    const sys = await talk([call(1, { prompt: 'hello', system: ['pass', 'word'].join('') + ' = ' + ['hunter2', 'secret'].join('') })]); // built at runtime: no literal shape in this file
    assert.equal(sys[0].result.isError, true);
    assert.match(sys[0].result.content[0].text, /assigned secret/);
  });
  test('red: the prompt cap per account, loopback only, and the key replaced in error text', async () => {
    const big = await talk([call(1, { prompt: 'x'.repeat(5000) })]);
    assert.match(big[0].result.content[0].text, /promptMaxBytes|too long/);
    const far = await talk([call(1, { prompt: 'hi' })], configFile({ baseUrl: 'http://10.1.1.1:20128' }));
    assert.match(far[0].result.content[0].text, /loopback/);
    writeFileSync(join(dir, 'other-key'), 'gw-other-key-' + 'q'.repeat(24) + '\n', { mode: 0o600 });
    const wrong = await talk([call(1, { prompt: 'hi' })], configFile({ keyFile: join(dir, 'other-key') }));
    assert.equal(wrong[0].result.isError, true);
    assert.ok(!wrong[0].result.content[0].text.includes('q'.repeat(24)), 'the key never appears in error text');
    assert.match(wrong[0].result.content[0].text, /401/);
  });
  test('the pure handler: unknown method, unknown tool, notification, parse error', () => {
    const ctx = { config: { baseUrl: base, route: 'r', keyFile, promptMaxBytes: 100, maxTokens: 16 } };
    assert.equal(mcp.handle({ jsonrpc: '2.0', id: 1, method: 'nope' }, ctx).error.code, -32601);
    assert.equal(mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'other' } }, ctx).error.code, -32602);
    assert.equal(mcp.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }, ctx), null);
    assert.ok(mcp.loopbackFault('http://127.0.0.1:1') === null && mcp.loopbackFault('http://localhost:1') === null && mcp.loopbackFault('http://[::1]:1') === null);
    assert.ok(mcp.loopbackFault('https://127.0.0.1:1') === null);
    assert.match(mcp.loopbackFault('http://example.test:1'), /loopback/);
  });
});
