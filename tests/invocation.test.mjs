/**
 * Every run command a kit script or hook prints names the layout it runs in: `npx builder run <x>` installed as a
 * package (or vendored into .claude/hooks/kit/), `node scripts/<x>.mjs` in the folder layout. One helper spells them
 * (scripts/lib/run-hint.cjs); a hard-coded form anywhere else under scripts/ or hooks/ is wrong advice in one layout.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const PACK = join(dirname(fileURLToPath(import.meta.url)), '..');
const made = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
const temp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); made.push(d); return d; };

const HELPER = 'scripts/lib/run-hint.cjs';
const HARD = /node (?:scripts\/|builder\/cli\.js)/;

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const abs = join(dir, e);
    if (statSync(abs).isDirectory()) walk(abs, out);
    else if (/\.(?:mjs|cjs|js)$/.test(e)) out.push(abs);
  }
  return out;
}

/** The code of a file without its comments (block comments, and lines that are only a // or * comment). */
function code(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ''))
    .split('\n')
    .map((l) => (/^\s*(?:\/\/|\*)/.test(l) ? '' : l));
}

describe('run commands come from the one helper', () => {
  test('red: no kit script or hook hard-codes `node scripts/` or `node builder/cli.js` outside run-hint.cjs', () => {
    const hits = [];
    for (const root of ['scripts', 'hooks']) {
      for (const abs of walk(join(PACK, root))) {
        const rel = relative(PACK, abs).split('\\').join('/');
        if (rel === HELPER) continue;
        code(readFileSync(abs, 'utf8')).forEach((l, i) => { if (HARD.test(l)) hits.push(`${rel}:${i + 1}: ${l.trim().slice(0, 120)}`); });
      }
    }
    assert.deepEqual(hits, [], `use runHint()/cliHint() from ${HELPER}:\n${hits.join('\n')}`);
  });

  test('the helper names the layout its own file is in', () => {
    const base = temp('kit-hint-');
    const probe = (rel) => {
      const dir = join(base, ...rel.split('/'));
      mkdirSync(dir, { recursive: true });
      cpSync(join(PACK, HELPER), join(dir, 'run-hint.cjs'));
      const r = spawnSync(process.execPath, ['-e', `const h = require(${JSON.stringify(join(dir, 'run-hint.cjs'))}); console.log(h.runHint('ledger-row', 'registry X') + '|' + h.cliHint('verify'))`], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout.trim();
    };
    assert.equal(probe('node_modules/@geopjinfo/builder-pipeline/scripts/lib'), 'npx builder run ledger-row registry X|npx builder verify');
    assert.equal(probe('proj/.claude/hooks/kit/lib'), 'npx builder run ledger-row registry X|npx builder verify');
    assert.equal(probe('proj/scripts/lib'), 'node scripts/ledger-row.mjs registry X|node builder/cli.js verify');
  });
});

describe('a usage line printed from the package says npx builder run', () => {
  const proj = temp('kit-hint-pkg-');
  const kit = join(proj, 'node_modules', '@geopjinfo', 'builder-pipeline');
  mkdirSync(kit, { recursive: true });
  cpSync(PACK, kit, { recursive: true, filter: (src) => !/[\\/](?:\.git|tests|node_modules)(?:[\\/]|$)/.test(`/${relative(PACK, src)}`) });

  for (const [name, args] of [['ledger-row', []], ['handoff-check', []], ['output-check', []], ['claims-check', []], ['cost-window', []]]) {
    test(`red: ${name} usage (package) vs the folder layout`, () => {
      const pkg = spawnSync(process.execPath, [join(kit, 'cli.js'), 'run', name, ...args], { cwd: proj, encoding: 'utf8' });
      const out = `${pkg.stdout}${pkg.stderr}`;
      assert.match(out, new RegExp(`npx builder run ${name}`), out);
      assert.doesNotMatch(out, HARD, out);
      const folder = spawnSync(process.execPath, [join(PACK, 'scripts', `${name}.mjs`), ...args], { cwd: proj, encoding: 'utf8' });
      assert.match(`${folder.stdout}${folder.stderr}`, new RegExp(`node scripts/${name}\\.mjs`));
    });
  }
});

describe('the reference docs give install-neutral commands', () => {
  for (const doc of ['USAGE.md', 'DESIGN.md', 'EXPERIMENTS.md', ...readdirSync(join(PACK, 'adapters')).filter((f) => f.endsWith('.md')).map((f) => `adapters/${f}`)]) {
    test(`${doc}: npx builder forms only, with the folder layout in one note`, () => {
      const text = readFileSync(join(PACK, ...doc.split('/')), 'utf8');
      const hits = text.split(/\r?\n/).map((l, i) => (HARD.test(l) ? `${doc}:${i + 1}: ${l.trim().slice(0, 100)}` : null)).filter(Boolean);
      assert.deepEqual(hits, []);
      if (/npx builder run /.test(text)) assert.match(text, /^> \*\*Commands\.\*\*/m, `${doc} names npx builder run without the folder-layout note`);
    });
  }
});
