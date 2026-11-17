/**
 * artifact-check (specs/repo-hygiene.spec.md, M21, REQ-1842, REQ-1843; D99 to D101, D103): assistant files, scratch
 * files, archives, assistant lines in .gitignore and generated-content labels, over the tree, since a ref or in the
 * index, reported with the command a person would run and never applied. Each test names its AC.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const PACK = join(here, '..');
const lib = require('../scripts/lib/artifact-check.cjs');
const match = require('../scripts/lib/hygiene-match.cjs');
const CLI = join(PACK, 'scripts', 'artifact-check.mjs');

const temps = [];
after(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const profile = (repo, features) => writeFileSync(join(repo, 'PIPELINE_PROFILE.md'), `\`\`\`json pipeline-settings\n${JSON.stringify({ schema: 2, features })}\n\`\`\`\n`);
const run = (cwd, args) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout };
};
const kinds = (stdout) => stdout.split(/\r?\n/).filter((l) => /^[A-Z-]+ {2,}/.test(l)).map((l) => l.split(/\s+/)[0]).sort();

/** The AC-1842 repo: .cursorrules, notes.tmp, release.zip, a README with a label, a .gitignore listing .claude/. */
function rig() {
  const parent = realpathSync.native(mkdtempSync(join(tmpdir(), 'artifact-check-')));
  temps.push(parent);
  const repo = join(parent, 'app');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 'T');
  writeFileSync(join(repo, '.cursorrules'), 'rules\n');
  writeFileSync(join(repo, 'notes.tmp'), 'scratch\n');
  writeFileSync(join(repo, 'release.zip'), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]));
  writeFileSync(join(repo, 'README.md'), '# App\n\nGenerated with Claude Code\n');
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n.claude/\n*.log\n');
  writeFileSync(join(repo, 'src.js'), 'export const a = 1;\n');
  for (const f of ['.cursorrules', 'notes.tmp', 'release.zip', 'README.md', '.gitignore', 'src.js']) git(repo, 'add', f);
  git(repo, 'commit', '-q', '-m', 'first');
  return { repo };
}

describe('artifact-check — pure', () => {
  test('red: AC-1842 the glob rules: a folder glob covers the tree under it, a bare name matches any segment, a rooted glob matches from the root', () => {
    assert.equal(match.matchesAny('.claude/settings.json', ['.claude/']), true);
    assert.equal(match.matchesAny('docs/CLAUDE.md', ['CLAUDE.md']), true);
    assert.equal(match.matchesAny('xCLAUDE.md', ['CLAUDE.md']), false);
    assert.equal(match.matchesAny('.aider.chat.history.md', ['.aider*']), true);
    assert.equal(match.matchesAny('.github/copilot-instructions.md', ['.github/copilot-instructions.md']), true);
    assert.equal(match.matchesAny('src/github/copilot-instructions.md', ['.github/copilot-instructions.md']), false);
    assert.equal(match.matchesAny('a/b/notes.tmp', ['*.tmp']), true);
    assert.equal(match.matchesAny('mytmp/x', ['tmp/']), false);
  });
  test('red: AC-1842 the label shapes and the .gitignore lines', () => {
    assert.deepEqual(lib.labelLines('# T\n\n🤖 Generated with [Claude Code](https://example.com)\nplain\nCo-Authored-By: Codex <x@example.com>\n'), [{ line: 3 }, { line: 5 }]);
    assert.deepEqual(lib.labelLines('the hook strips a "Generated with" line from a message\n'), [], 'the phrase without a tool name is prose');
    const ig = lib.assistantIgnoreLines('node_modules/\n.claude/\n# .codex is fine as a comment\n/CLAUDE.md\n*.log\n', lib.ASSISTANT);
    assert.deepEqual(ig.map((l) => l.line), [2, 4]);
  });
});

