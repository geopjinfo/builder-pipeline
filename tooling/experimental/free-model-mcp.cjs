#!/usr/bin/env node
'use strict';
/**
 * The free-model MCP server (plan M11, REQ-1107; D15, D43; `features.freeModelMcp`, experimental-off).
 *
 * A stdio JSON-RPC server with ONE tool, `ask_free_model`: it hands a self-contained prompt to a cheaper model
 * behind the local gateway on ONE fixed route and returns the text. Node built-ins only.
 *
 * Boundaries, on purpose:
 *   - the 2026-07-28 protocol (`server/discover`, per-request `_meta` echoed back, `resultType` on a result) and the
 *     legacy `initialize` / `tools/list` / `tools/call` of older clients both work
 *   - loopback only: a baseUrl that is plain http to anything but 127.0.0.1, localhost or ::1 is refused
 *   - no redirects (`redirect: 'error'`); the key is read from its file at call time, never cached, never printed, and
 *     replaced by `<key>` in any error text
 *   - the per-account `promptMaxBytes` caps the prompt; the outbound guard (scripts/lib/outbound-guard.cjs) scans the
 *     prompt and the system text and a secret shape refuses the call naming the kind of match
 *   - the registration is printed by `accounts install`, never written into a live client config
 *
 * Config: BUILDER_FREE_MODEL_CONFIG (a JSON file: baseUrl, route, keyFile, promptMaxBytes, maxTokens) — for tests and
 * hand runs — else PIPELINE_PROFILE.md features.freeModelMcp of the current folder with `--account <name>` naming the
 * account whose key file and promptMaxBytes apply.
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const PROTOCOL = '2026-07-28';
const LEGACY_PROTOCOL = '2025-06-18';
const SERVER = { name: 'builder-pipeline-free-model', version: '1.0.0' };
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\]|::1)$/i;
const TOOL = {
  name: 'ask_free_model',
  description:
    'Send ONE self-contained prompt to a cheaper model behind this machine\'s local gateway and return its text answer. The prompt leaves this conversation and may reach third-party free providers that log or train on it: send only public or scratch content, never secrets, private code or personal data. The other model sees nothing but the prompt.',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'The complete, self-contained request for the other model.' },
      system: { type: 'string', description: 'Optional short system instruction for the other model.' },
      max_tokens: { type: 'integer', minimum: 16, maximum: 16000, description: 'Optional cap on the answer length in tokens.' },
    },
    required: ['prompt'],
    additionalProperties: false,
  },
};

class ToolError extends Error {}

function loopbackFault(url) {
  let u;
  try {
    u = new URL(url);
  } catch (_) {
    return `baseUrl ${JSON.stringify(url)} is not a URL`;
  }
  if (u.protocol === 'https:') return null;
  if (u.protocol !== 'http:') return `baseUrl ${url}: http or https only`;
  return LOOPBACK.test(u.hostname) ? null : `baseUrl ${url}: plain http is allowed to loopback only`;
}

function readKey(file) {
  const k = fs.readFileSync(file, 'utf8').split(/\r?\n/)[0].trim();
  if (!k) throw new ToolError(`the key file is empty`);
  return k;
}

const guard = () => {
  try {
    return require(path.join(__dirname, '..', '..', 'scripts', 'lib', 'outbound-guard.cjs'));
  } catch (_) {
    return null;
  }
};

async function ask(args, { config, fetchImpl = globalThis.fetch }) {
  const prompt = args && args.prompt;
  if (typeof prompt !== 'string' || !prompt.trim()) throw new ToolError('prompt is required and must be non-empty text');
  const max = Number(config.promptMaxBytes) || 200000;
  const bytes = Buffer.byteLength(prompt, 'utf8');
  if (bytes > max) throw new ToolError(`prompt too long: ${bytes} bytes, promptMaxBytes is ${max} for this account`);
  const system = typeof args.system === 'string' && args.system.trim() ? args.system.slice(0, 8000) : null;
  const g = guard();
  if (g) {
    const hits = g.scan(`${prompt}\n${system || ''}`);
    if (hits.length) throw new ToolError(`refused: the prompt matches a secret shape (${[...new Set(hits.map((h) => h.kind))].join(', ')}) — nothing was sent`);
  }
  const fault = loopbackFault(config.baseUrl);
  if (fault) throw new ToolError(`refused: ${fault}`);
  const key = readKey(config.keyFile);
  const hide = (s) => String(s).split(key).join('<key>');
  const maxTokens = Number.isInteger(args.max_tokens) && args.max_tokens >= 16 && args.max_tokens <= 16000 ? args.max_tokens : Number(config.maxTokens) || 2048;
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });
  const body = { model: config.route, messages, max_tokens: maxTokens, stream: false };
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), Number(config.timeoutMs) || 120000);
  let res;
  try {
    res = await fetchImpl(`${config.baseUrl.replace(/\/$/, '')}/v1/chat/completions`, { method: 'POST', redirect: 'error', signal: ctl.signal, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  } catch (e) {
    throw new ToolError(`gateway call failed: ${hide(e && e.name === 'AbortError' ? 'timeout' : e && e.message ? e.message : 'error')}`);
  } finally {
    clearTimeout(t);
  }
  const text = await res.text();
  if (!res.ok) throw new ToolError(`gateway HTTP ${res.status}${res.status === 429 ? ' (rate limit or the key budget)' : ''}: ${hide(text).slice(0, 400)}`);
  let reply;
  try {
    reply = JSON.parse(text);
  } catch (_) {
    throw new ToolError('the gateway returned something that is not JSON');
  }
  const msg = reply && reply.choices && reply.choices[0] && reply.choices[0].message;
  let content = msg && msg.content;
  if (Array.isArray(content)) content = content.map((p) => (p && p.text) || '').join('');
  if (typeof content !== 'string' || !content.trim()) throw new ToolError('the other model returned an empty answer');
  const served = reply.model && reply.model !== config.route ? `, model ${hide(reply.model)}` : '';
  return `${content}\n\n[answered through the local gateway, route ${config.route}${served}]`;
}

const result = (id, payload) => ({ jsonrpc: '2.0', id, result: payload });
const error = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
const withMeta = (payload, params) => (params && params._meta ? { ...payload, _meta: params._meta } : payload);

/** One message in, one response out (null for a notification). A tools/call returns a Promise. */
function handle(msg, ctx) {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return error(null, -32600, 'invalid request');
  const { method, id } = msg;
  const params = msg.params || {};
  if (typeof method !== 'string' || !('id' in msg)) return null;
  if (method === 'server/discover') return result(id, { protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL, serverInfo: SERVER, capabilities: { tools: {} }, tools: [TOOL] });
  if (method === 'initialize') return result(id, { protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : LEGACY_PROTOCOL, capabilities: { tools: {} }, serverInfo: SERVER });
  if (method === 'ping') return result(id, {});
  if (method === 'tools/list') return result(id, { tools: [TOOL] });
  if (method === 'tools/call') {
    if (params.name !== TOOL.name) return error(id, -32602, 'unknown tool');
    const args = params.arguments || {};
    if (!args || typeof args !== 'object') return error(id, -32602, 'arguments must be an object');
    return ask(args, ctx)
      .then((text) => result(id, withMeta({ content: [{ type: 'text', text }], isError: false, resultType: 'text' }, params)))
      .catch((e) => result(id, withMeta({ content: [{ type: 'text', text: `${TOOL.name} failed: ${e instanceof ToolError ? e.message : `internal error (${e && e.name})`}` }], isError: true, resultType: 'text' }, params)));
  }
  if (method === 'resources/list' || method === 'prompts/list') return result(id, { [method.split('/')[0]]: [] });
  return error(id, -32601, `method not found: ${method.slice(0, 60)}`);
}

