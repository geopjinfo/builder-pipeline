/**
 * The two sample-project runs (a greenfield and a brownfield repo set up end to end by hand, reported in the kit's
 * sample-run reports) as one automated test. Each sample is built under the OS temp dir; the kit is copied in as
 * `node_modules/builder-pipeline` — the package layout, with no network and no npm install — and the
 * setup runs exactly as the setup prompt drives it:
 *
 *   bootstrap → inventory --json → choices → unpack --tool claude-code,codex,antigravity → verify → doctor
 *
 * then a re-run (a no-op), and an upgrade to a changed kit that keeps a hand edit. Asserted on both samples:
 * the mode, the project's own files byte for byte (the pointer files may only gain the one marked span), a valid
 * builder.lock.json and builder.choices.json, the no-op re-run, and the kept hand edit.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const PACK = join(dirname(fileURLToPath(import.meta.url)), '..');
const KIT_AT = ['node_modules', 'builder-pipeline'];
const TOOLS = 'claude-code,codex,antigravity';
const MARKER = '<!-- builder-kit:pipeline -->';
const MARKER_END = '<!-- /builder-kit:pipeline -->';
const made = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

/** A fresh sample with the kit installed as a package; `files` are the project's own, written before any kit step. */
function sample(name, files) {
  const proj = mkdtempSync(join(tmpdir(), `kit-sample-${name}-`));
  made.push(proj);
  const kit = join(proj, ...KIT_AT);
  mkdirSync(kit, { recursive: true });
  cpSync(PACK, kit, { recursive: true, filter: (src) => !/[\\/](?:\.git|\.github|tests|node_modules)(?:[\\/]|$)/.test(`/${relative(PACK, src)}`) });
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(proj, rel)), { recursive: true });
    writeFileSync(join(proj, rel), text);
  }
  const cli = join(kit, 'cli.js');
  const run = (...args) => {
    const r = spawnSync(process.execPath, [cli, ...args], { cwd: proj, encoding: 'utf8', timeout: 60_000 });
    return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, stdout: r.stdout ?? '' };
  };
  const ok = (...args) => {
    const r = run(...args);
    assert.equal(r.status, 0, `${args.join(' ')} exited ${r.status}:\n${r.out}`);
    return r;
  };
  return { proj, kit, run, ok, read: (rel) => readFileSync(join(proj, rel), 'utf8') };
}

