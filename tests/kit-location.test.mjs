/**
 * The kit names itself where it is. Installed as a package (`node_modules/@<scope>/builder-pipeline/`) it runs as
 * `npx builder`, and the files it installs and the lines it prints must say so — not `node builder/cli.js` or
 * `builder/DISCOVERY.md`, a folder that project does not have. A kit copied in as `builder/` keeps its old text.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const PACK = join(dirname(fileURLToPath(import.meta.url)), '..');
const made = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

function project(kitAt) {
  const proj = mkdtempSync(join(tmpdir(), 'kit-location-'));
  made.push(proj);
  const kit = join(proj, ...kitAt.split('/'));
  mkdirSync(kit, { recursive: true });
  cpSync(PACK, kit, { recursive: true, filter: (src) => !/[\\/](?:\.git|tests|node_modules)(?:[\\/]|$)/.test(relative(PACK, src) ? `/${relative(PACK, src)}` : '') });
  return { proj, cli: join(kit, 'cli.js') };
}
const run = (cli, cwd, args) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });
function mdFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      if (n === 'node_modules' || n === 'builder' || n === '.git') continue;
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (n.endsWith('.md')) out.push(p);
    }
  };
  walk(dir);
  return out;
}
const OLD = /node builder\/cli\.js|(?<![.\w@/-])builder\/(?:DISCOVERY|USAGE|UNPACK|SETUP_PROMPT|CHANGELOG)\.md/;

describe('the kit names itself where it is installed', () => {
  test('red: installed as a package, every installed Markdown file and the next steps say npx builder and the package path', () => {
    const { proj, cli } = project('node_modules/@geopjinfo/builder-pipeline');
    // opencode is a dotBuilder tool (codex installs natively now; tests/native-tools.test.mjs covers it in package mode).
    const r = run(cli, proj, ['unpack', '--tool', 'claude-code,opencode']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /npx builder verify/);
    assert.doesNotMatch(r.stdout, /node builder\/cli\.js/);
    const stale = mdFiles(proj).filter((f) => OLD.test(readFileSync(f, 'utf8'))).map((f) => relative(proj, f));
    assert.deepEqual(stale, [], `still name a builder/ folder: ${stale.join(', ')}`);
    assert.match(readFileSync(join(proj, 'CLAUDE.md'), 'utf8'), /node_modules\/@geopjinfo\/builder-pipeline\/DISCOVERY\.md/);
    // A project's own .builder/ folder is not the kit: its paths are left alone.
    assert.match(readFileSync(join(proj, 'AGENTS.md'), 'utf8'), /`\.builder\/playbooks\/build-module-pipeline\.md`/);
  });

  test('red: installed as a package, every kit file an installed Markdown file names is one the package ships', () => {
    // The package ships package.json "files" only — the kit's own tests/ stay out — so a rewritten
    // `builder/tests/run.mjs` would send a package user to a file that is not there.
    const at = 'node_modules/@geopjinfo/builder-pipeline';
    const { proj, cli } = project(at);
    for (const extra of ['tests', '.git']) rmSync(join(proj, ...at.split('/'), extra), { recursive: true, force: true });
    const r = run(cli, proj, ['unpack', '--tool', 'claude-code,opencode,codex']);
    assert.equal(r.status, 0, r.stderr);
    const missing = [];
    for (const f of mdFiles(proj)) {
      for (const m of readFileSync(f, 'utf8').matchAll(/node_modules\/@geopjinfo\/builder-pipeline\/([\w./-]*[\w/])/g)) {
        if (!existsSync(join(proj, ...at.split('/'), ...m[1].split('/')))) missing.push(`${relative(proj, f)}: ${m[1]}`);
      }
    }
    assert.deepEqual([...new Set(missing)], []);
  });

  test('control: copied in as builder/, the text is unchanged — node builder/cli.js and builder/DISCOVERY.md', () => {
    const { proj, cli } = project('builder');
    const r = run(cli, proj, ['unpack', '--tool', 'claude-code']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /node builder\/cli\.js verify/);
    assert.match(readFileSync(join(proj, 'CLAUDE.md'), 'utf8'), /`builder\/DISCOVERY\.md`/);
  });
});

/**
 * The documents a package user reads in place (from node_modules, or on the repository page) are never rewritten by
 * the install, so they must already say `npx builder`. A line may still give the folder-copy form when it says so
 * (it names the `builder/` folder); UNPACK.md is the folder-copy path itself, and CHANGELOG.md is history.
 */
describe('docs read in place speak to a package user', () => {
  test('red: README, USAGE, DISCOVERY, DESIGN, SETUP_PROMPT, adapters and the folder READMEs say npx builder, not node builder/cli.js', () => {
    const docs = ['README.md', 'USAGE.md', 'DISCOVERY.md', 'DESIGN.md', 'SETUP_PROMPT.md', 'hooks/README.md', 'skills-extra/README.md', ...readdirSync(join(PACK, 'adapters')).filter((f) => f.endsWith('.md')).map((f) => `adapters/${f}`)];
    const bad = [];
    for (const rel of docs) {
      readFileSync(join(PACK, rel), 'utf8').split(/\r?\n/).forEach((line, i) => {
        if (/node builder\/cli\.js|builder\/tests\/run\.mjs/.test(line) && !/`builder\/` folder|folder cop/.test(line)) bad.push(`${rel}:${i + 1}`);
      });
    }
    assert.deepEqual(bad, []);
  });
});
