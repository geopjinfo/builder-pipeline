/**
 * EXPERIMENTS.md carries one decision row per numbered section (REQ-801, REQ-901, REQ-1211, REQ-1401).
 *
 * The row is `**Decision (<date>).** keep | drop | not yet measured — <number or "no measurement">`. A `keep`
 * must carry a number: a keep on "no measurement" is the impression the file exists to replace.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
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

  test('red: REQ-801 §16 states the familyReview measurement: findings per auditor family, loop-backs, cost per task, three modules each way, and the keep rule (AC-801a)', () => {
    const s16 = all.find((s) => s.n === 16);
    assert.ok(s16, 'no §16');
    for (const must of [/accepted findings per auditor family/i, /loop-backs/i, /cost per task/i, /three modules/i, /\*\*Keep\*\*/, /\*\*Drop\*\*/, /second reader/i, /at or above the writer'?s tier/i, /features\.familyReview/, /no measurement/i]) {
      assert.match(s16.body, must, `§16 lacks ${must}`);
    }
    assert.match(s16.body, /nothing of it runs|runs nothing/i, '§16 does not say the feature runs nothing while off');
    assert.equal(all.filter((s) => s.n === 16).length, 1, 'one §16, never a second');
  });

  test('the parser: a decision row inside one section does not satisfy another', () => {
    const md = '## 1. A\n\n**Decision (2026-01-01).** drop — 0 of 3\n\n## 2. B\n\nno row here\n';
    const two = sections(md);
    assert.equal(two.length, 2);
    assert.ok(DECISION.test(two[0].body));
    assert.ok(!DECISION.test(two[1].body));
  });
});
