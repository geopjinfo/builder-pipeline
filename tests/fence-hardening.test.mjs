/**
 * hooks/protected-paths.cjs hardening (audit D, S1–S8) — the fence FAILS CLOSED: while anything is protected, a shell
 * statement that is not READ-ONLY and names a protected path (by spelling, case-insensitively on Windows, or by where
 * it lands, under every cd target) is refused; Windows device/UNC prefixes are placed; MCP file tools are judged; the
 * whole hook folders are fenced; a crash blocks. Every red case has a green control. Nothing here runs a command from
 * the cases: the hook only JUDGES the text it is handed.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, '..', 'hooks', 'protected-paths.cjs');
const PRECOMMIT = join(HERE, '..', 'hooks', 'protected-paths-precommit.sh');
const guard = require(HOOK);
const WIN = process.platform === 'win32';

const slash = (p) => p.replace(/\\/g, '/');
const lab = mkdtempSync(join(tmpdir(), 'fence-hard-'));
const proj = join(lab, 'proj');
const out = join(lab, 'out');
for (const d of ['.git', 'core/fenced', 'core/other', 'src/feature', 'notes', '.claude/hooks/kit', '.claude/agents', '.codex/hooks']) mkdirSync(join(proj, d), { recursive: true });
mkdirSync(out);
writeFileSync(join(proj, 'core/fenced/x.ts'), 'x');
writeFileSync(join(proj, '.claude/hooks/hook-trust.cjs'), '// trust');
writeFileSync(join(proj, '.claude/hooks/kit/k.cjs'), '// kit');
writeFileSync(join(proj, '.codex/hooks/protected-paths.cjs'), '// codex copy');
writeFileSync(join(proj, 'p.diff'), '--- a/core/fenced/x.ts\n+++ b/core/fenced/x.ts\n@@ -1 +1 @@\n-x\n+y\n');
writeFileSync(join(proj, 'ok.diff'), '--- a/notes/n.md\n+++ b/notes/n.md\n@@ -1 +1 @@\n-x\n+y\n');
let linkError = '';
const hl = join(out, 'hl');
try {
  symlinkSync(join(proj, '.claude', 'hooks'), hl, WIN ? 'junction' : 'dir');
} catch (e) {
  linkError = e.message;
}
/** Remove the link itself, never what it points at: a Windows junction is a directory entry, a POSIX symlink a file one. */
const dropLink = (p) => {
  try {
    unlinkSync(p);
  } catch {
    rmdirSync(p);
  }
};
after(() => {
  if (!linkError) {
    try {
      rmdirSync(hl);
    } catch {
      /* the link itself only */
    }
  }
  rmSync(lab, { recursive: true, force: true });
});

