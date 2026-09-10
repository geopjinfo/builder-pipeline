import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const lib = require('../scripts/lib/handoff-check.cjs');

const fixture = join(here, 'fixtures', 'handoff', 'project');
const read = (...p) => readFileSync(join(fixture, ...p), 'utf8').replace(/\r\n/g, '\n');
const pack = read('handoffs', '2026-02-03-stock-levels-handoff.md');
const ctx = (over = {}) => ({
  decisionIds: lib.idsIn(read('decisions', '2026-02-01-stock-levels-decisions.md'), lib.DEFAULT_DECISION_ID),
  registryIds: lib.registryRowIds(read('DEFERRED_TASKS.md')),
  tracker: null,
  ...over,
});
const section = (id) => new RegExp(`## ${id}[\\s\\S]*?(?=\\n## §|$)`);
const trackerTable = (to = 'Shipped', over = {}) =>
  [
    '## §B tracker flips',
    '',
    'RESPONSE REQUIRED: non-blocking',
    '',
    lib.TRACKER_HEADER,
    '|---|---|---|---|---|---|---|',
    `| ${over.when ?? 'post-merge'} | ${over.file ?? 'modules.csv'} | stock-levels | Build Status | Building | ${to} | ${over.evidence ?? 'merge `3f9a1c2`'} |`,
    '',
  ].join('\n');
const tracker = {
  files: ['modules.csv'],
  lists: lib.parseLists(read('tracker', 'lists.csv')),
  columnLists: { 'modules.csv': { 'Build Status': 'Build Status' } },
};

describe('handoff checker — pure', () => {
  test('the fixture decision workspace and registry are read as expected', () => {
    assert.deepEqual([...ctx().decisionIds].sort(), ['D-1', 'D-2']);
    assert.deepEqual([...ctx().registryIds], ['STK-D1'], 'an id mentioned in prose is not a registry row');
  });

  test('a complete pack passes, with the tracker not configured', () => {
    assert.deepEqual(lib.checkHandoff(pack, ctx()), []);
  });

  for (const [id, name] of lib.SECTIONS) {
    test(`red: missing section ${id}`, () => {
      assert.ok(lib.checkHandoff(pack.replace(section(id), ''), ctx()).includes(`missing section: ## ${id} ${name}`));
    });
  }

  test('red: sections out of order', () => {
    const c = pack.match(section('§C'))[0];
    const moved = pack.replace(section('§C'), '').replace('## §F', `${c}\n## §F`);
    assert.ok(lib.checkHandoff(moved, ctx()).includes('section out of order: ## §D'), lib.checkHandoff(moved, ctx()).join('\n'));
  });

  test('red: a section with no RESPONSE REQUIRED line', () => {
    const errors = lib.checkHandoff(pack.replace('## §C decisions\n\nRESPONSE REQUIRED: non-blocking\n', '## §C decisions\n'), ctx());
    assert.deepEqual(errors, ['§C: no "RESPONSE REQUIRED: blocking | non-blocking | none needed" line']);
  });

  test('red: an unfilled placeholder', () => {
    const errors = lib.checkHandoff(pack.replace('- Merge conditions: none.', '- Merge conditions: <fill: each, or "none">.'), ctx());
    assert.equal(errors.length, 1);
    assert.match(errors[0], /unfilled placeholder/);
  });

  test('red: §A without a commit, a version or a verdict', () => {
    const a = '## §A progress\n\nRESPONSE REQUIRED: none needed\n\n- we are done\n';
    const errors = lib.checkHandoff(pack.replace(section('§A'), a), ctx());
    assert.deepEqual(errors, ['§A: no commit sha', '§A: no version', '§A: no reviewer verdict']);
  });

  test('red: an unknown decision id in §C; a custom decision id shape is honoured', () => {
    assert.deepEqual(lib.checkHandoff(pack.replace('`D-1`', '`D-9`'), ctx()), ['§C: D-9 is not in the decision workspace']);
    const custom = ctx({ decisionIdPattern: 'DEC-\\d+', decisionIds: new Set(['DEC-3']) });
    assert.deepEqual(lib.checkHandoff(pack.replace('`D-1`', '`DEC-3`'), custom), []);
    assert.deepEqual(lib.checkHandoff(pack.replace('`D-1`', '`DEC-4`'), custom), ['§C: DEC-4 is not in the decision workspace']);
  });

  test('red: an unknown registry id in §D — including one the registry only mentions in prose', () => {
    assert.deepEqual(lib.checkHandoff(pack.replace('`STK-D1`', '`STK-D7`'), ctx()), ['§D: STK-D7 is not in the deferred registry']);
  });

  test('red: §F with no tag; "no tag" passes', () => {
    assert.deepEqual(lib.checkHandoff(pack.replace('- Tag: v0.4.0.', '- Tag: later.'), ctx()), ['§F: name the tag (vX.Y.Z) or say "no tag"']);
    assert.deepEqual(lib.checkHandoff(pack.replace('- Tag: v0.4.0.', '- Tag: no tag — a docs-only run.'), ctx()), []);
  });

  test('tracker not configured: "No tracker flips — <reason>" is required, and a tracker table is refused', () => {
    assert.deepEqual(lib.checkHandoff(pack.replace('No tracker flips — tracker: not configured', 'nothing'), ctx()), ['§B: tracker: not configured — say "No tracker flips — <reason>"']);
    assert.ok(lib.checkHandoff(pack.replace(section('§B'), trackerTable()), ctx()).some((e) => e.startsWith('§B: a tracker table, but no tracker is configured')));
  });

  test('tracker configured: a valid flip passes, and "No tracker flips — <reason>" is still accepted', () => {
    assert.deepEqual(lib.checkHandoff(pack.replace(section('§B'), trackerTable()), ctx({ tracker })), []);
    assert.deepEqual(lib.checkHandoff(pack, ctx({ tracker })), []);
  });

  test('red: tracker configured — an out-of-vocabulary value, a file not allowed, a bad When, no evidence', () => {
    const errors = (b) => lib.checkHandoff(pack.replace(section('§B'), b), ctx({ tracker }));
    assert.deepEqual(errors(trackerTable('Done')), ['§B row "stock-levels · Build Status": "Done" is not a Build Status value (Not started, Building, Shipped)']);
    assert.ok(errors(trackerTable('Shipped', { file: 'people.csv' })).some((e) => e.includes('File "people.csv" is not a tracker file')));
    assert.ok(errors(trackerTable('Shipped', { when: 'someday' })).some((e) => e.endsWith('When must be pre-merge or post-merge')));
    assert.ok(errors(trackerTable('Shipped', { evidence: '' })).some((e) => e.endsWith('Evidence is required')));
    assert.ok(errors('## §B tracker flips\n\nRESPONSE REQUIRED: non-blocking\n\nsee chat\n').some((e) => e.startsWith('§B: no tracker table with the header')));
  });
});

