/**
 * board-render.mjs + page-docs.cjs — run against COPIES of the fixture board in a temp directory,
 * with the synthetic transcript directory passed explicitly, so nothing outside the pack (and no real
 * `tasks/` or harness transcript) is ever read.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { splitDocs, PAGE_DOC_LIMIT, bytes } = require('../scripts/lib/page-docs.cjs');

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, '..', 'scripts', 'board-render.mjs');
const fixtureBoard = join(here, 'fixtures', 'board');
const transcripts = join(here, 'fixtures', 'transcripts', 'project');
const render = await import(pathToFileURL(script).href);

/** A fresh copy of the fixture board tree; removed after the test. */
function workspace(t) {
  const dir = mkdtempSync(join(tmpdir(), 'board-render-'));
  cpSync(fixtureBoard, dir, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const setProfile = (dir, mutate) => {
  const path = join(dir, 'PIPELINE_PROFILE.md');
  const text = readFileSync(path, 'utf8');
  writeFileSync(path, mutate(text), 'utf8');
};

const writeSkill = (dir, model) => {
  const skillDir = join(dir, '.claude', 'skills', 'build-module-pipeline');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), `# pipeline\n\n| Phase | Name | Seat | Model |\n|---|---|---|---|\n| 0 | Orchestrate | orchestrator (this session) | \`${model}\` |\n`, 'utf8');
};

/** The `<tr>` of the agents table whose first cell is `seat`. */
const agentRow = (html, seat) => {
  const section = html.slice(html.indexOf('id="agents"'), html.indexOf('id="source"'));
  return section.split('<tr').find((r) => r.includes(`<td>${seat}</td>`)) ?? null;
};

/* ── the declared orchestrator model ─────────────────────────────────────────────────────────── */

test('the orchestrator model is read from the profile', (t) => {
  const dir = workspace(t);
  assert.equal(render.declaredOrchestratorModel(dir), 'claude-opus-5');
});

test('the profile wins over the harness skill table', (t) => {
  const dir = workspace(t);
  writeSkill(dir, 'claude-sonnet-5');
  assert.equal(render.declaredOrchestratorModel(dir), 'claude-opus-5');
});

test('with no profile declaration, the skill table row is the fallback; with neither, no declaration', (t) => {
  const dir = workspace(t);
  setProfile(dir, (text) => text.replace('"orchestrator": "claude-opus-5"', '"orchestrator": null'));
  assert.equal(render.declaredOrchestratorModel(dir), null);
  writeSkill(dir, 'claude-sonnet-5');
  assert.equal(render.declaredOrchestratorModel(dir), 'claude-sonnet-5');
  rmSync(join(dir, 'PIPELINE_PROFILE.md'));
  assert.equal(render.declaredOrchestratorModel(dir), 'claude-sonnet-5');
});

/* ── the HTML page ───────────────────────────────────────────────────────────────────────────── */

test('the page reports the orchestrator as declared when the transcript agrees', (t) => {
  const dir = workspace(t);
  const html = readFileSync(render.renderBoard(join(dir, 'tasks', 'sample.md'), { transcripts }), 'utf8');
  assert.match(html, /claude-opus-5 <span class="hint">as declared<\/span>/);
});

test('a divergent declaration is reported, not refused', (t) => {
  const dir = workspace(t);
  setProfile(dir, (text) => text.replace('"orchestrator": "claude-opus-5"', '"orchestrator": "claude-sonnet-5"'));
  const html = readFileSync(render.renderBoard(join(dir, 'tasks', 'sample.md'), { transcripts }), 'utf8');
  assert.match(html, /declared claude-sonnet-5 — this run diverged/);
});