const P = slash(proj);
const ABS = proj.replace(/\//g, '\\');
const ctx = (over = {}) => ({ prefixes: ['core/fenced/'], unlockable: {}, grant: '', cwd: proj, projectDir: proj, ...over });
const ask = (payload, over) => guard.decide(payload, ctx(over));
const blocks = (payload, over) => ask(payload, over).block === true;
const sh = (command) => ({ tool_name: 'Bash', tool_input: { command } });
const ps = (command) => ({ tool_name: 'PowerShell', tool_input: { command } });
const write = (file_path) => ({ tool_name: 'Write', tool_input: { file_path, content: 'x' } });
const mcp = (tool, input) => ({ tool_name: tool, tool_input: input });
const red = (label, list, over) => test(`red: ${label}`, () => {
  for (const p of list) assert.equal(blocks(p, over), true, JSON.stringify(p.tool_input));
});
const green = (label, list, over) => test(`green: ${label}`, () => {
  for (const p of list) {
    const r = ask(p, over);
    assert.equal(r.block, false, `${JSON.stringify(p.tool_input)} -> ${r.reason}`);
  }
});

test('precondition: the link to the hook folder exists', () => assert.equal(linkError, ''));

describe('S1 — any statement that is not read-only and names a protected path', () => {
  red('removers, extractors, copiers and downloaders naming the fence', [
    sh('rm -rf core/fenced'),
    sh('/bin/rm core/fenced/x.ts'),
    sh('git checkout HEAD~1 -- core/fenced/x.ts'),
    sh('tar -xf a.tar -C core/fenced'),
    sh('unzip -o a.zip -d core/fenced'),
    sh('dd if=a.ts of=core/fenced/x.ts'),
    sh('install -m644 a.ts core/fenced/x.ts'),
    sh('curl -so core/fenced/x.ts http://127.0.0.1/'),
    sh('robocopy . core\\fenced a.ts'),
    sh('truncate -s0 core/fenced/x.ts'),
    sh('rm -rf core/{fenced,other}'),
    sh(`rm -rf ${P}/core/fenced`),
    ps('Remove-Item core/fenced -Recurse -Force'),
  ]);
  red('git apply / patch whose patch file touches the fence', [sh('git apply p.diff'), sh('patch -p1 < p.diff')]);
  green('reads of the fence, and writes elsewhere', [
    sh('cat core/fenced/x.ts'),
    sh('grep -n x core/fenced/x.ts'),
    sh('ls core/fenced'),
    sh('git show HEAD:core/fenced/x.ts'),
    sh('git diff -- core/fenced'),
    sh('git log --oneline -- core/fenced | head -5'),
    sh('rm -rf src/feature/tmp'),
    sh('tar -xf a.tar -C notes'),
    sh('git apply ok.diff'),
    sh('npm run build && npm test'),
  ]);
  if (WIN) red('case-insensitive on Windows', [sh('rm -rf CORE/Fenced'), write('CORE/FENCED/new/y.ts')]);
});

describe('S2 — bare tokens judged under every cd target', () => {
  red('cd/pushd/Set-Location then a relative operand', [
    sh('cd core && rm -rf fenced'),
    sh('cd core; rm fenced/x.ts'),
    sh('pushd core && unzip a.zip -d fenced'),
    sh("cd core && python -c \"open('fenced/x.ts','w')\""),
    ps('Set-Location core; Remove-Item fenced -Recurse -Force'),
  ]);
  green('a cd then a relative operand outside the fence', [sh('cd core && rm -rf other'), sh('cd src && rm -rf feature/tmp'), ps('Set-Location core; Remove-Item other -Recurse')]);
});

describe('S3 — Windows device and UNC prefixes, case, unplaceable absolute paths', { skip: !WIN && 'Windows path forms' }, () => {
  const unc = (host) => `\\\\${host}\\${ABS.replace(/^([A-Za-z]):/, '$1$$')}`;
  red('\\\\?\\, \\\\.\\, \\\\?\\UNC\\localhost, \\\\localhost\\C$, \\\\127.0.0.1\\c$ and the host name', [
    write(`\\\\?\\${ABS}\\CORE\\Fenced\\x.ts`),
    write(`\\\\?\\${ABS}\\core\\fenced\\x.ts`),
    { tool_name: 'Edit', tool_input: { file_path: `\\\\.\\${ABS}\\Core\\FENCED\\x.ts` } },
    write(`${unc('localhost')}\\CORE\\fenced\\x.ts`),
    write(`${unc('127.0.0.1')}\\core\\fenced\\x.ts`),
    write(`${unc(hostname())}\\core\\fenced\\x.ts`),
    write(`\\\\?\\UNC\\localhost\\${ABS.replace(/^([A-Za-z]):/, '$1$$')}\\core\\fenced\\x.ts`),
    sh(`echo x > '\\\\?\\${ABS}\\CORE\\fenced\\x.ts'`),
    write('\\\\fileserver\\share\\proj\\core\\fenced\\x.ts'), // cannot be placed, could be protected: fails closed
  ]);
  green('the same prefixes outside the fence', [
    write(`\\\\?\\${ABS}\\src\\feature\\x.ts`),
    write(`${unc('localhost')}\\notes\\x.md`),
    write('\\\\fileserver\\share\\notes\\x.md'),
  ]);
});

describe('S4 — MCP file tools', () => {
  red('a write, edit or move whose path lands in the fence; an unplaceable path', [
    mcp('mcp__desktop-commander__write_file', { path: 'core/fenced/x.ts', content: 'x' }),
    mcp('mcp__fs__edit_file', { file_path: `${slash(out)}/../proj/core/fenced/x.ts`, edits: [] }),
    mcp('mcp__fs__move_file', { source: 'core/fenced/x.ts', destination: 'notes/x.ts' }),
    mcp('mcp__fs__copy_file', { source: 'notes/a', target: 'core/fenced/a' }),
    mcp('mcp__fs__write_multiple', { paths: ['notes/a', 'core/fenced/b'] }),
    mcp('mcp__fs__write_file', { path: `${slash(hl)}/hook-trust.cjs`, content: '' }),
    ...(WIN ? [mcp('mcp__fs__write_file', { path: '/tmp/x', content: '' })] : []),
  ]);
  green('a read of an unprotected path, a write elsewhere, a tool with no path, a harmless command', [
    mcp('mcp__desktop-commander__read_file', { path: 'notes/a.md' }),
    mcp('mcp__fs__list_directory', { path: 'src/feature' }),
    mcp('mcp__fs__write_file', { path: 'notes/x.md', content: 'see core/fenced/x.ts' }),
    mcp('mcp__slack__send_message', { channel: 'C1', text: 'core/fenced is protected' }),
    mcp('mcp__dc__start_process', { command: 'ls notes', timeout_ms: 1000 }),
  ]);
  red('(1) an MCP tool that runs a command naming the fence', [
    mcp('mcp__dc__start_process', { command: 'rm -rf core/fenced' }),
    mcp('mcp__x__execute_command', { cmd: 'cd core && rm -rf fenced' }),
    mcp('mcp__x__run', { script: "Remove-Item core/fenced -Recurse" }),
    mcp('mcp__x__terminal_send', { input: 'rm -rf core/fenced' }),
  ]);
  red('(2) a path-shaped value under an unlisted key, the new keys, file:// URLs; a file write with no path', [
    mcp('mcp__fs__write_file', { where: 'core/fenced/x.ts', content: 'x' }),
    mcp('mcp__git__checkout', { repo_path: `${P}/core/fenced` }),
    mcp('mcp__fs__save', { location: 'core/fenced/y' }),
    mcp('mcp__fs__write_file', { uri: `file://${WIN ? '/' : ''}${P.split('/').map(encodeURIComponent).join('/').replace(/^([A-Za-z])%3A/, '$1:')}/core/fenced/x.ts` }),
    mcp('mcp__fs__write_file', { content: 'x' }),
  ]);
  red('(3) the count or depth cap reached', [
    mcp('mcp__fs__write_multiple', { paths: Array.from({ length: 65 }, (_, i) => `notes/n${i}`) }),
    mcp('mcp__fs__write_file', { a: { b: { c: { d: { e: { path: 'notes/x' } } } } } }),
  ]);
  red('(4) a read tool on the fence, and a read tool with an output key', [
    mcp('mcp__desktop-commander__read_file', { path: 'core/fenced/x.ts' }),
    mcp('mcp__fs__list_directory', { path: 'core/fenced' }),
    mcp('mcp__fs__read_file', { path: 'notes/a.md', output: 'core/fenced/b' }),
    mcp('mcp__fs__get_file', { path: 'notes/a.md', destination: '/tmp/never/placed' }),
  ].slice(0, WIN ? 4 : 3));
  test('green: a grant opens an MCP write as it opens a Write', () => {
    assert.equal(blocks(mcp('mcp__fs__write_file', { path: 'core/fenced/x.ts' }), { unlockable: { 'core/fenced/': 'core' }, grant: 'core' }), false);
  });
  test('the shipped matchers include mcp__.* — Claude Code snippet, header, Codex hooks.json', () => {
    const cc = require('../adapters/lib/claude-code.cjs');
    const codex = require('../adapters/lib/codex.cjs');
    const ccMatcher = (cc.protectedPathsHook ? cc.protectedPathsHook() : cc.hooks?.protectedPathsHook?.()).matcher;
    assert.ok(ccMatcher.split('|').includes('mcp__.*'), ccMatcher);
    assert.ok(/"matcher": "[^"]*mcp__\.\*/.test(readFileSync(HOOK, 'utf8')));
    const group = JSON.parse(codex.hooksConfig().content).hooks.PreToolUse[0];
    assert.ok(group.matcher.split('|').includes('mcp__.*'), group.matcher);
    for (const t of ['mcp__fs__write_file', 'Bash']) assert.ok(new RegExp(`^(?:${ccMatcher})$`).test(t), t);
  });
});

