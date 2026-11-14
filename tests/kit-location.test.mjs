/**
 * The kit names itself where it is. Installed as a package (`node_modules/@<scope>/builder-pipeline/`) it runs as
 * `npx builder`, and the files it installs and the lines it prints must say so — not `node builder/cli.js` or
 * `builder/DISCOVERY.md`, a folder that project does not have. A kit copied in as `builder/` keeps its old text.
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

  test('control: copied in as builder/, the text is unchanged — node builder/cli.js and builder/DISCOVERY.md', () => {
    const { proj, cli } = project('builder');
    const r = run(cli, proj, ['unpack', '--tool', 'claude-code']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /node builder\/cli\.js verify/);
    assert.match(readFileSync(join(proj, 'CLAUDE.md'), 'utf8'), /`builder\/DISCOVERY\.md`/);
  });
});
