/**
 * `upgrade` — bringing an install from an older kit release level with this one.
 *
 * WHY. `unpack` is copy-if-absent: re-run over an older install it adds the new files and keeps every CHANGED old
 * persona, skill and script, so new tooling ends up driven by old prose and nothing says so. `upgrade` walks the
 * same mapping and overwrites what the kit owns, after a backup, while the files the project owns — the profile,
 * the ledgers, the user's own text around the pointer block — stay byte-for-byte. Each test here drives the CLI in
 * a throwaway repo, the way an adopter would.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const PACK = join(dirname(fileURLToPath(import.meta.url)), '..');
const MARKER = '<!-- builder-kit:pipeline -->';
const MARKER_END = '<!-- /builder-kit:pipeline -->';

function copyPack(into) {
  cpSync(PACK, join(into, 'builder'), { recursive: true, filter: (src) => !/[\\/](?:\.git|node_modules)(?:[\\/]|$)/.test(src) });
}

function run(cwd, args) {
  const r = spawnSync(process.execPath, ['builder/cli.js', ...args], { cwd, encoding: 'utf8', env: { ...process.env, BUILDER_NO_BASH_CAP: '1' } });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const read = (root, rel) => readFileSync(join(root, rel), 'utf8');

/** Every file outside builder/, as rel path → content: the whole repo state an upgrade could have touched. */
function snapshot(root) {
  const out = {};
  const walk = (abs) => {
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const a = join(abs, e.name);
      const rel = relative(root, a).split('\\').join('/');
      if (rel === 'builder') continue;
      if (e.isDirectory()) walk(a);
      else out[rel] = readFileSync(a, 'utf8');
    }
  };
  walk(root);
  return out;
}

/** The block a pre-0.14.0 kit wrote: no end marker, an older Ledgers bullet. */
function legacyBlock(current) {
  const start = current.indexOf(MARKER);
  const end = current.indexOf(MARKER_END);
  return current
    .slice(start, end)
    .replace(/\n$/, '')
    .replace(/- \*\*Ledgers:\*\*[\s\S]*?(?=\n- \*\*Utility)/, '- **Ledgers:** task boards in `tasks/`, deferred work in `DEFERRED_TASKS.md`, run artifacts in\n  `.pipeline/` (gitignored). The pipeline never merges — it hands MERGE-READY to a human.');
}

const USER_BEFORE = '# My project\n\nOur own rules, written by people.\n\n';
const USER_AFTER = '\n\n## Our release checklist\n\nKeep this text exactly as it is.\n';
const LEDGER_ROW = '| D-77 | a filled row the project wrote | T3 | DEFERRED | waiting on the vendor |\n';