/** The config: BUILDER_FREE_MODEL_CONFIG, else the profile's features.freeModelMcp with --account. */
function loadConfig(env = process.env, argv = process.argv.slice(2)) {
  if (env.BUILDER_FREE_MODEL_CONFIG) return JSON.parse(fs.readFileSync(env.BUILDER_FREE_MODEL_CONFIG, 'utf8'));
  const profile = require(path.join(__dirname, '..', '..', 'scripts', 'lib', 'profile.cjs'));
  const accountPaths = require(path.join(__dirname, '..', '..', 'scripts', 'lib', 'account-paths.cjs'));
  const loaded = profile.load(process.cwd());
  const f = profile.feature(loaded.settings, 'freeModelMcp');
  if (!f.enabled) throw new Error(f.line);
  const i = argv.indexOf('--account');
  const account = i === -1 ? null : argv[i + 1];
  if (!account) throw new Error('free-model-mcp: --account <name> names the account whose key file and promptMaxBytes apply');
  const acct = loaded.settings.features.accounts && loaded.settings.features.accounts.accounts && loaded.settings.features.accounts.accounts[account];
  if (!acct) throw new Error(`free-model-mcp: no account "${account}" in features.accounts`);
  const p = accountPaths.paths(accountPaths.home(env), account, acct);
  const per = (f.config.promptMaxBytes && typeof f.config.promptMaxBytes === 'object' ? f.config.promptMaxBytes[account] || f.config.promptMaxBytes.default : f.config.promptMaxBytes) || 200000;
  return { baseUrl: acct.baseUrl || f.config.baseUrl, route: f.config.route, keyFile: p.keyFile, promptMaxBytes: per, maxTokens: f.config.maxTokens, timeoutMs: f.config.timeoutMs };
}

function main() {
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exit(2);
  }
  const ctx = { config };
  const rl = readline.createInterface({ input: process.stdin });
  let chain = Promise.resolve();
  rl.on('line', (line) => {
    if (!line.trim()) return;
    chain = chain.then(async () => {
      let resp;
      try {
        resp = await handle(JSON.parse(line), ctx);
      } catch (e) {
        resp = e instanceof SyntaxError ? error(null, -32700, 'parse error') : error(null, -32603, 'internal error');
      }
      if (resp) process.stdout.write(JSON.stringify(resp) + '\n');
    });
  });
  rl.on('close', () => chain.then(() => process.exit(0)));
}

if (require.main === module) main();

module.exports = { PROTOCOL, LEGACY_PROTOCOL, TOOL, SERVER, ToolError, loopbackFault, ask, handle, loadConfig };
