import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const hooksDir = join(here, '..', 'hooks', 'claude-code');
const trust = require('../hooks/claude-code/hook-trust.cjs');

const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'hook-trust-'));
  dirs.push(d);
  return d;
};
const git = (cwd, ...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8' });
const write = (root, rel, text) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const profileOn = (features) => `\`\`\`json pipeline-settings\n${JSON.stringify({ schema: 2, features })}\n\`\`\`\n`;

/** A committed git project with the kit's profile loader and the given files. */
function repo(files = {}) {
  const root = tmp();
  git(root, 'init', '-q');
  mkdirSync(join(root, 'scripts', 'lib'), { recursive: true });
  copyFileSync(join(here, '..', 'scripts', 'lib', 'profile.cjs'), join(root, 'scripts', 'lib', 'profile.cjs'));
  for (const [rel, text] of Object.entries(files)) write(root, rel, text);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  return root;
}
const hook = (file, input, root) =>
  spawnSync(process.execPath, [join(hooksDir, file)], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root } });

test('closure follows require, import and from; a path that does not exist is left out', () => {
  const root = tmp();
  write(root, 'a.mjs', "import x from './lib/b.cjs';\nconst c = require('./lib/c.cjs');\n// require('./lib/gone.cjs')\n");
  write(root, 'lib/b.cjs', "module.exports = require('./c.cjs');\n");
  write(root, 'lib/c.cjs', "const d = await import('../d.mjs');\n");
  write(root, 'd.mjs', 'export {};\n');
  const names = trust.closure(join(root, 'a.mjs')).map((f) => f.slice(root.length + 1).replace(/\\/g, '/'));
  assert.deepEqual(names.sort(), ['a.mjs', 'd.mjs', 'lib/b.cjs', 'lib/c.cjs']);
});

test('a require without an extension, or of a folder, is checked in the file Node would load', () => {
  const root = repo({
    'scripts/a.cjs': "require('./b');\nrequire('./pkg');\nrequire('./up/c.cjs');\n",
    'scripts/b.js': 'module.exports = 1;\n',
    'scripts/pkg/index.js': 'module.exports = 2;\n',
    'scripts/up/c.cjs': "module.exports = require('..');\n",
    'scripts/index.js': 'module.exports = 3;\n',
  });
  const a = join(root, 'scripts', 'a.cjs');
  assert.deepEqual(trust.trusted(a), { ok: true });
  const names = trust.closure(a).map((f) => f.slice(root.length + 1).replace(/\\/g, '/'));
  assert.deepEqual(names.sort(), ['scripts/a.cjs', 'scripts/b.js', 'scripts/index.js', 'scripts/pkg/index.js', 'scripts/up/c.cjs']);
  for (const rel of ['scripts/b.js', 'scripts/pkg/index.js', 'scripts/index.js']) {
    write(root, rel, 'module.exports = "rewritten";\n');
    // Spawned, so the check runs in a fresh process, as a hook does: Node caches resolved paths per process.
    const r = spawnSync(process.execPath, ['-e', `console.log(JSON.stringify(require(${JSON.stringify(join(hooksDir, 'hook-trust.cjs'))}).trusted(${JSON.stringify(a)})))`], { encoding: 'utf8' });
    assert.deepEqual(JSON.parse(r.stdout), { ok: false, reason: `a.cjs: ${rel} differs from HEAD` });
    git(root, 'checkout', '--', rel);
  }
});

test('a planted file that Node would pick for an extensionless require is refused', () => {
  const root = repo({ 'scripts/a.cjs': "require('./b');\n", 'scripts/b.json': '{}\n' });
  const a = join(root, 'scripts', 'a.cjs');
  assert.deepEqual(trust.trusted(a), { ok: true });
  write(root, 'scripts/b.js', 'module.exports = "planted";\n'); // .js is tried before .json
  const r = spawnSync(process.execPath, ['-e', `console.log(JSON.stringify(require(${JSON.stringify(join(hooksDir, 'hook-trust.cjs'))}).trusted(${JSON.stringify(a)})))`], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(r.stdout), { ok: false, reason: 'a.cjs: not all committed at HEAD' });
});

