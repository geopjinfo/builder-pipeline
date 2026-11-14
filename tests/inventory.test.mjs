/**
 * The overlap inventory — what a project already has, and how much of it looks like the kit.
 *
 * WHY. The ruling is that a project's own skills, agents and personas win, and nothing that could clash with one is
 * installed before a person decided it. That only holds if the inventory finds every item and the overlap pass sees
 * every kind of clash: a byte-identical copy, the same name over different content, and the same job under different
 * names. A missed clash is a silent overwrite or a second seat doing the same job. Fixtures are built in a temp dir.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const inv = require('../scripts/lib/inventory.cjs');
const PACK = join(dirname(fileURLToPath(import.meta.url)), '..');

const temps = [];
function tempDir(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
}
after(() => temps.forEach((d) => rmSync(d, { recursive: true, force: true })));

function put(root, rel, text) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

const skill = (name, description, body = '') => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${body}\n`;

const REVIEW = skill('code-review', 'Review the current diff for correctness bugs and risky changes. Trigger on "review my diff", "code review".', 'Read the diff, list bugs.');
const AUDIT = skill('change-audit', 'Audit the current diff for correctness bugs, risky changes and missing tests before merge.');
const RELEASE = skill('release-notes', 'Draft release notes from merged changes.');
const DEPLOY = skill('deploy-staging', 'Push the container image to the staging cluster and smoke-test it.');

/** A tiny fake kit: one skill per overlap case, one agent, one hook. */
function fakeKit() {
  const kit = tempDir('kit-');
  put(kit, 'skills/code-review.md', skill('code-review', 'Kit review: run the readiness checklist over one module before a pull request.'));
  put(kit, 'skills/release-notes.md', RELEASE);
  put(kit, 'skills/diff-audit.md', skill('diff-audit', 'Audit the diff for correctness bugs and risky changes, and missing tests, before merge.'));
  put(kit, 'skills/state-template.md', '# not a skill');
  put(kit, 'agents/module-planner.md', skill('module-planner', 'Read-only planner for one module build.'));
  put(kit, 'hooks/protected-paths.cjs', '/*\n * PreToolUse hook — blocks agent writes to protected paths.\n */\n');
  return kit;
}

function brownfield() {
  const root = tempDir('brown-');
  put(root, '.claude/skills/code-review/SKILL.md', REVIEW);
  put(root, '.claude/skills/change-audit/SKILL.md', AUDIT);
  put(root, '.agents/skills/release-notes/SKILL.md', RELEASE);
  put(root, '.agents/skills/deploy-staging/SKILL.md', DEPLOY);
  put(root, '.codex/agents/reviewer.toml', 'name = "reviewer"\ndescription = "Reviews pull requests"\n');
  put(root, 'personas/architect.md', '# Architect\n\nKeeps the module boundaries honest.\n');
  put(root, '.claude/hooks/format.sh', '#!/bin/sh\n# Formats staged files before commit.\nexit 0\n');
  put(root, 'AGENTS.md', '# Agents\n\nUse the code-review skill before every merge.\n');
  return root;
}

describe('inventory()', () => {
  test('finds every item under every harness folder, with kind, tool, name, path, hash and description', () => {
    const items = inv.inventory(brownfield());
    const byPath = Object.fromEntries(items.map((i) => [i.path, i]));
    assert.deepEqual(Object.keys(byPath).sort(), [
      '.agents/skills/deploy-staging/SKILL.md',
      '.agents/skills/release-notes/SKILL.md',
      '.claude/hooks/format.sh',
      '.claude/skills/change-audit/SKILL.md',
      '.claude/skills/code-review/SKILL.md',
      '.codex/agents/reviewer.toml',
      'personas/architect.md',
    ]);
    const review = byPath['.claude/skills/code-review/SKILL.md'];
    assert.equal(review.kind, 'skill');
    assert.equal(review.tool, 'claude-code');
    assert.equal(review.name, 'code-review');
    assert.match(review.sha256, /^[0-9a-f]{64}$/);
    assert.match(review.description, /correctness bugs/);
    assert.deepEqual(review.triggers, ['review my diff', 'code review']);
    assert.equal(byPath['.codex/agents/reviewer.toml'].name, 'reviewer');
    assert.equal(byPath['.codex/agents/reviewer.toml'].kind, 'agent');
    assert.equal(byPath['personas/architect.md'].description, 'Keeps the module boundaries honest.');
    assert.equal(byPath['.claude/hooks/format.sh'].description, 'Formats staged files before commit.');
  });

  test('an empty repo has no items', () => {
    assert.deepEqual(inv.inventory(tempDir('empty-')), []);
  });

  test('line endings do not change the hash', () => {
    const a = tempDir('crlf-');
    put(a, '.claude/agents/x.md', 'one\ntwo\n');
    const b = tempDir('crlf-');
    put(b, '.claude/agents/x.md', 'one\r\ntwo\r\n');
    assert.equal(inv.inventory(a)[0].sha256, inv.inventory(b)[0].sha256);
  });
});

