import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const { compileOperations } = require('../oracles/openapi3.cjs');
const oracle = require('../scripts/lib/contract-oracle.cjs');

const fx = (...p) => join(here, 'fixtures', 'oracle', ...p);
const doc = JSON.parse(readFileSync(fx('inventory.openapi.json'), 'utf8'));
const config = { codeField: 'code', statusFamilies: { 409: ['CONFLICT', 'STALE_VERSION'] }, platformCodePattern: '^[A-Z][A-Z_]+$' };
const ops = compileOperations(doc, config);
const rec = (method, url, status, responseBody = '') => ({ seq: 1, method, url, status, responseBody });
const classes = (record, c = config) => oracle.judge(record, ops, c).problems.map((p) => p.class);
const cli = join(here, '..', 'scripts', 'contract-oracle.mjs');
const run = (dir, args = []) => spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: 'utf8' });
const tmpBaseline = fx('baseline.under-test.json');
after(() => rmSync(tmpBaseline, { force: true }));

test('compiles OpenAPI 3: path-level and $ref parameters, codes from example, examples and schema enum', () => {
  const stock = ops.find((o) => o.template === '/warehouses/{warehouseId}/stock');
  assert.deepEqual([...stock.query].sort(), ['page', 'sku']);
  const item = ops.find((o) => o.template === '/items/{id}' && o.method === 'GET');
  assert.deepEqual([...item.codes.get('404')], ['NOT_FOUND']);
  assert.deepEqual([...ops.find((o) => o.template === '/items' && o.method === 'GET').codes.get('400')], ['VALIDATION']);
  assert.deepEqual([...ops.find((o) => o.template === '/items' && o.method === 'POST').codes.get('422')], ['VALIDATION']);
  assert.deepEqual([...ops.find((o) => o.template === '/items/{id}/reserve').codes.get('409')], ['CONFLICT']);
  assert.throws(() => compileOperations({ swagger: '2.0', paths: {} }), /not an OpenAPI 3/);
});

test('declared behaviour passes', () => {
  assert.deepEqual(classes(rec('GET', '/items?page=2&pageSize=10', 200)), []);
  assert.deepEqual(classes(rec('GET', '/items/9', 404, '{"code":"NOT_FOUND"}')), []);
  assert.deepEqual(classes(rec('POST', '/items/9/reserve', 409, '{"code":"CONFLICT"}')), []);
  assert.deepEqual(classes(rec('GET', '/warehouses/w1/stock?page=1&sku=A', 200)), []);
});

test('red: status drift — a route answering 200 where the contract declares 201', () => {
  assert.deepEqual(classes(rec('POST', '/items', 200)), ['status-drift']);
});

test('red: query drift — a success to an undeclared query parameter; an error answer to one is not judged', () => {
  assert.deepEqual(classes(rec('GET', '/items?page=1&search=bolt', 200)), ['query-drift']);
  assert.deepEqual(classes(rec('GET', '/items?search=bolt', 400, '{"code":"VALIDATION"}')), []);
});

test('red: code drift — a code outside the declared set; with a platform pattern a non-matching code is informational', () => {
  assert.deepEqual(classes(rec('GET', '/items/9', 404, '{"code":"GONE"}')), ['code-drift']);
  assert.deepEqual(classes(rec('POST', '/items/9/reserve', 409, { code: 'item.locked' })), ['other-code']);
  assert.equal(oracle.FAILING.has('other-code'), false);
  assert.deepEqual(classes(rec('POST', '/items/9/reserve', 409, { code: 'item.locked' }), { ...config, platformCodePattern: null }), ['code-drift']);
});

test('status families widen a declared status; they never declare one the operation lacks', () => {
  assert.deepEqual(classes(rec('POST', '/items/9/reserve', 409, '{"code":"STALE_VERSION"}')), []);
  assert.deepEqual(classes(rec('POST', '/items/9/reserve', 409, '{"code":"STALE_VERSION"}'), { ...config, statusFamilies: {} }), ['code-drift']);
  assert.deepEqual(classes(rec('GET', '/items/9', 409, '{"code":"CONFLICT"}')), ['status-drift']);
});

test('red: undocumented route — judged only when it succeeds', () => {
  assert.deepEqual(classes(rec('GET', '/suppliers', 200)), ['undocumented-route']);
  assert.deepEqual(classes(rec('GET', '/suppliers', 404)), []);
  assert.deepEqual(classes(rec('DELETE', '/items/9', 204)), ['undocumented-route']);
});

test('the most specific template wins over a parameterised one', () => {
  assert.equal(oracle.judge(rec('GET', '/items/export?format=csv', 200), ops).op.template, '/items/export');
  assert.deepEqual(classes(rec('GET', '/items/export?format=csv', 200)), []);
  assert.equal(oracle.judge(rec('GET', '/items/42', 200), ops).op.template, '/items/{id}');
});