describe('artifact-check — CLI', () => {
  test('red: AC-1842 five kinds once each with their commands, exit 1; nothing changed; allow removes the ASSISTANT-FILE line', () => {
    const { repo } = rig();
    const before = git(repo, 'rev-parse', 'HEAD');
    const ignoreBefore = readFileSync(join(repo, '.gitignore'), 'utf8');
    profile(repo, { artifactCheck: { state: 'on' } });
    const r = run(repo, []);
    assert.equal(r.status, 1, r.out);
    assert.deepEqual(kinds(r.stdout), ['AI-LABEL', 'ARCHIVE', 'ASSISTANT-FILE', 'ASSISTANT-IGNORE', 'SCRATCH-FILE']);
    assert.match(r.stdout, /^ASSISTANT-FILE +\.cursorrules — .* · git rm --cached \.cursorrules$/m);
    assert.match(r.stdout, /^SCRATCH-FILE +notes\.tmp — .* · git rm --cached notes\.tmp$/m);
    assert.match(r.stdout, /^ARCHIVE +release\.zip — .* · git rm --cached release\.zip$/m);
    assert.match(r.stdout, /^AI-LABEL +README\.md:3 — generated-content label · remove line 3 of README\.md$/m);
    assert.match(r.stdout, /^ASSISTANT-IGNORE +\.gitignore:2 — .* · drop the line `\.claude\/` from \.gitignore/m);
    assert.match(r.stdout, /nothing was removed or rewritten/);
    assert.equal(git(repo, 'rev-parse', 'HEAD'), before);
    assert.equal(readFileSync(join(repo, '.gitignore'), 'utf8'), ignoreBefore);
    assert.equal(git(repo, 'status', '--porcelain', '--untracked-files=no'), '', 'the tree is unchanged');
    assert.ok(existsSync(join(repo, '.cursorrules')));
    profile(repo, { artifactCheck: { state: 'on', allow: ['.cursorrules'] } });
    const allowed = run(repo, []);
    assert.equal(allowed.status, 1);
    assert.deepEqual(kinds(allowed.stdout), ['AI-LABEL', 'ARCHIVE', 'ASSISTANT-IGNORE', 'SCRATCH-FILE']);
    profile(repo, { artifactCheck: { state: 'off' } });
    const off = run(repo, []);
    assert.equal(off.status, 3, off.out);
    assert.equal(off.stdout.trim(), 'artifactCheck: not configured');
    const defaults = run(repo, ['--defaults', '--json']);
    assert.equal(defaults.status, 1);
    assert.equal(JSON.parse(defaults.stdout).defaults, true);
  });
  test('red: AC-1842b --since HEAD~1 reports only the CLAUDE.md added in the later commit', () => {
    const { repo } = rig();
    writeFileSync(join(repo, 'CLAUDE.md'), 'rules\n');
    git(repo, 'add', 'CLAUDE.md');
    git(repo, 'commit', '-q', '-m', 'second');
    profile(repo, { artifactCheck: { state: 'on' } });
    const r = run(repo, ['--since', 'HEAD~1']);
    assert.equal(r.status, 1, r.out);
    assert.deepEqual(kinds(r.stdout), ['ASSISTANT-FILE']);
    assert.match(r.stdout, /^ASSISTANT-FILE +CLAUDE\.md /m);
  });
  test('red: AC-1843 --staged refuses an .aider file picked up by git add -A, naming the path; allow lets it through; the hook file refuses the commit when armed', () => {
    const { repo } = rig();
    writeFileSync(join(repo, '.aider.chat.history.md'), 'chat\n');
    writeFileSync(join(repo, 'ok.txt'), 'ok\n');
    git(repo, 'add', '-A');
    profile(repo, { artifactCheck: { state: 'on' } });
    const r = run(repo, ['--staged']);
    assert.equal(r.status, 1, r.out);
    assert.deepEqual(kinds(r.stdout), ['ASSISTANT-FILE']);
    assert.match(r.stdout, /^ASSISTANT-FILE +\.aider\.chat\.history\.md /m);
    assert.doesNotMatch(r.stdout, /README|notes\.tmp/, 'the index only, not the tree');
    assert.equal(run(repo, ['--staged', '--since', 'HEAD']).status, 2, 'the two modes do not combine');
    // the hook, copied by hand as its header says, with KIT pointing at this pack
    const hooksDir = join(repo, '.git', 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    const hook = join(hooksDir, 'pre-commit');
    copyFileSync(join(PACK, 'hooks', 'artifact-check-precommit.sh'), hook);
    writeFileSync(hook, readFileSync(hook, 'utf8').replace("KIT=''", `KIT='kit'`));
    chmodSync(hook, 0o755);
    mkdirSync(join(repo, 'kit', 'scripts'), { recursive: true });
    const { cpSync } = require('node:fs');
    cpSync(join(PACK, 'scripts'), join(repo, 'kit', 'scripts'), { recursive: true });
    const refused = spawnSync('git', ['commit', '-q', '-m', 'junk'], { cwd: repo, encoding: 'utf8' });
    if (process.platform !== 'win32') {
      assert.notEqual(refused.status, 0, refused.stdout + refused.stderr);
      assert.match(refused.stdout + refused.stderr, /artifact-check refused the commit/);
    }
    profile(repo, { artifactCheck: { state: 'on', allow: ['.aider*'] } });
    const ok = run(repo, ['--staged']);
    assert.equal(ok.status, 0, ok.out);
    rmSync(join(repo, 'kit'), { recursive: true, force: true });
  });
  test('red: AC-1842 the sources hold no rm, unlink, git rm or write of the tree', () => {
    const src = readFileSync(join(PACK, 'scripts', 'lib', 'artifact-check.cjs'), 'utf8') + readFileSync(CLI, 'utf8');
    assert.doesNotMatch(src, /\brmSync\b|\bunlinkSync\b|\bwriteFileSync\b|\brenameSync\b/);
    const calls = [...src.matchAll(/spawnSync\('git',\s*\[([^\]]*)\]/g)].map((m) => m[1]);
    for (const c of calls) assert.doesNotMatch(c, /'(rm|add|commit|checkout|reset|push)'/, c);
  });
});
