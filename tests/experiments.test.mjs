/**
 * EXPERIMENTS.md carries one decision row per numbered section (REQ-801, REQ-901, REQ-1211, REQ-1401).
 *
 * The row is `**Decision (<date>).** keep | drop | not yet measured — <number or "no measurement">`. A `keep`
 * must carry a number: a keep on "no measurement" is the impression the file exists to replace.
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const exp = require('../scripts/lib/experiments.cjs');
const profile = require('../scripts/lib/profile.cjs');
const CLI = join(here, '..', 'scripts', 'experiments.mjs');
const text = readFileSync(join(here, '..', 'EXPERIMENTS.md'), 'utf8');

const DECISION = /^\*\*Decision \((\d{4}-\d{2}-\d{2})\)\.\*\* (keep|drop|not yet measured) — (.+)$/m;

/** `[{ n, title, body }]` for every `## <n>. <title>` section, in file order. */
export function sections(md) {
  const out = [];
  const re = /^## (\d+)\. (.+)$/gm;
  const heads = [...md.matchAll(re)];
  heads.forEach((h, i) => {
    const end = i + 1 < heads.length ? heads[i + 1].index : md.length;
    out.push({ n: Number(h[1]), title: h[2].trim(), body: md.slice(h.index, end) });
  });
  return out;
}

describe('EXPERIMENTS.md decision rows', () => {
  const all = sections(text);

  test('sections 1 to 20 are present, numbered without a gap', () => {
    assert.deepEqual(all.map((s) => s.n), Array.from({ length: 20 }, (_, i) => i + 1));
  });

  test('red: every section has a non-blank decision row with a date and a verdict', () => {
    const missing = all.filter((s) => !DECISION.test(s.body)).map((s) => `§${s.n} ${s.title}`);
    assert.deepEqual(missing, []);
  });

  test('a keep row carries a number, never "no measurement"', () => {
    const bad = all
      .map((s) => ({ s, m: s.body.match(DECISION) }))
      .filter(({ m }) => m && m[2] === 'keep' && (/no measurement/i.test(m[3]) || !/\d/.test(m[3])))
      .map(({ s }) => `§${s.n}`);
    assert.deepEqual(bad, []);
  });

  test('the new 2.0 sections name their features: familyReview, boardLoop, remoteLanes', () => {
    const titles = Object.fromEntries(all.map((s) => [s.n, s.title]));
    assert.match(titles[16] || '', /familyReview/);
    assert.match(titles[17] || '', /boardLoop/);
    assert.match(titles[18] || '', /remoteLanes/);
  });

  test('the parser: a decision row inside one section does not satisfy another', () => {
    const md = '## 1. A\n\n**Decision (2026-01-01).** drop — 0 of 3\n\n## 2. B\n\nno row here\n';
    const two = sections(md);
    assert.equal(two.length, 2);
    assert.ok(DECISION.test(two[0].body));
    assert.ok(!DECISION.test(two[1].body));
  });
});

describe('M14 — the evidence programme (REQ-1402, REQ-1405, REQ-1401)', () => {
  test('red: §19 names a run id, a cost line and a fix-rate line for each recorded run', () => {
    const s19 = sections(text).find((s) => s.n === 19);
    assert.match(s19.body, /run id:?\s*`?[a-z0-9-]+/i);
    assert.match(s19.body, /cost:?.*(unmeasured|\$\d)/i);
    assert.match(s19.body, /fix-rate:?.*(fixLane: unmeasured|fix-of-fix)/i);
    assert.match(s19.body, /silent failures/i);
  });
  test('red: §20 gives every default-on check a false-positive rate, and a check above 20% is off by default', () => {
    const s20 = sections(text).find((s) => s.n === 20);
    const rates = exp.falsePositiveRates(s20.body);
    for (const c of ['check-ledgers', 'claims-check', 'output-check', 'fix-rate', 'inventory']) assert.ok(c in rates, `${c} has a rate row`);
    const FEATURE_OF = { 'claims-check': 'claims', 'output-check': 'planSchema', 'fix-rate': 'fixLane' };
    for (const [check, r] of Object.entries(rates)) {
      if (r.percent !== null && r.percent > 20) {
        const f = FEATURE_OF[check];
        assert.ok(f && profile.FEATURES[f].defaults.state === 'off', `${check} is above 20% false positives (${r.percent}%) and must be off by default`);
      }
    }
  });
  test('red: the parser reads the decision of every section, and `experiments --check` passes on the shipped file', () => {
    const all = exp.parse(text);
    assert.equal(all.length, 20);
    for (const s of all) assert.ok(['keep', 'drop', 'not yet measured'].includes(s.decision.verdict), `§${s.n}`);
    assert.equal(all.find((s) => s.n === 17).flag, 'boardLoop');
    assert.equal(all.find((s) => s.n === 6).flag, 'builderBatch');
    const r = spawnSync(process.execPath, [CLI, '--check'], { cwd: join(here, '..'), encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^§17 .*boardLoop.*not yet measured/m);
    const m = spawnSync(process.execPath, [CLI, '--matrix'], { cwd: join(here, '..'), encoding: 'utf8' });
    assert.match(m.stdout, /boardLoop.*§17.*polyglot/);
    assert.match(m.stdout, /remoteLanes.*§18/);
  });
  test('red: `experiments --record` appends a row to a section table and refuses an unknown section', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kit-exp-'));
    const f = join(dir, 'EXPERIMENTS.md');
    writeFileSync(f, '# E\n\n## 17. Loop — `boardLoop` (x)\n\n| A | B |\n|---|---|\n\n**Decision (2026-11-17).** not yet measured — no measurement.\n\n## 18. Next\n');
    exp.recordRow(f, 17, '| 2026-11-17 | one |');
    assert.match(readFileSync(f, 'utf8'), /\|---\|---\|\n\| 2026-11-17 \| one \|\n/);
    assert.throws(() => exp.recordRow(f, 21, '| x |'), /no §21/);
    const r = spawnSync(process.execPath, [CLI, '--record', '17', '--row', '| 2026-11-18 | two |', '--file', f], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(readFileSync(f, 'utf8'), /\| 2026-11-18 \| two \|/);
  });
});
