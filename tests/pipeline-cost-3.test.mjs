/**
 * REQ-2021 and REQ-2031 — seat model parity (specs/pipeline-cost-3.spec.md). The install reads profile §16
 * `models.strong` / `models.mid` for the Claude Code agents, and `seat-models` reads the installed agents back
 * against it. Measurement: EXPERIMENTS §27 (benchmark third-01, PT9).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const PACK = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(PACK, rel), 'utf8');
const lib = require('../scripts/lib/seat-models.cjs');
const made = [];
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

const copyKit = (to) => cpSync(PACK, to, { recursive: true, filter: (src) => !/[\\/](?:\.git|tests|node_modules|logs)(?:[\\/]|$)/.test(`/${relative(PACK, src)}`) });
/** A project with the kit as a package and, when `models` is given, a profile whose §16 declares them. */
function project(models = null) {
  const proj = mkdtempSync(join(tmpdir(), 'kit-models-'));
  made.push(proj);
  const kit = join(proj, 'node_modules', 'builder-pipeline');
  mkdirSync(kit, { recursive: true });
  copyKit(kit);
  if (models) writeProfile(proj, models);
  return { proj, kit, cli: join(kit, 'cli.js') };
}
function writeProfile(proj, models) {
  const template = read('PIPELINE_PROFILE.template.md');
  const filled = template.replace(/"models":\s*\{[^}]*\}/, `"models": ${JSON.stringify({ orchestrator: null, strong: null, mid: null, ...models })}`);
  assert.notEqual(filled, template, 'the template has a §16 models line');
  writeFileSync(join(proj, 'PIPELINE_PROFILE.md'), filled);
}
const cli = (p, args) => spawnSync(process.execPath, [p.cli, ...args], { cwd: p.proj, encoding: 'utf8', env: { ...process.env, BUILDER_NO_BASH_CAP: '1' } });
const script = (p, args = []) => spawnSync(process.execPath, [join(p.kit, 'scripts', 'seat-models.mjs'), ...args], { cwd: p.proj, encoding: 'utf8' });
const ok = (r) => { assert.equal(r.status, 0, r.stdout + r.stderr); return r.stdout + r.stderr; };
const agent = (p, name) => readFileSync(join(p.proj, '.claude', 'agents', `${name}.md`), 'utf8');
const lock = (p) => JSON.parse(readFileSync(join(p.proj, 'builder.lock.json'), 'utf8'));

describe('REQ-2021 — the install reads profile §16 models', () => {
  test('red: AC-2021a models.strong and models.mid in the profile reach the agents; the lock records no override', () => {
    const p = project({ strong: 'claude-sonnet-5-5', mid: 'claude-haiku-4-5' });
    const out = ok(cli(p, ['unpack', '--tool', 'claude-code', '--no-extras']));
    assert.match(out, /model mapping \(PIPELINE_PROFILE\.md §16 models\): strong=claude-sonnet-5-5, mid=claude-haiku-4-5/);
    assert.match(agent(p, 'module-planner'), /^model: claude-sonnet-5-5$/m);
    assert.match(agent(p, 'module-builder'), /^model: claude-sonnet-5-5$/m);
    assert.match(agent(p, 'vuln-auditor'), /^model: claude-haiku-4-5$/m);
    assert.deepEqual(lock(p).install.models, {});
  });
  test('red: AC-2021b --models on the command wins over the profile, tier by tier', () => {
    const p = project({ strong: 'claude-sonnet-5-5', mid: 'claude-haiku-4-5' });
    ok(cli(p, ['unpack', '--tool', 'claude-code', '--no-extras', '--models', 'strong=big-model']));
    assert.match(agent(p, 'module-planner'), /^model: big-model$/m);
    assert.match(agent(p, 'vuln-auditor'), /^model: claude-haiku-4-5$/m, 'the profile still fills the tier the flag left alone');
  });
  test('red: AC-2021c the template placeholder <id> and a null leave the defaults in place; no profile line is printed', () => {
    const p = project();
    const out = ok(cli(p, ['unpack', '--tool', 'claude-code', '--no-extras']));
    assert.doesNotMatch(out, /PIPELINE_PROFILE\.md §16 models/);
    assert.match(agent(p, 'module-planner'), /^model: opus$/m);
    assert.match(agent(p, 'vuln-auditor'), /^model: sonnet$/m);
  });
  test('red: AC-2021d upgrade re-reads the profile: a model changed in §16 reaches the agents on the next upgrade', () => {
    const p = project({ strong: 'claude-sonnet-5-5' });
    ok(cli(p, ['unpack', '--tool', 'claude-code', '--no-extras']));
    writeProfile(p.proj, { strong: 'claude-opus-5-5' });
    ok(cli(p, ['upgrade']));
    assert.match(agent(p, 'module-planner'), /^model: claude-opus-5-5$/m);
  });
});

