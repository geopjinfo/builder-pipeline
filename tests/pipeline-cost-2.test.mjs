/**
 * REQ-2022 to REQ-2024 and REQ-2027 — escalation discipline (specs/pipeline-cost-2.spec.md). The foreground guard hook
 * (`features.foregroundGuard`, experimental-off), the planner's track hint, `track-check --shared` and the MEDIUM
 * auditor carried by `--json`. Measurement: EXPERIMENTS §26.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const PACK = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(PACK, rel), 'utf8');
const profile = require('../scripts/lib/profile.cjs');
const guard = require('../hooks/claude-code/foreground-guard.cjs');
const made = [];
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

const tmp = (prefix) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
};
const write = (dir, rel, text) => {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
};
const withFeatures = (features, paths = {}) => profile.merge(profile.DEFAULTS, { features, paths });
const on = withFeatures({ foregroundGuard: { state: 'experimental-on' } });

describe('REQ-2022 — the foreground guard', () => {
  test('red: AC-2022a a run open now, ScheduleWakeup → blocked, the reason names REQ-2004 and the state file', () => {
    const root = tmp('fg-');
    write(root, '.pipeline/k1/state.md', 'Now: phase 2\n');
    const d = guard.decide({ tool_name: 'ScheduleWakeup', tool_input: { delaySeconds: 600 } }, on, { root });
    assert.equal(d.block, true);
    assert.match(d.reason, /REQ-2004/);
    assert.match(d.reason, /\.pipeline\/k1\/state\.md/);
  });
  test('red: AC-2022g a run folder with only run.jsonl (no state.md) is open — a SMALL run writes no state file', () => {
    const root = tmp('fg-');
    write(root, '.pipeline/k7/run.jsonl', '{"event":"run.start"}\n');
    const d = guard.decide({ tool_name: 'ScheduleWakeup' }, on, { root });
    assert.equal(d.block, true);
    assert.match(d.reason, /\.pipeline\/k7\/run\.jsonl/);
    assert.equal(guard.openRuns(root, '.pipeline', 12)[0].key, 'k7');
  });
  test('red: AC-2022h scope "project" blocks with no run folder at all; an unknown scope reads as "run"', () => {
    const root = tmp('fg-');
    const project = withFeatures({ foregroundGuard: { state: 'on', scope: 'project' } });
    const d = guard.decide({ tool_name: 'Monitor' }, project, { root });
    assert.equal(d.block, true);
    assert.match(d.reason, /scope is "project"/);
    assert.deepEqual(guard.decide({ tool_name: 'Monitor' }, withFeatures({ foregroundGuard: { state: 'on', scope: 'bogus' } }), { root }), { block: false });
    assert.deepEqual(guard.SCOPES, ['run', 'project']);
    assert.equal(profile.FEATURES.foregroundGuard.defaults.scope, 'run');
  });
  test('red: AC-2022b the state file 13 hours old → passes', () => {
    const root = tmp('fg-');
    write(root, '.pipeline/k1/state.md', 'Now: phase 2\n');
    const old = (Date.now() - 13 * 3600 * 1000) / 1000;
    utimesSync(join(root, '.pipeline/k1/state.md'), old, old);
    assert.deepEqual(guard.decide({ tool_name: 'ScheduleWakeup', tool_input: {} }, on, { root }), { block: false });
  });
  test('red: AC-2022c the key off (the default) → CronCreate passes, even with a run open', () => {
    const root = tmp('fg-');
    write(root, '.pipeline/k1/state.md', 'Now: phase 2\n');
    assert.deepEqual(guard.decide({ tool_name: 'CronCreate', tool_input: {} }, withFeatures({}), { root }), { block: false });
    assert.equal(profile.FEATURES.foregroundGuard.defaults.state, 'experimental-off');
    assert.equal(profile.FEATURES.foregroundGuard.defaults.openHours, 12);
    assert.equal(profile.FEATURES.foregroundGuard.experiment, '§26');
  });
  test('red: AC-2022d the key on, a run open, Bash → passes (not a timer tool); Monitor is one', () => {
    const root = tmp('fg-');
    write(root, '.pipeline/k1/state.md', 'Now: phase 2\n');
    assert.deepEqual(guard.decide({ tool_name: 'Bash', tool_input: { command: 'ls' } }, on, { root }), { block: false });
    assert.equal(guard.decide({ tool_name: 'Monitor', tool_input: {} }, on, { root }).block, true);
    assert.deepEqual([...guard.TIMER_TOOLS], ['ScheduleWakeup', 'CronCreate', 'Monitor']);
  });
  test('red: openHours and paths.runs are read from the settings; no runs folder means no open run', () => {
    const root = tmp('fg-');
    write(root, 'runs/k2/state.md', 'Now: phase 1\n');
    const two = (Date.now() - 2 * 3600 * 1000) / 1000;
    utimesSync(join(root, 'runs/k2/state.md'), two, two);
    const narrow = withFeatures({ foregroundGuard: { state: 'on', openHours: 1 } }, { runs: 'runs' });
    assert.deepEqual(guard.decide({ tool_name: 'ScheduleWakeup' }, narrow, { root }), { block: false });
    const wide = withFeatures({ foregroundGuard: { state: 'on', openHours: 3 } }, { runs: 'runs' });
    assert.equal(guard.decide({ tool_name: 'ScheduleWakeup' }, wide, { root }).block, true);
    assert.deepEqual(guard.openRuns(root, '.pipeline', 12), []);
  });
  test('red: AC-2022e as a process: malformed stdin exits 0; a project without a profile exits 0', () => {
    const root = tmp('fg-');
    write(root, '.pipeline/k1/state.md', 'Now: phase 2\n');
    const run = (input) => spawnSync(process.execPath, [join(PACK, 'hooks', 'claude-code', 'foreground-guard.cjs')], { input, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root } });
    assert.equal(run('not json').status, 0);
    assert.equal(run(JSON.stringify({ tool_name: 'ScheduleWakeup', cwd: root })).status, 0);
  });
  test('red: AC-2022f the registry, the template, FEATURES.md, the adapter and hooks/README.md name foregroundGuard experimental-off with openHours 12', () => {
    assert.match(read('PIPELINE_PROFILE.template.md'), /"foregroundGuard":\s*\{ "state": "experimental-off", "openHours": 12, "scope": "run" \}/);
    assert.match(read('FEATURES.md'), /^\| `foregroundGuard` \|.*`openHours`, 12.*\[§26\]\(EXPERIMENTS\.md\)/m);
    const adapter = read('adapters/claude-code.md');
    assert.match(adapter, /"matcher": "ScheduleWakeup\|CronCreate\|Monitor"/);
    assert.match(adapter, /foreground-guard\.cjs/);
    assert.match(read('hooks/README.md'), /`claude-code\/foreground-guard\.cjs`.*`features\.foregroundGuard` on, `openHours` \(12\)/);
    const { hooksSettings } = require('../adapters/lib/claude-code.cjs');
    const pre = hooksSettings().hooks.PreToolUse;
    assert.ok(pre.some((e) => e.matcher === 'ScheduleWakeup|CronCreate|Monitor' && /foreground-guard\.cjs/.test(e.hooks[0].command)));
  });
});

describe('REQ-2023 — only track-check or the brief raises the track', () => {
  const SKILL = read('skills/build-module-pipeline.md');
  test('red: AC-2023a the skill: the planner returns a hint and never raises the track; FULL from the Size hint or a new bounded context', () => {
    assert.match(SKILL, /the planner returns a `Track\s+hint:`[\s\S]{0,40}and never raises the track\*\* \(REQ-2023\)/);
    assert.match(SKILL, /FULL is entered from the `Size hint:` or a new bounded context named in the brief/);
    assert.ok(SKILL.split('\n').length <= 400, `skill is ${SKILL.split('\n').length} lines`);
  });
  test('red: AC-2023b the planner file: ## Track returns a hint and the orchestrator keeps the track', () => {
    const planner = read('agents/module-planner.md');
    assert.match(planner, /\*\*## Track\*\* — return `Track hint: <track> — <reason>`/);
    assert.match(planner, /the `Track hint:` line/);
    assert.match(read('skills/references/sizing.md'), /## Who raises the track \(REQ-2023, D147\)/);
  });
});

// ---- track-check --shared (REQ-2024) and the MEDIUM auditor (REQ-2027) ----------------------------------------------

const git = (cwd, ...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
/** A repository with one base commit: src/api, src/shared/errors.ts (a catalogue), a test and a package.json. */
function repo() {
  const dir = tmp('pipeline-cost-2-');
  git(dir, 'init', '-q');
  write(dir, 'src/api/a.ts', 'export const a = 1;\n');
  write(dir, 'src/shared/errors.ts', 'export const E1 = "e1";\nexport const E2 = "e2";\n');
  write(dir, 'test/api.test.ts', 'test("a", () => {});\n');
  write(dir, 'package.json', JSON.stringify({ name: 't', version: '1.0.0' }, null, 2) + '\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  return { dir, base: git(dir, 'rev-parse', 'HEAD').stdout.trim() };
}
const apiFiles = (dir, n) => { for (let i = 0; i < n; i++) write(dir, `src/api/f${i}.ts`, `export const f${i} = ${i};\n`); };
const addLine = (dir) => write(dir, 'src/shared/errors.ts', 'export const E1 = "e1";\nexport const E2 = "e2";\nexport const E3 = "e3";\n');
const run = (cwd, args = []) => spawnSync(process.execPath, [join(PACK, 'scripts', 'track-check.mjs'), ...args], { cwd, encoding: 'utf8' });
const SHARED = ['--shared', 'src/shared/errors.ts'];

describe('REQ-2024 — track-check --shared', () => {
  test('red: AC-2024a 2 api files and one added line in the catalogue → SMALL, 3 files in 1 module, shared additions named, exit 0', () => {
    const { dir, base } = repo();
    apiFiles(dir, 2);
    addLine(dir);
    const r = run(dir, ['--since', base, ...SHARED]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.stdout.trim(), 'SMALL: 3 source files in 1 module; shared additions: src/shared/errors.ts');
    const j = JSON.parse(run(dir, ['--since', base, ...SHARED, '--json']).stdout);
    assert.deepEqual(j.sharedAdditions, ['src/shared/errors.ts']);
    assert.deepEqual(j.modules, ['api']);
    assert.equal(j.auditor, null);
  });
  test('red: AC-2024b the same change without --shared → ESCALATE on 2 modules, exit 1 (unchanged)', () => {
    const { dir, base } = repo();
    apiFiles(dir, 2);
    addLine(dir);
    const r = run(dir, ['--since', base]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /^ESCALATE: 2 modules touched \(api, shared\), limit 1$/m);
  });
  test('red: AC-2024c a changed line in the catalogue beside 2 api files → ESCALATE even with --shared, exit 1', () => {
    const { dir, base } = repo();
    apiFiles(dir, 2);
    write(dir, 'src/shared/errors.ts', 'export const E1 = "changed";\nexport const E2 = "e2";\n');
    const r = run(dir, ['--since', base, ...SHARED]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /^ESCALATE: 2 modules touched \(api, shared\), limit 1$/m);
    const j = JSON.parse(run(dir, ['--since', base, ...SHARED, '--json']).stdout);
    assert.deepEqual(j.sharedAdditions, []);
  });
  test('red: a catalogue file that did not exist at the base is a new file, not an addition', () => {
    const { dir, base } = repo();
    apiFiles(dir, 2);
    write(dir, 'src/shared/config.ts', 'export const C = 1;\n');
    const r = run(dir, ['--since', base, '--shared', 'src/shared/config.ts']);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /^ESCALATE: 2 modules touched \(api, shared\), limit 1$/m);
  });
  test('red: AC-2024d 5 api files and an added catalogue line with --medium → MEDIUM, 6 files, exit 3, auditor invariant-auditor', () => {
    const { dir, base } = repo();
    apiFiles(dir, 5);
    addLine(dir);
    const r = run(dir, ['--since', base, ...SHARED, '--medium']);
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.equal(r.stdout.trim(), 'MEDIUM: 6 source files in 1 module — 6 source files changed, limit 4; shared additions: src/shared/errors.ts');
    const j = JSON.parse(run(dir, ['--since', base, ...SHARED, '--medium', '--json']).stdout);
    assert.equal(j.track, 'MEDIUM');
    assert.equal(j.auditor, 'invariant-auditor');
  });
  test('red: the usage text and USAGE.md name --shared', () => {
    assert.match(run(tmpdir(), ['--help']).stdout + run(tmpdir(), ['--help']).stderr, /--shared/);
    assert.match(read('USAGE.md'), /`--shared <file,file>`/);
  });
});

