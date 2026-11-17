/**
 * The install lifecycle after the first unpack: upgrade over a release that removed files (I1), a folder->package
 * move (I2), install flags remembered in builder.lock.json (I3), a shared pointer that speaks for every installed
 * tool (I4), a "both" choice moved to "kit" (I5), `uninstall` (I6) and the pointer keeping its file's line endings
 * (I8). The kit runs as a package: <proj>/node_modules/builder-pipeline.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const PACK = join(dirname(fileURLToPath(import.meta.url)), '..');
const made = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

/** The instruction file each tool's pointer lives in, read from the TOOLS table in cli.js (never spelled here). */
const CLI_SRC = readFileSync(join(PACK, 'cli.js'), 'utf8');
const pointerOf = (tool) => new RegExp(`['"]?${tool}['"]?:\\s*\\{[^}]*pointer: '([^']+)'`).exec(CLI_SRC)[1];
const CC_POINTER = pointerOf('claude-code');
const SHARED_POINTER = pointerOf('codex');
const MARKER = '<!-- builder-kit:pipeline -->';

const copyKit = (to) => cpSync(PACK, to, { recursive: true, filter: (src) => !/[\\/](?:\.git|tests|node_modules|logs)(?:[\\/]|$)/.test(`/${relative(PACK, src)}`) });

function project() {
  const proj = mkdtempSync(join(tmpdir(), 'kit-life-'));
  made.push(proj);
  const kit = join(proj, 'node_modules', 'builder-pipeline');
  mkdirSync(kit, { recursive: true });
  copyKit(kit);
  return { proj, kit, cli: join(kit, 'cli.js') };
}
function run(p, args, cli = p.cli) {
  const r = spawnSync(process.execPath, [cli, ...args], { cwd: p.proj, encoding: 'utf8', env: { ...process.env, BUILDER_NO_BASH_CAP: '1' } });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}
const ok = (r) => { assert.equal(r.status, 0, r.out); return r.out; };
const lock = (p) => JSON.parse(readFileSync(join(p.proj, 'builder.lock.json'), 'utf8'));
const has = (p, rel) => existsSync(join(p.proj, ...rel.split('/')));
const read = (p, rel) => readFileSync(join(p.proj, ...rel.split('/')), 'utf8');
const backups = (p) => (existsSync(join(p.proj, '.builder')) ? readdirSync(join(p.proj, '.builder')).filter((d) => d.startsWith('backup-')) : []);
const inBackup = (p, rel) => backups(p).some((d) => existsSync(join(p.proj, '.builder', d, ...rel.split('/'))));

describe('I1 — upgrade over a release that removed a file', () => {
  test('red: a lock-matched leftover is reported stale; --prune backs it up, deletes it and drops it from the lock', () => {
    const p = project();
    ok(run(p, ['unpack', '--tool', 'claude-code']));
    const gone = '.claude/agents/docs-maintainer.md';
    assert.ok(lock(p).files[gone]);
    unlinkSync(join(p.kit, 'agents', 'docs-maintainer.md')); // the next release retired this persona
    const up = ok(run(p, ['upgrade', '--tool', 'claude-code']));
    assert.match(up, /stale \(removed from the kit\):\s+\.claude\/agents\/docs-maintainer\.md/);
    assert.ok(has(p, gone), 'reported, not deleted, without --prune');
    assert.ok(lock(p).files[gone], 'still locked until pruned');
    const pruned = ok(run(p, ['upgrade', '--tool', 'claude-code', '--prune']));
    assert.match(pruned, /pruned:\s+\.claude\/agents\/docs-maintainer\.md/);
    assert.ok(!has(p, gone));
    assert.ok(inBackup(p, gone), 'backed up first');
    assert.equal(lock(p).files[gone], undefined);
  });

  test('red: a leftover edited since the kit wrote it is kept and named, even with --prune', () => {
    const p = project();
    ok(run(p, ['unpack', '--tool', 'claude-code']));
    const gone = '.claude/agents/docs-maintainer.md';
    writeFileSync(join(p.proj, ...gone.split('/')), `${read(p, gone)}\nour own note\n`);
    unlinkSync(join(p.kit, 'agents', 'docs-maintainer.md'));
    const up = ok(run(p, ['upgrade', '--tool', 'claude-code', '--prune']));
    assert.match(up, /kept \(local edit\):\s+\.claude\/agents\/docs-maintainer\.md.*removed from the kit/);
    assert.ok(has(p, gone));
  });
});

