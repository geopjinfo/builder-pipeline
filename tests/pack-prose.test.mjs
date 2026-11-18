/**
 * The pack's prose holds to the pack's code.
 *
 * WHY. An adopter reads the playbook, the personas and the adapters, and does what they say. A command they name
 * that the pack does not ship, a feature name the settings loader does not know, a step with no "not configured"
 * branch, or a premise the pack has retracted is a defect the unit tests of the scripts cannot see — the scripts
 * are fine; the instructions around them are wrong. These checks read the pack's own files only.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const PACK = join(dirname(fileURLToPath(import.meta.url)), '..');
const profile = require('../scripts/lib/profile.cjs');

const read = (rel) => readFileSync(join(PACK, rel), 'utf8');
const posix = (p) => p.split('\\').join('/');

/** Every markdown file an adopter reads (not tests, not examples, not the history in CHANGELOG). */
function prose() {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      // `.claude/` holds only local state (settings, nested worktrees of this repo); none of it is pack prose.
      if (['.git', '.claude', 'node_modules', 'tests', 'examples'].includes(name)) continue;
      // Maintainer-only files the package never ships (tests/package.test.mjs skip list): the kit's own profile,
      // decision log, deferred registry and module specs name features before the loader knows them.
      if (dir === PACK && ['specs', 'PIPELINE_PROFILE.md', 'DECISIONS.md', 'DEFERRED_TASKS.md'].includes(name)) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.md') && name !== 'CHANGELOG.md') out.push(posix(relative(PACK, p)));
    }
  };
  walk(PACK);
  return out.sort();
}

test('the prose walk skips .claude/: a nested worktree of this repo is never read as pack prose', () => {
  const dir = join(PACK, '.claude', 'worktrees', '_prose-probe');
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(join(dir, 'README.md'), 'Use TodoWrite.');
    assert.deepEqual(prose().filter((f) => f.startsWith('.claude/')), []);
  } finally {
    rmSync(join(PACK, '.claude', 'worktrees', '_prose-probe'), { recursive: true, force: true });
  }
});