describe('REQ-2031 — seat-models, the free parity check', () => {
  test('red: AC-2031a agents in step → one line, exit 0; --json carries the entries', () => {
    const p = project({ strong: 'claude-sonnet-5-5', mid: 'claude-sonnet-5-5' });
    ok(cli(p, ['unpack', '--tool', 'claude-code', '--no-extras']));
    const r = script(p);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^seat models: in step — \d+ agent\(s\) on the declared models \(strong=claude-sonnet-5-5, mid=claude-sonnet-5-5\)$/m);
    const j = JSON.parse(script(p, ['--json']).stdout);
    assert.ok(j.entries.some((e) => e.name === 'module-planner' && e.tier === 'strong' && e.model === 'claude-sonnet-5-5'));
    assert.equal(j.drift.length, 0);
  });
  test('red: AC-2031b an agent on another model → one DRIFT line per agent naming file, model, tier and the declared model; exit 1', () => {
    const p = project({ strong: 'claude-sonnet-5-5', mid: 'claude-sonnet-5-5' });
    ok(cli(p, ['unpack', '--tool', 'claude-code', '--no-extras']));
    // the install from before REQ-2021, or a hand edit: the strong seats on opus
    for (const n of ['module-planner', 'module-builder']) writeFileSync(join(p.proj, '.claude', 'agents', `${n}.md`), agent(p, n).replace(/^model: .*$/m, 'model: opus'));
    const r = script(p);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    const lines = r.stdout.trim().split('\n');
    assert.deepEqual(lines, [
      'DRIFT: .claude/agents/module-builder.md runs opus, profile §16 declares strong=claude-sonnet-5-5',
      'DRIFT: .claude/agents/module-planner.md runs opus, profile §16 declares strong=claude-sonnet-5-5',
    ]);
  });
  test('red: AC-2031c --write rewrites the drifted lines, refreshes the lock hash, and the next upgrade sees no local edit', () => {
    const p = project({ strong: 'claude-sonnet-5-5', mid: 'claude-sonnet-5-5' });
    ok(cli(p, ['unpack', '--tool', 'claude-code', '--no-extras']));
    writeFileSync(join(p.proj, '.claude', 'agents', 'module-planner.md'), agent(p, 'module-planner').replace(/^model: .*$/m, 'model: opus'));
    const r = script(p, ['--write']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^written: \.claude\/agents\/module-planner\.md$/m);
    assert.match(r.stdout, /^seat models: in step/m);
    assert.match(agent(p, 'module-planner'), /^model: claude-sonnet-5-5$/m);
    const up = ok(cli(p, ['upgrade']));
    assert.doesNotMatch(up, /kept \(local edit\)[^\n]*module-planner/);
    assert.equal(script(p).status, 0);
  });
  test('red: AC-2031d a profile without models, a project-owned agent and a tier the profile leaves null are all in step', () => {
    const p = project({ strong: 'claude-sonnet-5-5' });
    ok(cli(p, ['unpack', '--tool', 'claude-code', '--no-extras']));
    writeFileSync(join(p.proj, '.claude', 'agents', 'my-own-agent.md'), '---\nname: my-own-agent\nmodel: anything\n---\nbody\n');
    const r = script(p);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const j = JSON.parse(script(p, ['--json']).stdout);
    assert.ok(!j.entries.some((e) => e.name === 'my-own-agent'));
    assert.ok(j.entries.find((e) => e.name === 'vuln-auditor').ok, 'mid is not declared, so the mid seat is in step whatever it runs');
    const bare = project();
    ok(cli(bare, ['unpack', '--tool', 'claude-code', '--no-extras']));
    const b = script(bare);
    assert.equal(b.status, 0);
    assert.match(b.stdout, /declares no strong or mid model/);
  });
  test('red: an extras persona (skills-extra/*/agents) is checked too, and --write aligns it', () => {
    const p = project({ strong: 'claude-sonnet-5-5', mid: 'claude-sonnet-5-5' });
    ok(cli(p, ['unpack', '--tool', 'claude-code', '--models', 'strong=opus,mid=opus']));
    assert.match(agent(p, 'repo-auditor'), /^model: opus$/m, 'the extras persona was installed on the flag model');
    const before = JSON.parse(script(p, ['--json']).stdout);
    assert.ok(before.entries.some((e) => e.name === 'repo-auditor'), 'the extras persona is an entry');
    assert.equal(before.entries.length, before.drift.length, 'every installed kit agent drifts under the flag');
    assert.equal(script(p, ['--write']).status, 0);
    assert.match(agent(p, 'repo-auditor'), /^model: claude-sonnet-5-5$/m);
  });
  test('red: a renamed "both" install (builder-<name>) is read by its kit name; declaredModels drops placeholders', () => {
    assert.deepEqual(lib.declaredModels({ models: { strong: '<id>', mid: ' x ', orchestrator: 'o' } }), { mid: 'x' });
    const root = mkdtempSync(join(tmpdir(), 'kit-models-lib-'));
    made.push(root);
    mkdirSync(join(root, '.claude', 'agents'), { recursive: true });
    writeFileSync(join(root, '.claude', 'agents', 'builder-module-planner.md'), '---\nname: builder-module-planner\nmodel: opus\n---\n');
    const r = lib.check(root, PACK, { models: { strong: 's' } });
    assert.equal(r.drift.length, 1);
    assert.equal(r.drift[0].tier, 'strong');
    assert.equal(lib.render(r)[0], 'DRIFT: .claude/agents/builder-module-planner.md runs opus, profile §16 declares strong=s');
    assert.equal(script({ kit: PACK, proj: root }, ['--bogus']).status, 2);
  });
});

