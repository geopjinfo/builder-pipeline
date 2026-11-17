'use strict';
/**
 * The reporter's channels (plan M16, REQ-1606, REQ-1608, REQ-1609, REQ-1610; D76): stdout, webhook (slack, generic) and
 * command. The file channel is the reporter's own write (report.cjs). Node built-ins only.
 *
 *   webhook   `node:https`; plain `http:` to 127.0.0.1 or localhost only; no redirect is followed (a 3xx fails the send);
 *             10 s timeout; the URL comes from `urlEnv` or a 0600 `urlFile`, never from §16; the log names host and
 *             status, never a body.
 *   slack     mrkdwn under `maxBytes`: when the report is cut, NEEDS A PERSON and the run lines survive and the last
 *             line names the full report file.
 *   generic   a JSON object { title, text, digest, at, runs: [{ runId, lanes: { <status>: count } }] }.
 *   command   `{file}` filled, the text on stdin, the platform shell, the headless env allowlist, `timeoutMs`; a non-zero
 *             exit is logged as `command exited N`, never with its output.
 */
const fs = require('fs');
const https = require('https');
const http = require('http');
const { spawn } = require('child_process');
const { ALLOW, ALLOW_WIN32 } = require('./worker-env.cjs');

const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\]|::1)$/i;

/** Why `url` may not be posted to, or null. */
function urlFault(url) {
  let u;
  try {
    u = new URL(url);
  } catch (_) {
    return 'the webhook URL is not a URL';
  }
  if (u.protocol === 'https:') return null;
  if (u.protocol === 'http:') return LOOPBACK.test(u.hostname) ? null : `the webhook is plain http to ${u.hostname}: https is the rule, http is for loopback only`;
  return `the webhook URL protocol ${u.protocol} is not https`;
}

/** The URL of a webhook channel from its env variable or its 0600 file; never from the profile. */
function resolveUrl(channel, env = process.env, { platform = process.platform } = {}) {
  if (channel.urlEnv) {
    const v = env[channel.urlEnv];
    if (!v || !String(v).trim()) return { error: `the webhook URL variable ${channel.urlEnv} is not set` };
    return { url: String(v).trim() };
  }
  if (channel.urlFile) {
    let st;
    try {
      st = fs.statSync(channel.urlFile);
    } catch (_) {
      return { error: `the webhook URL file is missing` };
    }
    if (platform !== 'win32' && (st.mode & 0o077) !== 0) return { error: `the webhook URL file is not 0600 (mode 0${(st.mode & 0o777).toString(8)})` };
    const v = fs.readFileSync(channel.urlFile, 'utf8').split(/\r?\n/)[0].trim();
    return v ? { url: v } : { error: 'the webhook URL file is empty' };
  }
  return { error: 'the webhook channel names neither urlEnv nor urlFile' };
}

