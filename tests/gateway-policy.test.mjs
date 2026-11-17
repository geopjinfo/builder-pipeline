/**
 * M11 — `accounts policy show | dry-run | apply` and `accounts usage-snapshot` through the OmniRoute adapter
 * (REQ-1104, REQ-1105; D8, D43). A stub management API on loopback; golden request plan per pinned version.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const PACK = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const policy = require(join(PACK, 'scripts/lib/gateway-policy.cjs'));
const omniroute = require(join(PACK, 'scripts/lib/gateways/omniroute.cjs'));
const gateways = require(join(PACK, 'scripts/lib/gateways/index.cjs'));
const FIX = join(PACK, 'tests/fixtures/gateway/omniroute-3.8');
const POLICY = JSON.parse(readFileSync(join(FIX, 'policy.json'), 'utf8'));
const CURRENT = JSON.parse(readFileSync(join(FIX, 'current.json'), 'utf8'));
const TOKEN = 'mgmt-token-for-tests-only';

let server;
let base;
const seen = [];
before(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'unauthorized', token: req.headers.authorization }));
      }
      if (req.url === '/redirect') {
        res.writeHead(302, { location: 'http://127.0.0.1:1/x' });
        return res.end();
      }
      const doc = CURRENT[req.url];
      res.writeHead(doc ? 200 : (req.method === 'GET' ? 404 : 200), { 'content-type': 'application/json' });
      return res.end(JSON.stringify(doc || { id: 'new-1', name: 'created', key: 'or-SECRET-SHOULD-NEVER-PRINT' }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server && server.close());
const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
function home() {
  const h = mkdtempSync(join(tmpdir(), 'kit-gw-'));
  dirs.push(h);
  mkdirSync(join(h, 'gateway'));
  writeFileSync(join(h, 'gateway', 'mgmt.token'), TOKEN + '\n', { mode: 0o600 });
  writeFileSync(join(h, 'gateway', 'policy.json'), JSON.stringify(POLICY, null, 2));
  return h;
}
const cfg = (h, over = {}) => ({ kind: 'omniroute', version: '3.8', baseUrl: base, tokenFile: join(h, 'gateway', 'mgmt.token'), policyFile: join(h, 'gateway', 'policy.json'), ...over });

describe('REQ-1104 — the adapter table and the refusals', () => {
  test('red: an unknown gateway is refused with the known list; a policy naming a subscription provider is refused', async () => {
    const h = home();
    await assert.rejects(() => policy.run('apply', cfg(h, { kind: 'nope' }), { home: h }), /unknown gateway "nope".*known: bifrost, omniroute/);
    const bad = { ...POLICY, pool: { ...POLICY.pool, paid: [...POLICY.pool.paid, 'subscription/claude-max'] } };
    writeFileSync(join(h, 'gateway', 'policy.json'), JSON.stringify(bad));
    await assert.rejects(() => policy.run('apply', cfg(h), { home: h }), /subscription provider/);
    assert.deepEqual(Object.keys(gateways.KNOWN).sort(), ['bifrost', 'omniroute']);
    for (const g of Object.values(gateways.KNOWN)) assert.deepEqual(Object.keys(g.capabilities).sort(), ['budgets', 'combos', 'usage']);
  });
  test('red: plain http only to loopback; redirects are an error; the token comes from a 0600 file', async () => {
    const h = home();
    await assert.rejects(() => policy.run('show', cfg(h, { baseUrl: 'http://10.0.0.5:20128' }), { home: h }), /plain http .*loopback/);
    await assert.rejects(() => policy.client(cfg(h, { baseUrl: base })).get('/redirect'), /redirect/i);
    chmodSync(join(h, 'gateway', 'mgmt.token'), 0o644);
    if (process.platform !== 'win32') await assert.rejects(() => policy.run('show', cfg(h), { home: h }), /0600/);
  });
  test('red: an error is redacted to an allowlist of fields: never the token, never a key', async () => {
    const h = home();
    writeFileSync(join(h, 'gateway', 'mgmt.token'), 'wrong-token\n', { mode: 0o600 });
    let msg = '';
    try {
      await policy.run('show', cfg(h), { home: h });
    } catch (e) {
      msg = e.message;
    }
    assert.match(msg, /401/);
    assert.ok(!msg.includes('wrong-token') && !msg.includes('Bearer'));
    assert.ok(!msg.includes('or-SECRET'));
  });
});

describe('REQ-1104 — the OmniRoute 3.8 plan is golden', () => {
  test('red: the endpoints are pinned per version and the dry-run request plan equals the golden fixture', async () => {
    const e = omniroute.endpoints('3.8');
    assert.deepEqual([e.keys, e.keyAccess('k-1'), e.combos, e.budget, e.pricing], ['/api/keys', '/api/keys/k-1/access', '/api/combos', '/api/usage/budget', '/api/pricing']);
    assert.throws(() => omniroute.endpoints('9.9'), /not pinned/);
    const h = home();
    const r = await policy.run('dry-run', cfg(h), { home: h });
    const golden = join(FIX, 'plan.golden.json');
    if (process.env.UPDATE_GOLDEN === '1') writeFileSync(golden, JSON.stringify(r.plan, null, 2) + '\n');
    assert.deepEqual(r.plan, JSON.parse(readFileSync(golden, 'utf8')));
    assert.equal(seen.some((s) => s.method !== 'GET'), false, 'a dry run only reads');
    for (const req of r.plan) assert.ok(!JSON.stringify(req).includes('or-SECRET'), 'no key secret in the plan');
  });
  test('red: apply is idempotent and writes the applied marker with the sha and the gateway version', async () => {
    const h = home();
    const a = await policy.run('apply', cfg(h), { home: h });
    assert.ok(a.applied.length > 0);
    const marker = JSON.parse(readFileSync(join(h, 'gateway', 'policy.applied.json'), 'utf8'));
    assert.match(marker.sha256, /^[0-9a-f]{64}$/);
    assert.equal(marker.gatewayVersion, '3.8.52');
    assert.deepEqual(marker.policy, POLICY);
    assert.equal(JSON.stringify(marker).includes('or-SECRET'), false);
    const text = JSON.stringify(a);
    assert.ok(!text.includes('or-SECRET') && !text.includes(TOKEN));
    assert.deepEqual(policy.drift(POLICY, marker), []);
    assert.deepEqual(policy.drift({ ...POLICY, budget: { ...POLICY.budget, monthlyLimitUsd: 50 } }, marker), ['budget.monthlyLimitUsd']);
  });
});

describe('REQ-1105 — usage snapshot', () => {
  test('red: the snapshot has the shape the assessment reads and holds neither the token nor a key', async () => {
    const h = home();
    const out = join(h, 'gateway', 'usage.json');
    const r = await policy.usageSnapshot(cfg(h), { home: h, out });
    const snap = JSON.parse(readFileSync(out, 'utf8'));
    assert.ok(Number.isInteger(snap.generatedAt));
    assert.deepEqual(snap.keys['cli-hobby'], { spend: 12.5, maxBudget: 100, budgetResetAt: '2025-12-01T00:00:00.000Z', todayUsd: 0.4, entries: 7 });
    const text = readFileSync(out, 'utf8');
    assert.ok(!text.includes(TOKEN) && !text.includes('or-REDACTED'));
    assert.equal(r.keys, 1);
  });
});
