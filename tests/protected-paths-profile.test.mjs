/**
 * The protected-paths hook also reads PIPELINE_PROFILE.md §16 `protected` — ADD-ONLY.
 *
 * §16 can add prefixes; it can never remove the hook's filled list, a BUILDER_PROTECTED addition or the hook's own
 * self-protection. A profile that is missing, unreadable or malformed leaves the hook exactly as strict as without
 * it. The profile is parsed as DATA by the hook itself (no profile code is loaded, from node_modules or anywhere),
 * so the copy unpack puts in .claude/hooks/ works with node_modules gone. While §16 adds anything, the profile is
 * itself protected (BUILDER_UNLOCK=fence opens it, as for the hook), so an agent cannot shrink the list it reads.
 * Every lab is a fresh os.tmpdir() folder; nothing here touches this checkout.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const PACK = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = join(PACK, 'hooks', 'protected-paths.cjs');
const guard = require(HOOK);

const made = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
const slash = (p) => p.replace(/\\/g, '/');

function lab(profile) {
  const proj = mkdtempSync(join(tmpdir(), 'fence-profile-'));
  made.push(proj);
  for (const d of ['.git', 'src/secret', 'src/open', 'docs']) mkdirSync(join(proj, d), { recursive: true });
  if (profile !== undefined) writeFileSync(join(proj, 'PIPELINE_PROFILE.md'), profile);
  return proj;
}
const settings = (obj) => `# Profile\n\n## 16. Pipeline settings\n\n\`\`\`json pipeline-settings\n${JSON.stringify(obj, null, 2)}\n\`\`\`\n`;
const env = (proj, over = {}) => ({ CLAUDE_PROJECT_DIR: proj, BUILDER_PROTECTED: '', BUILDER_UNLOCK: '', ...over });
const cfg = (proj, over) => guard.config(env(proj, over), proj);
const write = (p) => ({ tool_name: 'Write', tool_input: { file_path: p } });
const sh = (command) => ({ tool_name: 'Bash', tool_input: { command } });
const blocks = (payload, c) => guard.decide(payload, c).block;

describe('§16 protected adds prefixes', () => {
  test('red: a §16 path is refused; a path outside it is not', () => {
    const proj = lab(settings({ schema: 2, protected: ['src/secret/**'] }));
    const c = cfg(proj);
    assert.ok(c.prefixes.includes('src/secret/'), JSON.stringify(c.prefixes));
    assert.equal(blocks(write(slash(join(proj, 'src/secret/a.ts'))), c), true);
    assert.equal(blocks(write('src/secret/a.ts'), c), true, 'spelled relative');
    assert.equal(blocks(sh('echo x > src/secret/a.ts'), c), true, 'a shell write');
    assert.equal(blocks(write(slash(join(proj, 'src/open/a.ts'))), c), false, 'control');
  });

  test('a glob becomes the directory before its first wildcard; what a prefix cannot hold is skipped, never widened to the root', () => {
    const p = guard.profileProtected;
    const one = (g) => p(lab(settings({ protected: [g] })));
    assert.deepEqual(one('docs/**'), ['docs/']);
    assert.deepEqual(one('src/**/gen/*.ts'), ['src/']);
    assert.deepEqual(one('./lib/core/'), ['lib/core/']);
    assert.deepEqual(one('db\\migrations\\*.sql'), ['db/migrations/']);
    assert.deepEqual(one('LICENSE'), ['LICENSE']);
    for (const g of ['*.md', '**', '.env*', '<glob>', '../outside/', '/etc/', 'C:/x/', 'a/../../b/', '', '   ']) assert.deepEqual(one(g), [], JSON.stringify(g));
  });
});

describe('§16 can never remove protection', () => {
  test('red: BUILDER_PROTECTED and the hook itself stay protected whatever §16 says', () => {
    for (const profile of [settings({ protected: [] }), settings({ protected: ['src/secret/'] }), settings({ protected: ['!docs/'] }), settings({ protected: ['docs/'], unprotect: ['docs/'] })]) {
      const proj = lab(profile);
      const c = cfg(proj, { BUILDER_PROTECTED: 'docs/' });
      assert.ok(c.prefixes.includes('docs/'), profile);
      assert.equal(blocks(write(slash(join(proj, 'docs/a.md'))), c), true, profile);
      assert.equal(blocks(write(HOOK), c), true, `the hook itself: ${profile}`);
    }
  });

  test('red: the filled list in an installed copy survives a §16 that lists nothing or something else', () => {
    const proj = lab(settings({ protected: ['src/secret/'] }));
    const hooks = join(proj, '.claude', 'hooks');
    mkdirSync(hooks, { recursive: true });
    const src = readFileSync(HOOK, 'utf8');
    const filled = src.replace(/const PROTECTED = \[\r?\n/, "const PROTECTED = [\n  'docs/',\n");
    assert.notEqual(filled, src, 'the PROTECTED list moved — update this test');
    writeFileSync(join(hooks, 'protected-paths.cjs'), filled);
    const run = (payload) => spawnSync(process.execPath, [join(hooks, 'protected-paths.cjs')], { input: JSON.stringify(payload), cwd: proj, encoding: 'utf8', env: { ...process.env, ...env(proj) } });
    assert.equal(run(write(slash(join(proj, 'docs/a.md')))).status, 2, 'built-in');
    assert.equal(run(write(slash(join(proj, 'src/secret/a.ts')))).status, 2, '§16');
    assert.equal(run(write(slash(join(proj, 'src/open/a.ts')))).status, 0, 'control');
  });
});

describe('a missing, unreadable or malformed profile is the same as no profile', () => {
  const baseline = (over) => {
    const proj = lab();
    return cfg(proj, over);
  };
  const cases = {
    'no settings block': '# Profile\n\nno block here\n',
    'invalid JSON': '```json pipeline-settings\n{ "protected": ["src/secret/", }\n```\n',
    'two blocks': `${settings({ protected: ['src/secret/'] })}\n${settings({ protected: ['src/open/'] })}`,
    'not an object': '```json pipeline-settings\n["src/secret/"]\n```\n',
    'protected not an array': settings({ protected: 'src/secret/' }),
    'a non-string entry': settings({ protected: ['src/secret/', 7] }),
    'binary junk': '\u0000\u0001```json pipeline-settings\n\u0000\n```',
  };
  for (const [name, text] of Object.entries(cases)) {
    test(`red: ${name} — the prefixes are exactly the no-profile ones, and nothing is thrown`, () => {
      for (const over of [{}, { BUILDER_PROTECTED: 'docs/' }]) {
        const proj = lab(text);
        const c = cfg(proj, over);
        assert.deepEqual(c.prefixes, baseline(over).prefixes);
        assert.equal(blocks(write(slash(join(proj, 'src/secret/a.ts'))), c), false);
        if (over.BUILDER_PROTECTED) assert.equal(blocks(write(slash(join(proj, 'docs/a.md'))), c), true, 'still as strict');
      }
    });
  }
  test('red: a profile that is a directory, or a project dir that does not exist, does not crash and adds nothing', () => {
    const proj = lab();
    mkdirSync(join(proj, 'PIPELINE_PROFILE.md'));
    assert.deepEqual(cfg(proj).prefixes, []);
    assert.deepEqual(guard.config(env(join(proj, 'nope')), proj).prefixes, []);
  });
  test('red: a profile over the size cap is ignored (read as unreadable), not parsed', () => {
    const proj = lab(settings({ protected: ['src/secret/'] }) + 'x'.repeat(2 * 1024 * 1024));
    assert.deepEqual(cfg(proj).prefixes, []);
  });
  test('the hook process exits 0 on a malformed profile with nothing else protected', () => {
    const proj = lab('```json pipeline-settings\n{ nope\n```\n');
    const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(write(slash(join(proj, 'src/secret/a.ts')))), cwd: proj, encoding: 'utf8', env: { ...process.env, ...env(proj) } });
    assert.equal(r.status, 0, r.stderr);
  });
});

describe('the profile cannot be shrunk by an agent while §16 adds anything', () => {
  const proj = lab(settings({ protected: ['src/secret/'] }));
  const profile = slash(join(proj, 'PIPELINE_PROFILE.md'));
  test('red: a write to the profile is refused; BUILDER_UNLOCK=fence (a human grant) opens it', () => {
    assert.equal(blocks(write(profile), cfg(proj)), true);
    assert.equal(blocks(write('PIPELINE_PROFILE.md'), cfg(proj)), true);
    assert.equal(blocks(sh('echo "{}" > PIPELINE_PROFILE.md'), cfg(proj)), true);
    const r = guard.decide(write(profile), cfg(proj));
    assert.match(r.reason, /BUILDER_UNLOCK=fence/);
    assert.equal(blocks(write(profile), cfg(proj, { BUILDER_UNLOCK: 'fence' })), false);
    assert.equal(blocks(write(slash(join(proj, 'src/secret/a.ts'))), cfg(proj, { BUILDER_UNLOCK: 'fence' })), true, 'the grant opens the profile, not the §16 paths');
  });
  test('red: removing, moving or restoring the profile from the shell is refused; reading it is not', () => {
    const c = cfg(proj);
    for (const cmd of ['rm PIPELINE_PROFILE.md', 'rm -f ./PIPELINE_PROFILE.md', 'mv PIPELINE_PROFILE.md /tmp/p.md', 'git rm PIPELINE_PROFILE.md', 'git checkout HEAD~3 -- PIPELINE_PROFILE.md', 'git restore PIPELINE_PROFILE.md', 'Remove-Item PIPELINE_PROFILE.md', 'del PIPELINE_PROFILE.md', 'cd docs && rm ../PIPELINE_PROFILE.md']) {
      assert.equal(blocks(sh(cmd), c), true, cmd);
    }
    for (const cmd of ['cat PIPELINE_PROFILE.md', 'grep -n protected PIPELINE_PROFILE.md', 'git diff PIPELINE_PROFILE.md', 'rm notes.md']) assert.equal(blocks(sh(cmd), c), false, cmd);
  });
  test('trade-off: with §16 protected empty the profile is not fenced (an edit there can only ADD protection)', () => {
    const open = lab(settings({ protected: [] }));
    assert.equal(blocks(write(slash(join(open, 'PIPELINE_PROFILE.md'))), cfg(open)), false);
    assert.equal(blocks(write(slash(join(open, 'PIPELINE_PROFILE.md'))), cfg(open, { BUILDER_PROTECTED: 'docs/' })), false);
  });
  test('a built-in entry for the profile keeps its own (lack of) unlock: fence does not open what the filled list closed', () => {
    const c = cfg(proj, { BUILDER_PROTECTED: 'PIPELINE_PROFILE.md', BUILDER_UNLOCK: 'fence' });
    assert.equal(blocks(write(profile), c), true);
  });
});

describe('package mode: the installed hook reads §16 with node_modules gone', () => {
  test('red: unpack from the package, delete node_modules, and the .claude/hooks copy still refuses a §16 path', () => {
    const proj = lab(settings({ schema: 2, protected: ['src/secret/'] }));
    const kit = join(proj, 'node_modules', '@geopjinfo', 'builder-pipeline');
    mkdirSync(kit, { recursive: true });
    cpSync(PACK, kit, { recursive: true, filter: (src) => !/[\\/](?:\.git|tests|node_modules)(?:[\\/]|$)/.test(`/${relative(PACK, src)}`) });
    const u = spawnSync(process.execPath, [join(kit, 'cli.js'), 'unpack', '--tool', 'claude-code'], { cwd: proj, encoding: 'utf8' });
    assert.equal(u.status, 0, `${u.stdout}${u.stderr}`);
    const installed = join(proj, '.claude', 'hooks', 'protected-paths.cjs');
    assert.ok(existsSync(installed));
    rmSync(join(proj, 'node_modules'), { recursive: true, force: true });
    const run = (payload) => spawnSync(process.execPath, [installed], { input: JSON.stringify(payload), cwd: proj, encoding: 'utf8', env: { ...process.env, ...env(proj) } });
    const r = run(write(slash(join(proj, 'src/secret/a.ts'))));
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /src\/secret\//);
    assert.equal(run(write(slash(join(proj, 'PIPELINE_PROFILE.md')))).status, 2, 'the profile');
    assert.equal(run(write(installed)).status, 2, 'the hook itself');
    assert.equal(run(write(slash(join(proj, 'src/open/a.ts')))).status, 0, 'control');
  });
});