/** POST a JSON body. Resolves { ok, status, host } or { ok: false, error, host, status? }; never the response body. */
function post(url, body, { timeoutMs = 10000 } = {}) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(url);
    } catch (_) {
      return resolve({ ok: false, error: 'the webhook URL is not a URL' });
    }
    const data = JSON.stringify(body);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => {
      res.resume(); // the body is read and discarded, never kept
      res.on('end', () => {
        const status = res.statusCode || 0;
        if (status >= 200 && status < 300) resolve({ ok: true, status, host: u.hostname });
        else resolve({ ok: false, status, host: u.hostname, error: `HTTP ${status}${status >= 300 && status < 400 ? ' (a redirect is not followed)' : ''}` });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timed out after ${timeoutMs} ms`)));
    req.on('error', (e) => resolve({ ok: false, host: u.hostname, error: String(e && e.message ? e.message : e).split('\n')[0] }));
    req.end(data);
  });
}

/* ----------------------------------------------------------------- payload shapes ---- */

const mrkdwn = (text) => text.replace(/^# (.*)$/gm, '*$1*').replace(/^## (.*)$/gm, '*$1*').replace(/^_(.*)_$/gm, '_$1_');

/** Slack mrkdwn under maxBytes: NEEDS A PERSON and the run lines survive a cut; the last line names the file. */
function slackText(report, { maxBytes = 3500, filePath = null } = {}) {
  const full = mrkdwn(report);
  const tail = filePath ? `\nfull report: ${filePath}` : '';
  if (Buffer.byteLength(full) + Buffer.byteLength(tail) <= maxBytes) return full.replace(/\n?full report: .*\n?$/, '') + (filePath ? `\nfull report: ${filePath}\n` : '');
  const sections = report.split(/^## /m);
  const head = mrkdwn(sections[0]).split('\n').filter((l) => l.startsWith('*') || l.startsWith('_')).join('\n');
  const section = (name) => sections.find((s) => s.startsWith(name)) || '';
  const runsBody = section('RUNS AND LANES').split('\n').slice(1).filter((l) => l && !l.startsWith('- ') && !l.startsWith('boards')).join('\n');
  const needs = section('NEEDS A PERSON').split('\n').slice(1).filter(Boolean).join('\n');
  const parts = [head, `*RUNS AND LANES*\n${runsBody}`, `*NEEDS A PERSON*\n${needs}`];
  let text = parts.join('\n\n') + `\n\n_cut to ${maxBytes} bytes_\nfull report: ${filePath || 'latest.md'}\n`;
  if (Buffer.byteLength(text) > maxBytes) {
    const over = Buffer.byteLength(text) - maxBytes;
    const cut = runsBody.slice(0, Math.max(0, runsBody.length - over - 20));
    text = [head, `*RUNS AND LANES*\n${cut}\n…`, `*NEEDS A PERSON*\n${needs}`].join('\n\n') + `\n\n_cut to ${maxBytes} bytes_\nfull report: ${filePath || 'latest.md'}\n`;
  }
  while (Buffer.byteLength(text) > maxBytes && text.includes('\n- ')) text = text.replace(/\n- [^\n]*\n(?=[^-])/, '\n');
  return text;
}

/** The generic webhook payload. */
function genericPayload({ text, sources, digest, at }) {
  const runs = (sources && Array.isArray(sources.runs) ? sources.runs : []).map((r) => {
    const lanes = {};
    for (const l of Object.values(r.lanes || {})) lanes[l.status || 'UNKNOWN'] = (lanes[l.status || 'UNKNOWN'] || 0) + 1;
    return { runId: r.runId, lanes };
  });
  const title = (String(text || '').split('\n')[0] || 'Progress report').replace(/^#\s*/, '');
  return { title, text, digest, at, runs };
}

/* ----------------------------------------------------------------- the command channel ---- */

function allowlistEnv(env, platform = process.platform) {
  const out = {};
  for (const k of platform === 'win32' ? [...ALLOW, ...ALLOW_WIN32] : ALLOW) if (env[k] !== undefined) out[k] = env[k];
  return out;
}

/** Run the command with `{file}` filled and the text on stdin; never keep its output. */
function runCommand(channel, { text, file, env = process.env, timeoutMs = 10000, platform = process.platform }) {
  return new Promise((resolve) => {
    const cmd = String(channel.command).split('{file}').join(file || '');
    const child = spawn(cmd, { shell: true, env: allowlistEnv(env, platform), stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: `command failed to start: ${e.code || e.message}` });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, error: code === null ? `command stopped by ${signal || 'timeout'}` : `command exited ${code}` });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(text);
  });
}

/* ----------------------------------------------------------------- dispatch ---- */

/**
 * Send one payload through one channel. `payload`: { text, sources, digest, at, file, env, log, timeoutMs, maxBytes }.
 * Resolves { ok, ... }; never throws for a channel fault, never logs a body or a URL.
 */
async function send(channel, payload) {
  const log = typeof payload.log === 'function' ? payload.log : () => {};
  const env = payload.env || process.env;
  if (channel.kind === 'stdout') {
    process.stdout.write(payload.text.endsWith('\n') ? payload.text : `${payload.text}\n`);
    log({ type: 'notify.sent', kind: 'stdout' });
    return { ok: true };
  }
  if (channel.kind === 'command') {
    const r = await runCommand(channel, { text: payload.text, file: payload.file, env, timeoutMs: payload.timeoutMs || channel.timeoutMs });
    log(r.ok ? { type: 'notify.sent', kind: 'command' } : { type: 'notify.failed', kind: 'command', error: r.error });
    return r;
  }
  if (channel.kind === 'webhook') {
    const u = resolveUrl(channel, env);
    if (u.error) {
      log({ type: 'notify.failed', kind: 'webhook', error: u.error });
      return { ok: false, error: u.error };
    }
    const fault = urlFault(u.url);
    if (fault) {
      log({ type: 'notify.failed', kind: 'webhook', error: fault });
      return { ok: false, error: fault };
    }
    const body = channel.format === 'generic' ? genericPayload(payload) : { text: slackText(payload.text, { maxBytes: payload.maxBytes || channel.maxBytes || 3500, filePath: payload.file }) };
    const r = await post(u.url, body, { timeoutMs: payload.timeoutMs || channel.timeoutMs || 10000 });
    log(r.ok ? { type: 'notify.sent', kind: 'webhook', format: channel.format, host: r.host, status: r.status } : { type: 'notify.failed', kind: 'webhook', format: channel.format, host: r.host, status: r.status, error: r.error });
    return r;
  }
  return { ok: false, error: `unknown channel kind ${JSON.stringify(channel.kind)}` };
}

module.exports = { LOOPBACK, urlFault, resolveUrl, post, slackText, genericPayload, allowlistEnv, runCommand, send };