describe('handoff generator — pure', () => {
  const board = lib.summariseBoard(read('tasks', 'stock-levels.md'));

  test('the board summary counts settled rows (emphasis ignored) and collects deferral ids', () => {
    assert.deepEqual(board, { done: 3, deferred: 1, dropped: 0, open: 0, deferredTo: ['STK-D1'] });
  });

  test('the version comes from the top versioned CHANGELOG heading, else a manifest, else null', () => {
    assert.equal(lib.versionFrom({ changelog: read('CHANGELOG.md') }), '0.4.0');
    assert.equal(lib.versionFrom({ manifests: [{ name: 'package.json', text: '{"version":"2.1.0"}' }] }), '2.1.0');
    assert.equal(lib.versionFrom({ manifests: [{ name: 'pyproject.toml', text: '[project]\nname = "inventory"\nversion = "0.9.2"\n' }] }), '0.9.2');
    assert.equal(lib.versionFrom({ changelog: '# Changelog\n\n## [Unreleased]\n', manifests: [{ name: 'package.json', text: 'not json' }] }), null);
  });

  test('registry changes are read from a diff', () => {
    const diff = ['--- a/DEFERRED_TASKS.md', '+| STK-D1 | stock-levels | new |', '-| STK-D3 | stock-levels | old |', '+| STK-D3 | stock-levels | edited |', ' | STK-D4 | x |'].join('\n');
    assert.deepEqual(lib.registryChanges(diff), [
      { id: 'STK-D1', change: 'added' },
      { id: 'STK-D3', change: 'changed' },
    ]);
  });

  test('tracker not configured: the generator writes the not-configured line, and the filled pack passes the checker', () => {
    const rendered = lib.renderPack({
      key: 'stock-levels',
      sha: '3f9a1c2',
      version: '0.4.0',
      base: 'main',
      date: '2026-02-03',
      verdict: 'MERGE-READY',
      gates: [{ gate: 'unit', result: 'pass', figure: '41/41' }],
      board,
      registryChanges: [{ id: 'STK-D1', change: 'added' }],
      decisions: ['D-1'],
      trackerFiles: null,
    });
    assert.match(rendered, /^No tracker flips — tracker: not configured$/m);
    const unfilled = lib.checkHandoff(rendered, ctx());
    assert.ok(unfilled.length > 0 && unfilled.every((e) => /unfilled placeholder/.test(e)), unfilled.join('\n'));
    assert.deepEqual(lib.checkHandoff(rendered.replace(/<fill[^>]*>/g, 'none'), ctx()), []);
  });

  test('unknown sha and version are placeholders the checker refuses', () => {
    const rendered = lib.renderPack({ key: 'stock-levels', base: 'main', date: '2026-02-03', trackerFiles: ['modules.csv'] });
    assert.match(rendered, /<fill version>/);
    assert.match(rendered, /<fill: commit sha>/);
    assert.ok(rendered.includes(lib.TRACKER_HEADER));
    assert.ok(lib.checkHandoff(rendered, ctx({ tracker })).some((e) => /placeholder/.test(e)));
  });
});

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────────────────────
const scripts = join(here, '..', 'scripts');
const made = [];
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));
const project = () => {
  const dir = mkdtempSync(join(tmpdir(), 'builder-handoff-'));
  cpSync(fixture, dir, { recursive: true });
  made.push(dir);
  return dir;
};
const node = (cwd, script, ...args) => spawnSync(process.execPath, [join(scripts, script), ...args], { cwd, encoding: 'utf8' });
const profileWith = (dir, handoffPack) =>
  writeFileSync(
    join(dir, 'PIPELINE_PROFILE.md'),
    `\`\`\`json pipeline-settings\n${JSON.stringify({ schema: 2, paths: { runs: '.pipeline', decisions: 'decisions' }, features: { handoffPack } }, null, 2)}\n\`\`\`\n`,
  );