test('per-seat accounting: foreground, background-from-own-transcript, orchestrator, and an unmeasured em-dash', (t) => {
  const dir = workspace(t);
  const html = readFileSync(render.renderBoard(join(dir, 'tasks', 'sample.md'), { transcripts }), 'utf8');
  assert.match(agentRow(html, 'module-builder'), /\$0\.07/);
  // the background seat carried no usage in its dispatch result, and is still measured
  const security = agentRow(html, 'security-auditor');
  assert.match(security, /claude-opus-5/);
  assert.match(security, /\$0\.02/);
  assert.match(agentRow(html, 'orchestrator'), /\$0\.05/);
  // no transcript and no usage: an em-dash, never $0.00
  const vuln = agentRow(html, 'vuln-auditor');
  assert.ok(vuln, 'the unmeasured seat still has a row');
  assert.doesNotMatch(vuln, /\$/);
  assert.match(vuln, /—/);
  // two seats unmeasured: the totals are floors, and say so
  assert.match(html, /≥ \$0\.13 · 2 seats unmeasured <span class="hint">derived · rates/);
  assert.match(html, /<td class="num">≥ \$0\.13 · 2 seats unmeasured<\/td><\/tr><\/tfoot>/);
  assert.doesNotMatch(agentRow(html, 'module-builder'), /≥/, 'a measured seat is its own figure, never a floor');
});

test('with no transcript on this machine every cost is an em-dash and no $0.00 appears anywhere', (t) => {
  const dir = workspace(t);
  const html = readFileSync(render.renderBoard(join(dir, 'tasks', 'sample.md'), { transcripts: join(dir, 'no-transcripts') }), 'utf8');
  assert.doesNotMatch(html, /\$0\.00/);
  assert.doesNotMatch(agentRow(html, 'module-builder'), /\$/);
});

test('todo, definition of done, modules and decisions render from their sources', (t) => {
  const dir = workspace(t);
  const html = readFileSync(render.renderBoard(join(dir, 'tasks', 'sample.md'), { transcripts }), 'utf8');
  assert.match(html, /Render the page/);
  assert.match(html, /every row settled and its test named/);
  assert.match(html, /POST \/adjustments/);
  assert.match(html, /Decisions this run<span>2 logged/);
  assert.match(html, /restore fractional stock in one migration/);
});

test('absent Todo / Definition of Done / Modules render as "declares no", not as an invented table', (t) => {
  const dir = workspace(t);
  const html = readFileSync(render.renderBoard(join(dir, 'tasks', 'bare.md'), { transcripts }), 'utf8');
  assert.match(html, /This board declares no ## Todo list\./);
  assert.match(html, /This board declares no ## Definition of Done table\./);
  assert.match(html, /This board declares no ## Modules &amp; endpoints table\./);
  assert.match(html, /No decision event in the run log\./);
});

/* ── --json section documents ────────────────────────────────────────────────────────────────── */

const readDocs = (dir) =>
  readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ file: join(dir, f), doc: JSON.parse(readFileSync(join(dir, f), 'utf8')) }));

test('--json writes one document per section, each within the cap, under paths.runs by default', (t) => {
  const dir = workspace(t);
  const { dir: out, ids } = render.renderJson(join(dir, 'tasks', 'sample.md'), { transcripts });
  assert.equal(out, join(dir, '.pipeline', 'sample', 'page'));
  for (const id of ['run', 'gates', 'rows-P2', 'rows-P4', 'todo', 'dod', 'modules', 'decisions', 'steps', 'agents']) assert.ok(ids.includes(id), id);
  for (const { file } of readDocs(out)) assert.ok(statSync(file).size <= PAGE_DOC_LIMIT);
  const agents = readDocs(out).find((d) => d.doc.id === 'agents').doc;
  assert.deepEqual(agents.rows.find((r) => r[0] === 'vuln-auditor').slice(2), ['—', '—', '—', '—', '—']);
});

test('--json sends the documents to an explicit --out directory instead of paths.runs', (t) => {
  const dir = workspace(t);
  const out = join(dir, 'elsewhere', 'page');
  const { dir: written } = render.renderJson(join(dir, 'tasks', 'sample.md'), { transcripts, outDir: out });
  assert.equal(written, out);
  assert.ok(readdirSync(out).some((f) => f.endsWith('.json')));
});

