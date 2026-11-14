/**
 * The setup flow (bootstrap → inventory → choices → unpack → verify) as the sample-project run exercised it:
 *   D1  a bare `npm init` repo read as brownfield — the kit's own install counted as evidence;
 *   D4  `choices set` / `check` accepted a key that names no kit item;
 *   D5  "both" on a pipeline seat installed it renamed while the skills and the write-guard dispatch the old name;
 *   D6  the persona library's scaffolding (WHY, USAGE, INDEX, _TEMPLATE, _census) listed as personas, the real
 *       profiles under personas/<set>/ missed;
 *   D9  bootstrap's own .agents/ output read as Antigravity on a re-run, and its lock read as a full install;
 *   D10 a greenfield setup ended with no builder.choices.json.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const PACK = join(dirname(fileURLToPath(import.meta.url)), '..');
const made = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

function project(kitAt = 'node_modules/@geopjinfo/builder-pipeline') {
  const proj = mkdtempSync(join(tmpdir(), 'kit-setup-'));
  made.push(proj);
  const kit = join(proj, ...kitAt.split('/'));
  mkdirSync(kit, { recursive: true });
  cpSync(PACK, kit, { recursive: true, filter: (src) => !/[\\/](?:\.git|tests|node_modules)(?:[\\/]|$)/.test(`/${relative(PACK, src)}`) });
  return { proj, kit, cli: join(kit, 'cli.js') };
}
const run = (cli, cwd, args) => {
  const r = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, stdout: r.stdout ?? '' };
};
const write = (root, rel, text) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const read = (root, rel) => readFileSync(join(root, rel), 'utf8');
/** What `npm init -y` writes, plus the kit as the one devDependency. */
const NPM_INIT = {
  name: 'sample',
  version: '1.0.0',
  description: '',
  main: 'index.js',
  scripts: { test: 'echo "Error: no test specified" && exit 1' },
  keywords: [],
  author: '',
  license: 'ISC',
  devDependencies: { '@geopjinfo/builder-pipeline': 'file:../kit.tgz' },
};
const inventory = (cli, proj) => JSON.parse(run(cli, proj, ['inventory', '--json']).stdout);

describe('D1 — greenfield is greenfield after the kit installs itself', () => {
  test('red: npm init + bootstrap + unpack: greenfield, 0 existing items, at every step', () => {
    const { proj, cli } = project();
    write(proj, 'package.json', JSON.stringify(NPM_INIT, null, 2));
    assert.equal(run(cli, proj, ['bootstrap']).status, 0);
    let inv = inventory(cli, proj);
    assert.equal(inv.mode.mode, 'greenfield', JSON.stringify(inv.mode.evidence));
    assert.equal(inv.mode.evidence.existingItems, 0);
    assert.equal(run(cli, proj, ['unpack', '--tool', 'claude-code']).status, 0);
    inv = inventory(cli, proj);
    assert.equal(inv.mode.mode, 'greenfield', `a re-run after unpack: ${JSON.stringify(inv.mode.evidence)}`);
    assert.deepEqual(inv.items, []);
  });

  test('red: the folder layout too — the kit scripts copied into scripts/ are not source code', () => {
    const { proj, cli } = project('builder');
    assert.equal(run(cli, proj, ['unpack', '--tool', 'claude-code']).status, 0);
    const inv = inventory(cli, proj);
    assert.equal(inv.mode.mode, 'greenfield', JSON.stringify(inv.mode.evidence));
    assert.equal(inv.mode.evidence.codeFiles, 0);
  });

  test('control: a package.json whose main file exists, or a real dependency, is a codebase', () => {
    const { proj, cli } = project();
    write(proj, 'package.json', JSON.stringify(NPM_INIT));
    write(proj, 'index.js', 'module.exports = 1;\n');
    assert.equal(inventory(cli, proj).mode.mode, 'brownfield');
    const b = project();
    write(b.proj, 'package.json', JSON.stringify({ ...NPM_INIT, dependencies: { express: '^4' } }));
    assert.equal(inventory(b.cli, b.proj).mode.mode, 'brownfield');
  });

  test('red: a brownfield count leaves the kit-installed builder-init copies out', () => {
    const { proj, cli } = project();
    write(proj, 'AGENTS.md', '# ours\n');
    write(proj, '.claude/skills/code-review/SKILL.md', '---\nname: code-review\ndescription: Our review.\n---\nx\n');
    assert.equal(run(cli, proj, ['bootstrap', '--tool', 'claude-code,codex']).status, 0);
    const inv = inventory(cli, proj);
    assert.equal(inv.mode.evidence.existingItems, inv.items.length);
    assert.equal(inv.items.length, 1);
  });
});

