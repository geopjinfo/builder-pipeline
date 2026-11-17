/**
 * `builder accounts migrate` (REQ-103, REQ-104, REQ-106, REQ-311; D33).
 *
 * WHY. The 1.0 seat keys are refused while the orchestrator is on and warned about while it is off, so every 1.0
 * project needs one mechanical step that keeps its placement decisions, touches nothing but the settings block, and can
 * run twice. A live run must stop it: the running orchestrator read the old keys.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const PACK = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { migrateText, liveRuns } = require(join(PACK, 'cli/accounts.cjs'));
const profile = require(join(PACK, 'scripts/lib/profile.cjs'));
const made = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

const LEGACY = {
  schema: 2,
  commands: { tier: null, tiers: [], affected: null, typecheck: null },
  models: { strong: 'strong-model', mid: 'mid-model', orchestrator: null },
  features: {
    orchestrator: {
      state: 'off', target: 'dev', seats: ['secondary', 'primary'], limits: { secondary: 70, primary: 50 },
      secondaryConfigDir: '/home/me/.claude-second', launchCommand: 'worker --brief {brief}',
      credit: { enabled: true, dailyCapUsd: 12 },
    },
  },
};
const HEAD = '# Profile\n\nSome prose that must stay, byte for byte.\n\n## 16. Settings\n\n';
const TAIL = '\n\nTrailing prose with a `code span` and  two spaces.\n';
const text = (block) => `${HEAD}\`\`\`json pipeline-settings\n${JSON.stringify(block, null, 2)}\n\`\`\`${TAIL}`;

function project(block = LEGACY) {
  const proj = mkdtempSync(join(tmpdir(), 'kit-accounts-'));
  made.push(proj);
  writeFileSync(join(proj, 'PIPELINE_PROFILE.md'), text(block));
  return proj;
}
const run = (cwd, args, env = {}) => {
  const r = spawnSync(process.execPath, [join(PACK, 'cli.js'), 'accounts', ...args], { cwd, encoding: 'utf8', env: { ...process.env, BUILDER_NO_BASH_CAP: '1', BUILDER_ORCH_DIR: join(cwd, '.pipeline', 'orchestrator'), ...env } });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};

describe('migrateText', () => {
  test('red: rewrites only the settings block; the bytes around it stay; the result validates and is idempotent', () => {
    const r = migrateText(text(LEGACY));
    assert.equal(r.changed, true);
    assert.ok(r.text.startsWith(HEAD + '```json pipeline-settings\n'), 'head kept');
    assert.ok(r.text.endsWith('```' + TAIL), 'tail kept');
    const parsed = profile.parse(r.text);
    assert.deepEqual(parsed.errors, []);
    assert.deepEqual(parsed.warnings, []);
    const a = parsed.settings.features.accounts;
    assert.equal(a.state, 'on');
    assert.deepEqual(Object.keys(a.accounts).sort(), ['credit', 'primary', 'secondary']);
    assert.equal(a.accounts.secondary.configDir, '/home/me/.claude-second');
    assert.equal(a.accounts.credit.budget.hard, 12);
    for (const k of ['seats', 'limits', 'secondaryConfigDir', 'credit']) assert.equal(k in parsed.settings.features.orchestrator, false, k);
    const again = migrateText(r.text);
    assert.equal(again.changed, false);
    assert.equal(again.text, r.text);
  });

  test('a profile without the block, with two blocks, or with broken JSON is refused and left alone', () => {
    assert.match(migrateText('# nothing\n').errors[0], /no pipeline-settings block/);
    assert.match(migrateText(text(LEGACY) + text(LEGACY)).errors[0], /2 pipeline-settings/);
    assert.match(migrateText('```json pipeline-settings\n{ nope\n```\n').errors[0], /not valid JSON/);
  });

  test('REQ-106: the legacy view of the migrated settings places every golden case as the 1.0 rule did', () => {
    const golden = JSON.parse(readFileSync(join(PACK, 'tests/fixtures/orch-placements-1.0.json'), 'utf8'));
    const { placement } = require(join(PACK, 'scripts/lib/orch-state.cjs'));
    const at = new Date(golden.at);
    for (const c of golden.cases) {
      const block = JSON.parse(JSON.stringify(LEGACY));
      block.features.orchestrator.seats = c.state.seats;
      block.features.orchestrator.limits = c.state.limits || {};
      block.features.orchestrator.credit = { enabled: false };
      const r = migrateText(text(block));
      const view = profile.accounts.legacyView(profile.parse(r.text).settings);
      const state = { ...c.state, seats: view.seats, limits: { ...c.state.limits, ...view.limits } };
      assert.deepEqual(placement(state, at, c.running), c.expected, c.name);
    }
  });
});

describe('builder accounts migrate', () => {
  test('red: REQ-103 — a legacy profile with the orchestrator off loads with one stderr warning that names the command; after migrate it loads clean', () => {
    const proj = project();
    const check = spawnSync(process.execPath, [join(PACK, 'scripts/features.mjs')], { cwd: proj, encoding: 'utf8', env: { ...process.env, BUILDER_NO_BASH_CAP: '1' } });
    assert.equal(check.status, 0, check.stderr);
    assert.match(check.stderr, /PIPELINE_PROFILE\.md: warning — features\.orchestrator\.seats, limits, secondaryConfigDir, credit: 1\.0 seat keys/);
    assert.match(check.stderr, /npx builder accounts migrate/);
    assert.equal(check.stderr.match(/warning —/g).length, 1, 'said once');
    const r = run(proj, ['migrate']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /rewritten/);
    assert.ok(existsSync(join(proj, 'PIPELINE_PROFILE.md.bak')));
    assert.equal(readFileSync(join(proj, 'PIPELINE_PROFILE.md.bak'), 'utf8'), text(LEGACY));
    const after = spawnSync(process.execPath, [join(PACK, 'scripts/features.mjs')], { cwd: proj, encoding: 'utf8', env: { ...process.env, BUILDER_NO_BASH_CAP: '1' } });
    assert.equal(after.status, 0, after.stderr);
    assert.doesNotMatch(after.stderr, /warning/);
    assert.match(after.stdout, /accounts: on/);
    const second = run(proj, ['migrate']);
    assert.equal(second.status, 0, second.out);
    assert.match(second.out, /nothing to migrate/);
    assert.equal(readFileSync(join(proj, 'PIPELINE_PROFILE.md.bak'), 'utf8'), text(LEGACY), 'backup not overwritten by a no-op run');
  });

  test('--dry-run prints the notes and writes nothing; unknown options and subcommands are refused', () => {
    const proj = project();
    const before = readFileSync(join(proj, 'PIPELINE_PROFILE.md'), 'utf8');
    const r = run(proj, ['migrate', '--dry-run']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /secondary seat → account "secondary"/);
    assert.match(r.out, /nothing written/);
    assert.equal(readFileSync(join(proj, 'PIPELINE_PROFILE.md'), 'utf8'), before);
    assert.equal(existsSync(join(proj, 'PIPELINE_PROFILE.md.bak')), false);
    assert.equal(run(proj, ['migrate', '--force']).status, 1);
    assert.equal(run(proj, ['nope']).status, 1);
    assert.equal(run(proj, []).status, 1);
    assert.equal(run(mkdtempSync(join(tmpdir(), 'kit-accounts-empty-')), ['migrate']).status, 1);
  });

  test('red: a run with a LAUNCHED or STALLED lane refuses the migration; finished runs do not', () => {
    const proj = project();
    const runs = join(proj, '.pipeline', 'orchestrator', 'runs');
    const state = (id, status) => {
      mkdirSync(join(runs, id), { recursive: true });
      writeFileSync(join(runs, id, 'state.json'), JSON.stringify({ runId: id, lanes: { a: { status }, b: { status: 'MERGED' } } }));
    };
    state('done-run', 'MERGED');
    state('live-run', 'LAUNCHED');
    mkdirSync(join(runs, 'junk'), { recursive: true });
    writeFileSync(join(runs, 'junk', 'state.json'), '{ not json');
    assert.deepEqual(liveRuns(proj, { BUILDER_ORCH_DIR: join(proj, '.pipeline', 'orchestrator') }), ['live-run']);
    const r = run(proj, ['migrate']);
    assert.equal(r.status, 1);
    assert.match(r.out, /live-run hold a LAUNCHED or STALLED lane/);
    assert.equal(readFileSync(join(proj, 'PIPELINE_PROFILE.md'), 'utf8'), text(LEGACY));
    state('live-run', 'STALLED');
    assert.equal(run(proj, ['migrate']).status, 1);
    state('live-run', 'FAILED');
    assert.equal(run(proj, ['migrate']).status, 0);
  });

  test('REQ-311: a finished 1.0 run state is read unchanged after the migration (state keeps its seats and limits)', () => {
    const proj = project();
    const runs = join(proj, '.pipeline', 'orchestrator', 'runs', 'old');
    mkdirSync(runs, { recursive: true });
    const old = { runId: 'old', seats: ['secondary', 'primary'], limits: { secondary: 70, primary: 50 }, lanes: { a: { status: 'MERGED', seat: 'secondary' } } };
    writeFileSync(join(runs, 'state.json'), JSON.stringify(old));
    assert.equal(run(proj, ['migrate']).status, 0);
    assert.deepEqual(JSON.parse(readFileSync(join(runs, 'state.json'), 'utf8')), old);
  });
});
