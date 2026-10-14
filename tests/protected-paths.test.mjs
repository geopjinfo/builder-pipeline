/**
 * The protected-paths hook (hooks/protected-paths.cjs) — writes judged by where they land, on every route.
 *
 * Every link here lives in a fresh os.tmpdir() lab and points at a FAKE project there (a folder with a `.git` dir),
 * never at this checkout. The link-creation cases only ASK the hook; nothing is created from command text. After the
 * suite each LINK is removed by itself (rmdir/unlink on the link, never a recursive delete through it), and the lab
 * is removed only once no link is left in it. The fence configuration is the test's own (`src/core/`, `docs/`), not a
 * house spelling: the hook protects whatever the profile declares. Every guard has a red case and a green control.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { linkSync, lstatSync, mkdirSync, mkdtempSync, rmdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'protected-paths.cjs');
const guard = require(HOOK);

const slash = (p) => p.replace(/\\/g, '/');
const bsl = (p) => p.replace(/\//g, '\\');

const lab = mkdtempSync(join(tmpdir(), 'fence-'));
const proj = join(lab, 'proj'); // the fake project
const out = join(lab, 'out'); //   outside the project: the links live here
for (const d of ['.git', 'src/core/kernel', 'src/feature', 'docs', 'notes']) mkdirSync(join(proj, d), { recursive: true });
writeFileSync(join(proj, 'src/core/kernel/k.ts'), 'x');
mkdirSync(out);
const made = [];
let linkError = '';
const link = (at, target) => {
  try {
    symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir');
    made.push(at);
  } catch (e) {
    if (!linkError) linkError = `${at}: ${e.message}`;
  }
};
link(join(out, 'j'), join(proj, 'src', 'core')); // a name with no protected spelling
link(join(out, 'safe'), join(proj, 'src', 'feature')); // control: not protected
link(join(out, 'dg2'), join(proj, 'src', 'core', 'not-yet')); // dangling, through a chain
link(join(out, 'dg1'), join(out, 'dg2'));
link(join(out, 'loopA'), join(out, 'loopB'));
link(join(out, 'loopB'), join(out, 'loopA'));
const hard = join(proj, 'src', 'feature', 'k.ts'); // a HARD link in feature code to a protected file
let hardError = '';
try {
  linkSync(join(proj, 'src/core/kernel/k.ts'), hard);
} catch (e) {
  hardError = e.message;
}
after(() => {
  if (!hardError) unlinkSync(hard); // one name of the file; the original stays
  for (const at of made) {
    try {
      rmdirSync(at);
    } catch {
      unlinkSync(at);
    } // the LINK itself, never its target
  }
  const left = made.filter((at) => {
    try {
      lstatSync(at);
      return true;
    } catch {
      return false;
    }
  });
  if (left.length === 0) rmSync(lab, { recursive: true, force: true }); // no link left to recurse through
});

const P = slash(proj);
const O = slash(out);
const PW = bsl(P);
const OW = bsl(O);
const ctx = (over = {}) => ({ prefixes: ['src/core/', 'docs/'], unlockable: { 'src/core/': 'core' }, grant: '', cwd: proj, projectDir: proj, ...over });
const ask = (payload, over) => guard.decide(payload, ctx(over));
const write = (file_path) => ({ tool_name: 'Write', tool_input: { file_path, content: 'x' } });
const notebook = (notebook_path) => ({ tool_name: 'NotebookEdit', tool_input: { notebook_path, new_source: 'x' } });
const sh = (command) => ({ tool_name: 'Bash', tool_input: { command } });
const ps = (command) => ({ tool_name: 'PowerShell', tool_input: { command } });
const blocks = (payload, over) => ask(payload, over).block === true;

test('precondition: the fixture links and the hard link exist — a skipped proof is a failure, never silent', () => {
  assert.equal(linkError, '');
  assert.equal(hardError, '');
  assert.equal(statSync(hard).nlink, 2);
});

describe('file tools', () => {
  test('red: a write spelled into, or landing in, a protected folder is refused — through a junction, a dangling chain, a loop', () => {
    assert.ok(blocks(write(`${P}/src/core/a.ts`)));
    assert.ok(blocks(write('src//core\\a.ts'))); // a run of separators hides nothing
    assert.ok(blocks(write(`${O}/j/a.ts`)));
    assert.ok(blocks(write(`${O}/dg1/x.ts`)));
    assert.ok(blocks(write(`${O}/loopA/src/core/x.ts`))); // undecidable + protected spelling = fails closed
  });

  test('red: NotebookEdit is judged like Write — its path is notebook_path', () => {
    assert.ok(blocks(notebook(`${P}/docs/x.ipynb`)));
    assert.ok(blocks(notebook(`${O}/j/x.ipynb`)));
  });

  test('red: a write to an existing hard-linked file is refused — no link to follow', () => {
    const r = ask(write(slash(hard)));
    assert.equal(r.block, true);
    assert.match(r.reason, /2 hard links/);
  });

  test('green: ordinary writes, a link to an unprotected folder, a single-link file, and an unlock grant', () => {
    assert.equal(blocks(write(`${P}/src/feature/new.ts`)), false);
    assert.equal(blocks(write(`${O}/safe/z.ts`)), false);
    assert.equal(blocks(write(`${P}/mydocs/x.md`)), false);
    assert.equal(blocks(write(`${P}/src/core/a.ts`), { grant: 'core' }), false);
    assert.equal(blocks(write(`${P}/docs/a.md`), { grant: 'core' }), true); // a grant opens only its own prefix
    assert.equal(guard.decide(write(`${P}/src/core/a.ts`), ctx({ prefixes: [] })).block, false); // nothing configured
  });
});

describe('shell writes, hard links and cd', () => {
  test('red: a shell write into, or through a link into, a protected folder is refused', () => {
    assert.ok(blocks(sh('echo x > src/core/a.ts')));
    assert.ok(blocks(sh(`echo x >> ${O}/j/a.ts`)));
    assert.ok(blocks(sh('cat a | tee docs/a.md')));
    assert.ok(blocks(sh(`cp notes/a.md ${O}/j/b.ts`)));
    assert.ok(blocks(sh(`echo x > ${slash(hard)}`))); // hard-linked target
  });

  test('red: cd before a relative write lands where the cd went — through a link, and with no link at all', () => {
    assert.ok(blocks(sh(`cd ${O}/j && echo x > kernel/y.ts`)));
    assert.ok(blocks(sh(`cd ${P}/src && echo x > core/y.ts`)));
    assert.ok(blocks(sh(`cd ${P} && cd src && echo x > core/k.ts`))); // chained cd
    assert.ok(blocks(sh(`pushd ${O}/j; cp a kernel/x.ts`)));
    assert.ok(blocks(ps(`Set-Location ${OW}\\j; Set-Content kernel\\x y`)));
    assert.ok(blocks(sh(`cd ${P}/src/feature && echo x > k.ts`))); // hard-linked, reached after cd
  });

  test('red: changing INTO a protected folder and then writing or running code there is refused', () => {
    assert.ok(blocks(sh(`cd ${P}/docs && node w.js`)));
    assert.ok(blocks(sh(`cd ${P}/src/core && echo x > y.ts`)));
    assert.ok(blocks(ps(`Set-Location ${PW}\\src\\core; Get-ChildItem`)));
  });

  test('red: code naming a protected path is refused — by spelling, through a link, in a nested string', () => {
    assert.ok(blocks(sh('node -e "require(\'fs\').writeFileSync(\'src/core/a.ts\',\'x\')"')));
    assert.ok(blocks(sh(`python tool.py ${O}/j/kernel/k.ts`)));
    assert.ok(blocks(ps(`Set-Content ${OW}\\j\\x.ts y`)));
  });

  test('green: leads and cd before ordinary work are unchanged; reading after cd into a fence is allowed', () => {
    for (const c of ['X=1 npm run build', 'timeout 5 git status', `cd ${P} && git status --short`, `cd ${P} && npm test > notes/a.log 2>&1`,
      `cd ${P}/docs && ls`, `cd ${P}/src && echo x > feature/y.ts`, `cd ${O}/safe && echo x > y.ts`, 'git commit -m "if ln -s fails, try mklink /J or subst"',
      'echo x 2>/dev/null', `node scripts/x.js ${P}/notes/a.md`]) {
      assert.equal(blocks(sh(c)), false, c);
    }
    assert.equal(blocks(ps(`Set-Location ${OW}\\safe; Set-Content y.ts z`)), false);
  });
});

describe('creating a link into a protected folder', () => {
  const LEAD_CASES = [
    ['ln -s', sh(`ln -s ${P}/src/core ${O}/n`)],
    ['a hard link (ln without -s) to a protected file', sh(`ln ${P}/src/core/kernel/k.ts ${O}/k.ts`)],
    ['an env assignment before ln -s', sh(`X=1 ln -s ${P}/src/core ${O}/n`)],
    ['a brace group', sh(`true && { ln -s ${P}/docs ${O}/n; }`)],
    ['if ln -s', sh(`if ln -s ${P}/src/core ${O}/n; then :; fi`)],
    ['then ln -s', sh(`if true; then ln -s ${P}/docs ${O}/n; fi`)],
    ['nohup ln -s', sh(`nohup ln -s ${P}/src/core ${O}/n`)],
    ['time ln -s', sh(`time ln -s ${P}/src/core ${O}/n`)],
    ['xargs ln -s (the link name from stdin)', sh(`echo ${O}/n | xargs ln -s ${P}/src/core`)],
    ['a command substitution', sh(`echo $(ln -s ${P}/src/core ${O}/n)`)],
    ['backticks', sh(`echo \`ln -s ${P}/docs ${O}/n\``)],
    ['bash -c', sh(`bash -c "ln -s ${P}/docs ${O}/n"`)],
    ['cmd /c mklink /J', sh(`cmd /c mklink /J ${OW}\\n ${PW}\\src\\core`)],
    ['a link to a folder that CONTAINS the fence', sh(`ln -s ${P}/src ${O}/n`)],
    ['a link to the project root', sh(`ln -s ${P} ${O}/n`)],
    ['an operand that cannot be placed', sh(`ln -s $TARGET ${O}/n`)],
    ['PowerShell $null = New-Item Junction', ps(`$null = New-Item -ItemType Junction -Path ${OW}\\n -Target ${PW}\\src\\core`)],
    ['PowerShell [void](New-Item Junction)', ps(`[void](New-Item -ItemType Junction -Path ${OW}\\n -Target ${PW}\\docs)`)],
    ['PowerShell module-qualified New-Item', ps(`Microsoft.PowerShell.Management\\New-Item -ItemType SymbolicLink -Path ${OW}\\n -Target ${PW}\\docs`)],
    ['PowerShell Start-Process cmd /c mklink /J', ps(`Start-Process cmd -ArgumentList '/c mklink /J ${OW}\\n ${PW}\\src\\core'`)],
    ['subst (a drive letter onto a protected folder)', sh(`subst Q: ${PW}\\src\\core`)],
    ['cmd //c subst', sh(`cmd //c subst Q: ${PW}\\docs`)],
    ['PowerShell New-PSDrive', ps(`New-PSDrive -Name Q -PSProvider FileSystem -Root ${PW}\\src`)],
    ['ndr', ps(`ndr -Name Q -PSProvider FileSystem -Root ${PW}\\docs`)],
    ['cd into src, then a relative link operand', sh(`cd ${P}/src && ln -s core ${O}/n`)],
    ['an interpreter calling symlink', sh(`node -e "require('fs').symlinkSync('${P}/src/core','${O}/n','junction')"`)],
  ];

  test('the table is the size it claims — an emptied table must fail, not pass quietly', () => {
    assert.equal(LEAD_CASES.length, 26);
  });

  for (const [label, payload] of LEAD_CASES) {
    test(`red: refused — ${label}`, () => {
      const r = ask(payload);
      assert.equal(r.block, true, label);
      assert.match(r.reason, /creates a link/); // refused as a link, not by some other rule

    });
  }

  test('green: links and drives onto an unprotected folder still work', () => {
    assert.equal(blocks(ps(`$x = New-Item -ItemType Junction -Path ${OW}\\j2 -Target ${OW}\\safe`)), false);
    assert.equal(blocks(ps(`$x = New-Item -ItemType Directory -Path ${OW}\\dir`)), false);
    assert.equal(blocks(ps(`New-PSDrive -Name Q -PSProvider FileSystem -Root ${PW}\\src\\feature`)), false);
    assert.equal(blocks(sh(`subst Q: ${PW}\\notes`)), false);
    assert.equal(blocks(sh(`ln -s ${P}/src/feature ${O}/n`)), false);
  });

  test('red: an unlock grant opens only its own prefix, on the shell route too', () => {
    assert.equal(blocks(sh(`ln -s ${P}/src/core ${O}/n`), { grant: 'core' }), false);
    assert.equal(blocks(sh(`ln -s ${P}/docs ${O}/n`), { grant: 'core' }), true);
  });
});

describe('the hook as Claude Code runs it', () => {
  const run = (payload, env = {}) => spawnSync(process.execPath, [HOOK], { input: JSON.stringify(payload), cwd: proj, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: proj, BUILDER_UNLOCK: '', ...env } });

  test('red: exit 2 with the reason on stderr; BUILDER_PROTECTED adds prefixes; exit 0 when nothing is protected', () => {
    const r = run(sh(`cd ${O}/j && echo x > a.ts`), { BUILDER_PROTECTED: 'src/core/' });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /BLOCKED: .*src\/core\//);
    assert.equal(run(notebook(`${P}/docs/x.ipynb`), { BUILDER_PROTECTED: 'docs/' }).status, 2);
    assert.equal(run(sh(`cd ${O}/j && echo x > a.ts`), { BUILDER_PROTECTED: '' }).status, 0);
    assert.equal(spawnSync(process.execPath, [HOOK], { input: 'not json', encoding: 'utf8' }).status, 0); // malformed input → don't block
  });

  test('the shipped settings snippet names every route the hook judges', () => {
    const text = require('node:fs').readFileSync(HOOK, 'utf8');
    const matcher = /"matcher": "([^"]+)"/.exec(text)[1].split('|');
    for (const t of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'PowerShell']) assert.ok(matcher.includes(t), t);
  });
});