describe('the ledgers and the texts', () => {
  test('red: EXPERIMENTS §27 exists with a not-yet-measured decision; DECISIONS D150 and D151; the CHANGELOG entry', () => {
    const exp = require('../scripts/lib/experiments.cjs');
    const s27 = exp.parse(read('EXPERIMENTS.md')).find((s) => s.n === 27);
    assert.ok(s27, '§27');
    assert.equal(s27.decision.verdict, 'not yet measured');
    assert.match(s27.body, /PT9/);
    const dec = read('DECISIONS.md');
    for (const id of ['D150', 'D151']) assert.match(dec, new RegExp(`^\\| ${id} \\| 2026-11-20 \\| pipeline-cost-3 \\|`, 'm'));
    assert.match(read('CHANGELOG.md'), /\*\*Seat model parity \(`specs\/pipeline-cost-3\.spec\.md` REQ-2021, REQ-2031 and REQ-2032/);
  });
  test('red: adapters/claude-code.md, USAGE.md and the run discipline name §16 models and seat-models', () => {
    assert.match(read('adapters/claude-code.md'), /`models\.strong` \/ `models\.mid`[^\n]*§16/);
    assert.match(read('USAGE.md'), /`npx --no-install builder-pipeline run seat-models`/);
    assert.match(read('skills/references/run-discipline.md'), /seat-models/);
    assert.match(read('skills/build-module-pipeline.md'), /seat-models/);
    assert.ok(read('skills/build-module-pipeline.md').split('\n').length <= 400);
  });
});
