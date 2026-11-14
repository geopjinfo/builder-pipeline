/**
 * adapters/lib — the per-harness renderers (Claude Code, Codex, Antigravity).
 *
 * WHY. One neutral persona has to become three native agent files without any of them drifting or gaining access
 * the persona did not grant. The Claude Code renderer must stay byte-identical to what `unpack` installs today, so
 * it is compared with a real install of every persona; the others are held to golden fields, a strict TOML check
 * and a red test for a capability typo.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const PACK = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const lib = require('../adapters/lib/index.cjs');
const neutral = require('../adapters/lib/neutral.cjs');
const claude = lib['claude-code'];
const { codex, antigravity } = lib;

const AGENTS = readdirSync(join(PACK, 'agents')).filter((f) => f.endsWith('.md')).sort();
const persona = (f) => readFileSync(join(PACK, 'agents', f), 'utf8');
const temps = [];
after(() => temps.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A throwaway project with the kit at builder/, after a real `unpack --tool claude-code`. */
function installed(extra = []) {
  const root = mkdtempSync(join(tmpdir(), 'adapters-'));
  temps.push(root);
  cpSync(PACK, join(root, 'builder'), { recursive: true, filter: (src) => !/[\\/](?:\.git|node_modules)(?:[\\/]|$)/.test(src) });
  const r = spawnSync(process.execPath, ['builder/cli.js', 'unpack', '--tool', 'claude-code', '--no-extras', ...extra], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, BUILDER_NO_BASH_CAP: '1' },
  });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  return root;
}

/**
 * Strict TOML for what the Codex renderer may write: blank lines, `#` comment lines, and `key = "basic string"`
 * lines with only the escapes TOML and JSON share. No tables, no duplicate keys. Returns the decoded values.
 */