test('an oversized section splits into parts within the cap that add back to the whole; a later render leaves no orphan part', (t) => {
  const dir = workspace(t);
  const board = join(dir, 'tasks', 'sample.md');
  const whole = readDocs(render.renderJson(board, { transcripts, outDir: join(dir, 'whole') }).dir).map((d) => d.doc);

  /* The smallest cap every single row still fits under — so sections split but none must throw. */
  const envelope = (doc) => bytes({ ...doc, id: `${doc.id}~9999`, rows: [], part: 9999, parts: 9999 });
  const limit = Math.max(...whole.map((doc) => (doc.rows.length === 0 ? bytes(doc) : envelope(doc) + Math.max(...doc.rows.map((r) => bytes(r) + 1)))));
  assert.ok(whole.some((doc) => bytes(doc) > limit), 'the fixture must hold a section over the chosen cap');

  const splitDir = join(dir, 'split');
  const docs = readDocs(render.renderJson(board, { transcripts, outDir: splitDir, limit }).dir);
  for (const { file } of docs) assert.ok(statSync(file).size <= limit, `${file} is over ${limit}`);
  for (const w of whole) {
    const parts = docs.map((d) => d.doc).filter((d) => d.id === w.id || d.id.startsWith(`${w.id}~`)).sort((a, b) => (a.part ?? 0) - (b.part ?? 0));
    assert.deepEqual(parts.flatMap((p) => p.rows), w.rows, `${w.id} rows must add back to the whole`);
    if (parts.length > 1) assert.ok(parts.every((p) => p.parts === parts.length));
  }
  assert.ok(docs.some((d) => d.doc.parts > 1));

  render.renderJson(board, { transcripts, outDir: splitDir });
  assert.equal(readdirSync(splitDir).filter((f) => f.includes('~')).length, 0);
});

test('a single row over the cap throws rather than being truncated', (t) => {
  const dir = workspace(t);
  assert.throws(() => render.renderJson(join(dir, 'tasks', 'sample.md'), { transcripts, limit: 200 }), /refusing to/);
});

test('splitDocs: a section whose envelope alone is over the cap throws, rows or none, rather than vanishing', () => {
  const doc = { id: 'steps', order: 0, title: 'z'.repeat(2000), subtitle: 'x', columns: ['A'], rows: [['a'], ['b']] };
  assert.throws(() => splitDocs([doc], 1024), /section "steps" is over 1024 bytes before any row \(2 rows\)/);
  assert.throws(() => splitDocs([{ ...doc, rows: [] }], 1024), /before any row \(0 rows\)/);
});

test('splitDocs: under-cap untouched, over-cap split, a lone oversized row or a rowless oversized section throws', () => {
  const doc = { id: 'steps', order: 0, title: 'Step log', subtitle: 'x', columns: ['A'], rows: Array.from({ length: 50 }, (_, i) => [`row ${i} ${'x'.repeat(80)}`]) };
  assert.deepEqual(splitDocs([doc], 1 << 20), [doc]);
  const parts = splitDocs([doc], 1024);
  assert.ok(parts.length > 1);
  for (const p of parts) assert.ok(bytes(p) <= 1024);
  assert.deepEqual(parts.flatMap((p) => p.rows), doc.rows);
  assert.deepEqual(parts.map((p) => p.id), parts.map((_, i) => `steps~${i + 1}`));
  assert.throws(() => splitDocs([{ ...doc, rows: [...doc.rows, ['y'.repeat(2000)]] }], 1024), /row 51 alone is over 1024 bytes/);
  assert.throws(() => splitDocs([{ ...doc, title: 'z'.repeat(2000), rows: [] }], 1024), /before any row \(0 rows\)/);
});

/* ── the CLI ─────────────────────────────────────────────────────────────────────────────────── */

test('CLI: --json with --out and --transcripts, a plain render, and a bad --limit', (t) => {
  const dir = workspace(t);
  const board = join(dir, 'tasks', 'sample.md');
  const out = join(dir, 'cli-docs');
  const json = spawnSync(process.execPath, [script, board, '--json', '--out', out, '--transcripts', transcripts], { encoding: 'utf8' });
  assert.equal(json.status, 0, json.stderr);
  assert.match(json.stdout, /document\(s\)/);
  assert.ok(readdirSync(out).length > 0);

  const html = spawnSync(process.execPath, [script, board, '--transcripts', transcripts], { encoding: 'utf8' });
  assert.equal(html.status, 0, html.stderr);
  assert.ok(existsSync(join(dir, 'tasks', 'sample.html')));

  const bad = spawnSync(process.execPath, [script, board, '--json', '--limit', 'lots', '--transcripts', transcripts], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
});
