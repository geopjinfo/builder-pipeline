/**
 * The pipeline skill is kept short by progressive disclosure: its detail lives in skills/references/<topic>.md, and
 * the skill points at each file with a relative `references/<file>.md` link at the step that needs it.
 *
 * WHY. A pointer to a file that did not install is a step the agent cannot follow, and nothing else would notice:
 * the skill still reads fine. Native tools install the references beside the skill
 * (`.claude/skills/build-module-pipeline/references/`, `.agents/skills/build-module-pipeline/references/`), dotBuilder
 * tools beside the playbook (`.builder/playbooks/references/`), so the same relative link must resolve in every
 * layout. And the skill must stay short — the whole point of the split; it is held under 400 lines here.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const PACK = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKILL = join(PACK, 'skills', 'build-module-pipeline.md');
const REFS = readdirSync(join(PACK, 'skills', 'references')).filter((f) => f.endsWith('.md'));
const MAX_LINES = 400;

/** Relative `references/<file>` links — not the kit-path form `builder/skills/references/<file>`. */
const links = (text) => [...new Set([...text.matchAll(/(?<![\w/.-])references\/([\w.-]+\.md)/g)].map((m) => m[1]))];

const made = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

describe('the pipeline skill and its reference files (kit source)', () => {
  const text = readFileSync(SKILL, 'utf8');

  test(`the skill stays under ${MAX_LINES} lines`, () => {
    const lines = text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n').length;
    assert.ok(lines < MAX_LINES, `skills/build-module-pipeline.md is ${lines} lines`);
  });

  test('every references/<file> link in the skill names a file in skills/references/', () => {
    const found = links(text);
    assert.ok(found.length >= 5, `only ${found.length} reference links found — the pointers went missing`);
    assert.deepEqual(found.filter((f) => !REFS.includes(f)), []);
  });

  test('every reference file is pointed at from the skill (no orphan detail)', () => {
    const named = new Set([...links(text), ...[...text.matchAll(/skills\/references\/([\w.-]+\.md)/g)].map((m) => m[1])]);
    assert.deepEqual(REFS.filter((f) => !named.has(f)), []);
  });
});

describe('installed as a package with --tool all, every reference link resolves', () => {
  const proj = mkdtempSync(join(tmpdir(), 'kit-refs-'));
  made.push(proj);
  const kit = join(proj, 'node_modules', '@geopjinfo', 'builder-pipeline');
  mkdirSync(kit, { recursive: true });
  cpSync(PACK, kit, { recursive: true, filter: (src) => !/[\\/](?:\.git|tests|node_modules)(?:[\\/]|$)/.test(`/${relative(PACK, src)}`) });
  const r = spawnSync(process.execPath, [join(kit, 'cli.js'), 'unpack', '--tool', 'all'], { cwd: proj, encoding: 'utf8' });

  const layouts = [
    '.claude/skills/build-module-pipeline/SKILL.md',
    '.agents/skills/build-module-pipeline/SKILL.md',
    '.builder/playbooks/build-module-pipeline.md',
  ];

  test('unpack --tool all succeeds', () => {
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  });

  for (const rel of layouts) {
    test(`${rel}: every references/<file> link exists beside it, and every reference file installed`, () => {
      const file = join(proj, rel);
      assert.ok(existsSync(file), `${rel} was not installed`);
      const dir = dirname(file);
      const found = links(readFileSync(file, 'utf8'));
      assert.ok(found.length >= 5, `${rel}: only ${found.length} reference links`);
      assert.deepEqual(found.filter((f) => !existsSync(join(dir, 'references', f))), [], `${rel}: links that do not resolve`);
      assert.deepEqual(REFS.filter((f) => !existsSync(join(dir, 'references', f))), [], `${rel}: reference files not installed`);
    });
  }

  test('every installed SKILL.md and playbook: each references/<file> link resolves beside it', () => {
    const files = [];
    for (const base of ['.claude/skills', '.agents/skills']) {
      const root = join(proj, base);
      if (!existsSync(root)) continue;
      for (const d of readdirSync(root)) if (existsSync(join(root, d, 'SKILL.md'))) files.push(join(base, d, 'SKILL.md'));
    }
    const pb = join(proj, '.builder', 'playbooks');
    if (existsSync(pb)) for (const f of readdirSync(pb)) if (f.endsWith('.md')) files.push(join('.builder', 'playbooks', f));
    assert.ok(files.length >= 3, `only ${files.length} installed skills/playbooks found`);
    const broken = [];
    for (const rel of files) {
      const dir = dirname(join(proj, rel));
      for (const f of links(readFileSync(join(proj, rel), 'utf8'))) if (!existsSync(join(dir, 'references', f))) broken.push(`${rel}: references/${f}`);
    }
    assert.deepEqual(broken, []);
  });
});