describe('overlaps()', () => {
  const kit = inv.kitInventory(fakeKit());
  const pairs = inv.overlaps(inv.inventory(brownfield()), kit);
  const find = (project, kitName) => pairs.find((p) => p.project === project && p.kitName === kitName);

  test('kitInventory names items by their installed name and leaves the state template out', () => {
    assert.deepEqual(kit.map((k) => `${k.kind}:${k.name}`).sort(), ['agent:module-planner', 'hook:protected-paths', 'skill:code-review', 'skill:diff-audit', 'skill:release-notes']);
  });

  test('exact duplicate: same content scores 1 and says so', () => {
    const p = find('.agents/skills/release-notes/SKILL.md', 'release-notes');
    assert.ok(p, JSON.stringify(pairs, null, 1));
    assert.equal(p.sameContent, true);
    assert.equal(p.sameName, true);
    assert.equal(p.score, 1);
    assert.match(p.reason, /exact duplicate/);
  });

  test('same name, different content is reported whatever the wording score', () => {
    const p = find('.claude/skills/code-review/SKILL.md', 'code-review');
    assert.ok(p);
    assert.equal(p.sameName, true);
    assert.equal(p.sameContent, false);
    assert.ok(p.score < 1);
    assert.match(p.reason, /same name, different content/);
  });

  test('similar purpose by wording: different names, shared vocabulary above the threshold', () => {
    const p = find('.claude/skills/change-audit/SKILL.md', 'diff-audit');
    assert.ok(p, JSON.stringify(pairs.map((x) => [x.project, x.kitName, x.score]), null, 1));
    assert.equal(p.sameName, false);
    assert.equal(p.sameContent, false);
    assert.ok(p.score >= inv.SIMILAR && p.score < 1, `score ${p.score}`);
    assert.match(p.reason, /similar purpose by wording/);
  });

  test('no overlap: an unrelated item pairs with nothing, and kinds of different families are never compared', () => {
    assert.equal(pairs.filter((p) => p.project === '.agents/skills/deploy-staging/SKILL.md').length, 0);
    assert.equal(pairs.filter((p) => p.project === '.claude/hooks/format.sh' && p.kitKind !== 'hook').length, 0);
    assert.equal(pairs.filter((p) => p.kind === 'skill' && p.kitKind === 'agent').length, 0);
  });

  test('pairs are sorted by score, highest first', () => {
    const scores = pairs.map((p) => p.score);
    assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
  });

  test('report() lists the clashing kit keys', () => {
    const r = inv.report(brownfield(), fakeKit());
    assert.ok(r.clashes.includes('skill:code-review'));
    assert.ok(r.clashes.includes('skill:release-notes'));
    assert.ok(r.clashes.includes('skill:diff-audit'));
    assert.ok(!r.clashes.includes('agent:module-planner'));
  });
});

