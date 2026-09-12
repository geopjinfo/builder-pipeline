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
const wiring = require('../scripts/lib/wiring.cjs');
const profile = require('../scripts/lib/profile.cjs');

const fixture = join(here, 'fixtures', 'wiring', 'project');
const exampleKinds = JSON.parse(readFileSync(join(here, '..', 'examples', 'wiring', 'typescript-di.kinds.json'), 'utf8'));

const file = (path, text, production = true) => ({ path, text, production });
const motor = (over = {}) => ({ name: 'motor', declare: '^async (pump\\w*)\\(', join: '\\.{id}\\(', ...over });
const statuses = (seams) => seams.map((s) => `${s.id}:${s.status}`);

describe('wiring — inventory', () => {
  test('a seam is joined only by ANOTHER production file — not its own file, not a test', () => {
    const decl = file('src/queue.ts', 'async pumpAll() {}\nthis.pumpAll()\n');
    assert.deepEqual(statuses(wiring.inventory([decl], [motor()])), ['pumpAll:unjoined']);
    assert.deepEqual(statuses(wiring.inventory([decl, file('src/queue.test.ts', 'q.pumpAll()', false)], [motor()])), ['pumpAll:unjoined']);
    assert.deepEqual(statuses(wiring.inventory([decl, file('src/job.ts', 'q.pumpAll()')], [motor()])), ['pumpAll:joined']);
  });

  test('scope "any-file" lets the declaring file join its own seam', () => {
    const decl = file('src/queue.ts', 'async pumpAll() {}\nthis.pumpAll()\n');
    assert.deepEqual(statuses(wiring.inventory([decl], [motor({ scope: 'any-file' })])), ['pumpAll:joined']);
  });

  test('a test file never declares a seam', () => {
    assert.deepEqual(wiring.inventory([file('src/queue.test.ts', 'async pumpAll() {}', false)], [motor()]), []);
  });

  test('where carries the declaring line', () => {
    const [seam] = wiring.inventory([file('src/queue.ts', 'class Q {\n\nasync pumpAll() {}\n')], [motor()]);
    assert.equal(seam.where, 'src/queue.ts:3');
  });

  test('red: the id is regex-ESCAPED before substitution — an unescaped "." would join stock.low to stockXlow', () => {
    const kind = { name: 'subscription', declare: "on\\('([^']+)'\\)", join: "emit\\('{id}'\\)" };
    const files = [file('src/listener.ts', "bus.on('stock.low')"), file('src/emitter.ts', "bus.emit('stockXlow')")];
    assert.ok(new RegExp(kind.join.split('{id}').join('stock.low')).test("bus.emit('stockXlow')"), 'the red half: unescaped substitution joins');
    assert.deepEqual(statuses(wiring.inventory(files, [kind])), ['stock.low:unjoined']);
  });

  test('an empty or non-participating capture is NOT-EVALUABLE, and the verdict neither fails nor passes it as joined', () => {
    const kind = { name: 'subscription', declare: "on\\((?:'([^']*)'|\\w+)\\)", join: "emit\\('{id}'\\)" };
    const seams = wiring.inventory([file('src/listener.ts', "for (const name of NAMES) bus.on(name)\nbus.on('')\n")], [kind]);
    assert.deepEqual(seams.map((s) => s.status), ['not-evaluable', 'not-evaluable']);
    const v = wiring.judge({ seams, kinds: [kind] });
    assert.equal(v.ok, true);
    assert.equal(v.unjoined.length, 0);
    assert.equal(v.notEvaluable.length, 2);
  });
});

