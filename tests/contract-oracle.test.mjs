import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
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

test('CLI: --write-baseline --initial records every failing finding when no baseline exists, and the next run passes', () => {
  const written = run(fx(), ['--baseline', tmpBaseline, '--write-baseline', '--initial']);
  assert.equal(written.status, 0, written.stderr);
  assert.match(written.stdout, /initial baseline recorded — 4 failing finding\(s\)/);
  assert.equal(JSON.parse(readFileSync(tmpBaseline, 'utf8')).findings.length, 4);
  const again = run(fx(), ['--baseline', tmpBaseline]);
  assert.equal(again.status, 0, again.stdout);
  assert.match(again.stdout, /contract-oracle: PASS \(no new drift\)/);
});

/* ---- shrink-only baseline ---------------------------------------------------------------------------- */

const K = {
  status: 'status-drift POST /items 200 declared 201/422',
  query: 'query-drift GET /items 200 accepted undeclared query parameter "search"',
  code: 'code-drift GET /items/{id} 404 404 carried GONE; declared NOT_FOUND',
  route: 'undocumented-route GET /suppliers 200 GET /suppliers answered 200',
  stale: 'query-drift GET /gone 200 accepted undeclared query parameter "q"',
};
const made = [];
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));
const project = () => {
  const dir = mkdtempSync(join(tmpdir(), 'builder-oracle-'));
  cpSync(fx(), dir, { recursive: true });
  made.push(dir);
  return dir;
};
const entry = (key) => ({ key, class: key.split(' ')[0], count: 1, example: '#0 fixture' });
const withBaseline = (dir, keys) => {
  writeFileSync(join(dir, 'baseline.json'), `${JSON.stringify({ _doc: 'carried', transcript: 'transcript.jsonl', findings: keys.map(entry) }, null, 2)}\n`);
  return readFileSync(join(dir, 'baseline.json'));
};
const failingNow = [K.status, K.query, K.code, K.route].map((key) => ({ ...entry(key), count: 2 }));

describe('nextBaseline — pure', () => {
  test('prunes resolved entries and never adds; carried entries are left exactly as they were', () => {
    const baseline = { _doc: 'x', findings: [entry(K.stale), ...[K.status, K.query, K.code, K.route].map(entry)] };
    const n = oracle.nextBaseline(failingNow, baseline);
    assert.deepEqual(n.pruned.map((f) => f.key), [K.stale]);
    assert.deepEqual(n.added, []);
    assert.equal(n.changed, true);
    assert.equal(n.document._doc, 'x');
    assert.deepEqual(n.document.findings.map((f) => f.count), [1, 1, 1, 1]);
  });

  test('red: an unnamed fresh finding is refused, and nothing is offered to write', () => {
    const n = oracle.nextBaseline(failingNow, { findings: [entry(K.route), entry(K.stale)] });
    assert.deepEqual(n.refused.map((f) => f.key), [K.status, K.query, K.code]);
    assert.equal(n.document, null);
    assert.equal(n.changed, false);
  });

  test('--accept adds only the named key; unnamed fresh still refuse; a carried key is a no-op; an unproduced key is unknown', () => {
    const base = { findings: [K.route, K.status, K.query].map(entry) };
    const one = oracle.nextBaseline(failingNow, base, { accept: [K.code, K.route] });
    assert.deepEqual(one.added.map((f) => f.key), [K.code]);
    assert.deepEqual(one.noop, [K.route]);
    assert.equal(one.document.findings.length, 4);
    assert.deepEqual(oracle.nextBaseline(failingNow, { findings: [entry(K.route)] }, { accept: [K.code] }).refused.map((f) => f.key), [K.status, K.query]);
    assert.deepEqual(oracle.nextBaseline(failingNow, base, { accept: [K.stale] }).unknown, [K.stale]);
  });

  test('--initial only without a baseline, and never with --accept', () => {
    assert.equal(oracle.nextBaseline(failingNow, null, { initial: true }).document.findings.length, 4);
    assert.match(oracle.nextBaseline(failingNow, { findings: [] }, { initial: true }).invalid[0], /already exists/);
    assert.match(oracle.nextBaseline(failingNow, null, { initial: true, accept: [K.code] }).invalid[0], /exclusive/);
  });

  test('nothing moved → changed is false', () => {
    const n = oracle.nextBaseline(failingNow, { findings: [K.status, K.query, K.code, K.route].map(entry) });
    assert.equal(n.changed, false);
    assert.deepEqual([n.added.length, n.pruned.length, n.refused.length], [0, 0, 0]);
  });
});