describe('I2 — folder layout -> package', () => {
  test('red: kit-locked scripts/** copies are reported stale after the move, and --prune removes them', () => {
    const p = project();
    copyKit(join(p.proj, 'builder'));
    ok(run(p, ['unpack', '--tool', 'claude-code'], join(p.proj, 'builder', 'cli.js')));
    assert.ok(lock(p).files['scripts/lib/profile.cjs'], 'the folder layout locks its scripts/ copies');
    rmSync(join(p.proj, 'builder'), { recursive: true, force: true });
    const up = ok(run(p, ['upgrade', '--tool', 'claude-code']));
    assert.match(up, /stale \(removed from the kit\):\s+scripts\/lib\/profile\.cjs/);
    assert.ok(has(p, '.claude/hooks/kit/lib/profile.cjs'), 'the package vendors the hook scripts');
    ok(run(p, ['upgrade', '--tool', 'claude-code', '--prune']));
    assert.ok(!has(p, 'scripts/lib/profile.cjs'));
    assert.equal(Object.keys(lock(p).files).filter((k) => k.startsWith('scripts/')).length, 0);
  });
});

describe('I3 — upgrade remembers the install flags', () => {
  test('red: tools, models and --no-extras are stored in the lock and are the upgrade defaults', () => {
    const p = project();
    ok(run(p, ['unpack', '--tool', 'claude-code', '--no-extras', '--models', 'strong=haiku']));
    const install = lock(p).install;
    assert.deepEqual(install.tools, ['claude-code']);
    assert.equal(install.noExtras, true);
    assert.equal(install.experimental, false);
    assert.equal(install.models['claude-code'].strong, 'haiku');
    ok(run(p, ['upgrade'])); // no --tool: the lock has the tools
    assert.match(read(p, '.claude/agents/module-planner.md'), /^model: haiku$/m, 'the --models choice survived');
    assert.ok(!has(p, '.claude/agents/repo-auditor.md'), 'extras stayed out');
    assert.ok(!has(p, '.claude/skills/caveman'), 'extras stayed out');
  });

  test('red: an explicit flag overrides the stored default', () => {
    const p = project();
    ok(run(p, ['unpack', '--tool', 'claude-code', '--models', 'strong=haiku']));
    ok(run(p, ['upgrade', '--models', 'strong=sonnet']));
    assert.match(read(p, '.claude/agents/module-planner.md'), /^model: sonnet$/m);
    assert.equal(lock(p).install.models['claude-code'].strong, 'sonnet');
  });

  test('upgrade with no --tool and no tools in the lock still asks for --tool', () => {
    const p = project();
    ok(run(p, ['unpack', '--tool', 'claude-code']));
    const l = lock(p);
    delete l.install;
    writeFileSync(join(p.proj, 'builder.lock.json'), JSON.stringify(l));
    const r = run(p, ['upgrade']);
    assert.equal(r.status, 1);
    assert.match(r.out, /requires --tool/);
  });
});