const sha = (text) => createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');
/** Every file under the project except the installed kit itself: relative path → bytes as text. */
function snapshot(proj) {
  const out = {};
  const walk = (dir) => {
    for (const e of readdirSync(join(proj, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (rel === 'node_modules') continue;
      if (e.isDirectory()) walk(rel);
      else out[rel] = readFileSync(join(proj, rel), 'utf8');
    }
  };
  walk('');
  return out;
}

/** A pointer file: the original text, then exactly one marked span and nothing else outside it. */
function assertPointerOnly(before, after, file) {
  assert.ok(after.startsWith(before), `${file}: the project's text is no longer an exact prefix`);
  const added = after.slice(before.length);
  assert.equal(added.split(MARKER).length - 1, 1, `${file}: one opening marker`);
  assert.equal(added.split(MARKER_END).length - 1, 1, `${file}: one closing marker`);
  const outside = added.slice(0, added.indexOf(MARKER)) + added.slice(added.indexOf(MARKER_END) + MARKER_END.length);
  assert.equal(outside.trim(), '', `${file}: only whitespace outside the marked span, got ${JSON.stringify(outside)}`);
}

function assertLock(s, projectFiles) {
  const lock = JSON.parse(s.read('builder.lock.json'));
  const version = JSON.parse(readFileSync(join(s.kit, 'package.json'), 'utf8')).version;
  assert.equal(lock.kit, version);
  assert.equal(lock.bootstrap, undefined, 'after unpack the lock is a full install, not a bootstrap lock');
  const keys = Object.keys(lock.files);
  assert.ok(keys.length > 50, `the lock records the install (${keys.length} files)`);
  for (const k of keys) {
    assert.ok(existsSync(join(s.proj, k)), `lock names ${k}, which is not on disk`);
    assert.equal(lock.files[k], sha(s.read(k)), `${k}: lock sha differs from the file the kit wrote`);
    assert.ok(!projectFiles.includes(k), `the lock claims the project's own ${k}`);
  }
  return lock;
}

/** One sample end to end. `decide` records the sample's choices between inventory and unpack. */
function setup(s, { mode, decide = () => {} }) {
  const before = snapshot(s.proj);
  const own = Object.keys(before);

  const boot = s.ok('bootstrap');
  assert.match(boot.out, /detected: /);
  const inv = JSON.parse(s.ok('inventory', '--json').stdout);
  assert.equal(inv.mode.mode, mode, JSON.stringify(inv.mode.evidence));
  decide(inv);

  s.ok('unpack', '--tool', TOOLS);
  for (const p of ['.claude/agents/module-planner.md', '.codex/agents/module-planner.toml', '.agents/agents/module-planner.md', '.agents/skills/build-module-pipeline/SKILL.md', '.claude/skills/build-module-pipeline/SKILL.md']) {
    assert.ok(existsSync(join(s.proj, p)), `installed: ${p}`);
  }
  assert.ok(!existsSync(join(s.proj, 'scripts', 'board-progress.mjs')), 'a package install copies no scripts into the project');

  // verify: every install check passes; the only failures left are the profile the human has not filled yet
  const v = s.run('verify');
  const lines = v.out.split(/\r?\n/);
  const install = lines.slice(lines.findIndex((l) => /^Install:/.test(l)), lines.findIndex((l) => /^Profile:/.test(l)));
  assert.ok(install.length > 5, v.out);
  assert.deepEqual(install.filter((l) => /^\s+FAIL/.test(l)), [], 'install checks');
  assert.match(v.out, /PASS\s+pipeline seats are the kit's \(claude-code, codex, antigravity\)/);
  assert.match(v.out, /PASS\s+pointer block wired/);
  assert.match(v.out, /FAIL\s+no template placeholders left/, 'negative control: an unfilled profile is not passed');

  const doc = s.ok('doctor', '--tool', TOOLS);
  for (const t of ['claude-code', 'codex', 'antigravity']) assert.match(doc.out, new RegExp(t));

  // the project's own files: byte for byte, except the pointer files, which only gain the marked span
  const now = snapshot(s.proj);
  for (const rel of own) {
    if (rel === 'package.json') {
      const was = JSON.parse(before[rel]);
      const is = JSON.parse(now[rel]);
      for (const k of Object.keys(was).filter((k) => k !== 'devDependencies')) assert.deepEqual(is[k], was[k], `package.json ${k}`);
    } else if (rel === 'CLAUDE.md' || rel === 'AGENTS.md' || rel === '.gitignore') {
      if (rel === '.gitignore') assert.ok(now[rel].startsWith(before[rel]), '.gitignore only gains lines');
      else assertPointerOnly(before[rel], now[rel], rel);
    } else {
      assert.equal(now[rel], before[rel], `project file changed: ${rel}`);
    }
  }
  for (const f of ['CLAUDE.md', 'AGENTS.md']) assertPointerOnly(before[f] ?? '', now[f], f);
  assert.match(now['.gitignore'], /^\.pipeline\/$/m);

  assertLock(s, own);
  const choices = JSON.parse(s.read('builder.choices.json'));
  assert.equal(choices.version, 1);
  assert.match(s.ok('choices', 'check').out, /valid, \d+ choice\(s\)/);

  // a re-run is a no-op: nothing installed, nothing written
  s.ok('bootstrap');
  const again = s.ok('unpack', '--tool', TOOLS);
  assert.doesNotMatch(again.out, /^(installed|wrote|appended|updated):/m, again.out);
  assert.deepEqual(snapshot(s.proj), now, 'the re-run changed a file');
  assert.match(s.ok('upgrade', '--tool', TOOLS, '--dry-run').out, /Would be: 0 updated, 0 added, \d+ unchanged/);

  // upgrade to a changed kit keeps a hand edit to a kit-owned file and takes the kit's change elsewhere
  const edited = '.claude/agents/module-reviewer.md';
  writeFileSync(join(s.proj, edited), `${s.read(edited)}\nLocal rule: this project's reviewer also reads the changelog.\n`);
  const tester = join(s.kit, 'agents', 'module-tester.md');
  writeFileSync(tester, `${readFileSync(tester, 'utf8')}\nUpstream line from the next kit release.\n`);
  const pkg = join(s.kit, 'package.json');
  writeFileSync(pkg, JSON.stringify({ ...JSON.parse(readFileSync(pkg, 'utf8')), version: '99.0.0-test' }, null, 2));
  const up = s.ok('upgrade', '--tool', TOOLS);
  assert.match(up.out, /kept \(local edit\)/);
  assert.match(s.read(edited), /Local rule: this project's reviewer also reads the changelog\./);
  assert.match(s.read('.claude/agents/module-tester.md'), /Upstream line from the next kit release\./);
  assert.equal(JSON.parse(s.read('builder.lock.json')).kit, '99.0.0-test');
  for (const rel of own.filter((r) => !['package.json', 'CLAUDE.md', 'AGENTS.md', '.gitignore'].includes(r))) {
    assert.equal(s.read(rel), before[rel], `the upgrade changed the project's ${rel}`);
  }
}

/** What `npm init -y` writes. */
const NPM_INIT = { name: 'sample', version: '1.0.0', description: '', main: 'index.js', scripts: { test: 'echo "Error: no test specified" && exit 1' }, keywords: [], author: '', license: 'ISC' };

describe('sample projects, end to end in the package layout', () => {
  test('greenfield: an empty npm init repo', () => {
    const s = sample('greenfield', { 'package.json': `${JSON.stringify(NPM_INIT, null, 2)}\n` });
    setup(s, {
      mode: 'greenfield',
      decide: (inv) => {
        assert.deepEqual(inv.items, [], 'nothing of the project\'s own to review');
        assert.deepEqual(inv.clashes, []);
      },
    });
    assert.deepEqual(JSON.parse(s.read('builder.choices.json')).items, {}, 'nothing to decide still leaves the record');
  });

  test('brownfield: a small service with its own instruction files, code-review skill, adr skill and reviewer agent', () => {
    const own = {
      'package.json': `${JSON.stringify({ name: 'todo-api', version: '0.3.1', main: 'src/index.js', scripts: { test: 'node --test' }, dependencies: { express: '^4.19.0' } }, null, 2)}\n`,
      'src/index.js': "const { list } = require('./todos');\nmodule.exports = { list };\n",
      'src/todos.js': 'const todos = [];\nexports.list = () => todos.slice();\n',
      'test/todos.test.js': "const t = require('node:test');\nt.test('list', () => {});\n",
      'CLAUDE.md': '# todo-api\n\nRun `npm test` before every commit.\n',
      'AGENTS.md': '# todo-api agents\n\nKeep handlers small.\n',
      '.gitignore': 'node_modules/\n',
      '.claude/skills/code-review/SKILL.md': '---\nname: code-review\ndescription: How this team reviews a pull request.\n---\n\nRead the diff twice.\n',
      '.claude/skills/adr/SKILL.md': '---\nname: adr\ndescription: This team\'s decision records.\n---\n\nOne page, three headings.\n',
      '.claude/agents/reviewer.md': '---\nname: reviewer\ndescription: The team\'s own pull-request reviewer.\n---\n\nYou review pull requests for todo-api.\n',
    };
    const s = sample('brownfield', own);
    setup(s, {
      mode: 'brownfield',
      decide: (inv) => {
        const items = inv.items.map((i) => `${i.kind}:${i.name}`);
        for (const it of ['skill:code-review', 'skill:adr', 'agent:reviewer']) assert.ok(items.includes(it), `inventory lists the project's ${it}: ${items}`);
        assert.deepEqual(inv.clashes, ['skill:adr'], 'the one same-name clash');
        // code-review is the project's alone: there is no kit item of that name, so there is nothing to decide —
        // the kit refuses to record a choice for it and installs nothing over it.
        const none = s.run('choices', 'set', 'skill:code-review', 'keep', '--by', 'sample');
        assert.equal(none.status, 1, none.out);
        assert.match(none.out, /names no kit item/);
        // the real clash: keep the project's adr
        s.ok('choices', 'set', 'skill:adr', 'keep', '--by', 'sample');
      },
    });
    const choices = JSON.parse(s.read('builder.choices.json'));
    assert.deepEqual(Object.keys(choices.items), ['skill:adr']);
    assert.equal(choices.items['skill:adr'].decision, 'keep');
    assert.equal(s.read('.claude/skills/adr/SKILL.md'), own['.claude/skills/adr/SKILL.md']);
    assert.equal(s.read('.claude/skills/code-review/SKILL.md'), own['.claude/skills/code-review/SKILL.md']);
    assert.ok(!existsSync(join(s.proj, '.claude', 'skills', 'builder-adr')), 'keep installs no renamed copy');
  });
});