describe('S5 — unplaceable write operands that share a segment with a protected prefix', () => {
  red('a variable or a built string', [
    ps("$d='core'; Set-Content \"$d/fenced/x.ts\" 'a'"),
    ps("Copy-Item a.ts -Destination ('core/'+'fenced')"),
    ps('Remove-Item (Join-Path core fenced) -Recurse'),
    sh('D=core; rm -rf $D/fenced'),
  ]);
  green('a variable that shares nothing with the fence', [ps("$d='notes'; Set-Content \"$d/x.ts\" 'a'"), sh('D=notes; rm -rf $D/tmp')]);
});

describe('S7 — the hook folders are fenced, unlockable via BUILDER_UNLOCK=fence', () => {
  red('a write to any file in .claude/hooks/ (kit/, hook-trust.cjs) or .codex/hooks/, by spelling or landing', [
    write(`${P}/.claude/hooks/hook-trust.cjs`),
    write(`${P}/.claude/hooks/kit/k.cjs`),
    write(`${P}/.claude/hooks/new-hook.cjs`),
    write(`${P}/.codex/hooks/protected-paths.cjs`),
    write(`${slash(hl)}/hook-trust.cjs`),
    sh('rm -rf .claude/hooks/kit'),
    sh('echo x > .claude/hooks/kit/k.cjs'),
    sh('rm -rf .claude'),
  ]);
  green('the fence grant opens them', [write(`${P}/.claude/hooks/hook-trust.cjs`), sh('rm -rf .claude/hooks/kit')], { grant: 'fence' });
  green('other .claude files and reading the hooks', [write(`${P}/.claude/agents/a.md`), sh('cat .claude/hooks/hook-trust.cjs'), sh('ls .claude/hooks/kit')]);
  test('red: the reason names the unlock', () => assert.match(ask(write(`${P}/.claude/hooks/kit/k.cjs`)).reason, /BUILDER_UNLOCK=fence/));
});