describe('wiring — judge', () => {
  const kinds = [motor()];
  const unjoined = wiring.inventory([file('src/queue.ts', 'async pumpAll() {}')], kinds);
  const joined = wiring.inventory([file('src/queue.ts', 'async pumpAll() {}'), file('src/job.ts', 'q.pumpAll()')], kinds);
  const row = { id: 'pumpAll', reason: 'ships ahead of its job', citation: 'DECISIONS.md — STK-2' };

  test('red: an unjoined seam with no waiver fails, naming it', () => {
    const v = wiring.judge({ seams: unjoined, kinds });
    assert.equal(v.ok, false);
    assert.match(v.problems.join('\n'), /UNJOINED \[motor\] pumpAll at src\/queue\.ts:1/);
  });

  test('a waiver with a reason and a citation rules it latent', () => {
    const v = wiring.judge({ seams: unjoined, kinds, allow: [row] });
    assert.equal(v.ok, true, v.problems.join('\n'));
    assert.equal(v.waived.length, 1);
  });

  test('red: a waiver missing its reason or citation fails — a latent seam is a decision, not a shrug', () => {
    for (const bad of [{ ...row, citation: '' }, { id: 'pumpAll', reason: 'x' }, { id: 'pumpAll' }]) {
      const v = wiring.judge({ seams: unjoined, kinds, allow: [bad] });
      assert.equal(v.ok, false);
      assert.match(v.problems.join('\n'), /missing/);
    }
  });

  test('red: a waiver matching no inventoried seam is dead', () => {
    const v = wiring.judge({ seams: unjoined, kinds, allow: [row, { ...row, id: 'nothing.produces.this' }] });
    assert.equal(v.ok, false);
    assert.match(v.problems.join('\n'), /dead waiver nothing\.produces\.this: matches no inventoried seam/);
  });

  test('red: a waiver on a seam that has since been joined is dead — delete the row', () => {
    const v = wiring.judge({ seams: joined, kinds, allow: [row] });
    assert.equal(v.ok, false);
    assert.match(v.problems.join('\n'), /dead waiver pumpAll: every seam it names is joined/);
  });

  test('a kind-scoped waiver matches only that kind', () => {
    const v = wiring.judge({ seams: unjoined, kinds, allow: [{ ...row, kind: 'provider' }] });
    assert.equal(v.ok, false);
    assert.match(v.problems.join('\n'), /kind "provider" is not a declared kind/);
  });

  test('positive control: zero seams across every kind fails — zero unjoined proves nothing', () => {
    const v = wiring.judge({ seams: [], kinds });
    assert.equal(v.ok, false);
    assert.match(v.problems[0], /inventoried nothing/);
  });

  test('positive control: a mandatory kind with zero seams fails; an optional one does not', () => {
    const two = [motor(), { name: 'provider', declare: 'providers: \\[(\\w+)\\]', join: '{id}' }];
    assert.match(wiring.judge({ seams: joined, kinds: two }).problems.join('\n'), /kind "provider" inventoried zero seams/);
    assert.equal(wiring.judge({ seams: joined, kinds: [two[0], { ...two[1], optional: true }] }).ok, true);
  });

  test('an empty or absent allow file is valid; a non-array or broken one is unusable', () => {
    assert.deepEqual(wiring.parseAllow(null), { rows: [], error: null });
    assert.deepEqual(wiring.parseAllow('  \n'), { rows: [], error: null });
    assert.deepEqual(wiring.parseAllow('[]'), { rows: [], error: null });
    assert.match(wiring.parseAllow('{}').error, /JSON array/);
    assert.match(wiring.parseAllow('[').error, /not valid JSON/);
  });

  test('kind shapes the settings loader leaves open are checked', () => {
    assert.deepEqual(wiring.validateKinds([motor()]), []);
    assert.match(wiring.validateKinds([motor({ scope: 'same-file' })])[0], /scope: one of other-file \| any-file/);
    assert.match(wiring.validateKinds([motor({ optional: 'yes' })])[0], /optional/);
    assert.match(wiring.validateKinds([motor(), motor()])[0], /declared twice/);
  });
});