test('verify: committed and clean passes; changed, staged, untracked, ignored or no git is refused, with the reason', () => {
  const root = repo({ 'scripts/x.cjs': "module.exports = require('./lib/profile.cjs');\n", '.gitignore': 'scripts/ignored.cjs\n' });
  const x = join(root, 'scripts', 'x.cjs');
  assert.deepEqual(trust.trusted(x), { ok: true });

  write(root, 'scripts/lib/profile.cjs', 'module.exports = {}; // rewritten\n');
  assert.deepEqual(trust.trusted(x), { ok: false, reason: 'x.cjs: scripts/lib/profile.cjs differs from HEAD' });
  git(root, 'add', '-A');
  assert.equal(trust.trusted(x).ok, false, 'staged is still not HEAD');
  git(root, 'reset', '-q', '--hard');

  write(root, 'scripts/new.cjs', 'module.exports = 1;\n');
  assert.deepEqual(trust.trusted(join(root, 'scripts', 'new.cjs')), { ok: false, reason: 'new.cjs: not all committed at HEAD' });
  write(root, 'scripts/ignored.cjs', 'module.exports = 1;\n');
  assert.equal(trust.trusted(join(root, 'scripts', 'ignored.cjs')).ok, false, 'an ignored file shows in no status, and is still refused');

  const bare = tmp();
  write(bare, 'x.cjs', 'module.exports = 1;\n');
  assert.match(trust.trusted(join(bare, 'x.cjs')).reason, /cannot verify against HEAD/);
});

test('index flags cannot hide a change: assume-unchanged and skip-worktree are still refused', () => {
  const root = repo({ 'scripts/x.cjs': 'module.exports = 1;\n' });
  const x = join(root, 'scripts', 'x.cjs');
  for (const flag of ['--assume-unchanged', '--skip-worktree']) {
    git(root, 'update-index', flag, 'scripts/x.cjs');
    write(root, 'scripts/x.cjs', 'module.exports = 2;\n');
    assert.equal(git(root, 'status', '--porcelain').stdout, '', `control: ${flag} hides the change from status`);
    assert.deepEqual(trust.trusted(x), { ok: false, reason: 'x.cjs: scripts/x.cjs differs from HEAD' }, flag);
    git(root, 'update-index', flag.replace('--', '--no-'), 'scripts/x.cjs');
    git(root, 'checkout', '--', 'scripts/x.cjs');
  }
});

test('a fsmonitor command in the repository config is never run by the check', (t) => {
  const root = repo({ 'scripts/x.cjs': 'module.exports = 1;\n' });
  const slash = (p) => p.replace(/\\/g, '/');
  const marker = slash(join(root, 'FSMON'));
  write(root, 'fsmon.sh', `#!/bin/sh\necho x > "${marker}"\n`);
  git(root, 'config', 'core.fsmonitor', slash(join(root, 'fsmon.sh')));
  git(root, 'status');
  if (!existsSync(marker)) return t.skip('control: this git did not run the fsmonitor command, so the negative proves nothing here');
  rmSync(marker);
  assert.equal(trust.trusted(join(root, 'scripts', 'x.cjs')).ok, true);
  assert.equal(existsSync(marker), false, 'the check ran the configured fsmonitor');
});

test('a repository planted under scripts/ is refused; a CRLF checkout of an LF blob passes', () => {
  const root = repo({ 'scripts/lib/x.cjs': 'module.exports = 1;\n' });
  const x = join(root, 'scripts', 'lib', 'x.cjs');
  git(join(root, 'scripts'), 'init', '-q');
  assert.deepEqual(trust.trusted(x, { base: root }), { ok: false, reason: 'x.cjs: scripts/lib/x.cjs is inside a nested repository' });
  rmSync(join(root, 'scripts', '.git'), { recursive: true, force: true });
  write(root, 'scripts/lib/x.cjs', 'module.exports = 1;\r\n');
  assert.deepEqual(trust.trusted(x, { base: root }), { ok: true });
  write(root, 'scripts/lib/x.cjs', 'module.exports = 3;\r\n');
  assert.equal(trust.trusted(x, { base: root }).ok, false, 'line endings are the only latitude');
});

test('a symlinked copy of a committed file is judged where Node loads it from: its own requires are checked there', (t) => {
  const committed = { 'scripts/lib/a.cjs': "module.exports = require('./b.cjs');\n", 'scripts/lib/b.cjs': 'module.exports = "clean";\n' };
  const root = repo(committed);
  const evil = tmp();
  write(evil, 'a.cjs', committed['scripts/lib/a.cjs']); // byte-identical to HEAD
  write(evil, 'b.cjs', 'module.exports = "evil";\n');
  const a = join(root, 'scripts', 'lib', 'a.cjs');
  rmSync(a);
  try {
    symlinkSync(join(evil, 'a.cjs'), a, 'file');
  } catch {
    return t.skip('this host cannot create a file symlink (Windows without developer mode)');
  }
  assert.equal(require(a), 'evil', 'control: Node resolves the copy\'s require beside the copy');
  assert.match(trust.trusted(a, { base: root }).reason, /outside the repository/);
});