describe('glob deletes and whole-tree resets', () => {
  red('a glob whose directory part is, or may expand to, the fence', [
    sh('rm core/fenced/*.ts'),
    sh('rm -rf core/*'),
    sh('rm -rf core/fen*'),
    sh('cd core && rm -rf fen*'),
    ps('Remove-Item core/* -Recurse'),
  ]);
  green('a glob that cannot reach the fence', [sh('rm notes/*.md'), sh('rm core/*.ts'), sh('rm -rf src/*')]);
  red('whole-tree resets while anything is protected', [
    sh('git checkout .'),
    sh('git checkout -- .'),
    sh('git restore .'),
    sh('git reset --hard'),
    sh('git reset --hard HEAD~1'),
    sh('git stash'),
    sh('git stash pop'),
    sh('git clean -fd'),
    sh('cd core && git checkout -- .'),
  ]);
  green('git work that does not reset the tree', [
    sh('git stash list'),
    sh('git status'),
    sh('git reset HEAD notes/a.md'),
    sh('git checkout -b feature/x'),
    sh('git restore notes/a.md'),
    sh('git checkout -- notes/a.md'),
    sh('git clean -fd notes'),
  ]);
  test('green: nothing protected, nothing refused', () => {
    assert.equal(blocks(sh('git reset --hard'), { prefixes: [] }), false);
  });
});

describe('S8 — a crash blocks', () => {
  const run = (input, env) => spawnSync(process.execPath, [HOOK], { input, cwd: proj, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: proj, BUILDER_UNLOCK: '', BUILDER_PROTECTED: '', ...env } });
  test('red: malformed input while something is protected → exit 2 with a reason', () => {
    const r = run('not json', { BUILDER_PROTECTED: 'core/fenced/' });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /BLOCKED: .*(malformed|not JSON)/i);
  });
  test('green: malformed input with nothing protected → exit 0', () => {
    assert.equal(run('not json', { CLAUDE_PROJECT_DIR: out }).status, 0);
  });
  test('red: an exception inside decide → exit 2 (verdict), never a non-blocking exit 1', () => {
    const v = guard.verdict(JSON.stringify(sh('ls')), { decide: () => { throw new Error('boom'); }, config: () => ctx() });
    assert.equal(v.code, 2);
    assert.match(v.message, /boom/);
    const ok = guard.verdict(JSON.stringify(sh('ls')), { config: () => ctx() });
    assert.equal(ok.code, 0);
  });
});

