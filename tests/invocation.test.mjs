/**
 * Every run command a kit script or hook prints names the layout it runs in: `npx builder-pipeline run <x>` installed as a
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
    assert.equal(probe('node_modules/builder-pipeline/scripts/lib'), 'npx builder-pipeline run ledger-row registry X|npx builder-pipeline verify');
    assert.equal(probe('proj/.claude/hooks/kit/lib'), 'npx builder-pipeline run ledger-row registry X|npx builder-pipeline verify');
    assert.equal(probe('proj/scripts/lib'), 'node scripts/ledger-row.mjs registry X|node builder/cli.js verify');
  });
});

describe('a usage line printed from the package says npx builder-pipeline run', () => {
  const proj = temp('kit-hint-pkg-');
  const kit = join(proj, 'node_modules', 'builder-pipeline');
  mkdirSync(kit, { recursive: true });
  cpSync(PACK, kit, { recursive: true, filter: (src) => !/[\\/](?:\.git|tests|node_modules)(?:[\\/]|$)/.test(`/${relative(PACK, src)}`) });

  for (const [name, args] of [['ledger-row', []], ['handoff-check', []], ['output-check', []], ['claims-check', []], ['cost-window', []]]) {
    test(`red: ${name} usage (package) vs the folder layout`, () => {
      const pkg = spawnSync(process.execPath, [join(kit, 'cli.js'), 'run', name, ...args], { cwd: proj, encoding: 'utf8' });
      const out = `${pkg.stdout}${pkg.stderr}`;
      assert.match(out, new RegExp(`npx builder-pipeline run ${name}`), out);
      assert.doesNotMatch(out, HARD, out);
      const folder = spawnSync(process.execPath, [join(PACK, 'scripts', `${name}.mjs`), ...args], { cwd: proj, encoding: 'utf8' });
      assert.match(`${folder.stdout}${folder.stderr}`, new RegExp(`node scripts/${name}\\.mjs`));
    });
  }
});

/*
 * Every SHIPPED file (package.json "files"), not only scripts/ and hooks/. A bare kit command
 * (`node builder/cli.js …`, `node scripts/<kit script>…`) is advice for the folder layout only, so it is allowed only
 * where the text says so:
 *   - on a line that names the folder layout (`folder layout` on that line);
 *   - inside a Markdown `> **Commands.**` note (the one note per doc that gives the folder forms);
 *   - in a file whose first lines say `folder-layout: this whole file|document` (UNPACK.md, the shell unpackers);
 *   - in Markdown the CLI INSTALLS (skills, personas, the copied templates): kitPaths() rewrites every kit form at
 *     install time in the package layout and leaves the folder layout byte-for-byte, so the source keeps the folder
 *     form on purpose — proved below by a package-mode install that must hold no kit form at all;
 *   - in cli.js's printed strings, which go through the same kitPaths() at print time (its comments are judged);
 *   - in the helper itself, and in CHANGELOG history (released sections record what was true then).
 * `node scripts/<name>` for a script the kit does not ship (`run-tier.mjs`, the adopter's own copy) is not kit advice.
 */