const PACK = 'handoffs/2026-02-03-stock-levels-handoff.md';

describe('handoff — CLI on a fixture project', () => {
  test('handoff-check passes the complete pack and says the tracker is not configured', () => {
    const r = node(project(), 'handoff-check.mjs', PACK);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /tracker: not configured/);
    assert.match(r.stdout, /handoff-check: PASS/);
  });

  test('red: handoff-check fails a pack citing an unknown decision id', () => {
    const dir = project();
    writeFileSync(join(dir, PACK), readFileSync(join(dir, PACK), 'utf8').replace('`D-1`', '`D-99`'));
    const r = node(dir, 'handoff-check.mjs', PACK);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /§C: D-99 is not in the decision workspace/);
  });

  test('tracker configured through the profile: the lists CSV is read and an out-of-vocabulary value fails', () => {
    const dir = project();
    profileWith(dir, { state: 'on', tracker: { files: ['modules.csv'], lists: 'tracker/lists.csv', columnLists: { 'modules.csv': { 'Build Status': 'Build Status' } } } });
    const text = readFileSync(join(dir, PACK), 'utf8').replace(/\r\n/g, '\n');
    writeFileSync(join(dir, PACK), text.replace(section('§B'), trackerTable()));
    assert.equal(node(dir, 'handoff-check.mjs', PACK).status, 0);
    writeFileSync(join(dir, PACK), text.replace(section('§B'), trackerTable('Done')));
    const r = node(dir, 'handoff-check.mjs', PACK);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /"Done" is not a Build Status value/);
  });

  test('a configured tracker whose lists file is missing exits 2', () => {
    const dir = project();
    profileWith(dir, { state: 'on', tracker: { files: ['modules.csv'], lists: 'tracker/missing.csv', columnLists: {} } });
    assert.equal(node(dir, 'handoff-check.mjs', PACK).status, 2);
  });

  test('handoff-pack writes one file per run from the board, run log and CHANGELOG', () => {
    const dir = project();
    const r = node(dir, 'handoff-pack.mjs', 'stock-levels', '--date', '2026-03-01');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const out = join(dir, 'handoffs', '2026-03-01-stock-levels-handoff.md');
    assert.ok(existsSync(out), r.stdout);
    const text = readFileSync(out, 'utf8');
    assert.match(text, /No tracker flips — tracker: not configured/);
    assert.match(text, /version v0\.4\.0, reviewer verdict \*\*MERGE-READY\*\*/);
    assert.match(text, /3 DONE · 1 DEFERRED · 0 DROPPED · 0 still open/);
    assert.match(text, /unit pass \(41\/41\) · integration pass \(12\/12\)/, 'the last result per gate, not the first');
    assert.match(text, /`D-1`/);
    assert.match(r.stdout, /placeholder\(s\) to fill/);
  });

  test('the feature off prints "handoffPack: not configured" for both CLIs', () => {
    const dir = project();
    profileWith(dir, { state: 'off' });
    for (const [script, arg] of [
      ['handoff-check.mjs', PACK],
      ['handoff-pack.mjs', 'stock-levels'],
    ]) {
      const r = node(dir, script, arg);
      assert.equal(r.status, 0);
      assert.equal(r.stdout.trim(), 'handoffPack: not configured');
    }
  });
});