describe('I4 + I8 — the shared pointer', () => {
  test('red: a second tool keeps the first tool in the shared pointer (unpack and upgrade)', () => {
    const p = project();
    ok(run(p, ['unpack', '--tool', 'codex']));
    ok(run(p, ['unpack', '--tool', 'antigravity']));
    const text = read(p, SHARED_POINTER);
    assert.match(text, /\.codex\/agents\/` \(Codex\)/);
    assert.match(text, /\.agents\/agents\/` \(Antigravity\)/);
    assert.equal(text.split(MARKER).length, 2, 'one block');
    assert.deepEqual(lock(p).install.tools, ['antigravity', 'codex']);
    ok(run(p, ['upgrade', '--tool', 'antigravity']));
    assert.match(read(p, SHARED_POINTER), /\(Codex\)/, 'upgrade keeps the lock tools too');
  });

  test('red: a pointer appended to a CRLF file is written CRLF, and re-wired CRLF', () => {
    const p = project();
    writeFileSync(join(p.proj, SHARED_POINTER), '# Ours\r\n\r\nOur rules.\r\n');
    ok(run(p, ['unpack', '--tool', 'codex']));
    const lone = (t) => t.replace(/\r\n/g, '').includes('\n');
    assert.ok(!lone(read(p, SHARED_POINTER)), 'no bare LF after unpack');
    ok(run(p, ['unpack', '--tool', 'antigravity']));
    assert.ok(!lone(read(p, SHARED_POINTER)), 'no bare LF after the re-wire');
    assert.match(read(p, SHARED_POINTER), /^# Ours\r\n\r\nOur rules\.\r\n/);
  });
});

describe('I5 — a "both" choice moved to "kit"', () => {
  test('red: the lock-matched builder-<name> copy is backed up, removed and reported', () => {
    const p = project();
    mkdirSync(join(p.proj, '.claude', 'skills', 'scaffold-module'), { recursive: true });
    writeFileSync(join(p.proj, '.claude', 'skills', 'scaffold-module', 'SKILL.md'), '---\nname: scaffold-module\ndescription: ours\n---\nOur scaffold.\n');
    ok(run(p, ['choices', 'set', 'skill:scaffold-module', 'both', '--by', 'tester']));
    ok(run(p, ['unpack', '--tool', 'claude-code']));
    const renamed = '.claude/skills/builder-scaffold-module/SKILL.md';
    assert.ok(has(p, renamed));
    ok(run(p, ['choices', 'set', 'skill:scaffold-module', 'kit', '--by', 'tester']));
    const up = ok(run(p, ['upgrade', '--tool', 'claude-code']));
    assert.match(up, /removed \(choice is no longer both\):\s+\.claude\/skills\/builder-scaffold-module\/SKILL\.md/);
    assert.ok(!has(p, renamed));
    assert.ok(inBackup(p, renamed));
    assert.equal(lock(p).files[renamed], undefined);
  });
});

describe('I6 — uninstall', () => {
  test('red: --tool removes that tool\'s lock-matched files and its pointer; keeps edited and project-owned files', () => {
    const p = project();
    writeFileSync(join(p.proj, SHARED_POINTER), '# Ours\n\nOur rules.\n');
    ok(run(p, ['unpack', '--tool', 'claude-code,codex']));
    const edited = '.codex/agents/module-planner.toml';
    writeFileSync(join(p.proj, ...edited.split('/')), `${read(p, edited)}\n# our tweak\n`);
    const dry = ok(run(p, ['uninstall', '--tool', 'codex', '--dry-run']));
    assert.match(dry, /would remove:\s+\.codex\/agents\/module-tester\.toml/);
    assert.ok(has(p, '.codex/agents/module-tester.toml'), 'dry run writes nothing');
    const r = ok(run(p, ['uninstall', '--tool', 'codex']));
    assert.ok(!has(p, '.codex/agents/module-tester.toml'));
    assert.ok(!has(p, '.agents/skills/build-module-pipeline/SKILL.md'));
    assert.ok(has(p, edited), 'a locally edited file is kept');
    assert.match(r, /kept \(local edit\):\s+\.codex\/agents\/module-planner\.toml/);
    assert.equal(read(p, SHARED_POINTER).includes(MARKER), false, 'pointer span stripped');
    assert.match(read(p, SHARED_POINTER), /^# Ours\n\nOur rules\.\n$/);
    assert.ok(has(p, '.claude/agents/module-planner.md'), 'the other tool stays');
    assert.ok(has(p, 'PIPELINE_PROFILE.md'), 'project-owned stays');
    const l = lock(p);
    assert.deepEqual(l.install.tools, ['claude-code']);
    assert.equal(Object.keys(l.files).filter((k) => k.startsWith('.codex/') || k.startsWith('.agents/')).length, 0);
  });

  test('red: --all removes every lock-matched kit file, the vendored hook scripts and the pointer', () => {
    const p = project();
    ok(run(p, ['unpack', '--tool', 'claude-code']));
    ok(run(p, ['uninstall', '--all']));
    assert.ok(!has(p, '.claude/agents/module-planner.md'));
    assert.ok(!has(p, '.claude/hooks/kit'));
    assert.ok(!has(p, '.claude/skills/build-module-pipeline'));
    assert.ok(!has(p, CC_POINTER) || !read(p, CC_POINTER).includes(MARKER));
    assert.ok(has(p, 'PIPELINE_PROFILE.md'));
    assert.ok(!has(p, 'builder.lock.json'), 'nothing left to lock');
  });

  test('uninstall with neither --tool nor --all is refused', () => {
    const p = project();
    ok(run(p, ['unpack', '--tool', 'claude-code']));
    const r = run(p, ['uninstall']);
    assert.equal(r.status, 1);
    assert.match(r.out, /--tool <list> or --all/);
  });
});
