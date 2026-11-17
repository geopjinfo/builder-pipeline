/**
 * The kit installed as a package (node_modules/builder-pipeline) — what the sample-project run found broken:
 *   D2  board-check-all spawned `scripts/board-progress.mjs` relative to the working directory, and its --fix printed
 *       PASS after the child crashed;
 *   D3  the board-render and instruction-lint hooks looked for `<project>/scripts/lib`, which a package install never
 *       creates, so they were silent no-ops;
 *   D7  the docs the install sends the agent to named the folder-layout commands;
 *   D8  installed files named `scripts/…` and `builder/` paths that do not exist in this layout;
 *   D11 board-progress took a path only, not the board key the docs use.
 * The folder layout (kit copied in as `builder/`) is the control: it keeps its `node scripts/…` forms.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const PACK = join(dirname(fileURLToPath(import.meta.url)), '..');
const BOARD = join(PACK, 'tests', 'fixtures', 'board', 'tasks', 'sample.md');
const made = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

const git = (cwd, ...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8' });

function project(kitAt = 'node_modules/builder-pipeline') {
  const proj = mkdtempSync(join(tmpdir(), 'kit-pkg-'));
  made.push(proj);
  const kit = join(proj, ...kitAt.split('/'));
  mkdirSync(kit, { recursive: true });
  cpSync(PACK, kit, { recursive: true, filter: (src) => !/[\\/](?:\.git|tests|node_modules)(?:[\\/]|$)/.test(`/${relative(PACK, src)}`) });
  return { proj, kit, cli: join(kit, 'cli.js') };
}
const run = (cli, cwd, args, env = {}) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
const out = (r) => `${r.stdout}${r.stderr}`;

/** Every file under a folder (posix, relative to `root`), skipping the kit itself. */
function files(root, from = root) {
  const acc = [];
  if (!existsSync(from)) return acc;
  for (const e of readdirSync(from, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'builder' || e.name === '.git') continue;
    const p = join(from, e.name);
    if (e.isDirectory()) acc.push(...files(root, p));
    else acc.push(relative(root, p).split('\\').join('/'));
  }
  return acc;
}

describe('D7 — the docs the install points at are install-neutral', () => {
  test('red: DISCOVERY.md, SETUP_PROMPT.md and USAGE.md name no node builder/cli.js and no node scripts/', () => {
    // + the persona library, which persona-detect copies into personas/ by hand (no install-time rewrite)
    for (const f of ['DISCOVERY.md', 'SETUP_PROMPT.md', 'USAGE.md', ...['INDEX', 'USAGE', 'WHY', '_TEMPLATE', '_census'].map((n) => `templates/personas/${n}.md`)]) {
      const text = readFileSync(join(PACK, f), 'utf8');
      assert.doesNotMatch(text, /node builder\/cli\.js/, f);
      assert.doesNotMatch(text, /node scripts\//, f);
      assert.doesNotMatch(text, /(?<![\w@/.-])builder\/(?:examples|tooling|DISCOVERY|CHANGELOG|templates)\b/, `${f} cites a builder/ folder the package layout does not have`);
    }
  });
});

describe('D8 — installed files name paths that exist in the package layout', () => {
  const { proj, cli } = project();
  const u = run(cli, proj, ['unpack', '--tool', 'claude-code,codex,antigravity']);

  test('red: no installed Markdown names a scripts/ file, a node builder/cli.js, or a bare skills/ path', () => {
    assert.equal(u.status, 0, out(u));
    const bad = [];
    for (const f of files(proj).filter((x) => x.endsWith('.md'))) {
      const text = readFileSync(join(proj, f), 'utf8');
      for (const m of text.matchAll(/node builder\/cli\.js|(?<![\w@/.-])scripts\/[\w./-]+\.(?:mjs|cjs)|(?<![\w@/.-])skills\/(?:references\/[\w.-]+|[\w-]+\.md)/g)) bad.push(`${f}: ${m[0]}`);
    }
    assert.deepEqual(bad, []);
  });

  test('red: builder-init names where the profile template and persona-detect are', () => {
    const skill = readFileSync(join(proj, '.claude', 'skills', 'builder-init', 'SKILL.md'), 'utf8');
    assert.match(skill, /node_modules\/builder-pipeline\/PIPELINE_PROFILE\.template\.md/);
    assert.doesNotMatch(skill, /`skills\/persona-detect\.md`/);
  });

  test('red: upgrade next steps and verify labels name the package, not builder/', () => {
    const up = run(cli, proj, ['upgrade', '--tool', 'claude-code', '--dry-run']);
    assert.equal(up.status, 0, out(up));
    assert.doesNotMatch(up.stdout, /against builder\//);
    assert.doesNotMatch(up.stdout, /(?<![\w@/.-])builder\//);
    const v = run(cli, proj, ['verify']);
    assert.doesNotMatch(v.stdout, /\(scripts\/board-/);
    assert.match(v.stdout, /board scripts installed \(node_modules\/builder-pipeline\/scripts\//);
  });

  test('control: the folder layout keeps its node scripts/ forms in the installed board rules', () => {
    const c = project('builder');
    assert.equal(run(c.cli, c.proj, ['unpack', '--tool', 'claude-code']).status, 0);
    assert.match(readFileSync(join(c.proj, 'tasks', 'README.md'), 'utf8'), /node scripts\/board-check-all\.mjs/);
  });
});
