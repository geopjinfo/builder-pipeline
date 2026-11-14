/**
 * The persona detector: the roster block parses, validate() names every problem, a confirmed persona renders to a
 * neutral read-only agent and an unconfirmed one never does, a refresh never overwrites a confirmed persona, and
 * the skill's prose carries the confirm gate and the never-overwrite rule.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const PACK = join(dirname(fileURLToPath(import.meta.url)), '..');
const lib = require('../scripts/lib/personas.cjs');

const entry = (over = {}) => ({ id: 'end-user', name: 'End user', set: 'product', confirmed: true, routes: ['journey-review'], ...over });
const index = (roster) => `# Persona roster\n\nSome prose.\n\n\`\`\`json\n${JSON.stringify(roster, null, 2)}\n\`\`\`\n`;
const profile = (seed = 'You are the end user. Walk the journey and complain.') =>
  `# End user — product\n\n## Role and mandate\n\nGets the job done without reading a manual.\n\n## Agent seed\n\n\`\`\`\n${seed}\n\`\`\`\n\n## Grounding\n\n| Claim | Status | Source |\n`;

describe('parseRoster', () => {
  test('green: reads the one roster block, ignoring other json blocks', () => {
    const md = `\`\`\`json\n{"other": 1}\n\`\`\`\n\n${index({ personas: [entry()] })}`;
    assert.deepEqual(lib.parseRoster(md), { personas: [entry()] });
  });
  test('green: CRLF text parses', () => {
    assert.equal(lib.parseRoster(index({ personas: [entry()] }).replace(/\n/g, '\r\n')).personas.length, 1);
  });
  test('red: no roster block throws, never reads as empty', () => {
    assert.throws(() => lib.parseRoster('# Persona roster\n\nno block here\n'), /no roster block/);
  });
  test('red: a roster block that is not JSON throws', () => {
    assert.throws(() => lib.parseRoster('```json\n{"personas": [ {"id": ]}\n```\n'), /not valid JSON/);
  });
  test('red: two roster blocks throw', () => {
    const md = index({ personas: [] }) + index({ personas: [entry()] });
    assert.throws(() => lib.parseRoster(md), /2 roster blocks/);
  });
});

describe('validate', () => {
  test('green: a complete roster has no problems', () => {
    const roster = { personas: [entry(), entry({ id: 'owner', name: 'Owner', set: 'governance', confirmed: false, routes: [] })] };
    assert.deepEqual(lib.validate(roster, { fileExists: () => true }), []);
  });
  test('red: duplicate ids', () => {
    const problems = lib.validate({ personas: [entry(), entry()] });
    assert.ok(problems.some((p) => /duplicate id "end-user"/.test(p)), problems.join('\n'));
  });
  test('red: missing fields are each named', () => {
    const problems = lib.validate({ personas: [{ id: 'x' }] });
    for (const field of ['name', 'set', 'confirmed', 'routes']) assert.ok(problems.some((p) => p.includes(`missing field "${field}"`)), field);
  });
  test('red: an unconfirmed persona marked for rendering', () => {
    const problems = lib.validate({ personas: [entry({ confirmed: false, render: true })] });
    assert.ok(problems.some((p) => /marked to render but not confirmed/.test(p)), problems.join('\n'));
  });
  test('green: a confirmed persona marked for rendering is fine', () => {
    assert.deepEqual(lib.validate({ personas: [entry({ render: true })] }), []);
  });
  test('red: a profile file missing', () => {
    const problems = lib.validate({ personas: [entry()] }, { fileExists: (rel) => rel !== 'product/end-user.md' });
    assert.ok(problems.some((p) => /profile file missing — product\/end-user\.md/.test(p)), problems.join('\n'));
  });
  test('red: a bad set, a non-slug id, a file outside personas/', () => {
    const problems = lib.validate({ personas: [entry({ set: 'staff' }), entry({ id: 'Bad Id' }), entry({ id: 'esc', file: '../x.md' })] });
    assert.ok(problems.some((p) => /set must be one of/.test(p)));
    assert.ok(problems.some((p) => /lower-case slug/.test(p)));
    assert.ok(problems.some((p) => /inside personas/.test(p)));
  });
  test('red: no personas array', () => {
    assert.deepEqual(lib.validate({}), ['the roster has no "personas" array']);
  });
});

describe('toNeutralAgent', () => {
  test('green: a confirmed persona renders a neutral read-only agent', () => {
    const text = lib.toNeutralAgent(profile(), entry({ routes: ['journey-review', 'acceptance-walkthrough'] }));
    const fm = text.slice(4, text.indexOf('---', 4));
    assert.match(fm, /^name: persona-end-user$/m);
    assert.match(fm, /^description: Use when a task is one of: journey-review, acceptance-walkthrough\..*never evidence/m);
    assert.match(fm, /^capabilities: read-only$/m);
    assert.match(fm, /^tier: mid$/m);
    assert.equal(fm.split('\n').filter((l) => l.startsWith('description:')).length, 1, 'the description is one line');
    assert.match(text, /You are the end user\. Walk the journey and complain\./);
    assert.doesNotMatch(text, /## Grounding/, 'only the seed is the body');
  });
  test('green: the entry tier is carried', () => {
    assert.match(lib.toNeutralAgent(profile(), entry({ tier: 'strong' })), /^tier: strong$/m);
  });
  test('red: an unconfirmed persona never renders', () => {
    assert.throws(() => lib.toNeutralAgent(profile(), entry({ confirmed: false })), /not confirmed/);
  });
  test('red: a profile without an Agent seed block', () => {
    assert.throws(() => lib.toNeutralAgent('# End user\n\n## Role and mandate\n\nx\n', entry()), /no Agent seed/);
  });
});

describe('mergeProposal (refresh)', () => {
  test('a confirmed persona is never overwritten; its proposed change is returned, not applied', () => {
    const existing = { personas: [entry({ render: true })] };
    const proposed = { personas: [entry({ confirmed: false, routes: ['journey-review', 'pricing-review'] }), entry({ id: 'auditor', name: 'Auditor', set: 'governance', confirmed: true, routes: ['sign-off'] })] };
    const { roster, added, changes, kept } = lib.mergeProposal(existing, proposed);
    assert.deepEqual(roster.personas[0], entry({ render: true }));
    assert.deepEqual(kept, ['end-user']);
    assert.deepEqual(changes, [{ id: 'end-user', field: 'routes', from: ['journey-review'], to: ['journey-review', 'pricing-review'] }]);
    assert.deepEqual(added, ['auditor']);
    assert.equal(roster.personas[1].confirmed, false, 'an addition is never confirmed by the detector');
    assert.equal(roster.personas[1].render, false);
  });
  test('an unconfirmed existing entry is replaced by the proposal; an entry absent from the proposal stays', () => {
    const existing = { personas: [entry({ confirmed: false, name: 'Old name' }), entry({ id: 'owner', name: 'Owner', set: 'governance', confirmed: false })] };
    const { roster } = lib.mergeProposal(existing, { personas: [entry({ confirmed: false, name: 'New name' })] });
    assert.equal(roster.personas[0].name, 'New name');
    assert.equal(roster.personas[1].id, 'owner');
  });
});

describe('personas-check CLI', () => {
  const run = (cwd, ...args) => spawnSync(process.execPath, [join(PACK, 'scripts', 'personas-check.mjs'), ...args], { cwd, encoding: 'utf8' });
  const setup = (roster, files = {}) => {
    const root = mkdtempSync(join(tmpdir(), 'personas-'));
    mkdirSync(join(root, 'personas', 'product'), { recursive: true });
    writeFileSync(join(root, 'personas', 'INDEX.md'), index(roster));
    for (const [rel, text] of Object.entries(files)) writeFileSync(join(root, 'personas', rel), text);
    return root;
  };

  test('no personas/ is said, exit 0', () => {
    const root = mkdtempSync(join(tmpdir(), 'personas-'));
    try {
      const r = run(root);
      assert.equal(r.status, 0);
      assert.match(r.stdout, /nothing to check/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test('red: a problem exits 1 and renders nothing', () => {
    const root = setup({ personas: [entry({ confirmed: false, render: true })] }, { 'product/end-user.md': profile() });
    try {
      const r = run(root, '--render', 'out');
      assert.equal(r.status, 1, r.stderr);
      assert.match(r.stderr, /not confirmed/);
      assert.ok(!existsSync(join(root, 'out', 'persona-end-user.md')));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test('green: PASS, and --render writes only confirmed + render entries', () => {
    const roster = { personas: [entry({ render: true }), entry({ id: 'guest', name: 'Guest', confirmed: true, render: false })] };
    const root = setup(roster, { 'product/end-user.md': profile(), 'product/guest.md': profile('You are a guest.') });
    try {
      const r = run(root, '--render', 'out');
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /PASS — 2 persona\(s\), 2 confirmed, 1 rendered/);
      assert.match(readFileSync(join(root, 'out', 'persona-end-user.md'), 'utf8'), /^capabilities: read-only$/m);
      assert.ok(!existsSync(join(root, 'out', 'persona-guest.md')));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test('red: a missing roster block exits 2', () => {
    const root = mkdtempSync(join(tmpdir(), 'personas-'));
    mkdirSync(join(root, 'personas'));
    writeFileSync(join(root, 'personas', 'INDEX.md'), '# no block\n');
    try {
      assert.equal(run(root).status, 2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the skill and its templates', () => {
  const skill = readFileSync(join(PACK, 'skills', 'persona-detect.md'), 'utf8').replace(/\r\n/g, '\n');
  const flat = skill.replace(/`/g, '').replace(/\s+/g, ' ');

  test('frontmatter names the skill and describes it', () => {
    assert.match(skill, /^---\nname: persona-detect\ndescription: Use to .+\n---\n/);
  });
  test('names the human confirm gate', () => {
    assert.match(flat, /Nothing becomes an agent before the human confirms it/);
    assert.match(flat, /Silence is not a confirm/);
    assert.match(flat, /"confirmed": false/);
  });
  test('names the refresh never-overwrite rule', () => {
    assert.match(flat, /proposes additions and changes only/);
    assert.match(flat, /never overwritten/);
  });
  test('keeps the core rule, the markers, the fence and the refusal list', () => {
    assert.match(flat, /A persona is a thinking tool\. It is never evidence\./);
    for (const marker of ['Traced', 'Derived', 'Invented']) assert.ok(flat.includes(`**${marker}**`), marker);
    assert.match(flat, /Fence it before you fill it/);
    assert.match(flat, /Refused/);
    assert.match(flat, /every researched claim is Derived and carries its URL/i);
    assert.match(flat, /Offline/);
  });
  test('documents every roster field the library knows', () => {
    for (const field of ['id', 'name', 'set', 'confirmed', 'routes', 'file', 'render', 'tier']) assert.ok(flat.includes(`| ${field} |`), field);
  });
  test('every template the skill copies ships, and the INDEX template roster parses and validates', () => {
    for (const f of ['WHY.md', 'USAGE.md', 'INDEX.md', '_census.md', '_TEMPLATE.md']) assert.ok(existsSync(join(PACK, 'templates', 'personas', f)), f);
    const roster = lib.parseRoster(readFileSync(join(PACK, 'templates', 'personas', 'INDEX.md'), 'utf8'));
    assert.deepEqual(lib.validate(roster), []);
  });
  test('the profile template carries every section the detector requires', () => {
    const headings = readFileSync(join(PACK, 'templates', 'personas', '_TEMPLATE.md'), 'utf8')
      .split(/\r?\n/)
      .filter((l) => l.startsWith('## '))
      .map((l) => l.toLowerCase());
    for (const h of ['Role and mandate', 'Goals', 'Decisions owned', 'Expertise', 'do NOT know', 'When to consult', 'Routing hints', 'Agent seed', 'Grounding']) {
      assert.ok(headings.some((l) => l.includes(h.toLowerCase())), h);
    }
  });
});
