#!/usr/bin/env node
/*
 * PreToolUse hook (Claude Code) — blocks agent writes to protected paths, on every route.
 *
 * "Guardrails by hook beat guardrails by goodwill": personas promise not to touch protected
 * paths (PIPELINE_PROFILE.md §4), but a hook makes the promise mechanical. Installed to
 * .claude/hooks/ by the unpack CLI; ENABLING it is a manual, deliberate step — add to
 * .claude/settings.json:
 *
 *   {
 *     "hooks": {
 *       "PreToolUse": [{
 *         "matcher": "Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell",
 *         "hooks": [{ "type": "command", "command": "node .claude/hooks/protected-paths.cjs" }]
 *       }]
 *     }
 *   }
 *
 * Fill PROTECTED below from your PIPELINE_PROFILE.md §4 (the DISCOVERY step tells the agent to
 * do this for you). Prefixes are repo-root-relative, forward slashes. `BUILDER_PROTECTED` (a comma
 * list in the hook process's environment) ADDS prefixes — it can never remove one. The profile's §16
 * `protected` globs are read too and also only ADD (profileProtected below); while they add anything the
 * profile itself is protected.
 *
 * WHAT IT JUDGES.
 *  - File tools (Write, Edit, MultiEdit, NotebookEdit — whose path is `notebook_path`): the path as SPELLED,
 *    and where the write LANDS — the real path of the deepest existing ancestor plus the rest, a dangling link
 *    followed by its text — relative to the project's real root. A junction or symlink outside the project that
 *    points into a protected folder has no protected prefix in its spelling; its landing does. A path that
 *    cannot be resolved (EACCES, a link loop) fails CLOSED when its spelling is protected.
 *  - Shell (Bash, PowerShell):
 *      writes   the accidental write shapes (`>`/`>>`, `tee`, the last operand of `mv`/`cp`, `sed -i`), each by
 *               spelling and by landing;
 *      links    creating a link (symlink, junction, hard link, a drive letter or PS drive onto a folder) whose
 *               operand is protected, lies in a protected folder, or CONTAINS one (the project root, an ancestor
 *               of it, a parent of a protected folder) is refused. Makers are recognised after a statement lead
 *               (`X=1 ln`, `{ ln …; }`, `if|then ln`, `time|nohup|xargs|eval ln`, `$(ln …)`, backticks,
 *               `cmd /c mklink`, `bash -c "…"`, PowerShell `$x = New-Item …`, `[void](New-Item …)`, a
 *               module-qualified New-Item, `Start-Process cmd -ArgumentList '/c mklink …'`) and as the link-shaped
 *               aliases `subst`, `New-PSDrive`, `ndr`, `mount`. An operand that cannot be placed (`$VAR`, `%VAR%`)
 *               fails CLOSED — spell the paths out;
 *      cd       `cd`/`pushd`/`chdir`/`Set-Location`/`sl`/`Push-Location` before a RELATIVE write, link operand
 *               or interpreter operand: every relative target is also judged under each directory the command
 *               changes into (the hook itself resolves against its own cwd), and changing INTO a protected
 *               folder before a write, a link or code is refused outright (reading after it is not);
 *      code     an interpreter (node, python, …), a heredoc, or the PowerShell tool: a path-shaped operand that is
 *               protected by spelling or by landing is refused — the Read tool is the route for reading. A DATA
 *               heredoc body (`cat >> notes.md <<'EOF'`, `tee notes.md <<'EOF'`, `git commit -F - <<'EOF'`) and a
 *               read-only pipeline are not code: naming a protected path there is not writing it (see mentionScope
 *               below). A command made of data heredoc statements alone is also judged WITHOUT their bodies by the
 *               writes, links and cd rules — a body quoting `ln -s` or `> protected/x` makes neither (dataStripped);
 *               a link maker word is found anywhere in a statement, not only after a known lead (makersAnywhere);
 *  - This file itself: it defines the protected set, so it is protected whenever anything is (`BUILDER_UNLOCK=fence`).
 *  - Hard links: a write to an EXISTING file with more than one hard link is refused. There is no link to follow,
 *    so whether the same bytes also live under a protected path cannot be told — it fails CLOSED.
 * Not seen, stated plainly: a path an interpreter builds at runtime; a `cd` whose operand cannot be placed
 * (`cd "$D"` — not failed closed, since `cd` is in most commands). A deny list of makers, admittedly; the
 * landing check is what holds when a maker is missed. Exit 2 = deny the tool call, message shown to the agent.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

// ── FILL FROM PIPELINE_PROFILE.md §4 ────────────────────────────────────────
const PROTECTED = [
  // 'src/platform/',       // stable core — boundary events go to the human
  // 'docs/',               // read-only mirror — changes ride the run's handoff pack
];
// Paths that are protected but may be unlocked by an env grant (revert after merge):
const UNLOCK_ENV = 'BUILDER_UNLOCK'; // e.g. BUILDER_UNLOCK=platform lifts entries tagged below
const UNLOCKABLE = {
  // 'src/platform/': 'platform',
};
// ────────────────────────────────────────────────────────────────────────────

const WIN = process.platform === 'win32';
const fold = (p) => (WIN ? p.toLowerCase() : p);
const fwd = (p) => String(p).replace(/[\\/]+/g, '/');
/** Sinks a redirect may name without writing a file. */
const DISCARD = /^(\/dev\/null|nul|\$null)$/i;
const RUNS_CODE = /(^|[\s;|&(])(python3?|node|deno|bun|perl|ruby|php|pwsh|powershell)([\s.]|$)|<<-?\s*['"]?[A-Za-z_]+/i;

/**
 * THE FENCE FENCES ITS OWN DEFINITION. This file holds PROTECTED and the rules that read it; unfenced, one write
 * could empty the list and every later call would be judged against the emptied set — a fence that certifies its
 * own removal. So whenever anything is protected, this file is too, by where a write LANDS (its real path, so a
 * copy elsewhere is not it and a link to it is): file tools, shell writes, code naming it, a link to it or to a
 * folder holding it. `BUILDER_UNLOCK=fence` opens it for a deliberate change, as a human grant.
 */
const SELF_TAG = '(this hook)';
const SELF_UNLOCK = 'fence';
function selfPath() {
  try {
    return fs.realpathSync.native(__filename);
  } catch (_) {
    return path.resolve(__filename);
  }
}

/**
 * PIPELINE_PROFILE.md §16 `protected` — ADD-ONLY. The profile's one `json pipeline-settings` block may list protected
 * globs; each becomes a prefix here, ADDED to PROTECTED and BUILDER_PROTECTED. Nothing in the profile can remove a
 * prefix, an unlock rule or this file's self-protection: the result is a union, and the profile is only ever read.
 *
 * Read as DATA by this file alone — no profile code is loaded (not scripts/lib/profile.cjs, never anything under
 * node_modules), so the copy unpack puts in .claude/hooks/ judges the same with node_modules gone. A profile that
 * is missing, unreadable, over PROFILE_MAX_BYTES, holds no block or more than one, is not JSON, is not an object, or
 * whose `protected` is not an array of strings adds NOTHING: the hook is then exactly as strict as without it (the
 * stricter of the two outcomes this file may choose between — it never adds less than the built-in list).
 *
 * A glob becomes the directory before its first wildcard (`src/**\/gen/*.ts` → `src/`, wider, never narrower). An
 * entry a prefix cannot hold without fencing the whole project (`*.md`, `.env*`, `**`), a negation (`!x`), an
 * unfilled placeholder (`<glob>`), an absolute path or one with a `..` segment is skipped, and the others still count.
 *
 * THE PROFILE FENCES ITSELF while §16 adds anything: a write to it, and an rm / mv / del / Remove-Item / Move-Item /
 * git rm|mv|checkout|restore that names it, is refused (`BUILDER_UNLOCK=fence` opens it, as for this file) — else
 * one edit could shrink the list this hook reads. With §16 `protected` empty the profile is NOT fenced: an edit there
 * can only add protection, and the pipeline's own setup writes the profile. Not seen, stated plainly: a glob that
 * deletes it (`rm *.md`), and a whole-tree reset (`git checkout .`, `git stash`) — residuals shared with every
 * protected path; the pre-commit hook and CI are the backstop.
 */
const PROFILE_FILE = 'PIPELINE_PROFILE.md';
const PROFILE_MAX_BYTES = 1024 * 1024;
const SETTINGS_BLOCK = /```json[ \t]+pipeline-settings[ \t]*\r?\n([\s\S]*?)\r?\n```/g;

/** One §16 glob as a root-relative prefix, or null when it cannot be one (see above). */
function globPrefix(g) {
  let p = fwd(String(g).trim()).replace(/^(?:\.\/)+/, '');
  if (!p || /[<>]/.test(p) || p.startsWith('!') || p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.split('/').includes('..')) return null;
  const wild = p.search(/[*?[\]{}]/);
  if (wild !== -1) p = p.slice(0, p.slice(0, wild).lastIndexOf('/') + 1);
  return /^\.?\/?$/.test(p) ? null : p;
}

/** The prefixes §16 `protected` adds for a project, [] when the profile adds nothing. Never throws. */
function profileProtected(projectDir) {
  try {
    const file = path.resolve(projectDir, PROFILE_FILE);
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > PROFILE_MAX_BYTES) return [];
    const blocks = [...fs.readFileSync(file, 'utf8').matchAll(SETTINGS_BLOCK)];
    if (blocks.length !== 1) return [];
    const raw = JSON.parse(blocks[0][1]);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    const list = raw.protected;
    if (list === undefined) return [];
    if (!Array.isArray(list) || !list.every((g) => typeof g === 'string')) return [];
    return [...new Set(list.map(globPrefix).filter(Boolean))];
  } catch (_) {
    return [];
  }
}

/** The fence configuration: the filled PROTECTED list plus any BUILDER_PROTECTED additions plus §16 `protected`. */
function config(env = process.env, cwd = process.cwd()) {
  const extra = String(env.BUILDER_PROTECTED || '').split(',').map((s) => s.trim()).filter(Boolean);
  const projectDir = env.CLAUDE_PROJECT_DIR || cwd;
  const norm = (p) => fwd(p).replace(/^\.\//, '');
  const base = [...new Set([...PROTECTED, ...extra].map(norm))];
  const fromProfile = profileProtected(projectDir);
  const unlockable = Object.fromEntries(Object.entries(UNLOCKABLE).map(([k, v]) => [fwd(k), v]));
  let profile = null;
  if (fromProfile.length) {
    // The profile joins the fence. A built-in entry for it keeps its own unlock rule (or none): never loosened here.
    if (!base.includes(PROFILE_FILE)) unlockable[PROFILE_FILE] = SELF_UNLOCK;
    try {
      profile = realTarget(path.resolve(projectDir, PROFILE_FILE));
    } catch (_) {
      profile = path.resolve(projectDir, PROFILE_FILE);
    }
  }
  return {
    self: selfPath(),
    prefixes: [...new Set([...base, ...fromProfile, ...(fromProfile.length ? [PROFILE_FILE] : [])])],
    unlockable,
    grant: String(env[UNLOCK_ENV] || ''),
    cwd,
    projectDir,
    profile,
  };
}

/** An absolute native path for a spelled target, or null when it cannot be placed (`/tmp/x` on Windows). */
function resolveTarget(target, cwd) {
  let p = fwd(String(target).trim());
  p = p.replace(/^(?:~|\$HOME|\$\{HOME\}|\$env:USERPROFILE|%USERPROFILE%)(?=\/|$)/i, fwd(os.homedir()));
  if (WIN && p.startsWith('/')) {
    const drive = /^\/(?:cygdrive\/)?([a-zA-Z])(\/.*|$)/.exec(p); // Git Bash spells C:\x as /c/x
    if (!drive) return null;
    p = `${drive[1]}:${drive[2] || '/'}`;
  }
  return path.resolve(cwd, p);
}

/**
 * Real path of an absolute `p` (which may not exist yet): realpath of the deepest EXISTING ancestor, plus the
 * rest; a dangling link is followed by its text (a write may create what it names), up to 8 hops.
 * Throws when it cannot be decided (EACCES, EPERM, a link loop).
 */
function realTarget(p, hops = 0) {
  const tail = [];
  for (let head = path.resolve(p); ;) {
    let st;
    try {
      st = fs.lstatSync(head, { throwIfNoEntry: false });
    } catch (e) {
      if (e.code !== 'ENOTDIR') throw e;
    }
    if (st) {
      try {
        return path.join(fs.realpathSync.native(head), ...tail);
      } catch (e) {
        if (!st.isSymbolicLink() || (e.code !== 'ENOENT' && e.code !== 'ENOTDIR')) throw e;
        if (hops >= 8) throw Object.assign(new Error('link loop'), { code: 'ELOOP' });
        return realTarget(path.join(path.resolve(path.dirname(head), fs.readlinkSync(head)), ...tail), hops + 1);
      }
    }
    const up = path.dirname(head);
    if (up === head) return path.resolve(p);
    tail.unshift(path.basename(head));
    head = up;
  }
}

const rootOf = (ctx) => {
  if (!ctx._root) ctx._root = realTarget(path.resolve(ctx.projectDir));
  return ctx._root;
};
/** Path of a real absolute path relative to the project's real root (forward slashes), or null outside it. */
function relToRoot(real, ctx) {
  const rel = path.relative(rootOf(ctx), real);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return fwd(rel);
}
/** Is a root-relative path the prefix itself (a file, or the folder) or under it? */
const under = (rel, prefix) => {
  const p = prefix.replace(/\/+$/, '');
  return rel === p || rel.startsWith(`${p}/`);
};

/** The protected prefix a target is spelled into or lands in, or null. Undecidable + spelled = fenced. */
function fenceOf(target, ctx, cwd = ctx.cwd) {
  const spelling = fwd(target);
  const spelled = ctx.prefixes.find((p) => spelling.startsWith(p) || spelling.includes(`/${p}`)) || null;
  const abs = resolveTarget(target, cwd);
  if (abs === null) return spelled;
  let real;
  try {
    real = realTarget(abs);
  } catch (e) {
    return spelled ? { prefix: spelled, why: `cannot be resolved (${e.code || e.message}); this fails closed` } : null;
  }
  if (ctx.self && fold(real) === fold(ctx.self)) return { prefix: SELF_TAG, why: 'this file defines the protected set' };
  if (spelled) return spelled;
  const rel = relToRoot(real, ctx);
  if (rel === null) return null;
  return ctx.prefixes.find((p) => under(rel, p)) || null;
}

const prefixOf = (hit) => (hit && typeof hit === 'object' ? hit.prefix : hit);
const grants = (ctx) => ctx.grant.split(',').map((s) => s.trim());
const isOpen = (prefix, ctx) =>
  prefix === SELF_TAG ? grants(ctx).includes(SELF_UNLOCK) : !!ctx.unlockable[prefix] && grants(ctx).includes(ctx.unlockable[prefix]);

/** An existing FILE with more than one hard link (0 otherwise, or when it cannot be stat'ed). */
function hardLinks(target, ctx, cwd = ctx.cwd) {
  try {
    const abs = resolveTarget(target, cwd);
    if (abs === null) return 0;
    const st = fs.statSync(realTarget(abs), { throwIfNoEntry: false });
    return st && st.isFile() && st.nlink > 1 ? st.nlink : 0;
  } catch (_) {
    return 0;
  }
}

// ──────────────────────────────────────────────────────────────── the shell
function shellWriteTargets(command) {
  const shapes = [
    />>?\s*['"]?([^\s'";|&]+)/g,
    /\btee\s+(?:-a\s+)?['"]?([^\s'";|&]+)/g,
    /\b(?:mv|cp)\s+(?:-\w+\s+)*\S+\s+['"]?([^\s'";|&]+)/g,
    /\bsed\s+(?:-\w*\s+)*-i[^\s]*\s+(?:'[^']*'|"[^"]*"|\S+)\s+['"]?([^\s'";|&]+)/g,
  ];
  const out = [];
  for (const re of shapes) {
    let m;
    while ((m = re.exec(command)) !== null) if (!DISCARD.test(m[1]) && !/^&?\d$/.test(m[1])) out.push(fwd(m[1]));
  }
  return out;
}

const SPLIT = /&&|\|\||[;\n\r|]|&(?![>&])/;
const LINK_MAKER = /^(?:(?:sudo|exec|command|env|&)\s+)*(?:["']?(?:cmd(?:\.exe)?)["']?\s+(?:\/[a-z]\s+)*[\/-]{1,2}[ck]\s+["']?)?(?:mklink|ln|junction(?:64)?|fsutil(?:\.exe)?\s+hardlink)(?:\.exe)?(?=[\s"']|$)|^cp\s(?:[^;|&]*\s)?(?:-[a-zA-Z]*[sl][a-zA-Z]*|--(?:symbolic-)?link)(?=[\s=]|$)|^(?:New-Item|ni)\s.*\b(?:SymbolicLink|Junction|HardLink)\b/i;
const LINK_CALL = /(?:Create(?:Symbolic|Hard)Link|CreateJunction|\bsymlink(?:Sync)?|\blink(?:Sync)?|\b(?:symlink|hardlink)_to)\s*\(/i;
const LINK_ALIAS = /^(?:subst|New-PSDrive|ndr|mount)(?:\.exe)?(?=[\s"']|$)/i;
const SHELL_WRAP = /(?:^|\s)(?:bash|sh|zsh|cmd(?:\.exe)?|pwsh|powershell)(?:\.exe)?\s+(?:-\w+\s+)*?[\/-]{1,2}(?:c|k|command)\s+(["']?)([\s\S]*)/i;
const START_PROCESS = /^(?:Start-Process|saps|start)\s+([\s\S]*)$/i;
const START_PROCESS_FLAGS = /(?:^|\s)-(?:FilePath|ArgumentList|Args|Wait|NoNewWindow|PassThru|Verb\s+\S+|WindowStyle\s+\S+|WorkingDirectory\s+\S+)(?=\s|$)/gi;
const STATEMENT_LEAD = /^(?:["'({]+|\$\(|`|!\s|["']?cmd(?:\.exe)?["']?\s+(?:\/[a-z]\s+)*[\/-]{1,2}[ck]\s+|(?:if|then|else|elif|do|while|until|time|nohup|exec|command|builtin|eval|sudo|env|nice|setsid|stdbuf|timeout|xargs|Invoke-Expression|iex)(?:\s+-{1,2}[\w-]+(?:=\S*)?|\s+\d+[smhd]?(?=\s))*(?=[\s"'])|[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|[^\s"']*)(?=\s)|\$[\w:]+\s*=(?!=)|\[[\w.]+\]|&|\.(?=\s)|Microsoft\.PowerShell\.Management\\)\s*/i;
const CD = /^(?:cd|pushd|chdir|Set-Location|sl|Push-Location)(?=[\s"']|$)([\s\S]*)$/i;

/** A statement with its leads stripped: the first word left is the command that runs. */
function statementHead(raw) {
  let s = String(raw).trim();
  for (let i = 0; i < 16; i += 1) {
    const next = s.replace(STATEMENT_LEAD, '').trim();
    if (next === s) break;
    s = next;
  }
  return s;
}

/** Every statement that creates a link, wherever it sits: after a lead, inside $( ) or backticks, a wrapper shell, Start-Process. */
function linkStatements(command) {
  const out = [];
  const queue = [command];
  let turns = 0;
  while (queue.length && out.length < 64 && turns < 128) {
    turns += 1;
    const text = queue.shift();
    for (const raw of text.split(SPLIT)) {
      const st = raw.trim().replace(/^["'(]+/, '');
      if (LINK_MAKER.test(st)) out.push(st);
      else {
        const head = statementHead(raw);
        if (LINK_MAKER.test(head) || LINK_ALIAS.test(head)) out.push(head);
        const started = START_PROCESS.exec(head);
        if (started) queue.push(started[1].replace(START_PROCESS_FLAGS, ' ').replace(/["',]/g, ' '));
      }
      const wrapped = SHELL_WRAP.exec(raw);
      if (wrapped && !/^cmd/i.test(raw.trim())) queue.push(wrapped[2].replace(/["']\s*$/, ''));
    }
    for (const sub of text.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)) queue.push(sub[1] ?? sub[2]);
  }
  for (const st of makersAnywhere(command)) if (out.length < 64) out.push(st);
  if (LINK_CALL.test(command)) out.push(command);
  return out;
}

/**
 * A maker WORD anywhere in a statement. The lead list above is a list of PREFIXES, and a prefix not on it hid the
 * maker (`find … -exec ln -s …`, `flock`, `busybox`, `doas`, `ionice -c3`, a PowerShell `{ New-Item … }` block). The
 * word is token-bounded (`kiln` is not `ln`) and starts a statement of its own, whose operands are judged exactly as
 * at a head. Left out: a pipeline whose every stage is read-only (`grep -n "ln -s" <protected file>` reads, it links
 * nothing) and the body of a DATA heredoc (it is written, not run) — unless the command is not inert, when the file
 * it wrote may be what runs. Not understood by the lexer = the whole text (fails CLOSED). It only adds blocks.
 */
const MAKER_ANYWHERE = /(?:^|[\s;&|({`'"=])((?:mklink|ln|junction(?:64)?|fsutil(?:\.exe)?\s+hardlink)(?:\.exe)?(?=[\s"'`)}]|$)[^\n]*|(?:New-Item|ni)\s[^\n]*\b(?:SymbolicLink|Junction|HardLink)\b[^\n]*)/i;
function makersAnywhere(command) {
  const split = splitShell(command);
  let text = command;
  if (split) {
    const kept = split.pipes.filter((p) => !p.readOnly).map((p) => p.text);
    const runs = !inertData(split) || RUNS_SHELL_CODE.test(split.pipes.map((p) => p.text).join('\n'));
    text = [...kept, ...split.docs.filter((h) => !h.kind || runs).map((h) => h.body)].join('\n');
  }
  const out = [];
  // `find … -exec ln … \;` — the escaped terminator is an argument of find, not an operand of the maker (a bare `\`
  // operand would resolve to the drive root and refuse every such link).
  for (const raw of text.replace(/\\;|';'|";"/g, ' ').split(SPLIT)) {
    const m = MAKER_ANYWHERE.exec(raw);
    if (m && out.length < 64) out.push(m[1].trim());
  }
  return out;
}

/** Operands: bare words and quoted strings, plus every quoted string nested inside another. */
function operandsOf(text) {
  const out = new Set();
  for (const re of [/"([^"]*)"|'([^']*)'|([^\s"'`;|&()<>,]+)/g, /'([^'\r\n]*)'/g, /"([^"\r\n]*)"/g, /`([^`\r\n]*)`/g]) {
    let m;
    while ((m = re.exec(text)) !== null) {
      const tok = m[1] ?? m[2] ?? m[3];
      if (tok) out.add(tok);
    }
  }
  return [...out];
}
const relativeTok = (t) => !!t && !/^(?:[A-Za-z]:|[\\/~$%`-])/.test(t) && !/\s/.test(t) && !DISCARD.test(t);

/** Every directory the command changes into (real path where it resolves), in order; `cd a && cd b` chains. */
function cdDirsOf(command, ctx) {
  const dirs = [];
  let cur = null;
  for (const raw of String(command).split(SPLIT)) {
    const m = CD.exec(statementHead(raw));
    if (!m) continue;
    const tok = operandsOf(m[1]).find((t) => !/^-/.test(t) && !/^\/[a-z]$/i.test(t));
    if (!tok || tok === '-' || /[$%`]/.test(tok)) continue; // cannot be placed: a stated residual
    const abs = resolveTarget(tok, cur || ctx.cwd);
    if (abs === null) continue;
    let real = abs;
    try {
      real = realTarget(abs);
    } catch (_) {
      /* judged by its spelling */
    }
    cur = real;
    if (!dirs.includes(real)) dirs.push(real);
    if (dirs.length >= 8) break;
  }
  return dirs;
}
const underCds = (tok, dirs) => (dirs.length && relativeTok(String(tok).trim()) ? dirs : []);

/** One link operand: protected, in a protected folder, or a folder CONTAINING one. null = not fenced. */
function linkOperandFence(tok, ctx, cwd = ctx.cwd) {
  if (/^-/.test(tok) || /^\/{1,2}[a-z]$/i.test(tok) || DISCARD.test(tok)) return null;
  tok = tok.trim().replace(/^(?:\$PWD|\$\{PWD\}|\$\(pwd\)|\$pwd)(?=[\\/]|$)/i, fwd(cwd));
  const code = /\s/.test(tok); // a path with a space, or a piece of code whose nested strings are operands of their own
  const closed = (why) => ({ prefix: ctx.prefixes[0], why: `${tok}: ${why}; this fails closed` });
  if (/[$%`]/.test(tok)) return code ? null : closed('a link operand that cannot be placed');
  const direct = fenceOf(tok, ctx, cwd);
  if (direct) return direct;
  const abs = resolveTarget(tok, cwd);
  if (abs === null) return code ? null : closed('a link operand that cannot be placed');
  let real;
  try {
    real = realTarget(abs);
  } catch (e) {
    return code ? null : closed(`cannot be resolved (${e.code})`);
  }
  const bare = real.replace(/[\\/]+$/, '');
  if (ctx.self && fold(ctx.self).startsWith(fold(bare + path.sep))) return { prefix: SELF_TAG, why: `${fwd(bare)} holds this hook, which defines the protected set` };
  const root = rootOf(ctx);
  if (fold(root + path.sep).startsWith(fold(bare + path.sep))) return { prefix: ctx.prefixes[0], why: `${fwd(bare)} is the project root or a folder above it` };
  const rel = relToRoot(bare, ctx);
  if (rel === null) return null;
  const inner = ctx.prefixes.find((p) => p.startsWith(`${rel}/`));
  return inner ? { prefix: inner, why: `${fwd(bare)} contains ${inner}` } : null;
}

/** Path-shaped operands of a code-running command (≤ 40), judged by spelling, landing, and under each cd. */
function codeOperandFence(command, dirs, ctx) {
  // A protected spelling ANYWHERE in the code's text (an assignment `P=src/core/x`, a string built in pieces next
  // to it): code that names the path is refused; nobody tries to recognise the write.
  const text = fwd(command);
  for (const p of ctx.prefixes) {
    const at = new RegExp(`(^|[^\\w.-])${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).exec(text);
    if (at) return { hit: p, tok: `${p}… (named in the code)` };
  }
  let n = 0;
  for (const tok of operandsOf(command)) {
    if (n >= 40) break;
    if (!/[\\/]|^[.~]|\.[A-Za-z0-9]+$/.test(tok) || /\s/.test(tok) || /^[a-z][a-z0-9+.-]*:\/\//i.test(tok) || DISCARD.test(tok) || /^-/.test(tok)) continue;
    n += 1;
    const hit = fenceOf(tok, ctx);
    if (hit) return { hit, tok };
    for (const d of underCds(tok, dirs)) {
      const viaCd = fenceOf(tok, ctx, d);
      if (viaCd) return { hit: viaCd, tok };
    }
  }
  return null;
}

/**
 * WHICH TEXT the code rule reads. Reading all of it refused READ-ONLY commands that merely NAMED a protected path
 * next to a heredoc or an interpreter: notes appended with `cat >> notes.md <<'EOF'` that mention a protected
 * folder, a commit message on stdin (`git commit -F - <<'EOF'`) naming one, `node scan.js && grep -c x docs/a.md`.
 * Two things are left out of the reading, and nothing else:
 *   1. the BODY of a heredoc that is pure DATA — its delimiter quoted (or a body with no `$`, backtick or
 *      backslash, so nothing in it expands), consumed by `cat >[>] FILE` or `git commit|tag … -F -`, alone in its
 *      pipeline. A `cat` body is read again whenever anything in the command could RUN the file it wrote (an
 *      interpreter, a shell, `source`, `.`, `xargs`, `eval`, `iex`, `Start-Process`, a PowerShell `&` call);
 *   2. a pipeline whose every stage is a READ-ONLY verb with no redirect and no writing option.
 * The write TARGETS are untouched: `cat > FILE <<'EOF'` is still judged at FILE, by spelling and by landing. Link
 * creation and the cd-into rule still read the whole command. POSIX shell text only (the PowerShell tool keeps the
 * whole-text reading). Anything the lexer does not fully understand — `$(`, a backtick, `$'…'`, `(`/`)`, a comment,
 * a line continuation, an unterminated quote or heredoc — returns the whole text: it fails CLOSED.
 */
const READ_ONLY = /^(?:cat|ls|grep|egrep|fgrep|wc|head|tail|test|\[|stat|diff|echo|pwd|true|git[ \t]+(?:log|show|diff|status|blame|ls-files|grep|rev-parse|cat-file))(?=[ \t]|$)/;
// Options of those verbs that write a file or run a program: also `-O` bundled into a flag cluster (`-nO'cmd'`) and
// git's unambiguous long-option prefixes (`--open=`, `--ou…`) — each runs a pager command or writes a file.
const READ_ONLY_WRITES = /(?:^|[\s'"])(?:--op(?:e(?:n[\w-]*)?)?(?=[\s=]|$)|--ou[\w-]*|--output\b|-[A-Za-z0-9]*O)/;
const HEREDOC_OP = String.raw`<<-?[ \t]*(?:'\w+'|"\w+"|\\\w+|\w+)`;
const REDIRECT_TARGET = String.raw`(?:'[^']*'|"[^"]*"|[^\s'"<>|;&]+)`;
const DATA_CAT = new RegExp(String.raw`^cat[ \t]+(?:>>?[ \t]*${REDIRECT_TARGET}[ \t]+${HEREDOC_OP}|${HEREDOC_OP}[ \t]+>>?[ \t]*${REDIRECT_TARGET})$`);
// `tee [-a] FILE <<'EOF'`, the other redirect-only data form. Its stdout may be discarded; a pipe out of it is not data.
const DATA_TEE = new RegExp(String.raw`^tee[ \t]+(?:-a[ \t]+)?${REDIRECT_TARGET}[ \t]+${HEREDOC_OP}(?:[ \t]+[12]?>[ \t]*\/dev\/null)?$`);
const INTERPRETER = /(^|[\s;|&(])(python3?|node|deno|bun|perl|ruby|php|pwsh|powershell)([\s.]|$)/i;
/** Code that may run what a data heredoc just wrote: an interpreter, or a shell (`bash f`, `sh f`, `source f`, `. f`, `| sh`). */
const RUNS_SHELL_CODE = new RegExp(String.raw`${INTERPRETER.source}|(?:^|[\s;|&(\/\\])(?:bash|sh|zsh|dash|ksh|source|exec|eval)(?:\.exe)?(?=[\s;|&)]|$)|(?:^|[;&|\n]\s*)\.\s`, 'i');
const DATA_GIT = new RegExp(String.raw`^git[ \t]+(?:commit|tag)(?:[ \t]+[\w.\/:@+=-]+)*?[ \t]+(?:-F[ \t]*-|--file(?:=|[ \t]+)-)(?:[ \t]+[\w.\/:@+=-]+)*[ \t]+${HEREDOC_OP}$`);
const RUNNER = /(^|[\s;|&(])(python3?|node|deno|bun|perl|ruby|php|pwsh|powershell|bash|sh|zsh|dash|ksh|cmd|source|xargs|eval|iex|invoke-expression|start-process|npx|tsx|ts-node)([\s.]|$)|(^|[\s;|&])\.[ \t]+\S|(^|[\s;|(])&(?![&>])[ \t]/i;

/** Quote-aware split into pipelines + heredoc bodies; null = not understood (the caller fails closed). */
function splitShell(s) {
  // bash ends a line on `\n` only, so a lone `\r` is part of a word to bash but a line end here, and stock bash
  // compares a heredoc end line WITH its CR (`EOF\r` is not `EOF`): a body boundary the two disagree on. Any CR =
  // not understood (fails CLOSED).
  if (/\r/.test(s)) return null;
  const stmts = [];
  const docs = [];
  let raw = '';
  let bare = ''; // `raw` with every quoted character blanked, so a quoted `>` is not a redirect
  let state = 'N';
  let pending = [];
  let i = 0;
  const end = (sep) => {
    stmts.push({ raw, bare, sep, docs: [] });
    raw = '';
    bare = '';
  };
  const add = (r, b = r) => {
    raw += r;
    bare += b;
  };
  while (i < s.length) {
    const c = s[i];
    const n = s[i + 1];
    if (state === 'S') {
      add(c, c === "'" ? c : '_');
      if (c === "'") state = 'N';
      i += 1;
      continue;
    }
    if (state === 'D') {
      if (c === '`' || (c === '$' && n === '(')) return null;
      if (c === '\\') {
        add(s.slice(i, i + 2), '__');
        i += 2;
        continue;
      }
      add(c, c === '"' ? c : '_');
      if (c === '"') state = 'N';
      i += 1;
      continue;
    }
    if (c === "'" || c === '"') {
      state = c === "'" ? 'S' : 'D';
      add(c);
      i += 1;
      continue;
    }
    if (c === '`' || c === '(' || c === ')' || (c === '$' && (n === '(' || n === "'"))) return null;
    if (c === '\\') {
      if (n === undefined || n === '\n' || n === '\r') return null;
      add(s.slice(i, i + 2), '__');
      i += 2;
      continue;
    }
    if (c === '#' && (i === 0 || /[\s;&|]/.test(s[i - 1]))) return null;
    if (c === '<' && n === '<') {
      if (s[i + 2] === '<') {
        add('<<<'); // a here-STRING: its word stays ordinary text
        i += 3;
        continue;
      }
      const m = /^<<(-?)[ \t]*(?:'([A-Za-z_]\w*)'|"([A-Za-z_]\w*)"|\\([A-Za-z_]\w*)|([A-Za-z_]\w*))/.exec(s.slice(i));
      if (!m) return null;
      pending.push({ delim: m[2] || m[3] || m[4] || m[5], strip: m[1] === '-', quoted: !m[5], stmt: stmts.length });
      add(m[0]);
      i += m[0].length;
      continue;
    }
    if (c === '\n' || c === '\r') {
      if (c === '\r' && n === '\n') i += 1;
      end('\n');
      i += 1;
      for (const h of pending) {
        const start = i;
        for (;;) {
          if (i >= s.length) return null; // unterminated heredoc
          let e = s.indexOf('\n', i);
          if (e < 0) e = s.length;
          let line = s.slice(i, e).replace(/\r$/, '');
          if (h.strip) line = line.replace(/^\t+/, '');
          const next = Math.min(e + 1, s.length);
          if (line === h.delim) {
            h.body = s.slice(start, i);
            i = next;
            break;
          }
          i = next;
        }
        docs.push(h);
      }
      pending = [];
      continue;
    }
    if (c === ';') {
      end(';');
      i += 1;
      continue;
    }
    if (c === '&') {
      if (n === '&') {
        end('&&');
        i += 2;
        continue;
      }
      if (s[i - 1] === '>' || s[i - 1] === '<' || n === '>') {
        add(c); // 2>&1, &>, >&
        i += 1;
        continue;
      }
      end('&');
      i += 1;
      continue;
    }
    if (c === '|') {
      if (n === '|') {
        end('||');
        i += 2;
        continue;
      }
      end('|');
      i += 1;
      continue;
    }
    add(c);
    i += 1;
  }
  if (state !== 'N' || pending.length) return null;
  end('');
  for (const h of docs) stmts[h.stmt].docs.push(h);
  const pipes = [];
  let cur = [];
  for (const st of stmts) {
    cur.push(st);
    if (st.sep !== '|') {
      pipes.push(cur);
      cur = [];
    }
  }
  for (const pipe of pipes) {
    for (const st of pipe) {
      const t = st.raw.trim();
      for (const h of st.docs) {
        const literal = h.quoted || !/[$`\\]/.test(h.body);
        h.kind = !literal || pipe.length !== 1 || st.docs.length !== 1 ? null : DATA_CAT.test(t) ? 'cat' : DATA_TEE.test(t) ? 'tee' : DATA_GIT.test(t) ? 'git' : null;
      }
    }
  }
  const readOnly = (st) => {
    const t = st.raw.trim();
    const sinkless = st.bare.replace(/(^|\s)\d?>[ \t]*\/dev\/null(?=\s|$)/g, '$1').replace(/(^|\s)2>&1(?=\s|$)/g, '$1');
    // Also judged with quotes and backslashes removed: `-n'O'cmd`, `-\O`, `--o"pen"` are -nO / --open to git.
    return st.docs.length === 0 && !/[<>]/.test(sinkless) && READ_ONLY.test(t) && !READ_ONLY_WRITES.test(t) && !READ_ONLY_WRITES.test(t.replace(/['"\\]/g, ''));
  };
  return {
    pipes: pipes.map((p) => ({
      text: p.map((st) => st.raw).join(' | '),
      readOnly: p.some((st) => st.raw.trim()) && p.every((st) => !st.raw.trim() || readOnly(st)),
      // The pipeline IS one data heredoc statement: 'cat' | 'tee' | 'git' | null.
      data: p.length === 1 && p[0].docs.length === 1 ? p[0].docs[0].kind || null : null,
    })),
    docs,
  };
}

/**
 * A command made of DATA heredoc statements and nothing else. A `git commit|tag -F -` statement runs config-driven
 * code (hooks, fsmonitor, clean filters), so it is inert only as the WHOLE command — beside a `cat`/`tee` that may
 * have just written that hook or config, it is not. Read-only pipelines do not count as inert here: `git grep -nO`,
 * `--open=` and `git diff` with a diff.external run commands.
 */
function inertData(split) {
  const live = split.pipes.filter((p) => p.text.trim());
  return live.every((p) => p.data) && (live.length === 1 || live.every((p) => p.data !== 'git'));
}

/**
 * The text the write-shape, link and `cd` stages read: the command without the bodies of its DATA heredocs (the
 * redirect target stays in the statement and is judged by spelling and by landing as before). The whole text is kept
 * when the lexer does not understand the command (fails CLOSED), when the command is not made of data statements
 * alone (a deny list of runners — `./f`, `/bin/sh f`, `xargs`, `make`, `env` — would be a game the next spelling
 * wins), and when it runs code (RUNS_SHELL_CODE, belt and braces). A non-data heredoc body is always kept.
 */
function dataStripped(command) {
  const split = splitShell(command);
  if (!split || !split.docs.some((h) => h.kind)) return command;
  if (!inertData(split)) return command;
  const statements = split.pipes.map((p) => p.text).join('\n');
  if (RUNS_SHELL_CODE.test(statements)) return command;
  return [statements, ...split.docs.filter((h) => !h.kind).map((h) => h.body)].join('\n');
}

/** The text the code rule reads: '' when nothing but data and read-only pipelines carried the trigger. */
function mentionScope(command) {
  const split = splitShell(command);
  if (!split) return command; // not understood: the whole text (fails CLOSED)
  const kept = split.pipes.filter((p) => !p.readOnly).map((p) => p.text).join('\n');
  const notData = split.docs.filter((h) => !h.kind);
  const runs = RUNNER.test(kept);
  if (!runs && notData.length === 0) return '';
  const catBodies = runs ? split.docs.filter((h) => h.kind === 'cat' || h.kind === 'tee').map((h) => h.body) : [];
  return [kept, ...notData.map((h) => h.body), ...catBodies].join('\n');
}

// ──────────────────────────────────────────────────────────────── decide
const blocked = (reason) => ({ block: true, reason });
function deny(hit, what, ctx) {
  const prefix = prefixOf(hit);
  if (isOpen(prefix, ctx)) return null;
  const why = hit && typeof hit === 'object' && hit.why ? ` (${hit.why})` : '';
  return blocked(
    `BLOCKED: ${what} reaches the protected path "${prefix}"${why} (PIPELINE_PROFILE.md §4/§16). ` +
      'A write is judged by where it lands. This is a boundary event — stop and ask the human. ' +
      (prefix === SELF_TAG
        ? `(Unlockable via ${UNLOCK_ENV}=${SELF_UNLOCK} — human grant only.)`
        : ctx.unlockable[prefix]
          ? `(Unlockable via ${UNLOCK_ENV}=${ctx.unlockable[prefix]} — human grant only.)`
          : ''),
  );
}

/** Commands that delete, move away or roll back a file they name (the profile rule above). */
const PROFILE_REMOVER = /^(?:rm|unlink|del|erase|rd|rmdir|mv|move|ren|rename|Remove-Item|ri|Move-Item|mi|Rename-Item|rni|git\s+(?:-\S+\s+)*(?:rm|mv|checkout|restore|reset|switch))(?:\.exe)?(?=[\s"']|$)/i;

/** A statement that removes, moves or restores the fenced profile, or null. A name that cannot be placed fails closed. */
function profileRemoval(text, dirs, ctx) {
  if (!ctx.profile) return null;
  const hit = (tok) => ({ prefix: PROFILE_FILE, why: `${tok} is the profile whose §16 adds protected paths; removing, moving or restoring it would shrink the fence` });
  for (const raw of String(text).split(SPLIT)) {
    const head = statementHead(raw);
    if (!PROFILE_REMOVER.test(head)) continue;
    for (const tok of operandsOf(head)) {
      if (!new RegExp(`(^|[\\\\/])${PROFILE_FILE.replace('.', '\\.')}$`, 'i').test(tok.trim())) continue;
      if (/[$%`]/.test(tok)) return hit(tok);
      for (const cwd of [ctx.cwd, ...underCds(tok, dirs)]) {
        const abs = resolveTarget(tok, cwd);
        if (abs === null) return hit(tok);
        let real;
        try {
          real = realTarget(abs);
        } catch (_) {
          return hit(tok);
        }
        if (fold(real) === fold(ctx.profile)) return hit(tok);
      }
    }
  }
  return null;
}

function decideShell(command, isPowerShell, ctx) {
  const tool = isPowerShell ? 'PowerShell' : 'Bash';
  const text = isPowerShell ? command : dataStripped(command); // a data heredoc body is not a write, a link or a cd
  const writes = shellWriteTargets(text);
  const dirs = cdDirsOf(text, ctx);
  const links = linkStatements(text);
  const runsCode = isPowerShell || RUNS_CODE.test(command);
  const removal = profileRemoval(text, dirs, ctx);
  if (removal) {
    const r = deny(removal, `this ${tool} command removes, moves or restores ${PROFILE_FILE}, which`, ctx);
    if (r) return r;
  }
  for (const target of writes) {
    const hit = fenceOf(target, ctx);
    if (hit) {
      const r = deny(hit, `this ${tool} command writes ${target}, which`, ctx);
      if (r) return r;
      continue;
    }
    const n = hardLinks(target, ctx);
    if (n) return blocked(`BLOCKED: this ${tool} command writes ${target}, an existing file with ${n} hard links. The same bytes live at another path this hook cannot see, which may be protected. Delete this name (one file) and write the file fresh, or ask the human.`);
  }
  for (const st of links) {
    for (const tok of operandsOf(st)) {
      const hit = linkOperandFence(tok, ctx) || underCds(tok, dirs).map((d) => linkOperandFence(tok, ctx, d)).find(Boolean);
      if (hit) {
        const r = deny(hit, `this ${tool} command creates a link that`, ctx);
        if (r) return r;
      }
    }
  }
  if (dirs.length && (writes.length || links.length || runsCode)) {
    for (const d of dirs) {
      const hit = fenceOf(path.join(d, '.cd-probe'), ctx);
      if (hit) {
        const r = deny(hit, `this ${tool} command changes into ${fwd(d)} and then writes, links or runs code there — a relative write after cd lands where the cd went — and`, ctx);
        if (r) return r;
      }
    }
    for (const target of writes) {
      for (const d of underCds(target, dirs)) {
        const hit = fenceOf(target, ctx, d);
        if (hit) {
          const r = deny(hit, `this ${tool} command writes ${target} after a cd, which`, ctx);
          if (r) return r;
        }
        const n = hardLinks(target, ctx, d);
        if (n) return blocked(`BLOCKED: this ${tool} command writes ${target} after a cd, an existing file with ${n} hard links. Delete this name and write the file fresh, or ask the human.`);
      }
    }
  }
  const scope = isPowerShell ? command : mentionScope(command); // data heredoc bodies and read-only pipelines are not code
  if (runsCode && scope) {
    const via = codeOperandFence(scope, dirs, ctx);
    if (via) {
      const r = deny(via.hit, `this ${tool} command runs code naming ${via.tok}, which`, ctx);
      if (r) return { ...r, reason: `${r.reason} Read with the Read tool, or put the code in a script that names no protected path.` };
    }
  }
  return { block: false };
}

/**
 * The verdict for one tool call: { block, reason }. `ctx` from config(); pure apart from filesystem reads (no
 * writes), so the tests drive it directly.
 */
function decide(input, ctx = config()) {
  if (!ctx.prefixes.length) return { block: false };
  const ti = (input && input.tool_input) || {};
  const tool = String((input && input.tool_name) || '');
  const isPowerShell = /^powershell$/i.test(tool);
  if ((tool === 'Bash' || isPowerShell) && typeof ti.command === 'string') return decideShell(ti.command, isPowerShell, ctx);
  const filePath = ti.file_path || ti.notebook_path || '';
  if (!filePath) return { block: false };
  // fenceOf reads a RUN of separators as one: a doubled backslash or slash must not hide a protected prefix.
  const hit = fenceOf(filePath, ctx);
  if (hit) return deny(hit, `${filePath}`, ctx) || { block: false };
  const n = hardLinks(filePath, ctx);
  if (n) return blocked(`BLOCKED: ${filePath} is an existing file with ${n} hard links. The same bytes live at another path this hook cannot see, which may be protected. Delete this name (one file) and write the file fresh, or ask the human.`);
  return { block: false };
}

module.exports = { decide, config, profileProtected, globPrefix, mentionScope, splitShell, SELF_UNLOCK, linkStatements, statementHead, cdDirsOf, shellWriteTargets, fenceOf, realTarget, resolveTarget };

if (require.main === module) {
  let input = '';
  process.stdin.on('data', (d) => (input += d));
  process.stdin.on('end', () => {
    let j;
    try {
      j = JSON.parse(input);
    } catch (_) {
      process.exit(0); // malformed input → don't block
    }
    const v = decide(j, config());
    if (v.block) {
      console.error(v.reason);
      process.exit(2); // exit 2 = deny the tool call, message shown to the agent
    }
    process.exit(0);
  });
}
