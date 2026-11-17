/**
 * M16 — the channels (REQ-1606, REQ-1608, REQ-1609, REQ-1610; D76): a local node:http server for the webhook, a stub
 * command, the golden generic payload.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const notify = require('../scripts/lib/notify.cjs');
const report = require('../scripts/lib/report.cjs');
const FIX = join(here, 'fixtures', 'report');
const sources = () => JSON.parse(readFileSync(join(FIX, 'sources.json'), 'utf8'));
const NOW = Date.parse('2026-11-17T10:00:00.000Z');

let server; let base; const got = [];
before(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      got.push({ url: req.url, type: req.headers['content-type'], body });
      if (req.url === '/redirect') { res.writeHead(302, { location: `${base}/ok` }); return res.end(); }
      if (req.url === '/fail') { res.writeHead(500, { 'content-type': 'text/plain' }); return res.end('the secret body text that must not be logged'); }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('ok');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server && server.close());
const dir = mkdtempSync(join(tmpdir(), 'kit-notify-'));
after(() => rmSync(dir, { recursive: true, force: true }));

describe('REQ-1606 — the webhook transport', () => {
  test('red: the slack channel posts a JSON body with text and a JSON content type to a loopback http server', async () => {
    const log = [];
    const r = await notify.send({ kind: 'webhook', format: 'slack', urlEnv: 'HOOK' }, { text: '# Progress report\n\n## NEEDS A PERSON\n\nnone\n', sources: sources(), digest: 'd'.repeat(64), at: new Date(NOW).toISOString(), file: '.pipeline/reports/latest.md', env: { HOOK: `${base}/ok` }, log: (e) => log.push(e), timeoutMs: 2000, maxBytes: 3500 });
    assert.equal(r.ok, true, JSON.stringify(r));
    const req = got.at(-1);
    assert.match(req.type, /application\/json/);
    assert.ok(JSON.parse(req.body).text.includes('NEEDS A PERSON'));
    assert.ok(log.some((e) => e.type === 'notify.sent' && e.host === '127.0.0.1' && e.status === 200));
  });
  test('red: a 302 fails the send as HTTP 302 and no second request is made', async () => {
    const n = got.length;
    const r = await notify.send({ kind: 'webhook', format: 'generic', urlEnv: 'HOOK' }, { text: 'x', sources: sources(), digest: 'd', at: 'now', file: 'f', env: { HOOK: `${base}/redirect` }, log: () => {}, timeoutMs: 2000 });
    assert.equal(r.ok, false);
    assert.match(r.error, /HTTP 302/);
    assert.equal(got.length, n + 1, 'the redirect was not followed');
  });
  test('red: plain http to a host other than loopback is refused before any request; https is the rule', async () => {
    const n = got.length;
    const r = await notify.send({ kind: 'webhook', format: 'slack', urlEnv: 'HOOK' }, { text: 'x', sources: sources(), digest: 'd', at: 'now', file: 'f', env: { HOOK: 'http://example.test/hook' }, log: () => {}, timeoutMs: 2000 });
    assert.equal(r.ok, false);
    assert.match(r.error, /loopback|https/);
    assert.equal(got.length, n);
    assert.equal(notify.urlFault('https://hooks.example.test/x'), null);
    assert.equal(notify.urlFault('http://localhost:9/x'), null);
  });
  test('red: a 500 with a body is logged by host and status only; the body never appears', async () => {
    const log = [];
    const r = await notify.send({ kind: 'webhook', format: 'slack', urlEnv: 'HOOK' }, { text: 'x', sources: sources(), digest: 'd', at: 'now', file: 'f', env: { HOOK: `${base}/fail` }, log: (e) => log.push(e), timeoutMs: 2000 });
    assert.equal(r.ok, false);
    const text = JSON.stringify(log) + JSON.stringify(r);
    assert.ok(!text.includes('secret body text'));
    assert.ok(log.some((e) => e.type === 'notify.failed' && e.host === '127.0.0.1' && e.status === 500));
  });
  test('red: the URL comes from urlEnv or a 0600 urlFile, and a missing one is a named failure, never a thrown value', async () => {
    const f = join(dir, 'hook.url');
    writeFileSync(f, `${base}/ok\n`, { mode: 0o600 });
    const r = await notify.send({ kind: 'webhook', format: 'slack', urlFile: f }, { text: 'x', sources: sources(), digest: 'd', at: 'now', file: 'f', env: {}, log: () => {}, timeoutMs: 2000 });
    assert.equal(r.ok, true, JSON.stringify(r));
    const m = await notify.send({ kind: 'webhook', format: 'slack', urlEnv: 'NOPE' }, { text: 'x', sources: sources(), digest: 'd', at: 'now', file: 'f', env: {}, log: () => {}, timeoutMs: 2000 });
    assert.equal(m.ok, false);
    assert.match(m.error, /NOPE/);
  });
});

describe('REQ-1608, REQ-1609 — the payload shapes', () => {
  test('red: a 12 kB report cut to maxBytes 3500 keeps NEEDS A PERSON whole and the run lines, and ends with the file path', () => {
    const s = sources();
    s.runs[0].next = Array.from({ length: 200 }, (_, i) => `WAIT lane-${i}: launched ${i}m ago with a long explanatory line that pads the report well past the limit`);
    const text = report.build(s, { now: NOW, intervalMinutes: 30, filePath: '.pipeline/reports/latest.md' });
    assert.ok(Buffer.byteLength(text) > 12000, `report is ${Buffer.byteLength(text)} bytes`);
    const slack = notify.slackText(text, { maxBytes: 3500, filePath: '.pipeline/reports/latest.md' });
    assert.ok(Buffer.byteLength(slack) <= 3500, `slack text is ${Buffer.byteLength(slack)} bytes`);
    assert.ok(slack.includes('*NEEDS A PERSON*'));
    assert.match(slack, /r1\/l3 STALLED/);
    assert.match(slack, /r1: 1 MERGED, 1 LAUNCHED, 1 STALLED/, 'the run lines survive');
    assert.match(slack.trim().split('\n').at(-1), /full report: \.pipeline\/reports\/latest\.md$/);
    assert.ok(!slack.includes('## '), 'mrkdwn, not markdown headings');
  });
  test('red: the generic payload equals the golden fixture', () => {
    const s = sources();
    const payload = notify.genericPayload({ text: '# Progress report\n', sources: s, digest: 'f'.repeat(64), at: '2026-11-17T10:00:00.000Z' });
    const golden = join(FIX, 'generic.json');
    if (process.env.UPDATE_GOLDEN === '1') writeFileSync(golden, JSON.stringify(payload, null, 2) + '\n');
    assert.deepEqual(payload, JSON.parse(readFileSync(golden, 'utf8')));
    assert.deepEqual(Object.keys(payload), ['title', 'text', 'digest', 'at', 'runs']);
    assert.deepEqual(payload.runs[0], { runId: 'r1', lanes: { MERGED: 1, LAUNCHED: 1, STALLED: 1 } });
  });
});

describe('REQ-1610 — the command channel', () => {
  test('red: {file} is filled, the text arrives on stdin, the env is the allowlist', async () => {
    const out = join(dir, 'got.txt');
    const stub = join(dir, 'cmd.cjs');
    writeFileSync(stub, "const fs=require('fs');let s='';process.stdin.on('data',(c)=>s+=c);process.stdin.on('end',()=>{fs.writeFileSync(process.argv[2],s);fs.writeFileSync(process.argv[2]+'.env',Object.keys(process.env).sort().join(','));process.exit(0)});");
    const log = [];
    const r = await notify.send({ kind: 'command', command: `${JSON.stringify(process.execPath)} ${JSON.stringify(stub)} ${JSON.stringify(out)} {file}` }, { text: 'the report text\n', sources: sources(), digest: 'd', at: 'now', file: '.pipeline/reports/latest.md', env: { PATH: process.env.PATH, HOME: dir, ANTHROPIC_API_KEY: 'must-not-pass', SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec, PATHEXT: process.env.PATHEXT }, log: (e) => log.push(e), timeoutMs: 10000 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(readFileSync(out, 'utf8'), 'the report text\n');
    assert.ok(!readFileSync(`${out}.env`, 'utf8').includes('ANTHROPIC_API_KEY'));
  });
  test('red: a command that exits 3 and prints is logged as command exited 3 with no output', async () => {
    const stub = join(dir, 'bad.cjs');
    writeFileSync(stub, "process.stdout.write('leaky output line');process.exit(3);");
    const log = [];
    const r = await notify.send({ kind: 'command', command: `${JSON.stringify(process.execPath)} ${JSON.stringify(stub)}` }, { text: 'x', sources: sources(), digest: 'd', at: 'now', file: 'f', env: { PATH: process.env.PATH, HOME: dir, SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec, PATHEXT: process.env.PATHEXT }, log: (e) => log.push(e), timeoutMs: 10000 });
    assert.equal(r.ok, false);
    assert.match(r.error, /command exited 3/);
    assert.ok(!JSON.stringify(log).includes('leaky output line'));
    assert.ok(log.some((e) => e.type === 'notify.failed' && /command exited 3/.test(e.error)));
  });
});