const PLAYBOOK = 'skills/build-module-pipeline.md';
/** The playbook plus the reference files it points into (its detail moved there by progressive disclosure). */
const PLAYBOOK_SET = [PLAYBOOK, ...readdirSync(join(PACK, 'skills', 'references')).filter((f) => f.endsWith('.md')).map((f) => `skills/references/${f}`)];
const flat = (text) => text.replace(/`/g, '').replace(/\s+/g, ' ');

test('the prose corpus is not empty', () => {
  const files = prose();
  assert.ok(files.length > 30, `only ${files.length} prose files found`);
  assert.ok(files.includes(PLAYBOOK));
});

test('every `node scripts/<x>.mjs` the prose names is a script the pack ships', () => {
  const missing = [];
  for (const file of prose()) {
    for (const m of read(file).matchAll(/node scripts\/((?:experimental\/)?[\w-]+\.mjs)/g)) {
      const shipped = m[1].startsWith('experimental/')
        ? existsSync(join(PACK, 'tooling', m[1]))
        : existsSync(join(PACK, 'scripts', m[1]));
      if (!shipped) missing.push(`${file}: node scripts/${m[1]}`);
    }
  }
  assert.deepEqual([...new Set(missing)], []);
});

test('every pack file the playbook, personas and adapters point at exists', () => {
  const sources = [...PLAYBOOK_SET, ...prose().filter((f) => f.startsWith('agents/') || f.startsWith('adapters/'))];
  const missing = [];
  for (const file of sources) {
    for (const m of read(file).matchAll(/\b((?:skills\/references|adapters|templates|hooks\/claude-code|agents\/experimental|tooling\/experimental)\/[\w.-]+\.(?:md|js|cjs|mjs)|EXPERIMENTS\.md)\b/g)) {
      if (!existsSync(join(PACK, m[1]))) missing.push(`${file}: ${m[1]}`);
    }
  }
  assert.deepEqual([...new Set(missing)], []);
});

/**
 * Premises the pack has retracted. The changelog keeps them as history; nowhere else may assert them.
 *   - nesting: harnesses may nest subagents; the no-nested-run rule rests on run ↔ branch ↔ board.
 *   - the handoff is a pack FILE with sections, not a table in a chat report.
 *   - the board is the one progress surface; there is no harness to-do mirror.
 */
test('no prose asserts a retracted premise', () => {
  const retracted = [/subagents cannot spawn subagents/i, /\bhandoff table\b/i, /\bTodoWrite\b/, /mirror the rows/i];
  const hits = [];
  for (const file of prose()) {
    read(file)
      .split(/\r?\n/)
      .forEach((line, i) => {
        for (const re of retracted) if (re.test(line)) hits.push(`${file}:${i + 1} ${re}`);
      });
  }
  assert.deepEqual(hits, []);
});

test('no persona pastes a command-shaped graph query — they point at the one query block', () => {
  const shaped = /\bgraphify\s+(?:query|explain|path|affected)\b|graph\.mjs/;
  const hits = prose()
    .filter((f) => f.startsWith('agents/'))
    .filter((f) => shaped.test(read(f)));
  assert.deepEqual(hits, []);
});

const frontmatter = (rel) => {
  const text = read(rel);
  const end = text.indexOf('---', 4);
  const fm = text.slice(4, end);
  const get = (k) => ((fm.match(new RegExp(`^${k}:\\s*(.*)$`, 'm')) || [])[1] || '').split('#')[0].trim();
  return { get };
};

test('seat frontmatter carries what the ports decided', () => {
  const keeper = frontmatter('agents/experimental/page-keeper.md');
  const caps = keeper.get('capabilities').split(',').map((c) => c.trim());
  assert.ok(caps.includes('publish'), `keeper capabilities: ${caps}`);
  for (const writer of ['code', 'docs', 'test-only']) assert.ok(!caps.includes(writer), `the keeper must never write — found ${writer}`);
  assert.equal(keeper.get('writes'), '');

  const reviewer = frontmatter('agents/module-reviewer.md');
  assert.equal(reviewer.get('capabilities'), 'read-only');
  assert.match(reviewer.get('writes'), /review-pass<n>\.md$/);

  assert.equal(frontmatter('agents/docs-maintainer.md').get('effort'), 'low');
  assert.equal(frontmatter('agents/module-tester.md').get('tier'), 'strong');
});

test('the codex and generic adapters say what every Claude-Code-only step becomes', () => {
  const rows = ['Bash output cap hook', 'Session-start index refresh', 'Subagent spawn depth 1', 'Orchestrator model check', 'Per-seat cost accounting', 'Live page'];
  for (const file of ['adapters/codex.md', 'adapters/generic.md']) {
    const text = read(file);
    for (const row of rows) assert.ok(text.includes(row), `${file} has no line for "${row}"`);
    assert.match(text, /registry/i, `${file} says nothing about the registry read guard`);
    assert.match(text, /reviewer/i, `${file} says nothing about the reviewer's single file`);
  }
  const claude = read('adapters/claude-code.md');
  for (const hook of readdirSync(join(PACK, 'hooks', 'claude-code'))) assert.ok(claude.includes(hook), `adapters/claude-code.md does not wire ${hook}`);
});

test('the profile template parses, and its only problems are the placeholders an adopter fills', () => {
  const { found, errors } = profile.parse(read('PIPELINE_PROFILE.template.md'));
  assert.equal(found, true);
  assert.ok(errors.length > 0, 'an unfilled template must not validate');
  assert.deepEqual(errors.filter((e) => !e.includes('unfilled placeholder')), []);
});

test('every optional step in the playbook has its "not configured" line', () => {
  // The playbook or the reference file its step points at: most optional steps' detail lives in skills/references/.
  const text = PLAYBOOK_SET.map((f) => flat(read(f))).join(' ');
  const optional = [
    'graph', 'orchestratorModel', 'planSchema', 'citations', 'builderBatch', 'claims', 'lineCitations', 'wiring', 'mutation', 'rules',
    'findingsSchema', 'reviewTemplate', 'specTrace', 'contractOracle', 'ratchets', 'fixLane', 'decisionIndex', 'instructionBudget', 'instructionLint', 'worktreeSweep',
  ];
  for (const name of optional) assert.ok(text.includes(`${name}: not configured`), `${PLAYBOOK} has no "${name}: not configured" branch`);
});

test('every features.<name> the prose names is a feature the settings loader knows', () => {
  const unknown = [];
  for (const file of prose()) {
    // `features.mjs` is the script's file name, not a setting: a captured file extension is skipped.
    for (const m of read(file).matchAll(/(?<![\w/\\])features\.([A-Za-z]+)/g)) {
      if (['mjs', 'cjs', 'js', 'md', 'json'].includes(m[1])) continue;
      if (!profile.FEATURES[m[1]]) unknown.push(`${file}: features.${m[1]}`);
    }
  }
  assert.deepEqual([...new Set(unknown)], []);
});

test('REQ-405 GUIDE states what a worktree does not do: no process sandbox, no merge-conflict prevention (D50)', () => {
  const guide = flat(read('GUIDE.md'));
  assert.match(guide, /worktree separates working files; it does not sandbox processes and it does not prevent merge conflicts/i);
});