describe('wiring — the example kinds', () => {
  test('are valid settings and the fixture uses them verbatim', () => {
    const merged = profile.merge(profile.DEFAULTS, { features: { wiring: { state: 'on', roots: ['src'], extensions: ['.ts'], kinds: exampleKinds } } });
    assert.deepEqual(profile.validate(merged), []);
    assert.deepEqual(wiring.validateKinds(exampleKinds), []);
    assert.deepEqual(profile.load(fixture).settings.features.wiring.kinds, exampleKinds);
  });

  test('the motor kind needs async at line start — tick() inside a template string is not a motor', () => {
    const seams = wiring.inventory([file('src/page.ts', 'const html = `<button onclick="dispatchAll()">`;\n  async dispatchAll() {}\n')], [exampleKinds[0]]);
    assert.deepEqual(seams.map((s) => `${s.id}@${s.line}`), ['dispatchAll@2']);
  });
});

const cli = join(here, '..', 'scripts', 'wiring-check.mjs');
const made = [];
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
};
const project = () => {
  const dir = tmp('builder-wiring-');
  cpSync(fixture, dir, { recursive: true });
  return dir;
};
const run = (cwd, ...args) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });
const out = (r) => `${r.stdout}${r.stderr}`;
const lastLine = (r) => r.stdout.trim().split(/\r?\n/).at(-1);
const baseConfig = profile.load(fixture).settings.features.wiring;
const writeProfile = (dir, wiringConfig) =>
  writeFileSync(join(dir, 'PIPELINE_PROFILE.md'), `\`\`\`json pipeline-settings\n${JSON.stringify({ schema: 2, features: { wiring: wiringConfig } }, null, 2)}\n\`\`\`\n`);
const allowFile = (rows) => {
  const path = join(tmp('builder-wiring-allow-'), 'allow.json');
  writeFileSync(path, JSON.stringify(rows, null, 2));
  return path;
};
const realRows = JSON.parse(readFileSync(join(fixture, 'wiring.allow.json'), 'utf8'));

