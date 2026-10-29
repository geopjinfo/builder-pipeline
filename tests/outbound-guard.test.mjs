import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const guard = require('../scripts/lib/outbound-guard.cjs');

const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'outbound-'));
  dirs.push(d);
  return d;
};
const noFs = { read: () => null };

// Test values are assembled at run time so no secret-shaped literal sits in the pack's own source.
const fake = {
  aws: 'AKIA' + 'ABCDEFGHIJKLMNOP',
  gh: 'ghp_' + 'a'.repeat(36),
  ant: 'sk-ant-' + 'api03-' + 'b'.repeat(30),
  pem: '-----BEGIN ' + 'RSA PRIVATE KEY-----',
  url: 'postgres://app:' + 'hunter2pass' + '@db:5432/pmp',
  assign: 'DB_PASSWORD=' + 'Sup3rS3cretValue',
};

test('every secret shape is refused, and the reason never contains the secret', () => {
  for (const [name, value] of Object.entries(fake)) {
    const r = guard.check({ text: `line one\nconst x = "${value}";` }, { fsLike: noFs });
    assert.equal(r.send, false, name);
    assert.ok(r.reasons.some((x) => x.startsWith('text:2:')), `${name}: ${r.reasons}`);
    for (const reason of r.reasons) assert.ok(!reason.includes(value), `${name} leaked into the reason`);
  }
});

test('ordinary code, placeholders and redacted values pass', () => {
  const text = [
    'const password = process.env.DB_PASSWORD;',
    'password: "<your password>"',
    'api_key=${API_KEY}',
    'secret: ********',
    'if (token.length < 8) throw new Error("short");',
    'postgres://localhost:5432/pmp',
  ].join('\n');
  assert.deepEqual(guard.check({ text }, { fsLike: noFs }).reasons, []);
});

test('a value from the project env files is refused wherever it appears', () => {
  const root = tmp();
  writeFileSync(join(root, '.env'), 'REDIS_URL=redis://cache\nSMTP_PASS="plain-but-real-1"\nDEBUG=true\nPORT=3000\n');
  const r = guard.check({ text: 'mailer.login("plain-but-real-1")' }, { root });
  assert.equal(r.send, false);
  assert.deepEqual(r.reasons, ['text:1: value from an env file']);
  assert.equal(guard.check({ text: 'if (DEBUG === true) listen(3000)' }, { root }).send, true);
});

test('a denied file is refused by name even when its content is empty', () => {
  for (const p of ['.env', 'config/.env.production', 'certs/server.pem', 'C:\\keys\\id_rsa', 'credentials-prod.json']) {
    const r = guard.check({ files: [{ path: p, content: '' }] }, { fsLike: noFs });
    assert.equal(r.send, false, p);
    assert.match(r.reasons[0], /denied file/);
  }
  assert.equal(guard.check({ files: [{ path: 'src/env.ts', content: 'export {}' }] }, { fsLike: noFs }).send, true);
});

test('a payload over the excerpt limit is refused — paths and excerpts, not files', () => {
  const r = guard.check({ text: 'x'.repeat(50) }, { fsLike: noFs, config: { maxBytes: 40 } });
  assert.equal(r.send, false);
  assert.match(r.reasons[0], /over the 40-byte excerpt limit/);
});

test('project patterns add to the built-in shapes', () => {
  const config = { extraPatterns: ['\\bDALIL-[0-9]{6}\\b'] };
  assert.deepEqual(guard.check({ text: 'tenant DALIL-123456' }, { fsLike: noFs, config }).reasons, ['text:1: project pattern 1']);
});

test('send: refused payloads never reach the call; failures and timeouts come back as no advice', async () => {
  let called = 0;
  const call = async () => {
    called += 1;
    return 'advice';
  };
  assert.deepEqual(await guard.send({ text: fake.gh }, call, { fsLike: noFs }), { sent: false, reasons: ['text:1: GitHub token'] });
  assert.equal(called, 0);
  assert.deepEqual(await guard.send({ text: 'ok' }, call, { fsLike: noFs }), { sent: true, ok: true, result: 'advice' });
  assert.equal(called, 1);
  const failed = await guard.send({ text: 'ok' }, () => {
    throw new Error('503');
  }, { fsLike: noFs });
  assert.deepEqual(failed, { sent: true, ok: false, error: '503' });
  const slow = await guard.send({ text: 'ok' }, () => new Promise((r) => setTimeout(r, 500)), { fsLike: noFs, config: { timeoutMs: 20 } });
  assert.equal(slow.ok, false);
  assert.match(slow.error, /timed out after 20 ms/);
});

test('CLI: off refuses, on sends a clean payload and refuses a secret with exit 1', () => {
  const root = tmp();
  const cli = (input, args = []) =>
    spawnSync(process.execPath, [join(here, '..', 'scripts', 'outbound-check.mjs'), ...args], { cwd: root, input, encoding: 'utf8' });
  const off = cli('{"text":"hello"}');
  assert.equal(off.status, 1);
  assert.match(off.stdout, /outboundGuard: not configured — nothing may be sent/);

  writeFileSync(join(root, 'PIPELINE_PROFILE.md'), '```json pipeline-settings\n{ "schema": 2, "features": { "outboundGuard": { "state": "on" } } }\n```\n');
  const ok = cli('{"text":"hello"}');
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /^SEND 5 bytes/);
  const bad = cli(JSON.stringify({ text: fake.aws }));
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /NOT SENT\n {2}text:1: AWS access key/);
  assert.ok(!bad.stdout.includes(fake.aws));

  writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
  assert.equal(cli('', ['--files', 'a.ts']).status, 0);
  assert.equal(cli('not json').status, 2);
});