describe('S6 — paths.logs is validated and the bash cap writes no log outside it', () => {
  const profile = require('../scripts/lib/profile.cjs');
  const cap = require('../hooks/claude-code/bash-output-cap.cjs');
  const settings = (logs, prot = []) => {
    const s = JSON.parse(JSON.stringify(profile.DEFAULTS));
    s.paths.logs = logs;
    s.protected = prot;
    return s;
  };
  test('red: validate() rejects an absolute paths.logs, one with .., one under a protected glob or a hook folder', () => {
    for (const [logs, prot] of [['/var/log', []], ['C:/logs', []], ['../logs', []], ['logs/../../x', []], ['core/fenced/logs', ['core/fenced/**']], ['.claude/hooks/logs', []]]) {
      assert.ok(profile.validate(settings(logs, prot)).some((e) => /^paths\.logs/.test(e)), logs);
    }
  });
  test('green: validate() accepts a relative paths.logs outside the fence', () => {
    assert.ok(!profile.validate(settings('logs', ['core/fenced/**'])).some((e) => /^paths\.logs/.test(e)));
    assert.ok(!profile.validate(settings('out/logs')).some((e) => /^paths\.logs/.test(e)));
  });
  const big = 'line\n'.repeat(40000);
  const input = { tool_name: 'Bash', tool_input: { command: 'x' }, tool_response: { stdout: big, stderr: '' } };
  const on = (logs, prot) => ({ ...settings(logs, prot), features: { ...profile.DEFAULTS.features, bashCap: { state: 'on', limitBytes: 100 } } });
  test('red: the hook writes no log under a rejected paths.logs, and says why', () => {
    for (const [logs, prot] of [['../escape', []], ['/abs/logs', []], ['core/fenced', ['core/fenced/**']]]) {
      const r = cap.decide(input, on(logs, prot), { root: proj, stamp: 'T', pid: 1 });
      assert.equal(r.action, 'pass', logs);
      assert.match(r.reason, /paths\.logs/, logs);
    }
  });
  test('green: a valid paths.logs still caps', () => {
    assert.equal(cap.decide(input, on('logs'), { root: proj, stamp: 'T', pid: 1, fencePrefixes: [] }).action, 'cap');
  });
  test('red: spellings that normalise into a hook folder or a fence are refused', () => {
    for (const logs of ['./a/../.claude/hooks/x', '.claude//hooks', '.claude/./hooks', '.claude\\hooks', '.CLAUDE/Hooks/x', './core/fenced/', 'core\\\\fenced']) {
      assert.ok(profile.logsProblem(logs, ['core/fenced/**']), logs);
    }
  });
  test('red: the fence\'s whole set (built-in PROTECTED, BUILDER_PROTECTED) counts, not only §16', () => {
    assert.match(profile.logsProblem('vendor/logs', [], { prefixes: ['vendor/'] }), /vendor/);
    const r = cap.decide(input, on('notes/logs'), { root: proj, stamp: 'T', pid: 1, env: { BUILDER_PROTECTED: 'notes/' } });
    assert.equal(r.action, 'pass', r.reason);
    assert.match(r.reason, /paths\.logs/);
    assert.equal(cap.decide(input, on('notes/logs'), { root: proj, stamp: 'T', pid: 1, fencePrefixes: { reason: 'untrusted' } }).action, 'pass'); // set unreadable: fails closed
  });
  test('red (5): the write target <logs>/bash is judged — a fence equal to it or under it refuses', () => {
    assert.ok(profile.logsProblem('core', [], { prefixes: ['core/bash/'] }));
    assert.ok(profile.logsProblem('core', [], { prefixes: ['core/bash/deep/'] }));
    assert.equal(profile.logsProblem('core', [], { prefixes: ['core/fenced/'] }), null); // green: a sibling fence
  });
  test('red (5): a junction planted at <logs>/bash, after the first check, is caught by the recheck after mkdir', () => {
    mkdirSync(join(proj, 'lg2'));
    const r = cap.decide(input, on('lg2'), { root: proj, stamp: 'T', pid: 1, fencePrefixes: ['core/fenced/'] });
    assert.equal(r.action, 'cap');
    assert.equal(r.recheck(), null);
    symlinkSync(join(proj, 'core', 'fenced'), join(proj, 'lg2', 'bash'), WIN ? 'junction' : 'dir');
    try {
      assert.match(r.recheck(), /land/);
    } finally {
      dropLink(join(proj, 'lg2', 'bash'));
    }
  });
  test('red (6): trailing dots and spaces are cut per segment; a ":" in a segment is refused', () => {
    for (const logs of ['.claude./hooks', '.claude /hooks', '.claude. ./hooks.', 'core./fenced ', 'logs:stream', 'logs/x::$DATA']) {
      assert.ok(profile.logsProblem(logs, ['core/fenced/**']), logs);
    }
    assert.equal(profile.logsProblem('logs.d', ['core/fenced/**']), null);
  });
  test('red: a logs folder that is a junction into the fence or a hook folder is refused by landing', () => {
    const into = [['jl-fence', join(proj, 'core', 'fenced')], ['jl-hooks', join(proj, '.claude', 'hooks')], ['jl-out', out]];
    for (const [name, target] of into) {
      symlinkSync(target, join(proj, name), WIN ? 'junction' : 'dir');
      try {
        const why = profile.logsProblem(`${name}/sub`, ['core/fenced/**'], { root: proj, prefixes: ['core/fenced/'] });
        assert.ok(why, name);
        assert.match(why, /land/);
      } finally {
        dropLink(join(proj, name));
      }
    }
    assert.equal(profile.logsProblem('logs/sub', ['core/fenced/**'], { root: proj, prefixes: ['core/fenced/'] }), null);
  });
});

