/**
 * REQ-1406 — the 2.0.0 build's own record: EXPERIMENTS §19 names the recorded runs, every module PR of the build, and
 * where the run files live. The Library itself is outside this checkout, so the test reads what §19 claims and that the
 * claims are complete, not the Library's contents.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const text = readFileSync(join(here, '..', 'EXPERIMENTS.md'), 'utf8');
const s19 = text.slice(text.indexOf('\n## 19.'), text.indexOf('\n## 20.'));

/** The module PRs of the 2.0.0 build at the time of writing (draft or merged), by module. */
const MODULE_PRS = { M0: 6, M1: 14, M2a: 15, M3: 22, M6: 16, M9: 23, M10: 18, M11: 21, M12: 19, A: 7, B: 8, C: 9, M14: null };

describe('release check — the recorded runs of §19 (REQ-1406)', () => {
  test('red: §19 names every module PR of the 2.0.0 build and says how the build ran', () => {
    for (const [m, n] of Object.entries(MODULE_PRS)) if (n) assert.match(s19, new RegExp(`${m}\\b[^\\n]*#${n}\\b`), `§19 names ${m} as PR #${n}`);
    assert.match(s19, /device .*cloud|cloud .*device/i, 'how the build ran');
    assert.match(s19, /not .*through the kit's orchestrator|no run log|follow-up/i, 'the honest note');
  });
  test('red: §19 names the evidence folder of the recorded run and its files', () => {
    assert.match(s19, /evidence\/[a-z0-9-]+\//);
    for (const f of ['board.md', 'run.jsonl', 'progress.md']) assert.ok(s19.includes(f), `§19 names ${f}`);
  });
});