describe('D4/D5 — choices name real kit items; pipeline seats cannot be "both"', () => {
  test('red: set refuses a key that names no kit item, and names the keys that exist', () => {
    const { proj, cli } = project();
    for (const key of ['agent:nonexistent', 'skill:code-review']) {
      const r = run(cli, proj, ['choices', 'set', key, 'keep', '--by', 't']);
      assert.equal(r.status, 1, r.out);
      assert.match(r.out, /names no kit item/);
      assert.match(r.out, /agent:module-planner/);
    }
    assert.ok(!existsSync(join(proj, 'builder.choices.json')));
    assert.equal(run(cli, proj, ['choices', 'set', 'skill:caveman', 'keep', '--by', 't']).status, 0, 'a real kit item records');
  });

  test('red: check flags an unknown key written by hand', () => {
    const { proj, cli } = project();
    write(proj, 'builder.choices.json', JSON.stringify({ version: 1, items: { 'agent:nonexistent': { decision: 'keep', decidedAt: '2026-01-01T00:00:00Z', by: 't' } } }));
    const r = run(cli, proj, ['choices', 'check']);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /agent:nonexistent.*names no kit item/);
  });

  test('red: "both" on a pipeline seat is refused with keep/kit offered; a non-seat skill may be both', () => {
    const { proj, cli } = project();
    for (const seat of ['agent:module-reviewer', 'agent:module-planner', 'agent:vuln-auditor']) {
      const r = run(cli, proj, ['choices', 'set', seat, 'both', '--by', 't']);
      assert.equal(r.status, 1, r.out);
      assert.match(r.out, /pipeline seat/);
      assert.match(r.out, /keep.*kit|kit.*keep/);
    }
    assert.equal(run(cli, proj, ['choices', 'set', 'skill:caveman', 'both', '--by', 't']).status, 0);
    assert.equal(run(cli, proj, ['choices', 'set', 'agent:module-reviewer', 'kit', '--by', 't']).status, 0);
  });

  test('red: a hand-written seat "both" fails check and stops unpack before anything is written', () => {
    const { proj, cli } = project();
    write(proj, '.claude/agents/module-reviewer.md', '---\nname: module-reviewer\ndescription: ours\n---\nours\n');
    write(proj, 'builder.choices.json', JSON.stringify({ version: 1, items: { 'agent:module-reviewer': { decision: 'both', decidedAt: '2026-01-01T00:00:00Z', by: 't' } } }));
    assert.equal(run(cli, proj, ['choices', 'check']).status, 1);
    const u = run(cli, proj, ['unpack', '--tool', 'claude-code']);
    assert.equal(u.status, 1, u.out);
    assert.match(u.out, /pipeline seat/);
    assert.ok(!existsSync(join(proj, '.claude', 'agents', 'builder-module-reviewer.md')));
    assert.ok(!existsSync(join(proj, 'PIPELINE_PROFILE.md')));
  });

  test('red: verify fails when a seat the skills dispatch is not the kit\'s (kept project agent, or missing)', () => {
    const { proj, cli } = project();
    write(proj, '.claude/agents/module-reviewer.md', '---\nname: module-reviewer\ndescription: ours\n---\nours\n');
    assert.equal(run(cli, proj, ['choices', 'set', 'agent:module-reviewer', 'keep', '--by', 't']).status, 0);
    assert.equal(run(cli, proj, ['unpack', '--tool', 'claude-code']).status, 0);
    let v = run(cli, proj, ['verify']);
    assert.match(v.out, /FAIL.*pipeline seats.*module-reviewer/);
    unlinkSync(join(proj, '.claude', 'agents', 'module-planner.md'));
    v = run(cli, proj, ['verify']);
    assert.match(v.out, /FAIL.*pipeline seats.*module-planner/);
  });

  test('control: a plain install passes the seat check', () => {
    const { proj, cli } = project();
    assert.equal(run(cli, proj, ['unpack', '--tool', 'claude-code,codex,antigravity']).status, 0);
    assert.match(run(cli, proj, ['verify']).out, /PASS.*pipeline seats/);
  });
});