describe('mode()', () => {
  test('greenfield: an empty repo, and one with only a README', () => {
    const empty = tempDir('green-');
    assert.equal(inv.mode(empty).mode, 'greenfield');
    put(empty, 'README.md', '# New thing\n');
    put(empty, '.gitignore', 'node_modules\n');
    const m = inv.mode(empty);
    assert.equal(m.mode, 'greenfield');
    assert.equal(m.evidence.codeFiles, 0);
    assert.deepEqual(m.evidence.instructionFiles, []);
  });

  test('greenfield: a package.json that only installed the kit is not evidence of a codebase', () => {
    const root = tempDir('green-');
    put(root, 'package.json', JSON.stringify({ name: 'x', devDependencies: { '@geopjinfo/builder-pipeline': 'github:geopjinfo/builder-pipeline#v1' } }));
    const m = inv.mode(root);
    assert.equal(m.mode, 'greenfield', JSON.stringify(m.evidence));
    assert.deepEqual(m.evidence.manifests, ['package.json']);
    assert.deepEqual(m.evidence.countedManifests, []);
  });

  test('greenfield: the profiles persona-detect wrote (roster-listed, plus its library files) are not mode evidence (N1)', () => {
    const root = tempDir('green-');
    put(root, 'package.json', JSON.stringify({ name: 'x', devDependencies: { '@geopjinfo/builder-pipeline': '1.0.0' } }));
    const roster = { personas: [{ id: 'member', set: 'product' }, { id: 'auditor', set: 'governance' }, { id: 'pm', set: 'delivery' }] };
    put(root, 'personas/INDEX.md', `# Personas\n\n\`\`\`json\n${JSON.stringify(roster, null, 2)}\n\`\`\`\n`);
    for (const p of roster.personas) put(root, `personas/${p.set}/${p.id}.md`, `# ${p.id}\n\nA proposed persona.\n`);
    put(root, 'personas/USAGE.md', '# Usage\n');
    put(root, 'personas/WHY.md', '# Why\n');
    const m = inv.mode(root);
    assert.equal(m.mode, 'greenfield', JSON.stringify(m.evidence));
    assert.equal(m.evidence.existingItems, 0);
    assert.equal(m.evidence.personaProfiles, 3);
    // They are still listed for review: only the mode evidence leaves them out.
    assert.equal(inv.inventory(root).filter((i) => i.kind === 'persona').length, 3);
  });

  test('red: a project persona the roster does not list still counts toward brownfield', () => {
    const root = tempDir('brown-');
    put(root, 'personas/INDEX.md', '# Personas\n\n```json\n{ "personas": [{ "id": "member", "set": "product" }] }\n```\n');
    put(root, 'personas/product/member.md', '# member\n\nProposed.\n');
    put(root, 'personas/architect.md', '# Architect\n\nKeeps the module boundaries honest.\n');
    const m = inv.mode(root);
    assert.equal(m.mode, 'brownfield');
    assert.equal(m.evidence.existingItems, 1);
  });

  test('brownfield: own skills and an AGENTS.md, with the evidence named', () => {
    const m = inv.mode(brownfield());
    assert.equal(m.mode, 'brownfield');
    assert.deepEqual(m.evidence.instructionFiles, ['AGENTS.md']);
    assert.equal(m.evidence.existingItems, 7);
    assert.ok(m.evidence.reasons.some((r) => /AGENTS\.md/.test(r)));
  });

  test('brownfield: source code alone is enough', () => {
    const root = tempDir('brown-');
    for (const f of ['a.py', 'b.py', 'c.py']) put(root, join('app2', f), 'print(1)\n');
    const m = inv.mode(root);
    assert.equal(m.mode, 'brownfield');
    assert.equal(m.evidence.codeFiles, 3);
  });
});

describe('scripts/inventory.mjs', () => {
  test('--json prints the report; against the real kit the project code-review is still an item', () => {
    const root = brownfield();
    const r = spawnSync(process.execPath, [join(PACK, 'scripts', 'inventory.mjs'), '--json', '--root', root, '--kit', PACK], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.mode.mode, 'brownfield');
    assert.ok(out.items.some((i) => i.path === '.claude/skills/code-review/SKILL.md'));
    assert.ok(out.kitItems.some((k) => k.kind === 'skill' && k.name === 'build-module-pipeline'));
    assert.ok(out.kitItems.some((k) => k.kind === 'skill' && k.name === 'builder-init'));
  });

  test('the table form names the mode and every item', () => {
    const r = spawnSync(process.execPath, [join(PACK, 'scripts', 'inventory.mjs'), '--root', brownfield(), '--kit', fakeKit()], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^mode: brownfield/);
    assert.match(r.stdout, /code-review/);
    assert.match(r.stdout, /clashing kit items .*skill:code-review/);
  });

  test('red: a bad threshold is refused', () => {
    const r = spawnSync(process.execPath, [join(PACK, 'scripts', 'inventory.mjs'), '--threshold', 'lots', '--kit', PACK], { encoding: 'utf8' });
    assert.equal(r.status, 1);
  });
});
