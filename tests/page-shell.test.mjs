/**
 * tooling/experimental/page-shell — the read-only live page: fixtures render in section order with every
 * cell escaped, no data is an em-dash notice, a missing part is named, and the page script holds no write
 * call and no click handler.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { renderDocs, shellHtml, PAGE_CAPABILITIES, PAGE_COLLECTION } = require('../tooling/experimental/page-shell.cjs');

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', 'tooling', 'experimental', 'page-shell.mjs');

/** Section documents in the shape `board-render --json` writes, deliberately out of order. */
const docs = [
  { id: 'rows-P2', order: 1, title: 'P2 — Code', subtitle: '1 / 2', columns: ['#', 'Task', 'Status'], rows: [['T1', '<script>x</script>', 'DONE'], ['T2', '"quoted" & <b>bold</b>', 'PLANNED']] },
  { id: 'run', order: 0, title: 'Sample <run>', subtitle: '50%', columns: ['Fact', 'Value'], rows: [['Spend', null], ['Empty', '']] },
];

/** A write to the store, or a control a viewer could click. */
const WRITES = /\.(set|update|delete|add|acquire|publish)\(|addEventListener|onclick/;

const pageScript = (html) => html.slice(html.indexOf('<script>'));

test('fixtures render in section order, with every cell escaped', () => {
  const html = renderDocs(docs);
  assert.ok(html.indexOf('Sample &lt;run&gt;') < html.indexOf('P2 — Code'), 'order 0 renders before order 1');
  assert.match(html, /&lt;script&gt;x&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>x/);
  assert.match(html, /&quot;quoted&quot; &amp; &lt;b&gt;bold&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<b>bold/);
  assert.match(html, /<td>Spend<\/td><td>—<\/td>/, 'a null cell is an em-dash, never blank or zero');
  assert.match(html, /<td>Empty<\/td><td>—<\/td>/, 'an empty cell is an em-dash');
});

test('no data renders the em-dash notice', () => {
  assert.match(renderDocs([]), /— No page data yet/);
  assert.match(renderDocs(undefined), /— No page data yet/);
  assert.match(renderDocs([{ id: 'bad' }]), /— No page data yet/, 'a document with no rows is not data');
});

test('a missing part is named, not hidden; parts join in order', () => {
  const partial = [{ id: 'steps~1', order: 0, title: 'Steps', subtitle: '', columns: ['A'], rows: [['a']], part: 1, parts: 3 }];
  assert.match(renderDocs(partial), /2 of 3 part\(s\) of this section have not arrived/);

  const whole = [
    { id: 'steps~2', order: 0, title: 'Steps', subtitle: '', columns: ['A'], rows: [['second']], part: 2, parts: 2 },
    { id: 'steps~1', order: 0, title: 'Steps', subtitle: '', columns: ['A'], rows: [['first']], part: 1, parts: 2 },
  ];
  const html = renderDocs(whole);
  assert.doesNotMatch(html, /have not arrived/);
  assert.ok(html.indexOf('first') < html.indexOf('second'));
  assert.equal((html.match(/<section>/g) || []).length, 1, 'parts of one section render as one section');
});

test('the page script holds no write call and no click handler, and runs the tested renderer', () => {
  const shell = shellHtml({ title: 'sample live run', key: 'sample' });
  const script = pageScript(shell);
  assert.doesNotMatch(script, WRITES);
  assert.ok(script.includes(renderDocs.toString()), 'the page inlines the exact function under test');
  assert.match(script, new RegExp(`collection\\('${PAGE_COLLECTION}'\\)\\.onSnapshot`));
  assert.doesNotMatch(shell, /https?:\/\//, 'no external asset');
  assert.deepEqual(PAGE_CAPABILITIES, { db: { rules: [{ path: '', read: 'interact', write: 'owner' }] } });
});

test('red: the write detector catches a click-to-advance or writing shell', () => {
  const synthetic = shellHtml({ title: 't', key: 'k' }).replace(
    '</script>',
    "row.addEventListener('click', function () { db.collection('page').doc('run').update({ status: 'DONE' }); });\n</script>",
  );
  assert.match(pageScript(synthetic), WRITES);
  assert.match("<button onclick=\"advance()\">", WRITES);
  assert.match("db.collection('page').add({})", WRITES);
});

test('the title and key are escaped into the shell', () => {
  const shell = shellHtml({ title: '<img src=x>', key: 'a<b' });
  assert.doesNotMatch(shell, /<img src=x>/);
  assert.match(shell, /&lt;img src=x&gt;/);
});

test('CLI: no key is a usage error; a key writes a shell with no write call', () => {
  const bare = spawnSync(process.execPath, [CLI], { encoding: 'utf8' });
  assert.equal(bare.status, 2);
  assert.match(bare.stderr, /usage: node scripts\/experimental\/page-shell\.mjs <key>/);

  const dir = mkdtempSync(join(tmpdir(), 'page-shell-'));
  try {
    const out = join(dir, 'shell.html');
    const run = spawnSync(process.execPath, [CLI, 'sample', '--out', out], { encoding: 'utf8', cwd: dir });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /publish with capabilities/);
    const html = readFileSync(out, 'utf8');
    assert.match(html, /sample live run/);
    assert.doesNotMatch(pageScript(html), WRITES);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