const SHIPPED = JSON.parse(readFileSync(join(PACK, 'package.json'), 'utf8')).files;
const KIT_FORM = /node (builder\/cli\.js|scripts\/([\w./-]*))/g;
const INSTALLED_TEMPLATES = new Set(['task-board', 'deferred-registry', 'module-brief', 'module-report', 'orchestrator-plan', 'orchestrator-worker-brief', 'decision-log', 'session-board'].map((n) => `templates/${n}.md`));
const installedMd = (rel) => rel.endsWith('.md') && (/^(?:skills|agents)\//.test(rel) || /^skills-extra\/[^/]+\//.test(rel) || INSTALLED_TEMPLATES.has(rel));

/** Is `scripts/<p>` a kit script (a file the kit ships under scripts/, or experimental/<x> from tooling/)? '' = a placeholder = yes. */
function kitScript(p, root = PACK) {
  const rel = p.replace(/[.\-/]+$/, '');
  if (!rel || !/^[\w-]/.test(rel)) return true;
  const exp = /^experimental\/(.+)$/.exec(rel);
  const base = exp ? join(root, 'tooling', 'experimental', exp[1]) : join(root, 'scripts', ...rel.split('/'));
  return ['', '.mjs', '.cjs', '.js'].some((x) => { try { return statSync(base + x).isFile(); } catch { return false; } });
}

/** Lines that are comments in a JS file (block comments, and lines that are only a // or * comment). */
function commentLines(text) {
  const lines = text.split('\n');
  const isComment = lines.map((l) => /^\s*(?:\/\/|\*|\/\*)/.test(l));
  let inBlock = false;
  lines.forEach((l, i) => {
    if (inBlock) isComment[i] = true;
    if (/^\s*\/\*/.test(l) && !/\*\//.test(l.replace(/^\s*\/\*/, ''))) inBlock = true;
    else if (inBlock && /\*\//.test(l)) inBlock = false;
  });
  return isComment;
}

/** The bare kit commands in one shipped file's text that no marker covers: `<rel>:<line>: <text>`. */
function bareKitCommands(rel, text, root = PACK) {
  if (rel === HELPER) return [];
  const lines = text.split(/\r?\n/);
  if (lines.slice(0, 20).some((l) => /folder-layout: this whole (?:file|document)/.test(l))) return [];
  let scan = lines.map(() => true);
  if (rel === 'CHANGELOG.md') {
    let on = false;
    scan = lines.map((l) => (/^## \[/.test(l) ? (on = /^## \[Unreleased\]/.test(l)) && false : on));
  }
  if (installedMd(rel)) return [];
  if (rel === 'cli.js') scan = commentLines(text); // printed strings go through kitPaths(); comments do not
  let note = false;
  const hits = [];
  lines.forEach((l, i) => {
    if (rel.endsWith('.md')) {
      if (/^> \*\*Commands\.\*\*/.test(l)) note = true;
      else if (!/^>/.test(l)) note = false;
    }
    if (!scan[i] || note || /folder layout/i.test(l)) return;
    for (const m of l.matchAll(KIT_FORM)) {
      if (m[1].startsWith('scripts/') && !kitScript(m[2], root)) continue;
      hits.push(`${rel}:${i + 1}: ${l.trim().slice(0, 120)}`);
      break;
    }
  });
  return hits;
}

function shippedFiles() {
  const out = [];
  const add = (abs) => {
    if (statSync(abs).isDirectory()) for (const e of readdirSync(abs)) add(join(abs, e));
    else out.push(relative(PACK, abs).split('\\').join('/'));
  };
  for (const f of SHIPPED) add(join(PACK, f.replace(/\/$/, '')));
  return out;
}

describe('every shipped file gives install-neutral commands', () => {
  test('red: a bare kit command is flagged; a marked folder-layout note, a project script and a Commands note are not', () => {
    assert.equal(bareKitCommands('X.md', 'Run `node scripts/features.mjs` now.').length, 1);
    assert.equal(bareKitCommands('X.md', 'Then `node builder/cli.js verify`.').length, 1);
    assert.equal(bareKitCommands('scripts/x.mjs', ' *   node scripts/ledger-row.mjs registry X').length, 1, 'a comment is text a reader follows');
    assert.equal(bareKitCommands('X.md', 'Folder layout: `node scripts/features.mjs`.').length, 0);
    assert.equal(bareKitCommands('X.md', '> **Commands.** npm form; folder:\n> `node builder/cli.js verify`\n\nplain').length, 0);
    assert.equal(bareKitCommands('X.md', '> **Commands.** note\n\n`node builder/cli.js verify`').length, 1, 'the note ends at the blockquote');
    assert.equal(bareKitCommands('X.md', 'Your own `node scripts/run-tier.mjs unit`.').length, 0, 'not a kit script');
    assert.equal(bareKitCommands('X.md', '<!-- folder-layout: this whole document -->\n`node builder/cli.js verify`').length, 0);
    assert.equal(bareKitCommands('CHANGELOG.md', '## [Unreleased]\n- `node builder/cli.js verify`\n## [1.0.0]\n- `node builder/cli.js verify`').length, 1, 'history is not scanned, Unreleased is');
    assert.equal(bareKitCommands('cli.js', '/*\n * node builder/cli.js verify\n */\nconsole.log(`node builder/cli.js verify`);').length, 1, 'the comment, not the printed string');
  });

  test('red: no shipped file names a bare kit command outside a marked folder-layout note', () => {
    const hits = [];
    for (const rel of shippedFiles()) {
      const buf = readFileSync(join(PACK, ...rel.split('/')));
      if (buf.includes(0)) continue; // binary
      hits.push(...bareKitCommands(rel, buf.toString('utf8')));
    }
    assert.deepEqual(hits, [], `use npx builder-pipeline run <x> / npx builder-pipeline <cmd> (with one folder-layout note), or runHint()/cliHint():\n${hits.join('\n')}`);
  });

  test('red: the Markdown the CLI installs holds no kit form in the package layout (so its source may keep the folder form)', () => {
    const proj = temp('kit-hint-all-');
    const kit = join(proj, 'node_modules', 'builder-pipeline');
    mkdirSync(kit, { recursive: true });
    cpSync(PACK, kit, { recursive: true, filter: (src) => !/[\\/](?:\.git|tests|node_modules)(?:[\\/]|$)/.test(`/${relative(PACK, src)}`) });
    const u = spawnSync(process.execPath, [join(kit, 'cli.js'), 'unpack', '--tool', 'all', '--experimental'], { cwd: proj, encoding: 'utf8' });
    assert.equal(u.status, 0, `${u.stdout}${u.stderr}`);
    const hits = [];
    const scanDir = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === '.git') continue;
        const abs = join(dir, e.name);
        if (e.isDirectory()) scanDir(abs);
        else if (/\.(?:md|mdc|toml)$/.test(e.name)) {
          readFileSync(abs, 'utf8').split(/\r?\n/).forEach((l, i) => {
            for (const m of l.matchAll(KIT_FORM)) if (!m[1].startsWith('scripts/') || kitScript(m[2], kit)) hits.push(`${relative(proj, abs)}:${i + 1}: ${l.trim().slice(0, 100)}`);
          });
        }
      }
    };
    scanDir(proj);
    assert.deepEqual(hits, []);
  });
});

describe('the reference docs give install-neutral commands', () => {
  for (const doc of ['USAGE.md', 'DESIGN.md', 'EXPERIMENTS.md', ...readdirSync(join(PACK, 'adapters')).filter((f) => f.endsWith('.md')).map((f) => `adapters/${f}`)]) {
    test(`${doc}: npx builder-pipeline forms only, with the folder layout in one note`, () => {
      const text = readFileSync(join(PACK, ...doc.split('/')), 'utf8');
      const hits = text.split(/\r?\n/).map((l, i) => (HARD.test(l) ? `${doc}:${i + 1}: ${l.trim().slice(0, 100)}` : null)).filter(Boolean);
      assert.deepEqual(hits, []);
      if (/npx (?:--no-install )?builder-pipeline run /.test(text)) assert.match(text, /^> \*\*Commands\.\*\*/m, `${doc} names npx builder-pipeline run without the folder-layout note`);
    });
  }
});