describe('contract-oracle — shrink-only baseline CLI', () => {
  test('red: fresh findings + bare --write-baseline refuses, names each key and both ways forward, and leaves the file unchanged', () => {
    const dir = project();
    const before = readFileSync(join(dir, 'baseline.json'));
    const r = run(dir, ['--write-baseline']);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    for (const key of [K.status, K.query, K.code]) assert.ok(r.stdout.includes(`+ ${key}`), `refusal does not name ${key}`);
    assert.match(r.stdout, /fix the drift/);
    assert.match(r.stdout, /--write-baseline --accept "<key>"/);
    assert.match(r.stdout, /contract-oracle: FAIL — --write-baseline refused: 3 NEW/);
    assert.deepEqual(readFileSync(join(dir, 'baseline.json')), before);
  });

  test('bare --write-baseline prunes a resolved entry; a second run moves nothing and leaves the file byte-identical', () => {
    const dir = project();
    withBaseline(dir, [K.stale, K.status, K.query, K.code, K.route]);
    const r = run(dir, ['--write-baseline']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(r.stdout.includes(`pruned    ${K.stale}`));
    assert.match(r.stdout, /1 pruned, 0 accepted, 4 carried/);
    const after1 = readFileSync(join(dir, 'baseline.json'));
    const again = run(dir, ['--write-baseline']);
    assert.equal(again.status, 0);
    assert.match(again.stdout, /nothing moved; baseline left byte-identical/);
    assert.deepEqual(readFileSync(join(dir, 'baseline.json')), after1);
  });

  test('red: --accept adds only the named key — with another fresh finding unnamed it refuses and writes nothing', () => {
    const dir = project();
    const before = withBaseline(dir, [K.route, K.status]);
    const partial = run(dir, ['--write-baseline', '--accept', K.code]);
    assert.equal(partial.status, 1);
    assert.ok(partial.stdout.includes(`+ ${K.query}`));
    assert.ok(!partial.stdout.includes(`+ ${K.code}`));
    assert.deepEqual(readFileSync(join(dir, 'baseline.json')), before);

    withBaseline(dir, [K.route, K.status, K.query, K.stale]);
    const named = run(dir, ['--write-baseline', '--accept', K.code, '--accept', K.route]);
    assert.equal(named.status, 0, named.stdout + named.stderr);
    assert.ok(named.stdout.includes(`already baselined — no-op: ${K.route}`));
    const keys = JSON.parse(readFileSync(join(dir, 'baseline.json'), 'utf8')).findings.map((f) => f.key);
    assert.deepEqual(keys, [K.route, K.status, K.query, K.code]);
  });

  test('red: an --accept key the run does not produce exits 2 and writes nothing', () => {
    const dir = project();
    const before = withBaseline(dir, [K.route, K.status, K.query]);
    const r = run(dir, ['--write-baseline', '--accept', K.stale]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /does not produce as a failing finding/);
    assert.deepEqual(readFileSync(join(dir, 'baseline.json')), before);
  });

  test('red: --initial over an existing baseline exits 2 and leaves it unchanged; --accept without --write-baseline exits 2', () => {
    const dir = project();
    const before = readFileSync(join(dir, 'baseline.json'));
    const r = run(dir, ['--write-baseline', '--initial']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /only for adoption/);
    assert.deepEqual(readFileSync(join(dir, 'baseline.json')), before);
    assert.equal(run(dir, ['--accept', K.code]).status, 2);
    assert.equal(run(dir, ['--write-baseline', '--accept']).status, 2);
  });
});

test('CLI: feature off prints not configured and exits 0; a missing transcript exits 2', () => {
  const off = run(fx('off'));
  assert.equal(off.status, 0);
  assert.equal(off.stdout.trim(), 'contractOracle: not configured');
  const missing = run(fx(), ['--transcript', 'nope.jsonl']);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /no transcript at/);
});
