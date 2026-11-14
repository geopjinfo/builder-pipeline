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
 *         "matcher": "Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell|mcp__.*",
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
 *      named    FAILS CLOSED (protectedNamed below): any statement outside a READ-ONLY pipeline (cat, ls, grep,
 *               git show|diff|log …) that names a protected path — by spelling (case-insensitive on Windows), by
 *               landing under the cwd, every cd target and every directory operand, as a glob that may reach it, as a
 *               folder containing it for a remover/mover, as an unplaceable operand sharing a segment with it, as a
 *               path in a patch file — is refused: rm, `git checkout --`, tar -C, unzip -d, `dd of=`, install,
 *               curl -o, robocopy, Remove-Item and whatever the next spelling is. Reading is the Read tool's job;
 *      resets   `git reset --hard`, `git stash`, `git clean -f` with no pathspec, `git checkout|restore .`, a forced
 *               checkout — whole-tree rewrites — are refused while anything is protected;
 *  - MCP tools (`mcp__*`): every path-shaped key (path, paths, file_path, destination, target, source …) is judged as
 *    a Write; read-named tools are not; a path that cannot be placed fails CLOSED (decideMcp).
 *  - Windows forms: `\\?\`, `\\.\`, `\\?\UNC\`, `\\localhost\C$` (and 127.0.0.1, ::1, this host) are placed as the
 *    drive path; any other share cannot be placed and fails CLOSED when its spelling could be protected.
 *  - This file itself: it defines the protected set, so it is protected whenever anything is (`BUILDER_UNLOCK=fence`).
 *    So are the whole `.claude/hooks/` (the kit/ copy, hook-trust.cjs, every sibling hook) and `.codex/hooks/`, by
 *    landing: their files run on the next tool call. The same grant opens them.
 *  - Hard links: a write to an EXISTING file with more than one hard link is refused. There is no link to follow,
 *    so whether the same bytes also live under a protected path cannot be told — it fails CLOSED.
 *  - A crash blocks: malformed input while anything is protected, an unreadable configuration, or an exception
 *    while judging exits 2 with the reason (verdict below) — Claude Code treats exit 1 as non-blocking.
 * Not seen, stated plainly: a path an interpreter builds at runtime (`'src/co'+'re'` inside node -e); a `cd` whose
 * operand cannot be placed (`cd "$D"` — not failed closed, since `cd` is in most commands); a variable holding a
 * whole path with no protected segment spelled (`rm -rf $X`); a branch switch (`git checkout other-branch`); a script
 * or tool that writes protected files without naming them. The pre-commit hook and CI are the backstop. Exit 2 =
 * deny the tool call, message shown to the agent.
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
 * THE PROFILE FENCES ITSELF while §16 adds anything (`BUILDER_UNLOCK=fence` opens it, as for this file) — else one
 * edit could shrink the list this hook reads. It is fenced as ONE FILE: the project root's PIPELINE_PROFILE.md, by
 * its real path (ctx.profile) and, when it is itself a link, at the link's own path too (ctx.profileAt) — never by a
 * bare name, so docs/PIPELINE_PROFILE.md, PIPELINE_PROFILE.md.bak or a folder of that name are not it, and the
 * fence grant opens exactly that file. A target is matched by where it LANDS (a junction onto the root, a link to the
 * real target); one whose spelling ends in the profile's name but cannot be placed or resolved fails CLOSED.
 *   - File tools and shell write shapes: judged by fenceOf, as every protected path.
 *   - Any other shell statement: a deny list of removers (rm, git rm …) loses to the next spelling (`/bin/rm`, `\rm`,
 *     `git -C . rm`, truncate, `dd of=`, `find -delete`, shred, install …). So it FAILS CLOSED instead
 *     (profileNamed): a pipeline that names the profile — by spelling or by landing, as an operand, after `=` or `:`,
 *     with quotes or backslashes spliced in, relative to any cd or any directory operand (`git -C docs rm ../…`) — is
 *     refused unless every stage is READ-ONLY (cat, grep, git show|diff|log … — the READ_ONLY rule below). The NAME
 *     alone suffices (namesProfile: last segment, any case, trailing dots/spaces and streams dropped), whatever the
 *     operand resolves to, so a base the hook cannot find does not open it; landing is a second layer, and a cap
 *     reached there (operands, base directories) refuses the statement instead of leaving operands unchecked. A DATA
 *     heredoc body naming it is not an operand. The PowerShell tool has no read-only reading: any statement naming it
 *     is refused (read it with the Read tool).
 * With §16 `protected` empty the profile is NOT fenced: an edit there can only add protection, and the pipeline's own
 * setup writes the profile. Not seen, stated plainly: a glob that deletes it (`rm *.md` — the glob rule judges
 * prefixes, not this one file); whole-tree resets are refused by the reset rule while anything is protected. The
 * pre-commit hook and CI are the backstop.
 *
 * KNOWN LIMIT — no memory between calls. The hook keeps no state: every call reads the profile afresh. If the profile
 * disappears or becomes malformed (by a person, or by a route above that was not seen), §16's prefixes and the
 * profile's own fence are gone from the next call on — the hook is then exactly as strict as without a profile. That
 * is why the profile is fenced against removal and rewrite while §16 adds anything; the filled PROTECTED list and
 * BUILDER_PROTECTED never depend on it.
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
  let profileAt = null;
  if (fromProfile.length) {
    // The profile joins the fence as ONE file (see PROFILE_TAG), not as a prefix. `profileAt` is the root's entry
    // itself (lstat: a link's own path); `profile` is where it really lives. Unresolvable = the entry's own path.
    const entry = path.resolve(projectDir, PROFILE_FILE);
    try {
      profileAt = path.join(realTarget(projectDir), PROFILE_FILE);
    } catch (_) {
      profileAt = entry;
    }
    try {
      profile = realTarget(entry);
    } catch (_) {
      profile = profileAt;
    }
  }
  return {
    self: selfPath(),
    prefixes: [...new Set([...base, ...fromProfile])],
    unlockable,
    grant: String(env[UNLOCK_ENV] || ''),
    cwd,
    projectDir,
    profile,
    profileAt,
    // A built-in entry for the profile keeps its own unlock rule (or none): never loosened by the fence grant.
    profileUnlock: base.includes(PROFILE_FILE) ? null : SELF_UNLOCK,
  };
}

/**
 * WINDOWS PATH FORMS (S3). `\\?\C:\x` and `\\.\C:\x` (device namespace) are `C:\x`; `\\?\UNC\host\share\x` is
 * `\\host\share\x`; an administrative share on this machine (`\\localhost\C$\x`, `\\127.0.0.1\c$`, `\\::1\`, this
 * host's name) is the drive path. Any other share, or a device path that is not a drive path, cannot be placed:
 * null, and the caller fails closed when its spelling could be protected. Never touches the network.
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0:0:0:0:0:0:0:1']);
function winPlace(raw) {
  let s = String(raw).trim();
  if (!WIN) return s;
  const dev = /^[\\/]{2}[?.][\\/]+(.*)$/.exec(s);
  if (dev) {
    s = dev[1];
    const unc = /^UNC[\\/]+(.*)$/i.exec(s);
    if (unc) s = `\\\\${unc[1]}`;
    else return /^[A-Za-z]:(?:[\\/]|$)/.test(s) ? s : null;
  }
  const share = /^[\\/]{2}([^\\/?.][^\\/]*)[\\/]+([^\\/]+)(.*)$/.exec(s);
  if (share) {
    const host = share[1].toLowerCase();
    const drive = /^([A-Za-z])\$$/.exec(share[2]);
    if (drive && (LOCAL_HOSTS.has(host) || host === os.hostname().toLowerCase())) return `${drive[1]}:${share[3] || '\\'}`;
    return null;
  }
  return s;
}

/** An absolute native path for a spelled target, or null when it cannot be placed (`/tmp/x` on Windows, a share). */
function resolveTarget(target, cwd) {
  const placed = winPlace(target);
  if (placed === null) return null;
  let p = fwd(placed);
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
/** Is a root-relative path the prefix itself (a file, or the folder) or under it? Case-insensitive on Windows. */
const under = (rel, prefix) => {
  const p = fold(prefix.replace(/\/+$/, ''));
  const r = fold(rel);
  return r === p || r.startsWith(`${p}/`);
};

/**
 * The protected prefix a SPELLING names (case-insensitively on Windows): it starts with the prefix, holds it after a
 * `/`, or IS the prefixed folder itself (`rm -rf src/core`, `…/src/core`). null when none.
 */
function spelledIn(spelling, ctx) {
  const s = fold(fwd(spelling));
  return (
    ctx.prefixes.find((p) => {
      const f = fold(p);
      const bare = f.replace(/\/+$/, '');
      return !!bare && (s.startsWith(f) || s.includes(`/${f}`) || s === bare || s.endsWith(`/${bare}`));
    }) || null
  );
}

/**
 * THE HOOK FOLDERS (S7). Every file in the project's `.claude/hooks/` (the kit's `kit/` copy, hook-trust.cjs, the
 * sibling hooks) and `.codex/hooks/` is code the NEXT tool call runs — a rewrite there is a fence that certifies its
 * own removal, as for this file. So while anything is protected the whole folders are, by where a write LANDS (real
 * paths), unlocked like this file by `BUILDER_UNLOCK=fence`.
 */
const HOOK_DIRS = ['.claude/hooks', '.codex/hooks'];
function hookDirsOf(ctx) {
  if (!ctx._hooks) {
    const root = rootOf(ctx);
    ctx._hooks = HOOK_DIRS.map((h) => {
      const at = path.join(root, ...h.split('/'));
      try {
        return realTarget(at);
      } catch (_) {
        return at;
      }
    });
  }
  return ctx._hooks;
}
const HOOK_WHY = 'the hook folder: its files run on every tool call, so they define the fence too';
/** A spelling that could be a hook folder or this hook (for paths that cannot be placed or resolved). */
const hookSpelled = (spelling) => {
  const s = fold(fwd(spelling));
  return HOOK_DIRS.some((h) => s.startsWith(`${h}/`) || s.includes(`/${h}/`) || s === h || s.endsWith(`/${h}`)) || /(?:^|\/)protected-paths\.cjs$/.test(s);
};
/** A target that cannot be placed or resolved: fenced when its spelling could be protected (fails closed). */
function closedSpelling(spelling, ctx, why) {
  const spelled = spelledIn(spelling, ctx);
  if (spelled) return { prefix: spelled, why: `${spelling} ${why}; this fails closed` };
  if (hookSpelled(spelling)) return { prefix: SELF_TAG, why: `${spelling} ${why}, and could be a hook file; this fails closed` };
  return profileClosed(spelling, ctx, why);
}

/** The fenced profile's tag: one file, matched by landing (see PROFILE_FILE above), unlocked by ctx.profileUnlock. */
const PROFILE_TAG = `${PROFILE_FILE} (the §16 profile)`;
const PROFILE_WHY = 'the profile whose §16 adds protected paths; changing, moving or removing it would shrink the fence';
const PROFILE_NAME = new RegExp(`(?:^|[\\\\/])${PROFILE_FILE.replace('.', '\\.')}[\\\\/]*$`, 'i');
/** Does an absolute target land on the fenced profile — at its real path, or at the root entry itself (a link)? */
function landsOnProfile(abs, real, ctx) {
  if (!ctx.profile) return false;
  if (real && fold(real) === fold(ctx.profile)) return true;
  if (!ctx.profileAt) return false;
  let at = abs;
  try {
    at = path.join(realTarget(path.dirname(abs)), path.basename(abs)); // lstat landing: the entry, not what it points at
  } catch (_) {
    /* the spelled path */
  }
  return fold(at) === fold(ctx.profileAt);
}
const profileClosed = (spelling, ctx, why) => (ctx.profile && PROFILE_NAME.test(spelling) ? { prefix: PROFILE_TAG, why: `${spelling} ${why}; this fails closed` } : null);

/** The protected prefix a target is spelled into or lands in, or null. Undecidable + spelled = fenced. */
function fenceOf(target, ctx, cwd = ctx.cwd) {
  const spelling = fwd(target);
  const spelled = spelledIn(spelling, ctx);
  const abs = resolveTarget(target, cwd);
  if (abs === null) return spelled || closedSpelling(spelling, ctx, 'cannot be placed');
  let real;
  try {
    real = realTarget(abs);
  } catch (e) {
    return spelled ? { prefix: spelled, why: `cannot be resolved (${e.code || e.message}); this fails closed` } : closedSpelling(spelling, ctx, `cannot be resolved (${e.code || e.message})`);
  }
  if (ctx.self && fold(real) === fold(ctx.self)) return { prefix: SELF_TAG, why: 'this file defines the protected set' };
  if (spelled) return spelled;
  const fr = fold(real);
  const hookDir = hookDirsOf(ctx).find((h) => fr === fold(h) || fr.startsWith(fold(h + path.sep)));
  if (hookDir) return { prefix: SELF_TAG, why: `${fwd(hookDir)} is ${HOOK_WHY}` };
  const rel = relToRoot(real, ctx);
  const inPrefix = rel === null ? null : ctx.prefixes.find((p) => under(rel, p));
  if (inPrefix) return inPrefix;
  return landsOnProfile(abs, real, ctx) ? { prefix: PROFILE_TAG, why: PROFILE_WHY } : null;
}

const prefixOf = (hit) => (hit && typeof hit === 'object' ? hit.prefix : hit);
const grants = (ctx) => ctx.grant.split(',').map((s) => s.trim());
const unlockOf = (prefix, ctx) => (prefix === SELF_TAG ? SELF_UNLOCK : prefix === PROFILE_TAG ? ctx.profileUnlock || null : ctx.unlockable[prefix] || null);
const isOpen = (prefix, ctx) => !!unlockOf(prefix, ctx) && grants(ctx).includes(unlockOf(prefix, ctx));

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
  const holds = hookDirsOf(ctx).find((h) => fold(h + path.sep).startsWith(fold(bare + path.sep)));
  if (holds) return { prefix: SELF_TAG, why: `${fwd(bare)} holds ${fwd(holds)}, ${HOOK_WHY}` };
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
      (unlockOf(prefix, ctx) ? `(Unlockable via ${UNLOCK_ENV}=${unlockOf(prefix, ctx)} — human grant only.)` : ''),
  );
}

/**
 * A shell command that NAMES the fenced profile outside a read-only pipeline, or null (the profile rule above). It
 * fails CLOSED: no list of removers is consulted — any statement that names the file and is not read-only is refused.
 * The text judged: POSIX — every pipeline that is not read-only, plus every non-data heredoc body, plus data `cat`/`tee`
 * bodies when something in the command runs code; not understood by the lexer, or the PowerShell tool — the whole text.
 */
const PROFILE_TOKENS_MAX = 256;
const PROFILE_BASES_MAX = 24;
const PROFILE_LOWER = PROFILE_FILE.toLowerCase();
/**
 * Does an operand's LAST path segment spell the profile's name? Decided by the name alone, whatever the operand
 * resolves to, and as Windows reads a name: any case, trailing dots and spaces dropped (`PIPELINE_PROFILE.md. `),
 * an alternate data stream (`…md:x`, `…md::$DATA`) and a drive-relative `C:` ignored, the 8.3 short name
 * (`PIPELI~1.MD`) included. Quote and backslash splices are undone by the caller's three readings of the text.
 */
function namesProfile(tok) {
  let s = fwd(String(tok)).replace(/[/. ]+$/, '');
  s = s.slice(s.lastIndexOf('/') + 1).replace(/^[A-Za-z]:/, '').toLowerCase();
  s = s.replace(/:.*$/, '').replace(/[. ]+$/, '');
  return s === PROFILE_LOWER || /^pipeli~\d+\.md$/.test(s);
}
function profileNamed(command, isPowerShell, dirs, ctx) {
  if (!ctx.profile) return null;
  let scope = command;
  const split = isPowerShell ? null : splitShell(command);
  if (split) {
    const kept = split.pipes.filter((p) => !p.readOnly).map((p) => p.text);
    const runs = RUNNER.test(kept.join('\n'));
    scope = [...kept, ...split.docs.filter((h) => !h.kind || (runs && (h.kind === 'cat' || h.kind === 'tee'))).map((h) => h.body)].join('\n');
  }
  if (!scope.trim()) return null;
  // Operands as written, and again with the quotes (then the backslashes) a shell splices out: `PROF""ILE`, `PROF\ILE`.
  const pieces = new Set();
  for (const text of [scope, scope.replace(/["']/g, ''), scope.replace(/["'\\]/g, '')]) {
    for (const tok of operandsOf(text)) {
      const t = tok.trim();
      if (!t) continue;
      pieces.add(t);
      const eq = t.lastIndexOf('=');
      if (eq !== -1) pieces.add(t.slice(eq + 1)); // of=…, --output=…, --git-dir=…
      const colon = /^(?![A-Za-z]:[\\/])[^:]*:(.+)$/.exec(t);
      if (colon) pieces.add(colon[1]); // REV:path
      if (/^-[A-Za-z]./.test(t)) pieces.add(t.slice(2)); // a glued short option: -oFILE, -Cdir
    }
  }
  const hit = (tok, why) => ({ prefix: PROFILE_TAG, why: `${tok} is ${PROFILE_WHY}${why ? `; ${why}` : ''}` });
  // Layer 1 — the NAME, on every operand, uncapped and with no filesystem lookup: an operand whose last segment spells
  // the profile is refused whatever it resolves to (a `..` path through a directory no base knows, a cd target held
  // in a variable). Another file of that name is refused with it here; the file tools still judge by landing.
  for (const p of pieces) {
    if (namesProfile(p)) return hit(p, 'its name is the profile\'s, and a statement naming it fails closed whatever it resolves to');
  }
  // Layer 2 — LANDING, which costs filesystem lookups and so is capped. A cap reached is refused, never a reason to
  // stop checking: the operands after it would go unseen.
  const capped = (what) => ({
    prefix: PROFILE_TAG,
    what: `this command has ${what} for the profile check to place every operand (caps: ${PROFILE_TOKENS_MAX} operands, ${PROFILE_BASES_MAX} base directories), so the hook cannot rule out that it`,
    why: `${PROFILE_WHY}; a cap reached fails closed — split the command into smaller ones`,
  });
  if (pieces.size > PROFILE_TOKENS_MAX) return capped(`too many operands (${pieces.size})`);
  // Bases a relative operand may be resolved against: the cwd, every cd, and every operand that is a directory
  // (`git -C docs rm ../PIPELINE_PROFILE.md`, `tar -C`, `--work-tree=`).
  const bases = [ctx.cwd, ...dirs];
  if (bases.length > PROFILE_BASES_MAX) return capped(`too many cd targets (${bases.length})`);
  for (const p of pieces) {
    if (/[$%`]/.test(p) || /^-/.test(p) || DISCARD.test(p)) continue;
    for (const from of [ctx.cwd, ...dirs]) {
      const abs = resolveTarget(p, from);
      if (abs === null) continue;
      try {
        if (fs.statSync(abs).isDirectory() && !bases.includes(abs)) {
          if (bases.length >= PROFILE_BASES_MAX) return capped('too many directory operands');
          bases.push(abs);
        }
      } catch (_) {
        /* not a directory */
      }
    }
  }
  for (const p of pieces) {
    if (/[$%`]/.test(p)) {
      if (/PIPELINE_PROFILE/i.test(p)) return hit(p, 'an operand that cannot be placed; this fails closed');
      continue;
    }
    if (DISCARD.test(p)) continue;
    const named = PROFILE_NAME.test(fwd(p));
    for (const from of relativeTok(p) || /^\.{1,2}[\\/]/.test(p) ? bases : [ctx.cwd]) {
      const abs = resolveTarget(p, from);
      if (abs === null) {
        if (named) return hit(p, 'it cannot be placed; this fails closed');
        continue;
      }
      let real = null;
      try {
        real = realTarget(abs);
      } catch (e) {
        if (named) return hit(p, `it cannot be resolved (${e.code || e.message}); this fails closed`);
      }
      if (landsOnProfile(abs, real, ctx)) return hit(p, 'only a read-only pipeline (cat, grep, git show|diff|log …) may name it');
    }
  }
  return null;
}

/**
 * NAMED = REFUSED (S1, S2, S5, globs, resets). A deny list of writers (rm, `git checkout --`, tar -C, unzip -d,
 * `dd of=`, install, curl -o, robocopy, Remove-Item …) loses to the next spelling, so the fence FAILS CLOSED, as it
 * does for the profile: while anything is protected, a statement outside a READ-ONLY pipeline (READ_ONLY above: cat,
 * ls, grep, git show|diff|log …) that NAMES a protected path or a hook folder is refused. Named means any operand —
 * as written, with quotes and backslashes spliced out, after `=` or `REV:`, a glued `-oFILE`, each `{a,b}` brace
 * alternative, the words of a quoted string when the statement runs a shell or builds a string — that is:
 *   - SPELLED into a prefix (case-insensitively on Windows), or the prefixed folder itself;
 *   - LANDS in one, resolved against the cwd, EVERY cd/pushd/Set-Location target, and every directory operand
 *     (`git -C core rm fenced`), by real path, so a junction does not hide it;
 *   - a GLOB whose fixed part leads to, or whose wildcards may expand to, a protected folder (`rm core/*`);
 *   - for a remover or mover (rm, rmdir, del, Remove-Item, mv, Move-Item, robocopy, git rm|mv|clean|checkout|restore)
 *     a folder that CONTAINS one (`rm -rf src`, `git checkout -- .`); `git clean` with no pathspec means the cwd;
 *   - an operand that cannot be placed (`$D/fenced`, `"$d/fenced"`, `'core/'+'fenced'`, Join-Path) that SHARES A
 *     SEGMENT with a protected prefix; a patch (`git apply`, `git am`, `patch`) whose file names one.
 * `cd` statements themselves are judged by the cd rule above, and `npm|pnpm|yarn|bun run <script>`'s script name is a
 * name, not a path. A cap reached (operands, bases) refuses the statement rather than leaving operands unseen.
 * WHOLE-TREE RESETS — `git reset --hard|--merge|--keep`, `git stash` (but list|show|drop|clear|create), a forced
 * `git checkout|switch` — rewrite every protected file at once and are refused while anything is protected.
 */
const NAMED_TOKENS_MAX = 256;
const NAMED_BASES_MAX = 24;
const GIT_LEAD = String.raw`(?:\S*[\\/])?git(?:\.exe)?(?:\s+(?:-C|-c|--git-dir|--work-tree)(?:=|\s+)\S+|\s+--[\w-]+(?:=\S+)?|\s+-[pP])*\s+`;
const WHOLE_TREE = new RegExp(String.raw`^${GIT_LEAD}(?:reset\b(?=.*\s--(?:hard|merge|keep)\b)|stash(?!\s+(?:list|show|drop|clear|create)\b)(?=\s|$)|(?:checkout|switch)\b(?=.*\s(?:-f|--force|--discard-changes)(?=\s|$)))`, 'i');
const REMOVER = new RegExp(String.raw`^(?:(?:\S*[\\/])?(?:rm|rmdir|rd|del|erase|unlink|shred|mv|move|robocopy|Remove-Item|ri|Clear-Content|clc|Move-Item|mi)(?:\.exe)?|${GIT_LEAD}(?:rm|mv|clean|checkout|restore))(?=\s|$)`, 'i');
const GIT_CLEAN = new RegExp(String.raw`^${GIT_LEAD}clean(?=\s|$)([\s\S]*)$`, 'i');
const PATCHER = new RegExp(String.raw`^(?:${GIT_LEAD}(?:apply|am)|(?:\S*[\\/])?patch(?:\.exe)?)(?=\s|$)`, 'i');
const CONCAT = /['"]\s*\+|\+\s*['"]|-join\b|\bJoin-Path\b|::Combine\s*\(|\s-f\s/i;
const SCRIPT_RUN = /\b((?:npm|pnpm|yarn|bun)(?:\.cmd)?\s+run(?:-script)?\s+)[\w:.-]+/gi;
const URL_TOK = /^[a-z][a-z0-9+.-]*:\/\//i;

/** The statements the named rule reads: those of non-read-only pipelines, plus non-data heredoc bodies; no cd. */
function namedStatements(command, isPowerShell) {
  const split = isPowerShell ? null : splitShell(command);
  let texts = [command];
  if (split) {
    const kept = split.pipes.filter((p) => !p.readOnly).map((p) => p.text);
    const runs = RUNNER.test(kept.join('\n'));
    texts = [...kept, ...split.docs.filter((h) => !h.kind || (runs && (h.kind === 'cat' || h.kind === 'tee'))).map((h) => h.body)];
  }
  const out = [];
  for (const t of texts) {
    for (const raw of t.split(SPLIT)) {
      const head = statementHead(raw);
      if (!raw.trim() || CD.test(head)) continue;
      out.push({ raw: raw.replace(SCRIPT_RUN, '$1'), head });
    }
  }
  return out;
}

/** `a/{b,c}` → `a/b`, `a/c` (bash brace expansion, a few levels). */
function braces(tok, out = [], depth = 0) {
  const m = /\{([^{}]*,[^{}]*)\}/.exec(tok);
  if (!m || depth > 3 || out.length > 32) {
    out.push(tok);
    return out;
  }
  for (const alt of m[1].split(',')) braces(tok.slice(0, m.index) + alt + tok.slice(m.index + m[0].length), out, depth + 1);
  return out;
}

/** The operands of one statement, in every reading a shell may make of them. */
function piecesOf(st, isPowerShell) {
  const pieces = new Set();
  const words = RUNNER.test(st.raw) || CONCAT.test(st.raw) || SHELL_WRAP.test(st.raw);
  const one = (t) => {
    for (const b of braces(t)) {
      pieces.add(b);
      const eq = b.lastIndexOf('=');
      if (eq !== -1) pieces.add(b.slice(eq + 1));
      const colon = !URL_TOK.test(b) && /^(?![A-Za-z]:[\\/])[^:]*:(.+)$/.exec(b);
      if (colon) pieces.add(colon[1]);
      if (/^-[A-Za-z]./.test(b)) pieces.add(b.slice(2));
    }
  };
  const readings = isPowerShell ? [st.raw, st.raw.replace(/["']/g, '')] : [st.raw, st.raw.replace(/["']/g, ''), st.raw.replace(/["'\\]/g, '')];
  for (const text of readings) {
    for (const m of text.matchAll(/[^\s"'`;|&()<>]*\{[^{}\s]*,[^{}\s]*\}[^\s"'`;|&()<>]*/g)) one(m[0]); // `a/{b,c}`: the comma splits operands below
    for (const tok of operandsOf(text)) {
      const t = tok.trim();
      if (!t) continue;
      if (/\s/.test(t)) {
        if (words) for (const w of operandsOf(t)) if (w.trim() && !/\s/.test(w)) one(w.trim());
        continue;
      }
      one(t);
    }
  }
  return [...pieces].filter((p) => p && !URL_TOK.test(p) && !DISCARD.test(p) && !/^-/.test(p));
}

const isRelative = (t) => relativeTok(t) || /^\.{1,2}(?:[\\/]|$)/.test(t);
const dynamic = (t) => /[$%`]/.test(String(t).replace(/^(?:~|\$HOME|\$\{HOME\}|\$env:USERPROFILE|%USERPROFILE%|\$PWD|\$\{PWD\}|\$pwd)(?=[\\/]|$)/i, ''));
const segsOf = (p) => fwd(p).split('/').filter((s) => s && s !== '.' && s !== '..');

/** An operand that cannot be placed (or a piece of a built string) sharing a segment with a protected prefix. */
function sharedSegment(tok, ctx) {
  const mine = String(tok).split(/[\\/'"+(),\s]+/).filter((s) => s && !/[$%`]/.test(s) && s !== '.' && s !== '..').map(fold);
  if (!mine.length) return null;
  for (const p of ctx.prefixes) {
    const shared = segsOf(p).map(fold).find((s) => mine.includes(s));
    if (shared) return { prefix: p, why: `${tok} cannot be placed and shares the segment "${shared}" with it; this fails closed — spell the path out` };
  }
  const hook = ['.claude', '.codex'].find((s) => mine.includes(s));
  return hook ? { prefix: SELF_TAG, why: `${tok} cannot be placed and shares "${hook}" with a hook folder; this fails closed` } : null;
}

/** A root-real folder: every protected prefix (and hook folder, this hook) it IS an ancestor of. [] when none. */
function containedIn(real, ctx) {
  const bare = real.replace(/[\\/]+$/, '');
  const fb = fold(bare + path.sep);
  const hits = [];
  if (ctx.self && fold(ctx.self).startsWith(fb)) hits.push({ prefix: SELF_TAG, why: `${fwd(bare)} holds this hook, which defines the protected set` });
  for (const h of hookDirsOf(ctx)) if (fold(h + path.sep).startsWith(fb)) hits.push({ prefix: SELF_TAG, why: `${fwd(bare)} holds ${fwd(h)}, ${HOOK_WHY}` });
  const rel = fold(rootOf(ctx) + path.sep).startsWith(fb) ? '' : relToRoot(bare, ctx);
  if (rel === null) return hits;
  for (const p of ctx.prefixes) if (rel === '' || fold(p).startsWith(`${fold(rel)}/`)) hits.push({ prefix: p, why: `${fwd(bare)} contains ${p}` });
  return hits;
}

/** A glob token, from `base`: the protected prefixes (and hook folders) its fixed part leads to or its wildcards may reach. */
function globHits(tok, base, ctx) {
  const parts = fwd(tok).split('/');
  const wi = parts.findIndex((s) => /[*?[]/.test(s));
  if (wi < 0) return [];
  const fixed = parts.slice(0, wi).join('/');
  const abs = resolveTarget(fixed === '' && parts.length > 1 && wi > 0 ? '/' : fixed || '.', base);
  if (abs === null) return [];
  let real;
  try {
    real = realTarget(abs);
  } catch (_) {
    return [];
  }
  const root = rootOf(ctx);
  let relSegs;
  const r = relToRoot(real, ctx);
  if (r !== null) relSegs = r ? r.split('/') : [];
  else if (fold(root + path.sep).startsWith(fold(real.replace(/[\\/]+$/, '') + path.sep))) return containedIn(root, ctx); // a glob above the root
  else return [];
  const pats = parts.slice(wi).filter(Boolean);
  const segRe = (g) => {
    try {
      return new RegExp(`^${g.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, WIN ? 'i' : '');
    } catch (_) {
      return /^/; // not understood: matches (fails closed)
    }
  };
  const hits = [];
  const targets = [...ctx.prefixes.map((p) => ({ p, hit: { prefix: p, why: `the glob ${tok} may reach ${p}` } })), ...HOOK_DIRS.map((h) => ({ p: h, hit: { prefix: SELF_TAG, why: `the glob ${tok} may reach ${h}, ${HOOK_WHY}` } }))];
  for (const { p, hit } of targets) {
    const want = segsOf(p);
    let ok = true;
    for (let i = 0; i < want.length && ok; i += 1) {
      if (i < relSegs.length) ok = fold(relSegs[i]) === fold(want[i]);
      else {
        const g = pats[i - relSegs.length];
        if (g === undefined) break; // the glob names an ancestor of the prefix: it may contain it
        if (g === '**') break;
        ok = segRe(g).test(want[i]);
      }
    }
    if (ok) hits.push(hit);
  }
  return hits;
}

/** Paths a patch file names (`diff --git`, `---`/`+++`, rename/copy lines), a/ b/ dropped. */
function patchPaths(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > 1024 * 1024) return [];
    const out = new Set();
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      let m = /^diff --git (\S+) (\S+)/.exec(line);
      if (m) {
        out.add(m[1]);
        out.add(m[2]);
      }
      m = /^(?:---|\+\+\+|rename from|rename to|copy from|copy to) (\S+)/.exec(line);
      if (m && m[1] !== '/dev/null') out.add(m[1]);
    }
    return [...out].flatMap((p) => [p, p.replace(/^[ab]\//, '')]);
  } catch (_) {
    return [];
  }
}

/** Every hit (most often one) for a command that names a protected path outside a read-only pipeline. */
function protectedNamed(command, isPowerShell, dirs, ctx) {
  const stmts = namedStatements(command, isPowerShell);
  if (!stmts.length) return [];
  const capped = (what) => [{ prefix: ctx.prefixes[0], what: `this command has ${what} for the fence to place every operand (caps: ${NAMED_TOKENS_MAX} operands, ${NAMED_BASES_MAX} base directories), so the hook cannot rule out that it`, why: 'a cap reached fails closed — split the command into smaller ones' }];
  const bases = [ctx.cwd, ...dirs];
  if (bases.length > NAMED_BASES_MAX) return capped(`too many cd targets (${bases.length})`);
  const perStmt = stmts.map((st) => ({ ...st, pieces: piecesOf(st, isPowerShell) }));
  const total = perStmt.reduce((n, s) => n + s.pieces.length, 0);
  if (total > NAMED_TOKENS_MAX) return capped(`too many operands (${total})`);
  // Directory operands are bases too (`git -C core rm fenced`, `tar -C`, `--work-tree=`).
  for (const st of perStmt) {
    for (const p of st.pieces) {
      if (dynamic(p) || /[*?[]/.test(p)) continue;
      for (const from of isRelative(p) ? [ctx.cwd, ...dirs] : [ctx.cwd]) {
        const abs = resolveTarget(p, from);
        if (abs === null || bases.includes(abs)) continue;
        try {
          if (fs.statSync(abs).isDirectory()) {
            if (bases.length >= NAMED_BASES_MAX) return capped('too many directory operands');
            bases.push(abs);
          }
        } catch (_) {
          /* not a directory */
        }
      }
    }
  }
  const patching = perStmt.some((st) => PATCHER.test(st.head));
  const hits = [];
  const later = []; // hits found only under a directory operand: reported after the plain ones
  const primary = 1 + dirs.length;
  let sink = hits;
  const tag = (list, tok) => list.forEach((h) => sink.push({ ...(typeof h === 'string' ? { prefix: h } : h), tok }));
  for (const st of perStmt) {
    const remover = REMOVER.test(st.head);
    const concat = CONCAT.test(st.raw);
    const pieces = [...st.pieces];
    const clean = GIT_CLEAN.exec(st.head);
    if (clean && !operandsOf(clean[1]).some((t) => !/^-/.test(t))) pieces.push('.'); // git clean's pathspec defaults to the cwd
    for (const p of pieces) {
      if (dynamic(p) || concat) {
        const s = sharedSegment(p, ctx);
        if (s) tag([s], p);
        if (dynamic(p)) continue;
      }
      const spelled = spelledIn(p, ctx);
      if (spelled) {
        tag([spelled], p);
        continue;
      }
      const from = isRelative(p) ? bases : [ctx.cwd];
      if (/[*?[]/.test(p)) {
        for (const b of from) tag(globHits(p, b, ctx), p);
        continue;
      }
      for (const [i, b] of from.entries()) {
        sink = i < primary ? hits : later;
        const hit = fenceOf(p, ctx, b);
        if (hit) tag([hit], p);
        if (remover && !/^\/[a-z]$/i.test(p)) {
          const abs = resolveTarget(p, b);
          if (abs !== null) {
            try {
              tag(containedIn(realTarget(abs), ctx), p);
            } catch (_) {
              /* judged by spelling */
            }
          }
        }
        if (patching) for (const q of patchPaths(resolveTarget(p, b) || p)) for (const pb of bases) {
          const h = fenceOf(q, ctx, pb);
          if (h) tag([h], `${p} (patches ${q})`);
        }
      }
      sink = hits;
    }
  }
  return [...hits, ...later];
}

/** A whole-tree reset while anything is protected: every protected prefix it rewrites. */
function wholeTreeReset(command, isPowerShell) {
  const text = isPowerShell ? command : dataStripped(command);
  for (const raw of text.split(SPLIT)) {
    const head = statementHead(raw);
    if (WHOLE_TREE.test(head)) return head.trim();
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
  const named = profileNamed(command, isPowerShell, cdDirsOf(command, ctx), ctx);
  if (named) {
    const r = deny(named, named.what ? `this ${tool} ${named.what.replace(/^this /, '')}` : `this ${tool} command names ${PROFILE_FILE} outside a read-only pipeline, which`, ctx);
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
  const reset = wholeTreeReset(command, isPowerShell);
  if (reset) {
    for (const hit of containedIn(rootOf(ctx), ctx)) {
      const r = deny(hit, `this ${tool} command resets the whole working tree (${reset.slice(0, 60)}), which`, ctx);
      if (r) return r;
    }
  }
  for (const hit of protectedNamed(command, isPowerShell, cdDirsOf(command, ctx), ctx)) {
    const what = hit.what ? `this ${tool} ${hit.what.replace(/^this /, '')}` : `this ${tool} command names ${hit.tok} outside a read-only pipeline (cat, ls, grep, git show|diff|log …), which`;
    const r = deny(hit, what, ctx);
    if (r) return r;
  }
  return { block: false };
}

/**
 * MCP TOOLS (S4). Every `mcp__<server>__<tool>` call is judged, read-named or not:
 *   - SHELL: a tool whose action reads as running something (exec, run, shell, command, terminal, process, spawn)
 *     or whose input carries a `command`/`cmd`/`script` string has that string judged as a Bash command AND as a
 *     PowerShell command (decideShell) — either refusal refuses.
 *   - PATHS: every value under a path-shaped key (path, paths, file_path, destination, target, source, repo_path,
 *     cwd, uri, folder, location, to, from, …) and — fail closed, the key list is not trusted — every other string
 *     that LOOKS like a path (a separator, a drive letter, a leading `~`, a `file://` URL, decoded), except prose
 *     fields (content, text, body, message, old_string/new_string …). Each is judged by spelling and by landing.
 *   - READS (read_*, list_*, get_*, search_* … with no writing word and no output/destination key) are allowed only
 *     while every path they name lands outside the fence; an output/destination key makes a read a write.
 *   - WRITES: a path that cannot be placed fails closed; a file-writing tool (write, edit, move, copy, delete …) with
 *     no recognisable path fails closed while anything is protected.
 *   - CAPS: more than 64 path values, or input nested deeper than 4 levels, is refused — never left half-checked.
 */
const MCP_PATH_KEY = /^(?:path|paths|file|files|file_?path|file_?paths|file_?name|notebook_?path|destination|dest|destination_?path|target|target_?path|source|source_?path|src|new_?path|old_?path|directory|dir|output|output_?path|output_?file|out_?file|repo_?path|cwd|uri|url|folder|location|to|from|save_?to|save_?path)$/i;
const MCP_OUT_KEY = /^(?:output|output_?path|output_?file|out_?file|destination|dest|destination_?path|target|target_?path|save_?to|save_?path|to)$/i;
const MCP_PROSE_KEY = /^(?:content|contents|text|body|message|description|title|summary|old_?string|new_?string|old_?text|new_?text|data|query|pattern|prompt|code|comment|note|notes|reason)$/i;
const MCP_SHELL_KEY = /^(?:command|cmd|script|commands)$/i;
const MCP_READ = /^(?:read|list|get|search|find|stat|view|show|glob|grep|directory_tree|tree|describe|query|fetch|count|head|tail)(?:_|$)/i;
const MCP_WRITES = /write|edit|move|create|delete|remove|rename|copy|put|set|upload|patch|append|mkdir|make|exec|run|start|kill|replace|insert|update|save|apply|link|unzip|extract|download|touch|truncate/i;
const MCP_FILE_WRITES = /write|edit|move|copy|delete|remove|rename|mkdir|patch|append|save|upload|unzip|extract|download|touch|truncate|replace|apply|link/i;
const MCP_RUNS = /exec|run|shell|command|terminal|process|spawn|eval/i;
const MCP_MAX_PATHS = 64;
const MCP_MAX_DEPTH = 4;
const pathLike = (s) => !/[\r\n]/.test(s) && s.length <= 4096 && !/^[a-z][a-z0-9+.-]*:\/\//i.test(s.replace(/^file:/i, 'x:')) && (/[\\/]/.test(s) || /^[A-Za-z]:/.test(s) || /^~/.test(s));
function fileUrl(s) {
  if (!/^file:/i.test(s)) return s;
  try {
    return require('url').fileURLToPath(s);
  } catch (_) {
    try {
      return decodeURIComponent(s.replace(/^file:\/*/i, WIN ? '' : '/'));
    } catch (__) {
      return s.replace(/^file:\/*/i, WIN ? '' : '/');
    }
  }
}
/** Walk the input: { paths, shells, outKey, over } — `over` names a cap reached. */
function mcpScan(ti) {
  const r = { paths: [], shells: [], outKey: false, over: null };
  const walk = (v, key, depth) => {
    if (r.over) return;
    if (depth > MCP_MAX_DEPTH) {
      r.over = `input nested deeper than ${MCP_MAX_DEPTH} levels`;
      return;
    }
    if (typeof v === 'string') {
      const s = v.trim();
      if (!s) return;
      if (key && MCP_SHELL_KEY.test(key)) r.shells.push(s);
      const named = key && MCP_PATH_KEY.test(key);
      if (named && key && MCP_OUT_KEY.test(key)) r.outKey = true;
      if (named ? !/^https?:\/\//i.test(s) : !(key && (MCP_PROSE_KEY.test(key) || MCP_SHELL_KEY.test(key))) && pathLike(s)) {
        if (r.paths.length >= MCP_MAX_PATHS) r.over = `more than ${MCP_MAX_PATHS} path values`;
        else r.paths.push(fileUrl(s));
      }
    } else if (Array.isArray(v)) {
      for (const x of v) walk(x, key, depth + 1);
    } else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) walk(x, k, depth + 1);
    }
  };
  walk(ti, null, 0);
  return r;
}
function decideMcp(tool, ti, ctx) {
  const action = tool.slice(tool.lastIndexOf('__') + 2);
  const scan = mcpScan(ti);
  if (scan.over) return blocked(`BLOCKED: ${tool} has ${scan.over}, so the fence cannot check every path it names (PIPELINE_PROFILE.md §4/§16); a cap reached fails closed — split the call.`);
  const runs = MCP_RUNS.test(action);
  if (runs && !scan.shells.length) for (const v of Object.values(ti || {})) if (typeof v === 'string' && v.trim()) scan.shells.push(v.trim());
  for (const command of scan.shells) {
    for (const ps of [false, true]) {
      const v = decideShell(command, ps, ctx);
      if (v.block) return { ...v, reason: `${v.reason} (judged as the command ${tool} runs)` };
    }
  }
  const read = MCP_READ.test(action) && !MCP_WRITES.test(action) && !scan.outKey;
  for (const p of scan.paths) {
    if (resolveTarget(p, ctx.cwd) === null) {
      const closed = closedSpelling(fwd(p), ctx, 'cannot be placed');
      if (closed) {
        const r = deny(closed, `${tool} on ${p}`, ctx);
        if (r) return r;
      }
      if (read) continue;
      return blocked(`BLOCKED: ${tool} names ${p}, a path this hook cannot place on this machine, so it cannot rule out a protected path (PIPELINE_PROFILE.md §4/§16); this fails closed — spell a native absolute path or a project-relative one.`);
    }
    const hit = fenceOf(p, ctx);
    if (hit) {
      const r = deny(hit, `${tool} ${read ? 'reads' : 'on'} ${p}, which`, ctx);
      if (r) return read ? { ...r, reason: `${r.reason} Read it with the Read tool.` } : r;
      continue;
    }
    if (read) continue;
    const n = hardLinks(p, ctx);
    if (n) return blocked(`BLOCKED: ${tool} on ${p}, an existing file with ${n} hard links. The same bytes live at another path this hook cannot see, which may be protected. Delete this name (one file) and write the file fresh, or ask the human.`);
  }
  if (!read && !runs && MCP_FILE_WRITES.test(action) && !scan.paths.length) {
    return blocked(`BLOCKED: ${tool} reads as a file write but names no path this hook recognises, so it cannot rule out a protected path (PIPELINE_PROFILE.md §4/§16); this fails closed — pass the path under a key such as "path".`);
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
  if (/^mcp__/i.test(tool)) return decideMcp(tool, ti, ctx);
  const filePath = ti.file_path || ti.notebook_path || '';
  if (!filePath) return { block: false };
  // fenceOf reads a RUN of separators as one: a doubled backslash or slash must not hide a protected prefix.
  const hit = fenceOf(filePath, ctx);
  if (hit) return deny(hit, `${filePath}`, ctx) || { block: false };
  const n = hardLinks(filePath, ctx);
  if (n) return blocked(`BLOCKED: ${filePath} is an existing file with ${n} hard links. The same bytes live at another path this hook cannot see, which may be protected. Delete this name (one file) and write the file fresh, or ask the human.`);
  return { block: false };
}

/**
 * CRASH = BLOCK (S8). The exit code for one hook input: 0 allow, 2 deny (with the message). Malformed input while
 * anything is protected, a configuration that cannot be read, and any exception in decide() all deny — exit 1 is a
 * NON-blocking error to Claude Code, so a crash would otherwise let the call through. Nothing protected = 0.
 */
function verdict(text, deps = {}) {
  const readConfig = deps.config || config;
  const judge = deps.decide || decide;
  let ctx;
  try {
    ctx = readConfig();
  } catch (e) {
    return { code: 2, message: `BLOCKED: the protected-paths hook could not read its configuration (${(e && e.message) || e}); this fails closed — ask the human.` };
  }
  let j;
  try {
    j = JSON.parse(text);
  } catch (_) {
    if (!ctx.prefixes.length) return { code: 0 };
    return { code: 2, message: 'BLOCKED: the protected-paths hook received hook input that is not JSON (malformed); while paths are protected this fails closed.' };
  }
  try {
    const v = judge(j, ctx);
    return v && v.block ? { code: 2, message: v.reason } : { code: 0 };
  } catch (e) {
    return { code: 2, message: `BLOCKED: the protected-paths hook failed while judging this call (${(e && e.message) || e}); a crash fails closed — retry in a simpler form, or ask the human.` };
  }
}

module.exports = { decide, verdict, config, profileProtected, globPrefix, mentionScope, splitShell, SELF_UNLOCK, linkStatements, statementHead, cdDirsOf, shellWriteTargets, fenceOf, realTarget, resolveTarget };

if (require.main === module) {
  process.on('uncaughtException', (e) => {
    console.error(`BLOCKED: the protected-paths hook crashed (${(e && e.message) || e}); a crash fails closed.`);
    process.exit(2);
  });
  let input = '';
  process.stdin.on('data', (d) => (input += d));
  process.stdin.on('end', () => {
    const v = verdict(input);
    if (v.code === 2) console.error(v.message); // exit 2 = deny the tool call, message shown to the agent
    process.exit(v.code);
  });
}