describe('the git pre-commit hook reads §16 and matches prefixes literally', () => {
  const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
  const repo = (name, profileGlobs, staged, unlockable = '') => {
    const dir = join(lab, name);
    mkdirSync(dir);
    git(dir, 'init', '-q');
    if (profileGlobs) writeFileSync(join(dir, 'PIPELINE_PROFILE.md'), `# p\n\n\`\`\`json pipeline-settings\n${JSON.stringify({ protected: profileGlobs })}\n\`\`\`\n`);
    for (const f of staged) {
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      writeFileSync(join(dir, f), 'x');
      git(dir, 'add', f);
    }
    const hook = join(dir, 'pre-commit.sh');
    writeFileSync(hook, readFileSync(PRECOMMIT, 'utf8').split("UNLOCKABLE=''").join(`UNLOCKABLE='${unlockable}'`));
    chmodSync(hook, 0o755);
    return (env = {}) => spawnSync('sh', [hook], { cwd: dir, encoding: 'utf8', env: { ...process.env, BUILDER_UNLOCK: '', ...env } });
  };
  test('red: a staged file under a §16 glob is rejected', () => {
    const r = repo('pc-red', ['core/fenced/**'], ['core/fenced/x.ts'])();
    assert.equal(r.status, 1, r.stderr + r.stdout);
    assert.match(r.stderr, /core\/fenced\//);
  });
  test('green: an unprotected staged file passes; a regex metacharacter in a prefix is literal', () => {
    assert.equal(repo('pc-green', ['core/fenced/**'], ['notes/x.md'])().status, 0);
    assert.equal(repo('pc-literal', ['a.b/**'], ['axb/f.ts'])().status, 0);
    assert.equal(repo('pc-literal-red', ['a.b/**'], ['a.b/f.ts'])().status, 1);
  });
  test('green: the BUILDER_UNLOCK tag opens an unlockable prefix', () => {
    const run = repo('pc-unlock', ['core/fenced/**'], ['core/fenced/x.ts'], 'core/fenced/:core');
    assert.equal(run().status, 1);
    assert.equal(run({ BUILDER_UNLOCK: 'core' }).status, 0);
  });
});
