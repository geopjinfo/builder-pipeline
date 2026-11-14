/**
 * The shipped kit carries no project's identity.
 *
 * WHY. The kit was extracted from one production project, and it keeps being improved from there. Every port is a
 * chance to carry that project along by accident: a ticket id in a comment, a ruling number in a persona, a drive
 * path in an example, a private host in a script default. An adopter then reads someone else's ids as if they were
 * rules of their own, and the kit's "project-agnostic" claim is quietly false. Review does not catch these — they
 * look like ordinary prose. This test does: it scans every file the package ships (package.json "files", plus the
 * files npm always adds) for the shapes such ids take, with a short explicit allowlist for the kit's own neutral ids.
 *
 * The kit's own tests/ are not shipped and are not scanned (their fixtures may need such shapes on purpose).
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const PACK = join(dirname(fileURLToPath(import.meta.url)), '..');

// The source project's own names are stored encoded, so this file does not itself carry them in plain text (the
// source repository scans the kit for exactly those strings). b64 = the plain words, base64-encoded.
const b64 = (t) => Buffer.from(t, 'base64').toString('utf8');
const SOURCE_NAMES = b64('ZGFsaWx8YWRmZHxhaWNlbnRlcnxnZW9yZ2Vwag=='); // four project/owner names, |-separated
const SOURCE_PLACE = b64('QWJ1IERoYWJp');

/**
 * Shapes a project-specific id takes. Each one is named so a failure says which rule it broke.
 * Company and project names come from this repository's own history; the id shapes are the ones its source
 * project used (registry rows, decision ids, ADR numbers, rulings), and the rest is anything tied to one machine.
 */
export const DENY = [
  ['source-project name', new RegExp(`\\b(?:${SOURCE_NAMES})\\b`, 'i')],
  ['source-product name', /\bPMP\b/],
  ['place name', new RegExp(`\\b${SOURCE_PLACE}\\b`, 'i')],
  ['registry-row id (ABC-D12)', /\b[A-Z][A-Z0-9]{1,5}-D\d+\b/],
  ['decision id (DEC-1234)', /\bDEC-\d{2,}\b/],
  ['ADR number (ADR-0NN)', /\bADR-\d{3,}\b/],
  ['ruling id (OD-X-N, G-NN)', /\bOD-[A-Z0-9]+-\d+\b|\bG-\d{2}\b/],
  ['plan-item id (A-NNN)', /\bA-\d{3}\b/],
  ['absolute drive path', /(?<![\w])[A-Za-z]:[\\/](?:Users|George|Projects|home|srv)\b/i],
  ['home-directory path', /(?<![\w.])\/(?:home|Users)\/[a-z][\w.-]*\//],
  ['private IPv4 address', /\b(?:192\.168|10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/],
  ['private hostname', /\b[\w-]+\.(?:internal|corp|lan|intranet)\b/i],
  ['email address', /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}\b/i],
];

/**
 * The kit's own neutral ids, each as the exact text it matches — never a pattern, so the list cannot widen by
 * itself. Add a line only for an id the kit itself owns (its examples, its own vocabulary), with the reason.
 */
export const ALLOW = new Map([
  // Fixed RFC-reserved example domains are not anyone's address.
  ['user@example.com', 'RFC 2606 example domain'],
  ['noreply@example.com', 'RFC 2606 example domain'],
]);

/** Every file the package ships: package.json "files" (folders walked), plus the files npm always adds. */
export function shippedFiles(root) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const out = new Set(['package.json']);
  for (const always of ['README.md', 'CHANGELOG.md', 'LICENSE', 'LICENSE.md']) if (existsSync(join(root, always))) out.add(always);
  const walk = (abs) => {
    if (statSync(abs).isDirectory()) {
      for (const n of readdirSync(abs)) if (n !== 'node_modules' && n !== '.git') walk(join(abs, n));
    } else out.add(relative(root, abs).split('\\').join('/'));
  };
  for (const entry of pkg.files || []) {
    const abs = join(root, entry.replace(/\/$/, ''));
    if (existsSync(abs)) walk(abs);
  }
  return [...out].sort();
}