describe('D6 — the persona library is read through its roster', () => {
  test('red: inventory lists the roster profiles, not WHY/USAGE/INDEX/_TEMPLATE/_census', () => {
    const { proj, cli } = project();
    for (const f of ['WHY', 'USAGE', '_TEMPLATE', '_census']) write(proj, `personas/${f}.md`, `# ${f}\n\nlibrary text\n`);
    const roster = { personas: [{ id: 'ops-lead', name: 'Ops lead', set: 'delivery', confirmed: false, routes: ['release'] }, { id: 'auditor', name: 'Auditor', set: 'governance', confirmed: false, routes: ['audit'], file: 'governance/the-auditor.md' }] };
    write(proj, 'personas/INDEX.md', `# Personas\n\n\`\`\`json\n${JSON.stringify(roster, null, 2)}\n\`\`\`\n`);
    write(proj, 'personas/delivery/ops-lead.md', '# Ops lead — delivery\n\nShips on Fridays, never.\n');
    write(proj, 'personas/governance/the-auditor.md', '# Auditor — governance\n\nReads every log.\n');
    const personas = inventory(cli, proj).items.filter((i) => i.kind === 'persona');
    assert.deepEqual(personas.map((p) => p.path).sort(), ['personas/delivery/ops-lead.md', 'personas/governance/the-auditor.md']);
    assert.deepEqual(personas.map((p) => p.name).sort(), ['auditor', 'ops-lead']);
  });

  test('without a roster the set folders are walked; a top-level own persona file still counts', () => {
    const { proj, cli } = project();
    write(proj, 'personas/WHY.md', '# why\n');
    write(proj, 'personas/product/buyer.md', '# Buyer\n\nWants it cheap.\n');
    write(proj, 'personas/architect.md', '# Architect\n\nKeeps boundaries.\n');
    const paths = inventory(cli, proj).items.filter((i) => i.kind === 'persona').map((p) => p.path).sort();
    assert.deepEqual(paths, ['personas/architect.md', 'personas/product/buyer.md']);
  });
});

describe('D9 — bootstrap is stable across re-runs and its lock does not pass for an install', () => {
  test('red: a second bootstrap detects the same tools — its own .agents/ is not Antigravity', () => {
    const { proj, cli } = project();
    write(proj, 'AGENTS.md', '# ours\n');
    write(proj, 'CLAUDE.md', '# ours\n');
    const first = run(cli, proj, ['bootstrap']);
    assert.match(first.out, /detected: claude-code, codex\n/);
    const second = run(cli, proj, ['bootstrap']);
    assert.match(second.out, /detected: claude-code, codex\n/, second.out);
  });

  test('control: a user\'s own .agents/ content still means Antigravity', () => {
    const { proj, cli } = project();
    write(proj, '.agents/agents/ours.md', '---\nname: ours\n---\nx\n');
    assert.match(run(cli, proj, ['bootstrap']).out, /detected: antigravity\n/);
  });

  test('red: bootstrap over an install from before the lock leaves it a legacy install', () => {
    const { proj, cli } = project();
    assert.equal(run(cli, proj, ['unpack', '--tool', 'claude-code']).status, 0);
    unlinkSync(join(proj, 'builder.lock.json')); // an install from before the lock existed
    assert.equal(run(cli, proj, ['bootstrap']).status, 0);
    const lock = JSON.parse(read(proj, 'builder.lock.json'));
    assert.deepEqual(Object.keys(lock.files), ['.claude/skills/builder-init/SKILL.md'], 'bootstrap records only what it wrote');
    const up = run(cli, proj, ['upgrade', '--tool', 'claude-code', '--dry-run']);
    assert.equal(up.status, 0, up.out);
    assert.doesNotMatch(up.out, /undecided clash/);
    assert.deepEqual(inventory(cli, proj).items, []);
  });
});

describe('D10 — a setup with nothing to decide still leaves its record', () => {
  test('red: unpack with no clashes writes an empty, valid builder.choices.json', () => {
    const { proj, cli } = project();
    assert.equal(run(cli, proj, ['unpack', '--tool', 'claude-code', '--dry-run']).status, 0);
    assert.ok(!existsSync(join(proj, 'builder.choices.json')), 'a dry run writes nothing');
    assert.equal(run(cli, proj, ['unpack', '--tool', 'claude-code']).status, 0);
    assert.deepEqual(JSON.parse(read(proj, 'builder.choices.json')), { version: 1, items: {} });
    assert.match(run(cli, proj, ['choices', 'check']).out, /valid, 0 choice\(s\)/);
  });

  test('control: an undecided clash leaves no empty choices file to read as "decided"', () => {
    const { proj, cli } = project();
    write(proj, '.claude/agents/module-reviewer.md', '---\nname: module-reviewer\ndescription: ours\n---\nours\n');
    const u = run(cli, proj, ['unpack', '--tool', 'claude-code']);
    assert.match(u.out, /undecided clash/);
    assert.ok(!existsSync(join(proj, 'builder.choices.json')));
  });
});