describe('upgrade — an older install brought level with the pack', () => {
  let root;
  let fresh; // what this pack installs, captured before the install is aged
  let aged; // the install as an older release left it

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'builder-upgrade-'));
    copyPack(root);
    const r = run(root, ['unpack', '--tool', 'claude-code', '--no-extras']);
    assert.equal(r.status, 0, r.out);
    fresh = snapshot(root);

    // Age the install: two kit files from an "older release", one kit file the older release did not ship.
    writeFileSync(join(root, '.claude/agents/module-planner.md'), '---\nname: module-planner\n---\nold planner prose\n');
    writeFileSync(join(root, 'scripts/features.mjs'), '// old features script\n');
    unlinkSync(join(root, 'scripts/worktree-sweep.mjs'));
    // The project's own files, filled in since.
    writeFileSync(join(root, 'PIPELINE_PROFILE.md'), `${read(root, 'PIPELINE_PROFILE.md')}\n<!-- our own edit -->\n`);
    writeFileSync(join(root, 'DEFERRED_TASKS.md'), read(root, 'DEFERRED_TASKS.md') + LEDGER_ROW);
    writeFileSync(join(root, 'tasks/README.md'), `${read(root, 'tasks/README.md')}\nA local board rule.\n`);
    // The instruction file: the user's text around an old-shape pointer block.
    writeFileSync(join(root, 'CLAUDE.md'), USER_BEFORE + legacyBlock(fresh['CLAUDE.md']) + USER_AFTER);
    aged = snapshot(root);
  });

  after(() => rmSync(root, { recursive: true, force: true }));

  test('--dry-run writes nothing, and says what it would do', () => {
    const r = run(root, ['upgrade', '--tool', 'claude-code', '--no-extras', '--dry-run']);
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(snapshot(root), aged, 'a dry run changed the repo');
    assert.match(r.out, /would be updated:\s+\.claude[\\/]agents[\\/]module-planner\.md/);
    assert.match(r.out, /would be added:\s+scripts[\\/]worktree-sweep\.mjs/);
    assert.match(r.out, /Dry run — nothing written/);
    assert.ok(!existsSync(join(root, '.builder')), 'a dry run created the backup directory');
  });

  test('upgrade overwrites the differing kit files, adds the missing one and leaves the rest unchanged', () => {
    const r = run(root, ['upgrade', '--tool', 'claude-code', '--no-extras']);
    assert.equal(r.status, 0, r.out);
    assert.equal(read(root, '.claude/agents/module-planner.md'), fresh['.claude/agents/module-planner.md']);
    assert.equal(read(root, 'scripts/features.mjs'), fresh['scripts/features.mjs']);
    assert.equal(read(root, 'scripts/worktree-sweep.mjs'), fresh['scripts/worktree-sweep.mjs']);
    assert.match(r.out, /^updated:\s+\.claude[\\/]agents[\\/]module-planner\.md/m);
    assert.match(r.out, /^added:\s+scripts[\\/]worktree-sweep\.mjs/m);
    assert.match(r.out, /^unchanged:\s+\.claude[\\/]agents[\\/]module-coder\.md|^unchanged:\s+scripts[\\/]board-progress\.mjs/m);
    assert.match(r.out, /Upgraded: 3 updated, 1 added, \d+ unchanged, \d+ kept-project-owned\./);
    assert.match(r.out, /node builder\/cli\.js verify/);
    assert.match(r.out, /node builder\/cli\.js features/);
  });

  test('every overwritten file was backed up first, at its own path, with its old content', () => {
    const dirs = readdirSync(join(root, '.builder')).filter((d) => /^backup-\d{8}T\d{6}Z$/.test(d));
    assert.equal(dirs.length, 1, `backup dirs: ${dirs}`);
    const b = join('.builder', dirs[0]);
    assert.equal(read(root, join(b, '.claude/agents/module-planner.md')), aged['.claude/agents/module-planner.md']);
    assert.equal(read(root, join(b, 'scripts/features.mjs')), aged['scripts/features.mjs']);
    assert.equal(read(root, join(b, 'CLAUDE.md')), aged['CLAUDE.md']);
    assert.ok(!existsSync(join(root, b, 'scripts/board-progress.mjs')), 'an unchanged file was backed up');
    assert.ok(!existsSync(join(root, b, 'PIPELINE_PROFILE.md')), 'a project-owned file was backed up — it was never to be touched');
  });

  test('project-owned files are byte-identical: the profile, the registry with its filled row, the board rules', () => {
    for (const rel of ['PIPELINE_PROFILE.md', 'DEFERRED_TASKS.md', 'DECISIONS.md', 'tasks/README.md', 'tasks/_session-board.template.md', 'specs/module-brief.template.md', '.gitignore']) {
      assert.equal(read(root, rel), aged[rel], `${rel} was changed`);
    }
    assert.ok(read(root, 'DEFERRED_TASKS.md').includes(LEDGER_ROW));
  });

  test('the pointer block is re-wired between its markers and the user text around it is untouched', () => {
    const now = read(root, 'CLAUDE.md');
    assert.ok(now.startsWith(USER_BEFORE), 'text before the block changed');
    assert.ok(now.endsWith(USER_AFTER), 'text after the block changed');
    const block = fresh['CLAUDE.md'].slice(fresh['CLAUDE.md'].indexOf(MARKER), fresh['CLAUDE.md'].indexOf(MARKER_END) + MARKER_END.length);
    assert.equal(now, USER_BEFORE + block + USER_AFTER);
    assert.equal(now.split(MARKER).length, 2, 'the block was duplicated');
  });

  test('a second upgrade finds nothing to do', () => {
    const before = snapshot(root);
    const r = run(root, ['upgrade', '--tool', 'claude-code', '--no-extras']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /Upgraded: 0 updated, 0 added, /);
    assert.match(r.out, /^unchanged:\s+CLAUDE\.md\s+\(pointer block\)/m);
    assert.deepEqual(snapshot(root), before);
  });
});

describe('upgrade — the edges', () => {
  test('red: a marker followed by a shape the kit never wrote is left alone and named, not guessed at', () => {
    const root = mkdtempSync(join(tmpdir(), 'builder-upgrade-odd-'));
    try {
      copyPack(root);
      assert.equal(run(root, ['unpack', '--tool', 'claude-code', '--no-extras']).status, 0);
      const odd = `# Ours\n\n${MARKER}\nsomeone rewrote this by hand\n\n## Ours again\n`;
      writeFileSync(join(root, 'CLAUDE.md'), odd);
      const r = run(root, ['upgrade', '--tool', 'claude-code', '--no-extras']);
      assert.equal(r.status, 0, r.out);
      assert.equal(read(root, 'CLAUDE.md'), odd);
      assert.match(r.out, /kept \(by hand\):\s+CLAUDE\.md/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('red: a repo with no install is refused — upgrade is not a silent unpack', () => {
    const root = mkdtempSync(join(tmpdir(), 'builder-upgrade-none-'));
    try {
      copyPack(root);
      const r = run(root, ['upgrade', '--tool', 'claude-code']);
      assert.notEqual(r.status, 0);
      assert.match(r.out, /nothing to upgrade here/);
      assert.deepEqual(Object.keys(snapshot(root)), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a moved ledger (§16 paths) is honoured: upgrade adds no twin at the default path', () => {
    const root = mkdtempSync(join(tmpdir(), 'builder-upgrade-paths-'));
    try {
      copyPack(root);
      writeFileSync(join(root, 'PIPELINE_PROFILE.md'), readFileSync(join(PACK, 'tests/fixtures/profile/python-service.PIPELINE_PROFILE.md'), 'utf8'));
      assert.equal(run(root, ['unpack', '--tool', 'codex', '--no-extras']).status, 0);
      const before = snapshot(root);
      const r = run(root, ['upgrade', '--tool', 'codex', '--no-extras']);
      assert.equal(r.status, 0, r.out);
      assert.match(r.out, /Upgraded: 0 updated, 0 added, /);
      assert.deepEqual(snapshot(root), before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