function strictToml(text) {
  const out = {};
  const line = /^([A-Za-z_][A-Za-z0-9_]*) = ("(?:[^"\\\u0000-\u001f\u007f]|\\(?:["\\ntr]|u[0-9A-F]{4}))*")$/;
  for (const [i, l] of text.split('\n').entries()) {
    if (l === '' || l.startsWith('#')) continue;
    const m = l.match(line);
    assert.ok(m, `line ${i + 1} is not key = "string": ${l.slice(0, 80)}`);
    assert.ok(!Object.hasOwn(out, m[1]), `duplicate key ${m[1]}`);
    out[m[1]] = JSON.parse(m[2]);
  }
  return out;
}

/** Antigravity frontmatter → { scalars, tools }. Scalars are JSON strings or bare words. */
function agFrontmatter(text) {
  assert.ok(text.startsWith('---\n'));
  const fm = text.slice(4, text.indexOf('\n---\n', 4)).split('\n');
  const out = { tools: [] };
  for (const l of fm) {
    if (l.startsWith('  - ')) out.tools.push(l.slice(4));
    else if (l === 'tools:') continue;
    else {
      const [, k, v] = l.match(/^(\w+): (.*)$/);
      out[k] = v.startsWith('"') ? JSON.parse(v) : v;
    }
  }
  return out;
}

const EDITS = ['write_to_file', 'replace_file_content', 'multi_replace_file_content'];

test('claude-code renderAgent is byte-identical to a real unpack, for every persona', () => {
  const root = installed();
  for (const f of AGENTS) {
    const r = claude.renderAgent(persona(f), { file: f });
    assert.equal(r.path, `.claude/agents/${f}`);
    assert.equal(r.content, readFileSync(join(root, r.path), 'utf8'), f);
  }
});

test('claude-code renderAgent with --models overrides matches a real unpack with the same overrides', () => {
  const root = installed(['--models', 'strong=big-model,mid=small-model']);
  const models = { strong: 'big-model', mid: 'small-model' };
  for (const f of AGENTS) assert.equal(claude.renderAgent(persona(f), { models, file: f }).content, readFileSync(join(root, '.claude', 'agents', f), 'utf8'), f);
  assert.match(claude.renderAgent(persona('vuln-auditor.md'), { models }).content, /^model: small-model$/m);
  assert.equal(claude.renderAgent(persona('vuln-auditor.md')).path, '.claude/agents/vuln-auditor.md');
});

test('claude-code: skill path, and the hooks block equals the one adapters/claude-code.md documents', () => {
  assert.equal(claude.skillPath('build-module-pipeline'), '.claude/skills/build-module-pipeline/SKILL.md');
  const doc = readFileSync(join(PACK, 'adapters', 'claude-code.md'), 'utf8');
  const block = doc.slice(doc.indexOf('## Settings')).match(/```json\r?\n([\s\S]*?)```/)[1];
  assert.deepEqual(claude.hooksSettings(), JSON.parse(block));
});

test('codex golden: module-planner (read-only, strong) and module-reviewer (one own file)', () => {
  const planner = codex.renderAgent(persona('module-planner.md'), { file: 'module-planner.md' });
  assert.equal(planner.path, '.codex/agents/module-planner.toml');
  assert.equal(planner.access, 'read-only');
  const t = strictToml(planner.content);
  assert.deepEqual(Object.keys(t), ['name', 'description', 'developer_instructions']);
  assert.equal(t.name, 'module-planner');
  assert.equal(t.description, neutral.parsePersona(persona('module-planner.md')).description);
  assert.match(t.developer_instructions, /^Tool limits for this seat \(read-only\): make no file edits/);
  assert.ok(t.developer_instructions.endsWith(neutral.bodyText(neutral.split(persona('module-planner.md')).body)));
  assert.doesNotMatch(planner.content, /sandbox_mode|approval_policy/);

  const withModel = strictToml(codex.renderAgent(persona('module-planner.md'), { models: { strong: 'some-model' } }).content);
  assert.equal(withModel.model, 'some-model');

  const reviewer = codex.renderAgent(persona('module-reviewer.md'));
  assert.equal(reviewer.access, 'own-file');
  assert.match(strictToml(reviewer.content).developer_instructions, /except the ONE file you may write: `\.pipeline\/<moduleKey>\/review-pass<n>\.md`/);

  const docs = strictToml(codex.renderAgent(persona('docs-maintainer.md')).content);
  assert.equal(docs.model_reasoning_effort, 'low');
});

test('codex: every persona renders strict TOML that round-trips its instructions', () => {
  for (const f of AGENTS) {
    const t = strictToml(codex.renderAgent(persona(f), { file: f }).content);
    assert.ok(t.name && t.description && t.developer_instructions, f);
    assert.ok(!t.developer_instructions.includes('\r'), f);
  }
  assert.equal(codex.tomlString('a"b\\c\nd\u0001'), '"a\\"b\\\\c\\nd\\u0001"');
});

test('codex hooks.json: the documented shape, protected-paths on Bash only', () => {
  const h = codex.hooksConfig();
  assert.equal(h.path, '.codex/hooks.json');
  const j = JSON.parse(h.content);
  assert.deepEqual(Object.keys(j.hooks), ['PreToolUse']);
  const [group] = j.hooks.PreToolUse;
  assert.equal(group.matcher, 'Bash');
  assert.equal(group.hooks[0].type, 'command');
  assert.match(group.hooks[0].command, /git rev-parse --show-toplevel\)\/\.codex\/hooks\/protected-paths\.cjs"$/);
});

test('antigravity golden: module-planner and module-reviewer', () => {
  const planner = antigravity.renderAgent(persona('module-planner.md'));
  assert.equal(planner.path, '.agents/agents/module-planner.md');
  const fm = agFrontmatter(planner.content);
  assert.equal(fm.name, 'module-planner');
  assert.equal(fm.model, 'pro');
  assert.equal(fm.mainAgent, 'false');
  assert.deepEqual(fm.tools, ['view_file', 'list_dir', 'find_by_name', 'grep_search', 'run_command']);
  assert.match(planner.content, /\n---\n\nTool limits for this seat \(read-only\)/);
  assert.ok(!planner.content.includes('\r'));

  const reviewer = agFrontmatter(antigravity.renderAgent(persona('module-reviewer.md')).content);
  assert.deepEqual(reviewer.tools.filter((t) => EDITS.includes(t)), ['write_to_file']);
  assert.equal(agFrontmatter(antigravity.renderAgent(persona('vuln-auditor.md')).content).model, 'flash');
  assert.deepEqual(agFrontmatter(antigravity.renderAgent(persona('module-builder.md')).content).tools.filter((t) => EDITS.includes(t)), EDITS);
  assert.equal(agFrontmatter(antigravity.renderAgent(persona('module-planner.md'), { models: { strong: 'not-a-tier' } }).content).model, 'inherit');
  assert.equal(antigravity.hooksConfig(), null);
  assert.ok(antigravity.unconfirmed.some((u) => /^hooks/.test(u)));
});

test('one skill: claude keeps it as is; codex and antigravity share .agents/skills and it is written once', () => {
  const content = readFileSync(join(PACK, 'skills', 'build-module-pipeline.md'), 'utf8');
  assert.deepEqual(claude.renderSkill('build-module-pipeline', content), { path: '.claude/skills/build-module-pipeline/SKILL.md', content });
  const c = codex.renderSkill('build-module-pipeline', content);
  assert.deepEqual(antigravity.renderSkill('build-module-pipeline', content), c);
  assert.equal(c.path, '.agents/skills/build-module-pipeline/SKILL.md');
  assert.equal(c.content, content); // already has name + description
  const files = lib.skillFiles(['claude-code', 'codex', 'antigravity', 'not-a-tool'], [{ name: 'build-module-pipeline', content }]);
  assert.deepEqual(files.map((f) => [f.path, f.tools]), [
    ['.claude/skills/build-module-pipeline/SKILL.md', ['claude-code']],
    ['.agents/skills/build-module-pipeline/SKILL.md', ['codex', 'antigravity']],
  ]);
  assert.match(codex.renderSkill('x', '---\ndescription: d\n---\nbody').content, /^---\nname: x\ndescription: d\n---/);
});

test('red: a capability typo never gains write access in any adapter', () => {
  for (const caps of ['cdoe', 'code, typo', 'Code', 'test_only', 'constructor', '']) {
    const md = `---\nname: typo-seat\ndescription: d\ncapabilities: ${caps}\ntier: strong\n---\nbody\n`;
    assert.match(claude.renderAgent(md).content, /^tools: Read, Grep, Glob, Bash$/m, caps);
    const cx = codex.renderAgent(md);
    assert.equal(cx.access, 'read-only', caps);
    assert.match(strictToml(cx.content).developer_instructions, /^Tool limits for this seat \(read-only\): make no file edits/, caps);
    const ag = agFrontmatter(antigravity.renderAgent(md).content);
    assert.deepEqual(ag.tools.filter((t) => EDITS.includes(t)), [], caps);
  }
  // A publish seat is read-only outside Claude Code, and a `writes:` line on a code seat widens nothing.
  const pub = `---\nname: p\ndescription: d\ncapabilities: read-only, shell, publish\nwrites: x.md\n---\nb\n`;
  assert.equal(codex.renderAgent(pub).access, 'publish');
  assert.deepEqual(agFrontmatter(antigravity.renderAgent(pub).content).tools.filter((t) => EDITS.includes(t)), []);
});
