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
 * list in the hook process's environment) ADDS prefixes — it can never remove one.
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
 *               protected by spelling or by landing is refused — the Read tool is the route for reading.
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

/** The fence configuration: the filled PROTECTED list plus any BUILDER_PROTECTED additions. */
function config(env = process.env, cwd = process.cwd()) {
  const extra = String(env.BUILDER_PROTECTED || '').split(',').map((s) => s.trim()).filter(Boolean);
  return {
    prefixes: [...new Set([...PROTECTED, ...extra].map((p) => fwd(p).replace(/^\.\//, '')))],
    unlockable: Object.fromEntries(Object.entries(UNLOCKABLE).map(([k, v]) => [fwd(k), v])),
    grant: String(env[UNLOCK_ENV] || ''),
    cwd,
    projectDir: env.CLAUDE_PROJECT_DIR || cwd,
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
  if (spelled) return spelled;
  const rel = relToRoot(real, ctx);
  if (rel === null) return null;
  return ctx.prefixes.find((p) => under(rel, p)) || null;
}

const prefixOf = (hit) => (hit && typeof hit === 'object' ? hit.prefix : hit);
const isOpen = (prefix, ctx) => !!ctx.unlockable[prefix] && ctx.grant.split(',').map((s) => s.trim()).includes(ctx.unlockable[prefix]);

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
  if (LINK_CALL.test(command)) out.push(command);
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
  const root = rootOf(ctx);
  if (fold(root + path.sep).startsWith(fold(bare + path.sep))) return { prefix: ctx.prefixes[0], why: `${fwd(bare)} is the project root or a folder above it` };
  const rel = relToRoot(bare, ctx);
  if (rel === null) return null;
  const inner = ctx.prefixes.find((p) => p.startsWith(`${rel}/`));
  return inner ? { prefix: inner, why: `${fwd(bare)} contains ${inner}` } : null;
}

/** Path-shaped operands of a code-running command (≤ 40), judged by spelling, landing, and under each cd. */
function codeOperandFence(command, dirs, ctx) {
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

// ──────────────────────────────────────────────────────────────── decide
const blocked = (reason) => ({ block: true, reason });
function deny(hit, what, ctx) {
  const prefix = prefixOf(hit);
  if (isOpen(prefix, ctx)) return null;
  const why = hit && typeof hit === 'object' && hit.why ? ` (${hit.why})` : '';
  return blocked(
    `BLOCKED: ${what} reaches the protected path "${prefix}"${why} (PIPELINE_PROFILE.md §4). ` +
      'A write is judged by where it lands. This is a boundary event — stop and ask the human. ' +
      (ctx.unlockable[prefix] ? `(Unlockable via ${UNLOCK_ENV}=${ctx.unlockable[prefix]} — human grant only.)` : ''),
  );
}

function decideShell(command, isPowerShell, ctx) {
  const tool = isPowerShell ? 'PowerShell' : 'Bash';
  const writes = shellWriteTargets(command);
  const dirs = cdDirsOf(command, ctx);
  const links = linkStatements(command);
  const runsCode = isPowerShell || RUNS_CODE.test(command);
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
  if (runsCode) {
    const via = codeOperandFence(command, dirs, ctx);
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

module.exports = { decide, config, linkStatements, statementHead, cdDirsOf, shellWriteTargets, fenceOf, realTarget, resolveTarget };

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
