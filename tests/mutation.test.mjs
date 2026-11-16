import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, utimesSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const { summarise, lines } = require('../scripts/lib/mutation-summary.cjs');

const fx = (...p) => join(here, 'fixtures', 'mutation', ...p);
const report = JSON.parse(readFileSync(fx('report.json'), 'utf8'));
const PAYLOAD = '\\bdetail\\b|\\brule\\s*:';
const cli = join(here, '..', 'scripts', 'mutation-step.mjs');

function env() {
  const e = { ...process.env };
  const key = Object.keys(e).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
  e[key] = `${dirname(process.execPath)}${delimiter}${e[key] ?? ''}`;
  return e;
}
const run = (dir, args = []) => spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: 'utf8', env: env() });
const cleanup = () => {
  rmSync(fx('reports-under-test'), { recursive: true, force: true });
  rmSync(fx('logs-under-test'), { recursive: true, force: true });
};
after(cleanup);

test('score is detected over valid; invalid mutants are excluded; survivors split by the payload pattern', () => {
  const s = summarise(report, { payloadPattern: PAYLOAD });
  assert.equal(s.score, 40);
  assert.equal(s.detected, 2);
  assert.equal(s.undetected, 3);
  assert.equal(s.invalid, 2);
  assert.equal(s.payload, 1);
  assert.equal(s.logic, 2);
  assert.deepEqual(s.survivors.find((v) => v.kind === 'payload'), { file: 'src/items/reserve.ts', line: 2, mutator: 'StringLiteral', replacement: '""', status: 'Survived', kind: 'payload' });
});

test('with no payload pattern every survivor is logic', () => {
  const s = summarise(report);
  assert.equal(s.payload, 0);
  assert.equal(s.logic, 3);
  assert.match(lines(s, { target: 'items', reportPath: 'r.json' })[0], /no payloadPattern, every survivor is logic/);
});

test('red: a report with no valid mutant has no score, not 0%', () => {
  const s = summarise(JSON.parse(readFileSync(fx('report-no-valid.json'), 'utf8')));
  assert.equal(s.score, null);
  assert.equal(s.invalid, 2);
  assert.match(lines(s, { target: 'items', reportPath: 'r.json', payloadPattern: PAYLOAD })[0], /score — \(no valid mutant\)/);
  assert.equal(summarise({ files: {} }).score, null);
  assert.equal(summarise(null).score, null);
});

test('CLI: survivors do not block — the step exits 0 and prints score and LOGIC rows', () => {
  cleanup();
  const r = run(fx(), ['items']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^mutation: items score 40% · 2 detected · 3 undetected \(2 logic, 1 payload\) · 2 invalid · report reports-under-test\/items\/mutation\.json$/m);
  assert.match(r.stdout, /^ {2}LOGIC {3}src\/items\/reserve\.ts:1 EqualityOperator → "qty < onHand"$/m);
  assert.match(readFileSync(fx('logs-under-test', 'mutation-items.log'), 'utf8'), /fake mutation tool: items/);
  assert.equal(run(fx(), ['items', '--summary']).status, 0);
});

test('CLI: a tool that exits non-zero but writes a fresh report is summarised, exit 0', () => {
  const r = run(fx(), ['threshold']);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /the tool exited 2 but wrote a report/);
  assert.match(r.stdout, /score 40%/);
});

test('CLI red: a tool that produced no report exits 1 with NOT RUN — never a zero', () => {
  const r = run(fx(), ['broken']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /exited 1 and wrote no fresh report .* — mutation: NOT RUN/);
});

test('CLI red: a report left by an earlier run is stale, not this run’s result', () => {
  const dir = fx('reports-under-test', 'noop');
  mkdirSync(dir, { recursive: true });
  copyFileSync(fx('report.json'), join(dir, 'mutation.json'));
  const past = new Date(Date.now() - 3_600_000);
  utimesSync(join(dir, 'mutation.json'), past, past);
  const r = run(fx(), ['noop']);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /mutation: NOT RUN/);
});

test('CLI: feature off prints not configured; a missing or unsafe module name is a usage error', () => {
  const off = run(fx('off'), ['items']);
  assert.equal(off.status, 0);
  assert.equal(off.stdout.trim(), 'mutation: not configured');
  assert.equal(run(fx()).status, 2);
  assert.equal(run(fx(), ['items;echo']).status, 2);
});

test('a guard mutant on a payload line is logic — the split is by the mutant’s column, not the line’s text', () => {
  const source = "if (limit < 1) return fail('limit', 'range', 'limit must be between 1 and 100');";
  const r = { files: { 'src/q.js': { source, mutants: [
    { status: 'Survived', mutatorName: 'EqualityOperator', replacement: 'limit <= 1', location: { start: { line: 1, column: 11 } } },
    { status: 'Survived', mutatorName: 'StringLiteral', replacement: '""', location: { start: { line: 1, column: 47 } } },
    { status: 'Survived', mutatorName: 'ConditionalExpression', replacement: 'false', location: { start: { line: 1 } } },
  ] } } };
  const s = summarise(r, { payloadPattern: '\\bfail\\(' });
  assert.deepEqual(s.survivors.map((v) => v.kind), ['logic', 'payload', 'payload'], 'before the match → logic; on or after it → payload; no column → the line rule');
  assert.equal(s.logic, 1);
  assert.equal(s.payload, 2);
});