describe('wiring-check — CLI on a fixture project', () => {
  test('the fixture passes: 7 seams, 1 ruled latent, 1 not-evaluable', () => {
    const r = run(project());
    assert.equal(r.status, 0, out(r));
    assert.equal(lastLine(r), 'wiring-check: PASS — 7 seam(s), 1 ruled latent, 1 not-evaluable, 0 unjoined');
    assert.match(r.stdout, /not-evaluable \[subscription\] \.subscribe\(name at src\/notify\/audit-trail\.ts:8/);
    assert.match(r.stdout, /waived \[motor\] drainPending at src\/stock\/ledger-queue\.ts:8 — .*\(DECISIONS\.md — STK-4\)/);
  });

  test('--list prints the inventory as joined / UNJOINED', () => {
    const r = run(project(), '--list');
    assert.equal(r.status, 0, out(r));
    assert.match(r.stdout, /^ {2}joined {8}motor {10}dispatchBatch\s+src\/stock\/restock-queue\.ts:8$/m);
    assert.match(r.stdout, /^ {2}UNJOINED {6}motor {10}drainPending\s+src\/stock\/ledger-queue\.ts:8$/m);
    assert.match(r.stdout, /^ {2}joined {8}provider {7}EventBus\s+src\/stock\/stock\.providers\.ts:6$/m);
  });

  test('red: removing the only production caller of a motor fails, naming it', () => {
    const dir = project();
    const path = join(dir, 'src', 'stock', 'scheduler.ts');
    writeFileSync(path, readFileSync(path, 'utf8').replace('await this.queue.dispatchBatch()', 'await Promise.resolve(0)'));
    const r = run(dir);
    assert.equal(r.status, 1, out(r));
    assert.match(r.stdout, /UNJOINED \[motor\] dispatchBatch at src\/stock\/restock-queue\.ts:8 — no production caller/);
    assert.match(lastLine(r), /^wiring-check: FAIL — 1 problem\(s\), 1 unjoined of 7 seam\(s\)/);
  });

  test('red: a provider registered and injected nowhere fails', () => {
    const dir = project();
    const mod = join(dir, 'src', 'stock', 'stock.providers.ts');
    writeFileSync(mod, readFileSync(mod, 'utf8').replace('EventBus]', 'EventBus, StockAuditor]'));
    writeFileSync(join(dir, 'src', 'stock', 'stock-auditor.ts'), 'export class StockAuditor {\n  audit(): void {}\n}\n');
    const r = run(dir);
    assert.equal(r.status, 1, out(r));
    assert.match(r.stdout, /UNJOINED \[provider\] StockAuditor at src\/stock\/stock\.providers\.ts:6/);
  });

  test('red: an allow row matching no inventoried seam exits 1, naming the id', () => {
    const r = run(project(), '--allow', allowFile([...realRows, { id: 'nothing.produces.this', reason: 'a waiver for a seam that does not exist', citation: 'this fixture' }]));
    assert.equal(r.status, 1, out(r));
    assert.match(r.stdout, /dead waiver nothing\.produces\.this: matches no inventoried seam/);
  });

  test('positive control for the dead-waiver guard: the real rows alone pass — the guard is not always-on', () => {
    const r = run(project(), '--allow', allowFile(realRows));
    assert.equal(r.status, 0, out(r));
    assert.match(lastLine(r), /^wiring-check: PASS/);
  });

  test('and the real row is a live ruling: with nothing waiving it, the seam fails', () => {
    const r = run(project(), '--allow', allowFile([]));
    assert.equal(r.status, 1, out(r));
    assert.match(r.stdout, /UNJOINED \[motor\] drainPending/);
  });

  test('red: an allow row without a citation fails', () => {
    const r = run(project(), '--allow', allowFile([{ id: 'drainPending', kind: 'motor', reason: 'later' }]));
    assert.equal(r.status, 1, out(r));
    assert.match(r.stdout, /allow row 0 \(drainPending\): missing citation/);
  });

  test('red: testPattern null makes the spec a production caller, so the waiver is dead', () => {
    const dir = project();
    writeProfile(dir, { ...baseConfig, testPattern: null });
    const r = run(dir);
    assert.equal(r.status, 1, out(r));
    assert.match(r.stdout, /dead waiver drainPending \[motor\]: every seam it names is joined/);
  });

  test('positive control: kinds that match nothing fail — an empty inventory is not a pass', () => {
    const dir = project();
    writeProfile(dir, { ...baseConfig, allow: null, kinds: [{ name: 'pump', declare: 'NEVER_PRESENT_(\\w+)', join: '{id}' }] });
    const r = run(dir);
    assert.equal(r.status, 1, out(r));
    assert.match(r.stdout, /zero seams across every kind — the patterns inventoried nothing/);
  });

  test('an absent allow file is valid — and waives nothing', () => {
    const dir = project();
    rmSync(join(dir, 'wiring.allow.json'));
    const r = run(dir);
    assert.equal(r.status, 1, out(r));
    assert.match(r.stdout, /allow: none/);
    assert.match(r.stdout, /UNJOINED \[motor\] drainPending/);
  });

  test('exit 2: an unknown scope, a missing root, an explicit --allow that does not exist', () => {
    const dir = project();
    writeProfile(dir, { ...baseConfig, kinds: [{ ...baseConfig.kinds[0], scope: 'same-file' }] });
    assert.equal(run(dir).status, 2);
    const noRoot = project();
    writeProfile(noRoot, { ...baseConfig, roots: ['lib'] });
    assert.match(out(run(noRoot)), /roots names lib, which is not a directory/);
    assert.equal(run(project(), '--allow', 'nope.json').status, 2);
  });

  test('the feature off prints "wiring: not configured"', () => {
    const dir = project();
    writeFileSync(join(dir, 'PIPELINE_PROFILE.md'), '```json pipeline-settings\n{ "schema": 2, "features": { "wiring": { "state": "off" } } }\n```\n');
    const r = run(dir);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), 'wiring: not configured');
  });
});