describe('REQ-1613 — the orchestrator skill starts the reporter beside board-watch (AC-1613c)', () => {
  test('red: skills/orchestrator.md names features.reporter and the report --watch command', () => {
    const text = flat(read('skills/orchestrator.md'));
    assert.match(text, /features\.reporter/);
    assert.match(text, /run report --watch/);
    assert.match(text, /board-watch/);
  });
});

describe('REQ-1833, REQ-1845 to REQ-1848 — the completion gate is wired into the prose', () => {
  const STAGING = [/never git add \. or git add -A/, /git diff --cached --name-status/, /plain commit message/, /no\s+attribution trailer and no generated-content footer/, /hygiene --gate/];

  test('red: AC-1833, AC-1845 Phase 7 runs the report then the gate; a FAIL row is a FIX row and the module stays open; off is not configured', () => {
    const text = flat(read(PLAYBOOK));
    assert.match(text, /node scripts\/hygiene\.mjs --since <base> --json/);
    assert.match(text, /node scripts\/hygiene\.mjs --gate --since <base> --json/);
    assert.match(text, /FAIL row opens one FIX-n row per failing gate and the module stays open/);
    assert.match(text, /hygiene: not configured/);
    const readiness = flat(read('skills/module-readiness-check.md'));
    assert.match(readiness, /run hygiene --since <base> --json/);
    assert.match(readiness, /completion gate: PASS, FAIL .* or not configured/);
    assert.match(readiness, /hygiene: not configured \(not a pass\)/);
  });

  test('red: AC-1845 the orchestrator skill names hygiene-gate in gates, the refusal on FAIL, the steward for soft findings and the SWEEP offer', () => {
    const text = flat(read('skills/orchestrator.md'));
    assert.match(text, /hygiene-gate.*features\.orchestrator\.gates/);
    assert.match(text, /A FAIL row refuses the merge/);
    assert.match(text, /repo-steward/);
    assert.match(text, /SWEEP branches/);
    assert.match(text, /never names --apply/);
  });

  test('red: AC-1846 builder-init proposes the allow list from builder.lock.json and the two checks on, and writes nothing before the confirm gate', () => {
    const text = flat(read('skills/builder-init.md'));
    assert.match(text, /features\.artifactCheck\.allow.*builder\.lock\.json/);
    assert.match(text, /features\.attributionCheck and features\.artifactCheck \*\*on\*\* when §16 has features\.orchestrator on/);
    assert.match(text, /Propose only; nothing is written before Step 4/);
    assert.match(text, /arms neither/);
  });

  test('red: AC-1847 the four skills, the worker brief and the repo-steward persona carry the staging and commit rules', () => {
    for (const file of [PLAYBOOK, 'skills/build-module-lite-gate-batch.md', 'skills/orchestrator.md', 'skills/references/close-out.md', 'templates/orchestrator-worker-brief.md', 'agents/repo-steward.md']) {
      const text = flat(read(file));
      for (const re of STAGING) assert.match(text, re, `${file} lacks ${re}`);
    }
    const steward = flat(read('agents/repo-steward.md'));
    assert.match(steward, /separation/i);
    assert.match(steward, /terminology|model .* only where the product needs it/i);
    assert.match(steward, /never edit/i);
  });

  test('red: AC-1848 GUIDE has the "Repo hygiene and the completion gate" section with the seven rows and the limits; USAGE, FEATURES, llms.txt and the changelog name the gate', () => {
    const guide = read('GUIDE.md');
    const section = guide.slice(guide.indexOf('## 🧹 Repo hygiene and the completion gate'), guide.indexOf('## ⬆️ From 1.x'));
    assert.ok(section.length > 500, 'the section exists before "From 1.x"');
    for (const row of ['file scope', 'ignore rules', 'secrets', 'staging', 'commit', 'delivery', 'separation']) assert.match(section, new RegExp(`^\\| ${row} \\|`, 'm'), row);
    assert.match(section, /remove nothing and rewrite no history/);
    assert.match(section, /never erased to pass a check/);
    assert.match(section, /NOT CONFIGURED` is never a pass/);
    assert.match(read('USAGE.md'), /## Completion gate \(`run hygiene --gate`\)/);
    assert.match(read('FEATURES.md'), /^\| Completion gate \|/m);
    assert.match(read('FEATURES.md'), /^\| Hygiene runner \|/m);
    assert.match(read('llms.txt'), /Repo hygiene and the completion gate/);
    assert.match(read('CHANGELOG.md'), /M21 completion gate, part 2/);
  });
});