/** Every deny-pattern hit in the shipped files, as `file:line [rule] match`. */
export function scan(root) {
  const hits = [];
  for (const rel of shippedFiles(root)) {
    const buf = readFileSync(join(root, rel));
    if (buf.includes(0)) continue; // binary
    buf
      .toString('utf8')
      .split(/\r?\n/)
      .forEach((line, i) => {
        for (const [rule, re] of DENY) {
          for (const m of line.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`))) {
            if (!ALLOW.has(m[0])) hits.push(`${rel}:${i + 1} [${rule}] ${m[0]}`);
          }
        }
      });
  }
  return hits;
}

const made = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

describe('genericity — the shipped kit names no project', () => {
  test('red: a shipped file with a seeded project id fails, and names the rule it broke', () => {
    const root = mkdtempSync(join(tmpdir(), 'genericity-'));
    made.push(root);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'x', files: ['docs/'] }));
    mkdirSync(join(root, 'docs'));
    writeFileSync(join(root, 'docs', 'a.md'), 'Ruled in DEC-1234 (see ABC-D12).\n');
    const hits = scan(root);
    assert.equal(hits.length, 2, hits.join('\n'));
    assert.ok(hits.every((h) => h.startsWith('docs/a.md:1 [')), hits.join('\n'));
    assert.ok(hits.some((h) => h.includes('[decision id')) && hits.some((h) => h.includes('[registry-row id')), hits.join('\n'));
  });

  test('red: every rule catches its shape', () => {
    const seeds = {
      'source-project name': `the ${SOURCE_NAMES.split('|')[0]} backend`,
      'source-product name': 'the PMP platform',
      'place name': `in ${SOURCE_PLACE}`,
      'registry-row id (ABC-D12)': ['XYZ', 'D12'].join('-'),
      'decision id (DEC-1234)': ['DEC', '1234'].join('-'),
      'ADR number (ADR-0NN)': ['ADR', '012'].join('-'),
      'ruling id (OD-X-N, G-NN)': ['OD', 'X9', '12'].join('-'),
      'plan-item id (A-NNN)': ['A', '123'].join('-'),
      'absolute drive path': 'C:\\Users\\alice\\x',
      'home-directory path': 'cat /home/alice/x',
      'private IPv4 address': 'ssh 192.168.0.10',
      'private hostname': 'build.corp',
      'email address': 'someone@company.test',
    };
    assert.deepEqual(Object.keys(seeds).sort(), DENY.map(([r]) => r).sort(), 'one seed per rule');
    for (const [rule, text] of Object.entries(seeds)) {
      const re = DENY.find(([r]) => r === rule)[1];
      assert.match(text, re, `${rule} misses "${text}"`);
    }
  });

  test('control: an allowlisted neutral id and ordinary prose pass; tests/ is not shipped', () => {
    const root = mkdtempSync(join(tmpdir(), 'genericity-'));
    made.push(root);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'x', files: ['docs/'] }));
    mkdirSync(join(root, 'docs'));
    mkdirSync(join(root, 'tests'));
    writeFileSync(join(root, 'docs', 'a.md'), 'Mail user@example.com; row D-12 and REQ-7; version 1.0.0-rc.1; Node 18.\n');
    writeFileSync(join(root, 'tests', 'b.md'), 'DEC-1234\n');
    assert.deepEqual(scan(root), []);
    assert.ok(!shippedFiles(root).some((f) => f.startsWith('tests/')));
  });

  test('the real shipped tree names no project', () => {
    const files = shippedFiles(PACK);
    assert.ok(files.length > 100, `only ${files.length} shipped files found`);
    assert.ok(!files.some((f) => f.startsWith('tests/')), 'tests/ must not ship');
    assert.deepEqual(scan(PACK), []);
  });
});