describe('REQ-2027 — the MEDIUM auditor', () => {
  test('red: AC-2027 the sizing reference names invariant-auditor as the default, security-auditor for a public operation, and excludes the other two', () => {
    const ref = read('skills/references/sizing.md');
    assert.match(ref, /## The MEDIUM auditor \(REQ-2027, D149\)/);
    assert.match(ref, /`invariant-auditor` for a new migration, a new table or a plain 5 to 6 file change/);
    assert.match(ref, /`security-auditor` when the orchestrator's own reading of the\s+diff finds a new public operation or a new query parameter/);
    assert.match(ref, /`standards-auditor` and `vuln-auditor` never run on MEDIUM/);
    assert.match(read('skills/build-module-pipeline.md'), /REQ-2027/);
  });
  test('red: judge() carries the auditor on MEDIUM only', () => {
    const tc = require('../scripts/lib/track-check.cjs');
    const medium = tc.judge({ files: ['src/a/1.ts', 'src/a/2.ts', 'src/a/3.ts', 'src/a/4.ts', 'src/a/5.ts'], modules: ['a'], medium: 6 });
    assert.equal(medium.track, 'MEDIUM');
    assert.equal(medium.auditor, 'invariant-auditor');
    const small = tc.judge({ files: ['src/a/1.ts'], modules: ['a'] });
    assert.equal(small.auditor, null);
  });
});

describe('EXPERIMENTS §26 and the ledgers', () => {
  test('red: §26 exists with a not-yet-measured decision and the before rows; §25 carries the g12 after rows', () => {
    const exp = require('../scripts/lib/experiments.cjs');
    const all = exp.parse(read('EXPERIMENTS.md'));
    const s26 = all.find((s) => s.n === 26);
    assert.ok(s26, '§26');
    assert.equal(s26.flag, 'foregroundGuard');
    assert.equal(s26.decision.verdict, 'not yet measured');
    assert.match(s26.body, /0e09b2f \(before\)/);
    const s25 = all.find((s) => s.n === 25);
    assert.match(s25.body, /0e09b2f \(after, PR #44\) \| G1/);
    assert.match(s25.decision.text, /g12-after-E \(45 cells, kit 0e09b2f/);
    assert.match(s25.body, /keep rule \(under 1\.00 USD\) is not met/);
  });
  test('red: DECISIONS D146 to D149 and the CHANGELOG entry are present', () => {
    const dec = read('DECISIONS.md');
    for (const id of ['D146', 'D147', 'D148', 'D149']) assert.match(dec, new RegExp(`^\\| ${id} \\| 2026-11-20 \\| pipeline-cost-2 \\|`, 'm'));
    assert.match(read('CHANGELOG.md'), /\*\*Escalation discipline \(`specs\/pipeline-cost-2\.spec\.md` REQ-2022 to REQ-2024 and REQ-2027/);
  });
});