test('OpenAPI range and default responses, deepObject and free-form query parameters', () => {
  assert.deepEqual(classes(rec('GET', '/stock-moves?filter[sku]=A1', 200)), []);
  assert.deepEqual(classes(rec('GET', '/stock-moves?sort=asc', 200)), ['query-drift']);
  assert.deepEqual(classes(rec('GET', '/stock-moves', 418, '{"code":"BAD_REQUEST"}')), []);
  assert.deepEqual(classes(rec('GET', '/stock-moves', 418, '{"code":"TEAPOT"}')), ['code-drift']);
  assert.deepEqual(classes(rec('GET', '/stock-moves', 500)), ['status-drift']);
  assert.deepEqual(classes(rec('GET', '/reports?any=thing', 299)), []);
});

test('the code field name comes from config', () => {
  const custom = compileOperations({ openapi: '3.1.0', paths: { '/x': { get: { responses: { 404: { content: { 'application/json': { example: { errorCode: 'MISSING' } } } } } } } } }, { codeField: 'errorCode' });
  const judge = (body) => oracle.judge(rec('GET', '/x', 404, body), custom, { codeField: 'errorCode' }).problems.map((p) => p.class);
  assert.deepEqual(judge('{"errorCode":"MISSING"}'), []);
  assert.deepEqual(judge('{"errorCode":"OTHER"}'), ['code-drift']);
  assert.deepEqual(judge('{"code":"OTHER"}'), []);
});

test('distinct findings are keyed by class, template and status, so a baseline survives re-runs', () => {
  const r = oracle.findings([rec('POST', '/items', 200), { ...rec('POST', '/items', 200), seq: 2 }, rec('GET', '/items/1?x=1', 200)], ops, config);
  assert.equal(r.findings.length, 2);
  assert.deepEqual(r.findings[0], { key: 'status-drift POST /items 200 declared 201/422', class: 'status-drift', count: 2, example: '#1 POST /items' });
  assert.equal(r.findings[1].key, 'query-drift GET /items/{id} 200 accepted undeclared query parameter "x"');
});

test('a baselined finding does not fail and a new one does; a vanished one is resolved', () => {
  const result = oracle.findings([rec('POST', '/items', 200), rec('GET', '/suppliers', 200)], ops, config);
  const baseline = { findings: [{ key: 'status-drift POST /items 200 declared 201/422' }, { key: 'query-drift GET /gone 200 accepted undeclared query parameter "q"' }] };
  const c = oracle.compare(result, baseline);
  assert.deepEqual(c.known.map((f) => f.class), ['status-drift']);
  assert.deepEqual(c.fresh.map((f) => f.class), ['undocumented-route']);
  assert.equal(c.resolved.length, 1);
  assert.equal(oracle.compare(result, null).fresh.length, 2);
});

test('a malformed transcript line is named, not skipped', () => {
  assert.throws(() => oracle.parseTranscript('{"seq":1}\n{nope\n'), /transcript line 2/);
});

test('CLI red: new drift exits 1; the baselined finding is reported as known', () => {
  const r = run(fx());
  assert.equal(r.status, 1, r.stderr);
  // Two of the thirteen are /suppliers, which the contract does not describe.
  assert.match(r.stdout, /13 served request\(s\), 11 matched to 8 contract operation\(s\)/);
  assert.match(r.stdout, /NEW {7}status-drift POST \/items 200 declared 201\/422 ×2/);
  assert.match(r.stdout, /NEW {7}query-drift GET \/items 200 accepted undeclared query parameter "search"/);
  assert.match(r.stdout, /NEW {7}code-drift GET \/items\/\{id\} 404 404 carried GONE; declared NOT_FOUND/);
  assert.doesNotMatch(r.stdout, /NEW {7}undocumented-route/);
  assert.match(r.stdout, /baselined: 1 known finding/);
  assert.match(r.stdout, /contract-oracle: FAIL — 3 new drift finding\(s\)/);
});

test('CLI: --write-baseline records every failing finding, and the next run passes', () => {
  const written = run(fx(), ['--baseline', tmpBaseline, '--write-baseline']);
  assert.equal(written.status, 0, written.stderr);
  assert.match(written.stdout, /baseline written — 4 failing finding\(s\)/);
  assert.equal(JSON.parse(readFileSync(tmpBaseline, 'utf8')).findings.length, 4);
  const again = run(fx(), ['--baseline', tmpBaseline]);
  assert.equal(again.status, 0, again.stdout);
  assert.match(again.stdout, /contract-oracle: PASS \(no new drift\)/);
});

test('CLI: feature off prints not configured and exits 0; a missing transcript exits 2', () => {
  const off = run(fx('off'));
  assert.equal(off.status, 0);
  assert.equal(off.stdout.trim(), 'contractOracle: not configured');
  const missing = run(fx(), ['--transcript', 'nope.jsonl']);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /no transcript at/);
});
