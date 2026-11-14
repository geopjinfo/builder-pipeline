/**
 * hooks/protected-paths.cjs — two shell-reading rules, asked of the hook as Claude Code runs it (JSON on stdin, exit 2
 * = block). Nothing is executed and no link is made: every path points into a fake tree under the OS temp folder.
 *
 *  1. A link maker anywhere in a statement is a link maker. The statement-lead list is a list of PREFIXES, and a
 *     prefix not on it (`find … -exec`, `flock`, `busybox`, `doas`, `ionice -c3`, a PowerShell block) hid the maker.
 *  2. A DATA heredoc is judged by its TARGET, not by its body. `cat > notes.md <<'EOF'`, `tee [-a] f <<'EOF'` and a
 *     lone `git commit -F - <<'EOF'` write text; a body that quotes a redirect or a link into a protected folder
 *     makes neither. The body is read again whenever the rest of the command is not inert (it may run what was
 *     just written), and any CR in the command is not understood, so nothing is skipped (fails CLOSED).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'protected-paths.cjs');
const lab = mkdtempSync(join(tmpdir(), 'pp-heredoc-links-'));
const tree = join(lab, 'tree');
const outside = join(lab, 'out');
for (const d of ['.git', '.claude/hooks', 'src/core', 'docs', 'notes/k', 'requests']) mkdirSync(join(tree, d), { recursive: true });
mkdirSync(outside);
after(() => rmSync(lab, { recursive: true, force: true }));

const T = tree.replace(/\\/g, '/');
const O = outside.replace(/\\/g, '/');
const TW = tree.replace(/\//g, '\\');
const OW = outside.replace(/\//g, '\\');
const doc = (head, body, delim = "'EOF'") => `${head.replace('<<D', `<<${delim}`)}\n${body}\nEOF`;
const B = (command) => ({ tool_name: 'Bash', tool_input: { command } });
const PS = (command) => ({ tool_name: 'PowerShell', tool_input: { command } });
const ask = (payload) => {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    cwd: tree,
    env: { ...process.env, CLAUDE_PROJECT_DIR: tree, BUILDER_PROTECTED: '.claude,src/core,docs', BUILDER_UNLOCK: '' },
  });
  return { status: r.status, stderr: r.stderr || '' };
};
const lnBody = `ln -s ${T}/.claude ${O}/n`;

describe('a link maker anywhere in a statement', () => {
  for (const [label, payload] of [
    ['find -exec', B(`find ${O} -maxdepth 0 -exec ln -s ${T}/.claude ${O}/n \\;`)],
    ['find -execdir', B(`find ${O} -maxdepth 0 -execdir ln -s ${T}/src/core ${O}/n {} +`)],
    ['find -ok', B(`find ${O} -maxdepth 0 -ok ln -s ${T}/docs ${O}/n \\;`)],
    ['a flock lead', B(`flock ${O}/lock ln -s ${T}/.claude ${O}/n`)],
    ['a busybox lead', B(`busybox ln -s ${T}/.claude ${O}/n`)],
    ['a doas lead', B(`doas ln -s ${T}/.claude ${O}/n`)],
    ['an ionice lead with options', B(`ionice -c3 ln -s ${T}/.claude ${O}/n`)],
    ['PowerShell New-Item Junction inside a block', PS(`ForEach-Object { New-Item -ItemType Junction -Path ${OW}\\n -Target ${TW}\\.claude }`)],
  ]) {
    test(`red: ${label} into a protected folder is refused`, () => {
      const r = ask(payload);
      assert.equal(r.status, 2, r.stderr);
      assert.match(r.stderr, /creates a link/);
    });
  }
  for (const [label, payload] of [
    ['ln -s at the head', B(`ln -s ${T}/.claude ${O}/n`)],
    ['xargs ln', B(`echo ${O}/n | xargs ln -s ${T}/.claude`)],
    ['$( ln )', B(`echo $(ln -s ${T}/.claude ${O}/n)`)],
  ]) {
    test(`still refused: ${label}`, () => assert.equal(ask(payload).status, 2));
  }
  for (const [label, payload] of [
    ['a link between two unprotected folders', B(`ln -s ${O}/a ${O}/b`)],
    ['find -exec ln between unprotected folders', B(`find ${O} -maxdepth 0 -exec ln -s ${O}/a ${O}/b \\;`)],
    ['an echo of the word', B(`echo "use ln -s for this" > ${O}/note.txt`)],
    ['a read-only grep for the word in a protected file', B(`grep -n "ln -s" ${T}/.claude/hooks/x.cjs`)],
    ['a read-only grep piped to a read-only verb', B(`grep -c "mklink" ${T}/.claude/hooks/x.cjs | head -1`)],
    ['a word that merely contains the token', B(`echo kiln -s > ${O}/kiln.txt`)],
  ]) {
    test(`green: ${label} is allowed`, () => {
      const r = ask(payload);
      assert.equal(r.status, 0, r.stderr);
    });
  }
});

describe('a data heredoc is judged by its target, not its body', () => {
  for (const [label, command] of [
    ['a scratch note whose body quotes protected writes and links', doc(`cat > ${T}/notes/k/note.md <<D`, `edit .claude/hooks/x.cjs; echo x > ${T}/src/core/a.ts; ${lnBody}`)],
    ['cat > target, the body quotes a link maker', doc(`cat > ${T}/notes/k/probe.md <<D`, lnBody)],
    ['cat > target, the body holds a redirect', doc(`cat > ${T}/notes/k/probe.md <<D`, `run: echo x > ${T}/src/core/x.ts`)],
    ['cat <<D > target', doc(`cat <<D > ${T}/requests/req.md`, `edit .claude/hooks/x.cjs > ${T}/docs/a.md`)],
    ['tee target', doc(`tee ${T}/notes/k/y.md <<D`, '.claude/settings.json and the instruction file')],
    ['tee -a target', doc(`tee -a ${T}/notes/k/y.md <<D`, 'src/core/kernel/money.ts')],
    ['tee target with stdout discarded', doc(`tee ${T}/notes/k/y.md <<D > /dev/null`, '.claude/agents/builder.md')],
    ['git commit -F - alone', doc('git commit -F - <<D', `fix: edit .claude/hooks/x.cjs; echo x > ${T}/src/core/x.ts`)],
    ['an unquoted delimiter whose body expands nothing', doc(`cat > ${T}/notes/k/z.md <<D`, `cp a ${T}/src/core/b.ts`, 'EOF')],
  ]) {
    test(`red: ${label} is allowed`, () => {
      const r = ask(B(command));
      assert.equal(r.stderr, '');
      assert.equal(r.status, 0);
    });
  }
  for (const [label, command] of [
    ['cat > a protected target', doc(`cat > ${T}/.claude/hooks/x.js <<D`, 'hello')],
    ['cat <<D > a protected target', doc(`cat <<D > ${T}/src/core/x.ts`, 'hello')],
    ['tee a protected target', doc(`tee ${T}/docs/x.md <<D`, 'hello')],
    ['a data body, then an interpreter runs', `${doc(`cat > ${O}/p.js <<D`, `require('fs').writeFileSync('${T}/.claude/hooks/x', '')`)}\nnode ${O}/p.js`],
    ['a data body, then bash runs the written script', `${doc(`cat > ${O}/p.sh <<D`, lnBody)}\nbash ${O}/p.sh`],
    ['an unquoted body that expands $( )', doc(`cat > ${T}/notes/k/q.md <<D`, `$(${lnBody})`, 'EOF')],
    ['tee piped into a shell', doc(`tee ${T}/notes/k/y.md <<D | sh`, lnBody)],
    ['the written script run as ./p.sh', `${doc(`cat > ${O}/p.sh <<D`, lnBody)}\n./p.sh`],
    ['the written script run by a path-qualified shell', `${doc(`cat > ${O}/p.sh <<D`, lnBody)}\n/bin/sh ${O}/p.sh`],
    ['the written script run through env', `${doc(`cat > ${O}/p.sh <<D`, lnBody)}\nenv bash ${O}/p.sh`],
    ['the written script run through xargs', `${doc(`cat > ${O}/p.sh <<D`, lnBody)}\necho ${O}/p.sh | xargs sh`],
    ['the written file run by make', `${doc(`cat > ${O}/Makefile <<D`, `all:\n\t${lnBody}`)}\nmake -f ${O}/Makefile`],
    ['a lone CR after the heredoc operator', `cat > ${O}/x <<'EOF'\r${lnBody}\nEOF`],
    ['a lone CR inside the body', `cat > ${O}/x <<'EOF'\nhello\rEOF\r${lnBody}\nEOF`],
    ['git grep -nO runs the written script', `${doc(`cat > ${O}/x.sh <<D`, `echo x > ${T}/src/core/p.ts`)}\ngit grep -nO'sh ${O}/x.sh' -e zz`],
    ['git grep --open= runs the written script', `${doc(`cat > ${O}/x.sh <<D`, lnBody)}\ngit grep --open='sh ${O}/x.sh' -e zz`],
    ['git diff runs a diff.external the body configured', `${doc(`cat >> ${T}/.git/config <<D`, `[diff]\nexternal = "f(){ echo x > ${T}/src/core/p.ts; }; f"`)}\ngit diff`],
    ['git commit -F - after a body wrote a hook and core.hooksPath', `${doc(`cat > ${O}/h/pre-commit <<D`, `#!/bin/sh\necho x > ${T}/src/core/p.ts`)}\n${doc(`cat >> ${T}/.git/config <<D`, `[core]\n\thooksPath = ${O}/h`)}\n${doc('git commit --allow-empty -F - <<D', 'msg')}`],
    ["git grep -n'O' with a quoted O", `${doc(`cat > ${O}/x.sh <<D`, lnBody)}\ngit grep -n'O'"sh ${O}/x.sh" -e zz`],
    ['a CR-suffixed end line', `cat > ${O}/a.md <<'EOF'\nEOF\r\ncat > ${O}/b.md <<'ZZZ'\nEOF\necho x > ${T}/src/core/p.ts\nZZZ\n`],
  ]) {
    test(`still refused: ${label}`, () => assert.equal(ask(B(command)).status, 2));
  }
});