test('a folder junction or symlink out of the repository is refused', () => {
  const root = repo({ 'scripts/keep.cjs': 'module.exports = 1;\n' });
  const evil = tmp();
  copyFileSync(join(root, 'scripts', 'lib', 'profile.cjs'), join(evil, 'profile.cjs')); // byte-identical: only the location is wrong
  rmSync(join(root, 'scripts', 'lib'), { recursive: true, force: true });
  symlinkSync(evil, join(root, 'scripts', 'lib'), 'junction');
  assert.match(trust.trusted(join(root, 'scripts', 'lib', 'profile.cjs'), { base: root }).reason, /outside the repository/);
});

test('lint hook end to end: never spawns for another file; runs the committed script; a rewritten script never runs', () => {
  // The fake lint script leaves a marker when it runs, so "never spawned" is observed, not inferred.
  const lint = (marker) => `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'ran');\n`;
  const root = repo({ 'PIPELINE_PROFILE.md': profileOn({ instructionLint: { state: 'on', files: ['CLAUDE.md'] } }), 'CLAUDE.md': '# x\n' });
  write(root, 'scripts/instruction-lint.mjs', lint('ran-committed'));
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'lint');
  const edit = (rel) => hook('instruction-lint-on-edit.cjs', { tool_input: { file_path: join(root, rel) } }, root);

  assert.equal(edit('README.md').status, 0);
  assert.equal(existsSync(join(root, 'ran-committed')), false, 'filter before spawn');
  edit('CLAUDE.md');
  assert.equal(existsSync(join(root, 'ran-committed')), true, 'the committed script runs');

  write(root, 'scripts/instruction-lint.mjs', lint('ran-rewritten'));
  const r = edit('CLAUDE.md');
  assert.equal(r.status, 0);
  assert.equal(existsSync(join(root, 'ran-rewritten')), false, 'agent-written code is never run by the hook');
  const note = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(note.hookEventName, 'PostToolUse');
  assert.match(note.additionalContext, /not run for CLAUDE\.md — instruction-lint\.mjs: scripts\/instruction-lint\.mjs differs from HEAD/);
});

test('a rewritten profile loader is never required: the cap leaves the output, the reviewer guard still blocks, reanchor falls back', () => {
  const root = repo({
    'PIPELINE_PROFILE.md': profileOn({ bashCap: { state: 'on', limitBytes: 100 }, reanchor: { state: 'on', maxRuns: 2 } }),
    'scripts/lib/bash-cap.cjs': "module.exports = { digest: () => ({ capped: true, text: 'CAPPED' }), EXEMPT: /^$/, LIMIT_BYTES: 1 };\n",
  });
  write(root, 'scripts/lib/profile.cjs', "require('node:fs').writeFileSync(require('node:path').join(__dirname, 'PWNED'), 'x'); module.exports = require('node:module');\n");
  const pwned = join(root, 'scripts', 'lib', 'PWNED');

  const cap = hook('bash-output-cap.cjs', { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { stdout: 'y'.repeat(500), stderr: '' } }, root);
  assert.deepEqual([cap.status, cap.stdout], [0, '']);

  const guard = hook('reviewer-write-guard.cjs', { tool_name: 'Write', agent_type: 'module-reviewer', tool_input: { file_path: join(root, 'src', 'a.ts'), content: 'x' } }, root);
  assert.equal(guard.status, 2, 'the guard keeps its defaults and enforces');

  const re = hook('reanchor-after-compact.cjs', { hook_event_name: 'SessionStart', source: 'compact' }, root);
  assert.equal(re.status, 0);
  assert.match(JSON.parse(re.stdout).hookSpecificOutput.additionalContext, /re-read in order[\s\S]*did not load its code: profile\.cjs: scripts\/lib\/profile\.cjs differs from HEAD/);
  assert.equal(hook('reanchor-after-compact.cjs', { source: 'startup' }, root).stdout, '');

  assert.equal(existsSync(pwned), false, 'no hook required the rewritten loader');
});
