/**
 * 2.0.0 drops the `builder` bin: the package is `builder-pipeline` and its one command is `builder-pipeline`
 * (strategy decision S3, applied as DL-2 of specs/toolkit-distribution.spec.md).
 *
 * WHY. The registry name `builder` belongs to an unrelated package, so a bare `npx builder` in a project that has not
 * installed the kit fetches that package and runs it. One bin with the package's own name removes the clash, and every
 * shipped line that tells a person or an agent what to type must name it. This test walks every shipped file
 * (package.json "files", plus the files npm always adds) for the old form; CHANGELOG history (released headings) is
 * the one exception, because it records what was true then. The folder-layout form `node builder/cli.js` names a
 * folder, not the bin, and is covered by tests/invocation.test.mjs.
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const PACK = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(PACK, 'package.json'), 'utf8'));

/** `npx builder`, `npx --no builder`, `npx --no-install builder`: the bin name, not followed by `-pipeline` (or any other word part). */
export const OLD_BIN_FORM = /npx (?:--no(?:-install)? )?builder(?![\w-])/;

/** Every file the package ships: package.json "files" (folders walked), plus the files npm always adds. */
function shippedFiles(root) {
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

/** The lines of CHANGELOG.md that are the `## [Unreleased]` section (released headings are history and stay as written). */
function unreleasedLines(text) {
  const lines = text.split(/\r?\n/);
  let on = false;
  return lines.map((l, i) => {
    if (/^## \[/.test(l)) { on = /^## \[Unreleased\]/.test(l); return null; }
    return on ? [i + 1, l] : null;
  }).filter(Boolean);
}

/** The old-bin lines of one shipped file as `<rel>:<line>: <text>`. */
export function oldBinLines(rel, text) {
  const scan = rel === 'CHANGELOG.md' ? unreleasedLines(text) : text.split(/\r?\n/).map((l, i) => [i + 1, l]);
  return scan.filter(([, l]) => OLD_BIN_FORM.test(l)).map(([n, l]) => `${rel}:${n}: ${l.trim().slice(0, 120)}`);
}

describe('2.0.0 — one bin, builder-pipeline', () => {
  test('red: package.json declares exactly one bin, builder-pipeline, running cli.js', () => {
    assert.deepEqual(pkg.bin, { 'builder-pipeline': 'cli.js' });
    assert.equal(Object.keys(pkg.bin).length, 1, 'the `builder` bin was dropped in 2.0.0 (DL-2)');
  });

  test('red: the old form is flagged in prose and code; the new form, the folder form and CHANGELOG history are not', () => {
    assert.equal(oldBinLines('X.md', 'Run `npx builder verify`.').length, 1);
    assert.equal(oldBinLines('X.md', 'Then `npx builder`.').length, 1, 'the bare command at the end of a phrase');
    assert.equal(oldBinLines('X.md', 'Then `npx builder` with no command').length, 1);
    assert.equal(oldBinLines('x.cjs', "run('inventory', 'npx', ['--no', 'builder', 'inventory']);").length, 0, 'an argv array is checked by tests/first-value.test.mjs');
    assert.equal(oldBinLines('X.md', '`npx --no-install builder --version`').length, 1, 'the bin name after an npx flag');
    assert.equal(oldBinLines('X.md', 'Run `npx builder-pipeline verify`, then `npx builder-pipeline`.').length, 0);
    assert.equal(oldBinLines('X.md', 'Folder layout: `node builder/cli.js verify`.').length, 0, 'a folder name, not the bin');
    assert.equal(oldBinLines('X.md', 'the `builder-init` skill and `builder.lock.json`').length, 0, 'file and skill names are not the bin');
    assert.equal(oldBinLines('CHANGELOG.md', '## [Unreleased]\n- `npx builder verify`\n## [1.0.0]\n- `npx builder verify`').length, 1, 'history is not scanned, Unreleased is');
  });

  test('red: no shipped file names the dropped bin (CHANGELOG history excepted)', () => {
    const hits = [];
    for (const rel of shippedFiles(PACK)) {
      const buf = readFileSync(join(PACK, rel));
      if (buf.includes(0)) continue; // binary
      hits.push(...oldBinLines(rel, buf.toString('utf8')));
    }
    assert.deepEqual(hits, [], `say npx builder-pipeline:\n${hits.join('\n')}`);
  });

  test('red: the suite and the maintainer documents name the one bin too', () => {
    const hits = [];
    const walk = (dir) => {
      for (const n of readdirSync(dir)) {
        const abs = join(dir, n);
        if (statSync(abs).isDirectory()) { if (n !== 'node_modules' && n !== '.git' && n !== 'fixtures') walk(abs); continue; }
        if (!/\.(?:mjs|cjs|js|md|txt|json)$/.test(n)) continue;
        const rel = relative(PACK, abs).split('\\').join('/');
        if (rel === 'tests/bin-rename.test.mjs') continue; // this file names the old form on purpose
        hits.push(...oldBinLines(rel, readFileSync(abs, 'utf8')));
      }
    };
    for (const top of ['tests', 'specs']) walk(join(PACK, top));
    for (const f of ['AGENTS.md', 'RELEASING.md', 'CLAUDE.md', 'DECISIONS.md', 'DEFERRED_TASKS.md', 'PIPELINE_PROFILE.md']) if (existsSync(join(PACK, f))) hits.push(...oldBinLines(f, readFileSync(join(PACK, f), 'utf8')));
    assert.deepEqual(hits, [], `say npx builder-pipeline:\n${hits.join('\n')}`);
  });

  test('red: CHANGELOG [Unreleased] has a Breaking bullet that names the dropped bin', () => {
    const lines = unreleasedLines(readFileSync(join(PACK, 'CHANGELOG.md'), 'utf8')).map(([, l]) => l);
    const at = lines.findIndex((l) => /^### Breaking\b/.test(l));
    assert.notEqual(at, -1, 'no `### Breaking` heading under [Unreleased]');
    let end = lines.findIndex((l, i) => i > at && /^### /.test(l));
    if (end === -1) end = lines.length;
    const section = lines.slice(at + 1, end).join('\n');
    assert.match(section, /^- \*\*[^*]*`builder` bin/m, 'the Breaking section has no bullet about the `builder` bin');
    assert.match(section, /npx builder-pipeline/, 'the bullet names the command a project now types');
  });
});
