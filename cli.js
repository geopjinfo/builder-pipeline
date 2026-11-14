#!/usr/bin/env node
/*
 * builder-kit CLI — unpack the builder pipeline kit into the current repo.
 *
 * Zero dependencies; Node >= 18. Run from the TARGET repo root (the repo you unpacked the builder/
 * folder into):
 *
 *   node builder/cli.js unpack --tool claude-code
 *   node builder/cli.js unpack --tool claude-code,codex
 *   node builder/cli.js unpack --tool all [--dry-run] [--no-extras] [--experimental]
 *   node builder/cli.js unpack --tool claude-code --models strong=opus,mid=haiku
 *   node builder/cli.js upgrade --tool claude-code [--dry-run]   (an install from an older kit release)
 *   node builder/cli.js --version
 *   node builder/cli.js targets
 *   node builder/cli.js verify           (install + PIPELINE_PROFILE.md, including its §16 settings block)
 *   node builder/cli.js features         (which optional checks are on, off, unmeasured or experimental)
 *   node builder/cli.js check-ledgers    (mechanical board/registry gates — wire into CI)
 *   node builder/cli.js check-targets    (qa-audit environment safety — wire into CI)
 *
 * --no-extras skips the optional utility skills in skills-extra/ (status-and-next, caveman,
 * graphify, ledger-audit — see skills-extra/README.md) and the personas they ship (skills-extra/<name>/agents/).
 * --experimental also installs the experimental files (agents/experimental/, tooling/experimental/). They are
 * shipped but unproven; EXPERIMENTS.md names the measurement that promotes or removes each one.
 *
 * Safe by design: copy-if-absent (never overwrites), pointer blocks are appended once
 * (marker-guarded), --dry-run previews everything, hooks are copied but never armed. The kit itself is
 * inert until you run this.
 *
 * `upgrade` walks the SAME source→destination mapping as `unpack` (one code path, so the two sets cannot
 * drift). Kit-owned files — personas, skills, references, hooks, scripts, scripts/lib, oracles, tooling —
 * are overwritten when their content differs from the pack, after a copy goes to
 * .builder/backup-<UTC stamp>/<same path>. Project-owned files — PIPELINE_PROFILE.md, the boards, the
 * registry, the decision log, the brief templates — are never touched once they exist. The pointer block is
 * re-wired only between its markers, so the user's own text around it is left byte-for-byte.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const KIT = __dirname; // builder/
const CWD = process.cwd();
const MARKER = '<!-- builder-kit:pipeline -->';
// Closes the pointer block so `upgrade` can replace exactly what the kit wrote. Blocks written before 0.14.0
// have no end marker; pointerSpan() recognises their fixed shape instead.
const MARKER_END = '<!-- /builder-kit:pipeline -->';
/** The kit's version has ONE home, package.json; `--version`, the CHANGELOG test and the release tag agree with it. */
const VERSION = require('./package.json').version;
// The two lite skills install with the rest and stay inert until features.liteSplit is enabled (the gate
// queue refuses otherwise), so installing them changes nothing for a project that never opts in.
// The batch orchestrator skill installs the same way and stays inert until features.orchestrator is on (scripts/orch.mjs
// prints 'orchestrator: not configured' otherwise).
const SKILLS = ['build-module-pipeline', 'scaffold-module', 'module-readiness-check', 'setup-builder', 'build-module-lite', 'build-module-lite-gate-batch', 'orchestrator'];

// ---------------------------------------------------------------------------
// Tool registry. Two install styles:
//   native     → files land in the harness's own registry (subagents/skills auto-load)
//   dotBuilder → files land in .builder/{personas,playbooks}/ and an instruction file
//                gets a pointer block telling the agent how to run phases
// Most modern CLIs read AGENTS.md, so they share that pointer (marker prevents dupes).
// ---------------------------------------------------------------------------
const TOOLS = {
  'claude-code': { style: 'native', pointer: 'CLAUDE.md', label: 'Claude Code (native subagents + skills)' },
  codex:         { style: 'dotBuilder', pointer: 'AGENTS.md', label: 'OpenAI Codex CLI (AGENTS.md)' },
  opencode:      { style: 'dotBuilder', pointer: 'AGENTS.md', label: 'OpenCode (AGENTS.md)' },
  gemini:        { style: 'dotBuilder', pointer: 'GEMINI.md', label: 'Gemini CLI (GEMINI.md)' },
  cursor:        { style: 'dotBuilder', pointer: '.cursor/rules/builder-pipeline.mdc', mdc: true, label: 'Cursor (.cursor/rules)' },
  copilot:       { style: 'dotBuilder', pointer: '.github/copilot-instructions.md', label: 'GitHub Copilot (copilot-instructions.md)' },
  windsurf:      { style: 'dotBuilder', pointer: '.windsurf/rules/builder-pipeline.md', label: 'Windsurf (.windsurf/rules)' },
  cline:         { style: 'dotBuilder', pointer: '.clinerules/builder-pipeline.md', label: 'Cline / Roo Code (.clinerules)' },
  aider:         { style: 'dotBuilder', pointer: 'CONVENTIONS.md', label: 'aider (CONVENTIONS.md)' },
  generic:       { style: 'dotBuilder', pointer: 'AGENTS.md', label: 'Any other agent (AGENTS.md)' },
};

// --------------------------- where the kit lives ---------------------------
/**
 * The kit's own prose says `builder/<file>` and `node builder/cli.js` — true when the kit is a folder copied into the
 * project as `builder/`. Installed as a package it lives at `node_modules/@<scope>/builder-pipeline/` and runs as
 * `npx builder`. KIT_REL is the kit as the project sees it; RUN is how the project runs the CLI. Every text the kit
 * installs into the project (Markdown) and every line the CLI prints goes through kitPaths(), so it names the kit
 * where it actually is. With the kit at `builder/` nothing changes, byte for byte.
 */
const posixPath = (p) => p.split(path.sep).join('/');
const KIT_REL = posixPath(path.relative(CWD, KIT)) || '.';
const RUN = /(^|[\\/])node_modules[\\/]/.test(KIT) ? 'npx builder' : `node ${KIT_REL}/cli.js`;
const KIT_ENTRY = /(?<![.\w@/-])builder\/(?=(?:cli\.js|[A-Z][A-Z_]*(?:\.template)?\.md|adapters|agents|examples|hooks|oracles|scripts|skills-extra|skills|templates|tooling|tests)\b)/g;
/** Installed as a package, the kit's scripts run from it (`npx builder run <name>`) and are not copied into the project. */
const PACKAGED = RUN === 'npx builder';
/** Where the kit scripts are for this install: the package itself, or the project's scripts/ copies. */
const SCRIPTS_HOME = PACKAGED ? path.join(KIT, 'scripts') : path.join(CWD, 'scripts');
function kitPaths(text) {
  if (KIT_REL === 'builder') return text;
  let out = text.replace(/\bnode builder\/cli\.js\b/g, RUN).replace(KIT_ENTRY, `${KIT_REL}/`);
  if (PACKAGED) {
    out = out.replace(/\bnode scripts\/((?:experimental\/)?[\w-]+)\.(?:mjs|cjs|js)\b/g, (m, name) => (kitScript(name) ? `npx builder run ${name}` : m));
  }
  return out;
}

/**
 * The kit script a `builder run <name>` means: scripts/<name>.{mjs,cjs,js}, or tooling/experimental/<x> for
 * `experimental/<x>` (installed as scripts/experimental/ by a folder copy). A name is one path segment (plus that
 * prefix): nothing outside those two folders can be reached by it. null = no such script.
 */
function kitScript(name) {
  const m = /^(experimental\/)?([A-Za-z0-9][\w-]*)$/.exec(String(name || ''));
  if (!m) return null;
  const dir = m[1] ? path.join(KIT, 'tooling', 'experimental') : path.join(KIT, 'scripts');
  for (const ext of ['.mjs', '.cjs', '.js']) {
    const f = path.join(dir, m[2] + ext);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

// --------------------------- small helpers ---------------------------------
let DRY = false;
let NO_EXTRAS = false;
let EXPERIMENTAL = false;
const log = (tag, p) => console.log(`${tag.padEnd(15)}${p}`);

/**
 * 'unpack' (copy-if-absent) or 'upgrade'. Both modes walk the same installTool()/installCommon() calls; only
 * place() and the pointer helpers branch on it, so the set of files an upgrade refreshes is, by construction,
 * the set unpack installs.
 */
let MODE = 'unpack';
const UPGRADE = { stamp: null, seen: new Set(), counts: { updated: 0, added: 0, unchanged: 0, 'kept-project-owned': 0, 'kept (by hand)': 0, 'kept (local edit)': 0 } };

/**
 * builder.lock.json — what the kit last wrote, per KIT-OWNED file: { kit: version, files: { "<dst>": "<sha256>" } }.
 * Ownership classes: kit-owned (refreshed by upgrade, locked here), project-owned (seeded once, never touched again,
 * not locked) and merged (the pointer block inside a file the user also writes in; only its marked span is the kit's).
 * An upgrade that finds a kit-owned file whose content no longer matches its lock entry has met a LOCAL EDIT: it keeps
 * the file and says so instead of overwriting it; `--force` overwrites (after the usual backup). A file with no lock
 * entry (an install from before the lock) is upgraded as before. Line endings do not count as an edit.
 */
const LOCK_FILE = 'builder.lock.json';
let FORCE = false;
const LOCK = { prior: null, next: {} };
const shaOf = (buf) => require('crypto').createHash('sha256').update(Buffer.from(buf).toString('utf8').replace(/\r\n/g, '\n')).digest('hex');
function lockPrior() {
  if (LOCK.prior === null) {
    try {
      LOCK.prior = JSON.parse(fs.readFileSync(path.join(CWD, LOCK_FILE), 'utf8')).files || {};
    } catch (_) {
      LOCK.prior = {};
    }
  }
  return LOCK.prior;
}
const lockKey = (dst) => posixPath(dst);
function writeLock() {
  if (DRY) return;
  const files = { ...lockPrior(), ...LOCK.next };
  const sorted = Object.fromEntries(Object.keys(files).sort().map((k) => [k, files[k]]));
  fs.writeFileSync(path.join(CWD, LOCK_FILE), JSON.stringify({ kit: VERSION, files: sorted }, null, 2) + '\n');
}

function upgradeLog(status, dst, note = '') {
  UPGRADE.counts[status]++;
  const tag = DRY && (status === 'updated' || status === 'added') ? `would be ${status}:` : `${status}:`;
  console.log(`${tag.padEnd(24)}${dst}${note ? `  (${note})` : ''}`);
}

/** Line endings are not content: a checkout with autocrlf must not read every kit file as "changed". */
const sameText = (a, b) => a.toString('utf8').replace(/\r\n/g, '\n') === b.toString('utf8').replace(/\r\n/g, '\n');

function writeFile(abs, content) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

/** Copies the CURRENT file to .builder/backup-<stamp>/<dst> before an upgrade overwrites it. */
function backup(dst) {
  if (DRY) return;
  const to = path.join(CWD, '.builder', `backup-${UPGRADE.stamp}`, dst);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(path.join(CWD, dst), to);
}

/**
 * The one place a file lands. `owner` is 'kit' (the pack's own code and prose: refreshed by upgrade) or
 * 'project' (seeded once, then the project's: never touched again by either mode).
 */
function place(dst, produce, owner) {
  const abs = path.join(CWD, dst);
  const exists = fs.existsSync(abs);
  if (MODE !== 'upgrade') {
    if (exists) return log('skip (exists):', dst);
    const content = produce();
    if (!DRY) writeFile(abs, content);
    if (owner === 'kit') LOCK.next[lockKey(dst)] = shaOf(content);
    return log(DRY ? 'would install:' : 'installed:', dst);
  }
  // Two tools can map one source to one destination (codex + opencode share .builder/): report it once.
  if (UPGRADE.seen.has(dst)) return;
  UPGRADE.seen.add(dst);
  if (!exists) {
    const content = produce();
    if (!DRY) writeFile(abs, content);
    if (owner === 'kit') LOCK.next[lockKey(dst)] = shaOf(content);
    return upgradeLog('added', dst);
  }
  if (owner === 'project') return upgradeLog('kept-project-owned', dst);
  const next = Buffer.from(produce());
  const current = fs.readFileSync(abs);
  if (sameText(current, next)) {
    LOCK.next[lockKey(dst)] = shaOf(next);
    return upgradeLog('unchanged', dst);
  }
  const locked = lockPrior()[lockKey(dst)];
  if (locked && locked !== shaOf(current) && !FORCE) {
    return upgradeLog('kept (local edit)', dst, `changed since the kit wrote it (${LOCK_FILE}) — move the change into the profile or an overlay, or re-run with --force`);
  }
  backup(dst);
  if (!DRY) writeFile(abs, next);
  LOCK.next[lockKey(dst)] = shaOf(next);
  upgradeLog('updated', dst);
}

function copyIfAbsent(src, dst, owner = 'kit') {
  place(dst, () => (/\.md$/i.test(dst) ? kitPaths(fs.readFileSync(src, 'utf8')) : fs.readFileSync(src)), owner);
}

/**
 * Where the kit's pointer block sits in an instruction file: `{ start, end }` character offsets, or null when
 * there is no marker, or `{ unrecognised: true }` when there is one but the block is not a shape the kit wrote.
 *
 * A block from 0.14.0 on runs from MARKER to MARKER_END. An older block has no end marker, but every release
 * wrote the same shape: MARKER, the `## Builder pipeline` heading, one paragraph, then a bullet list whose
 * continuation lines are indented — so the block ends at the last line of that list. Anything else is left
 * alone and reported, because guessing where a user's text starts is how their text gets deleted.
 */
function pointerSpan(text) {
  const start = text.indexOf(MARKER);
  if (start === -1) return null;
  const close = text.indexOf(MARKER_END, start);
  if (close !== -1) return { start, end: close + MARKER_END.length };
  const lines = text.slice(start).split('\n');
  if (!/^## Builder pipeline\b/.test((lines[1] || '').replace(/\r$/, ''))) return { unrecognised: true };
  let i = 2;
  while (i < lines.length && !/^- /.test(lines[i])) {
    if (/^#/.test(lines[i])) return { unrecognised: true };
    i++;
  }
  if (i === lines.length) return { unrecognised: true };
  while (i + 1 < lines.length && /^(- |  +\S)/.test(lines[i + 1])) i++;
  const len = lines.slice(0, i + 1).join('\n').replace(/\r$/, '').length;
  return { start, end: start + len };
}

/**
 * The pointer block in an instruction file the user also writes in. Unpack appends it once. Upgrade replaces
 * only what lies between the markers, and only when that differs — the text around it is the user's.
 */
function wirePointer(dst, block, wholeFile) {
  const abs = path.join(CWD, dst);
  const existing = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
  if (MODE !== 'upgrade') {
    if (wholeFile) return place(dst, () => block + '\n', 'kit');
    if (existing !== null && existing.includes(MARKER)) return log('skip (wired):', dst);
    if (!DRY) writeFile(abs, (existing ? existing.replace(/\s*$/, '\n\n') : '') + block + '\n');
    return log(DRY ? 'would wire:' : 'wired:', dst);
  }
  if (UPGRADE.seen.has(dst)) return;
  UPGRADE.seen.add(dst);
  if (existing === null) {
    if (!DRY) writeFile(abs, block + '\n');
    return upgradeLog('added', dst, 'pointer block');
  }
  if (!existing.includes(MARKER)) {
    if (wholeFile) return upgradeLog('kept (by hand)', dst, 'file exists without the kit marker — add the block yourself');
    backup(dst);
    if (!DRY) writeFile(abs, existing.replace(/\s*$/, '\n\n') + block + '\n');
    return upgradeLog('added', dst, 'pointer block appended');
  }
  // A whole-file pointer (a rules file the kit owns outright) carries frontmatter before the marker; only the
  // marked part is compared and replaced either way.
  const fresh = block.slice(block.indexOf(MARKER));
  const span = pointerSpan(existing);
  if (span.unrecognised) return upgradeLog('kept (by hand)', dst, 'pointer block not in a shape the kit wrote — replace it by hand from `unpack --dry-run`');
  const current = existing.slice(span.start, span.end);
  if (sameText(Buffer.from(current), Buffer.from(fresh))) return upgradeLog('unchanged', dst, 'pointer block');
  backup(dst);
  if (!DRY) writeFile(abs, existing.slice(0, span.start) + fresh + existing.slice(span.end));
  upgradeLog('updated', dst, 'pointer block only');
}

/** Files under a kit directory, recursively, as paths relative to that directory. Missing dir → none. */
function filesUnder(dir) {
  const root = path.join(KIT, dir);
  if (!fs.existsSync(root)) return [];
  const out = [];
  const walk = (abs, rel) => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const a = path.join(abs, entry.name);
      const r = rel ? path.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) walk(a, r);
      else out.push(r);
    }
  };
  walk(root, '');
  return out.sort();
}

function agentFiles() {
  return fs.readdirSync(path.join(KIT, 'agents')).filter((f) => f.endsWith('.md'));
}

function experimentalAgentFiles() {
  return filesUnder(path.join('agents', 'experimental')).filter((f) => f.endsWith('.md'));
}

// Persona frontmatter is harness-NEUTRAL (capabilities + tier [+ effort]). Adapters that have a native
// agent format transform it at install time; everyone else consumes it as-is (prompt text).
const CAP_TO_CLAUDE_TOOLS = {
  'read-only': 'Read, Grep, Glob, Bash',
  code: 'Read, Grep, Glob, Edit, Write, Bash',
  'test-only': 'Read, Grep, Glob, Edit, Write, Bash', // scope narrowed by the persona text itself
  docs: 'Read, Grep, Glob, Edit, Write, Bash',
  // A read-only seat that must write exactly ONE file of its own (the reviewer's review). The grant is only a
  // grant if something holds it to that file: hooks/claude-code/reviewer-write-guard.cjs does.
  'read-only+own-file': 'Read, Grep, Glob, Bash, Write',
  // Reads and publishes a page; never edits the repo (experimental live-page keeper). The page's data store has
  // its own tool, separate from the publishing one; the keeper's version-pinned reads and writes go through it.
  publish: 'Bash, Read, Artifact, ArtifactData',
};
// Default tier→model mapping for adapters with a native model field. Override per install with
// --models strong=<x>,mid=<y> (the setup-builder skill picks these by inspecting the user's
// harness/subscription). Only harnesses with a native agent format need this — everyone else
// records their mapping in PIPELINE_PROFILE.md §12 instead.
let TIER_TO_CLAUDE_MODEL = { strong: 'opus', mid: 'sonnet', low: 'haiku' };
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

function toClaudeAgent(content) {
  const end = content.indexOf('---', 4);
  if (end === -1) return content;
  const fm = content.slice(4, end);
  const get = (k) => ((fm.match(new RegExp(`^${k}: (.*)$`, 'm')) || [])[1] || '').split('#')[0].trim();
  // `capabilities` may be one value or a comma list (`read-only, shell, publish`); `writes:` names the ONE file a
  // read-only seat may write. Anything unrecognised falls back to read-only tools — a seat never gains write access
  // by a typo.
  const caps = (get('capabilities') || 'read-only').split(',').map((c) => c.trim()).filter(Boolean);
  const writes = get('writes');
  let tools = CAP_TO_CLAUDE_TOOLS['read-only'];
  if (caps.includes('publish')) tools = CAP_TO_CLAUDE_TOOLS.publish;
  else if (caps.length === 1 && CAP_TO_CLAUDE_TOOLS[caps[0]]) tools = CAP_TO_CLAUDE_TOOLS[caps[0]];
  if (writes && caps.includes('read-only') && !caps.includes('publish')) tools = CAP_TO_CLAUDE_TOOLS['read-only+own-file'];
  const tier = get('tier') || 'strong';
  const effort = get('effort');
  const lines = [
    '---',
    `name: ${get('name')}`,
    `description: ${get('description')}`,
    `tools: ${tools}`,
    `model: ${TIER_TO_CLAUDE_MODEL[tier] || 'opus'}`,
  ];
  if (EFFORTS.has(effort)) lines.push(`effort: ${effort}`);
  lines.push('---');
  return lines.join('\n') + content.slice(end + 3);
}

function copyTransformed(src, dst, fn) {
  place(dst, () => kitPaths(fn(fs.readFileSync(src, 'utf8'))), 'kit');
}

function copyDirIfAbsent(srcDir, dstDir, skipTop = []) {
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (skipTop.includes(entry.name)) continue;
    const src = path.join(srcDir, entry.name);
    const dst = path.join(dstDir, entry.name);
    if (entry.isDirectory()) copyDirIfAbsent(src, dst);
    else copyIfAbsent(src, dst);
  }
}

function extrasList() {
  const dir = path.join(KIT, 'skills-extra');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
}

/**
 * Personas an extra skill ships (`skills-extra/<name>/agents/*.md`). They install like `agents/*.md`, into the
 * persona registry, and only with the extras. They are NOT also copied into the skill's own folder: a second copy
 * there would keep the neutral frontmatter, never load as a subagent, and drift from the one that does.
 */
function extraAgentFiles() {
  return extrasList().flatMap((name) =>
    fs.existsSync(path.join(KIT, 'skills-extra', name, 'agents'))
      ? fs.readdirSync(path.join(KIT, 'skills-extra', name, 'agents')).filter((f) => f.endsWith('.md')).map((file) => ({ name, file }))
      : [],
  );
}

// --------------------------- pointer content -------------------------------
function pointerBlock(tool) {
  const native = TOOLS[tool].style === 'native';
  const playbook = native
    ? 'the `build-module-pipeline` skill (auto-registered under `.claude/skills/`)'
    : '`.builder/playbooks/build-module-pipeline.md`';
  const personas = native
    ? 'auto-registered subagents under `.claude/agents/` (dispatch by name)'
    : 'prompt files under `.builder/personas/` — when the playbook says "dispatch persona X", start a FRESH session whose first message is the persona file + `PIPELINE_PROFILE.md` + the distilled inputs the playbook names, and nothing else; never run two phases in one context; honour each persona\'s tool limits (read-only seats never edit; the tester edits test files only)';
  const body = `${MARKER}
## Builder pipeline (module builds)

Module/feature builds go through the multi-agent builder pipeline.

- **Grounding:** \`PIPELINE_PROFILE.md\` (repo root). If it still contains template placeholders,
  FIRST run the discovery prompt in \`builder/DISCOVERY.md\` — it fills the profile from THIS
  project's own docs, including the §16 settings block.
- **Orchestrator playbook:** ${playbook}.
- **Personas:** ${personas}.
- **Optional checks:** \`node scripts/features.mjs\` says which are on here; a check that is off prints
  "<feature>: not configured" and is never a pass.
- **Ledgers:** task boards, the deferred registry and the decision log live at the paths in
  \`PIPELINE_PROFILE.md\` §16 \`paths\` (\`boards\`, \`registry\`, \`decisions\`) — read them there, not
  from memory; run artifacts in \`.pipeline/\` (gitignored), one handoff pack per run. The pipeline
  never merges — it hands MERGE-READY to a human.
- **Utility skills** (if installed — see \`builder/skills-extra/README.md\`): \`status-and-next\`
  to open a session (verify state fresh, pick the next item, emit its brief), \`graphify\` for
  cheap scoped doc/architecture lookups (query the graph before re-reading big docs), \`caveman\`
  for compressed replies, \`ledger-audit\` for periodic unearned-status sweeps of the ledgers.
${MARKER_END}`;
  return pointerFrame(tool, kitPaths(body));
}

function pointerFrame(tool, body) {
  if (TOOLS[tool].mdc) {
    return `---
description: Builder pipeline — how module builds run in this repo
alwaysApply: true
---

${body}`;
  }
  return body;
}

// --------------------------- commands --------------------------------------
function installTool(tool) {
  const t = TOOLS[tool];
  console.log(`\n[${tool}] ${t.label}`);
  const references = filesUnder(path.join('skills', 'references'));
  if (t.style === 'native') {
    for (const f of agentFiles()) copyTransformed(path.join(KIT, 'agents', f), path.join('.claude', 'agents', f), toClaudeAgent);
    if (EXPERIMENTAL) {
      for (const f of experimentalAgentFiles()) copyTransformed(path.join(KIT, 'agents', 'experimental', f), path.join('.claude', 'agents', f), toClaudeAgent);
    }
    for (const s of SKILLS) copyIfAbsent(path.join(KIT, 'skills', `${s}.md`), path.join('.claude', 'skills', s, 'SKILL.md'));
    copyIfAbsent(path.join(KIT, 'skills', 'state-template.md'), path.join('.claude', 'skills', 'build-module-pipeline', 'references', 'state-template.md'));
    for (const r of references) copyIfAbsent(path.join(KIT, 'skills', 'references', r), path.join('.claude', 'skills', 'build-module-pipeline', 'references', r));
    /**
     * Hooks: copied, never armed. Enabling one in `.claude/settings.json` is the user's deliberate act, and
     * hooks are read at session start, so one added mid-session does not fire until the next session.
     * `adapters/claude-code.md` names the event and matcher for each.
     */
    copyIfAbsent(path.join(KIT, 'hooks', 'protected-paths.cjs'), path.join('.claude', 'hooks', 'protected-paths.cjs'));
    copyIfAbsent(path.join(KIT, 'hooks', 'board-render.cjs'), path.join('.claude', 'hooks', 'board-render.cjs'));
    for (const h of filesUnder(path.join('hooks', 'claude-code'))) {
      copyIfAbsent(path.join(KIT, 'hooks', 'claude-code', h), path.join('.claude', 'hooks', h));
    }
  } else {
    for (const f of agentFiles()) copyIfAbsent(path.join(KIT, 'agents', f), path.join('.builder', 'personas', f));
    if (EXPERIMENTAL) {
      for (const f of experimentalAgentFiles()) copyIfAbsent(path.join(KIT, 'agents', 'experimental', f), path.join('.builder', 'personas', 'experimental', f));
    }
    for (const f of fs.readdirSync(path.join(KIT, 'skills')).filter((x) => x.endsWith('.md'))) {
      copyIfAbsent(path.join(KIT, 'skills', f), path.join('.builder', 'playbooks', f));
    }
    for (const r of references) copyIfAbsent(path.join(KIT, 'skills', 'references', r), path.join('.builder', 'playbooks', 'references', r));
  }
  if (!NO_EXTRAS) {
    const base = t.style === 'native' ? path.join('.claude', 'skills') : path.join('.builder', 'skills');
    for (const name of extrasList()) copyDirIfAbsent(path.join(KIT, 'skills-extra', name), path.join(base, name), ['agents']);
    for (const { name, file } of extraAgentFiles()) {
      const src = path.join(KIT, 'skills-extra', name, 'agents', file);
      if (t.style === 'native') copyTransformed(src, path.join('.claude', 'agents', file), toClaudeAgent);
      else copyIfAbsent(src, path.join('.builder', 'personas', file));
    }
  }
  wirePointer(t.pointer, pointerBlock(tool), Boolean(t.mdc));
}

function installCommon() {
  console.log('\n[common] ledgers + profile');
  /**
   * The installer honours §16 `paths` like every other reader — it was the last one that did not.
   *
   * WHY. An adopter whose conventions keep history elsewhere moves the ledgers and records the move in §16;
   * `verify`, `check-ledgers` and the board tooling all followed. The installer kept copying to its OWN
   * defaults, so the next run of `unpack` — the documented upgrade path — re-created a blank board dir, a
   * blank registry and a blank decision log at the root, beside the real ones. Nothing mechanical objected:
   * the checkers read §16 and stayed green while a person, a search or a later script reaching for the root
   * file found an empty ledger wearing the kit's own header, which reads as "nothing decided" with the
   * authority of a real file. A ledger has exactly one home. With no profile the defaults stand.
   *
   * The brief template is not a ledger — it stays beside the specs, and §16 has no path for it.
   */
  const { boards, registry, decisions } = ledgerPaths();
  /**
   * Project-owned from the moment they land: the ledgers fill with the project's rows, the profile with its
   * answers, and the board rules and brief templates are the documented place to tune. `upgrade` adds one that
   * is missing and never rewrites one that exists — compare against builder/templates/ by hand if wanted.
   */
  const own = 'project';
  copyIfAbsent(path.join(KIT, 'templates', 'task-board.md'), path.join(boards, 'README.md'), own);
  copyIfAbsent(path.join(KIT, 'templates', 'deferred-registry.md'), registry, own);
  copyIfAbsent(path.join(KIT, 'templates', 'module-brief.md'), path.join('specs', 'module-brief.template.md'), own);
  copyIfAbsent(path.join(KIT, 'templates', 'orchestrator-plan.md'), path.join('specs', 'orchestrator-plan.template.md'), own);
  copyIfAbsent(path.join(KIT, 'templates', 'orchestrator-worker-brief.md'), path.join('specs', 'orchestrator-worker-brief.template.md'), own);
  copyIfAbsent(path.join(KIT, 'templates', 'decision-log.md'), decisions, own);
  copyIfAbsent(path.join(KIT, 'templates', 'session-board.md'), path.join(boards, '_session-board.template.md'), own);
  copyIfAbsent(path.join(KIT, 'PIPELINE_PROFILE.template.md'), 'PIPELINE_PROFILE.md', own);

  /**
   * The scripts, not just the rules they enforce.
   *
   * A progress bar that is TYPED is a claim nobody re-derives; a findings list nobody validates is a list
   * nobody can verify mechanically; a citation nobody resolves is a confident-looking invention. Every rule in
   * the playbook that a script can hold is held by one of these, and a rule shipped without its script is
   * unenforceable. They read `PIPELINE_PROFILE.md` §16 and say "<feature>: not configured" for anything the
   * project does not have. Wire `board-check-all.mjs` into the gate chain (profile §8).
   *
   * Every file under builder/scripts/ is installed under scripts/ with the same relative path (so each
   * script's `./lib/…` requires keep resolving), except the no-Node unpack fallbacks.
   */
  console.log('\n[common] scripts');
  if (PACKAGED) {
    // Installed as a package the scripts run from it — `npx builder run <name>` — so a kit update reaches them with
    // the version bump, and the project carries no copies to drift (plan BU-4).
    console.log(`run from the package: ${RUN} run <name>   (list them: ${RUN} run)`);
  }
  for (const rel of PACKAGED ? [] : filesUnder('scripts')) {
    if (/^unpack\.(sh|ps1)$/.test(rel)) continue;
    copyIfAbsent(path.join(KIT, 'scripts', rel), path.join('scripts', rel));
  }
  // Contract-oracle adapters (one file per contract format). The oracle script looks in scripts/oracles/.
  for (const rel of PACKAGED ? [] : filesUnder('oracles')) {
    copyIfAbsent(path.join(KIT, 'oracles', rel), path.join('scripts', 'oracles', rel));
  }
  if (EXPERIMENTAL) {
    console.log('\n[experimental] shipped, unproven — see builder/EXPERIMENTS.md');
    for (const rel of PACKAGED ? [] : filesUnder(path.join('tooling', 'experimental'))) {
      copyIfAbsent(path.join(KIT, 'tooling', 'experimental', rel), path.join('scripts', 'experimental', rel));
    }
  }

  const gi = path.join(CWD, '.gitignore');
  const has = fs.existsSync(gi) && /^\.pipeline\/?$/m.test(fs.readFileSync(gi, 'utf8'));
  if (has) {
    if (MODE === 'upgrade') upgradeLog('kept-project-owned', '.gitignore', '.pipeline/ already listed');
    else log('skip (exists):', '.gitignore (.pipeline/)');
  } else {
    if (!DRY) fs.appendFileSync(gi, `${fs.existsSync(gi) ? '\n' : ''}.pipeline/\n`);
    if (MODE === 'upgrade') upgradeLog('added', '.gitignore', '.pipeline/ line appended');
    else log(DRY ? 'would append:' : 'appended:', '.gitignore (.pipeline/)');
  }
}

// --------------------------- check-targets ----------------------------------
// The one rule prose cannot enforce: a target whose DATASTORE is shared with other people must
// never run the destructive audit. Judge by whose data it is, not whose process — an app on your
// laptop pointed at a team database is shared. Config is explicit (`shared: true`) rather than
// guessed from hostnames: guessing wrong in the permissive direction is exactly the failure that
// takes a team environment down.
const TARGET_FILES = ['qa-targets.json', 'test/e2e/qa-targets.json', 'qa/targets.json'];

function cmdCheckTargets() {
  const found = TARGET_FILES.map((p) => path.join(CWD, p)).filter((p) => fs.existsSync(p));
  // The skill is INSTALLED but no targets are declared: that is not "nothing to check", it is the
  // check having nothing to stand on. Passing silently here would mean the one rule that can take
  // down a shared environment is unguarded precisely while someone is building the audit.
  const skillInstalled = [
    path.join(CWD, '.claude', 'skills', 'qa-audit', 'SKILL.md'),
    path.join(CWD, '.builder', 'skills', 'qa-audit', 'SKILL.md'),
  ].some((p) => fs.existsSync(p));
  if (!found.length) {
    if (skillInstalled) {
      console.log(`  FAIL  qa-audit is installed but no target config exists (looked for: ${TARGET_FILES.join(', ')}).`);
      console.log('        Declare your environments before running the audit — start from builder/templates/qa-targets.md.');
      console.log('        Every attached target must answer: whose DATA is it?');
      process.exit(1);
    }
    console.log(`no target config found and qa-audit is not installed — nothing to check.`);
    process.exit(0);
  }
  let fail = 0;
  for (const file of found) {
    let cfg;
    try {
      cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      console.log(`  FAIL  ${path.relative(CWD, file)} — not valid JSON: ${e.message}`);
      fail++;
      continue;
    }
    const targets = cfg.targets || {};
    for (const [name, t] of Object.entries(targets)) {
      const rel = path.relative(CWD, file);
      if (t.shared === true && t.destructive === true) {
        console.log(`  FAIL  ${rel}: '${name}' is shared:true AND destructive:true — a shared datastore must be read-only. Add a disposable target instead of flipping this one.`);
        fail++;
      } else if (t.kind === 'attach' && t.shared === undefined) {
        console.log(`  FAIL  ${rel}: '${name}' is kind=attach but does not declare 'shared'. Answer it explicitly: whose DATA is it?`);
        fail++;
      } else if (/password|secret|token/i.test(JSON.stringify(t))) {
        console.log(`  FAIL  ${rel}: '${name}' appears to embed a credential — name an env file or variable instead.`);
        fail++;
      } else {
        console.log(`  PASS  ${rel}: '${name}' ${t.shared ? 'shared → read-only' : 'disposable'}`);
      }
    }
  }
  console.log(fail === 0 ? '\nTarget config safe.' : `\n${fail} problem(s) — see above.`);
  process.exit(fail === 0 ? 0 : 1);
}

function cmdUnpack(tools) {
  if (!fs.existsSync(path.join(KIT, 'agents'))) die('kit incomplete: builder/agents/ not found next to cli.js');
  if (path.relative(CWD, KIT) === '') die('run from the TARGET repo root, not from inside builder/');
  if (fs.existsSync(path.join(KIT, '.git'))) {
    console.log('note: builder/ contains a .git directory — this is a working copy of the pack\'s own repository, not a release.');
    console.log('      Unpacking works, but receive releases as an archive (see UNPACK.md) so the pack\'s history never lands in this repo.');
  }
  for (const tool of tools) installTool(tool);
  installCommon();
  writeLock();
  console.log(`\n${DRY ? 'Dry run — nothing written.' : 'Unpacked.'}${EXPERIMENTAL ? ' Experimental files included.' : ''} Next steps:
  1. Open builder/DISCOVERY.md in your AI agent → it fills PIPELINE_PROFILE.md (incl. §16 settings) from
     THIS project's docs (not the kit's source project).
  2. Answer the agent's "⚠ CONFIRM" questions; then run: node builder/cli.js verify
  3. See which optional checks are on: node builder/cli.js features
  4. Write a brief from specs/module-brief.template.md and start:
     "Build the <X> module through the pipeline."`);
}

/**
 * Brings an install from an older kit release level with this one. Unpack alone cannot: copy-if-absent adds
 * new files but keeps every CHANGED old persona, skill and script, so new tooling ends up driven by old prose.
 */
function cmdUpgrade(tools) {
  if (!fs.existsSync(path.join(KIT, 'agents'))) die('kit incomplete: builder/agents/ not found next to cli.js');
  if (path.relative(CWD, KIT) === '') die('run from the TARGET repo root, not from inside builder/');
  const installed = ['PIPELINE_PROFILE.md', path.join('.claude', 'agents'), path.join('.builder', 'personas')].some((p) => fs.existsSync(path.join(CWD, p)));
  if (!installed) die('nothing to upgrade here (no PIPELINE_PROFILE.md, .claude/agents/ or .builder/personas/) — run unpack first');
  MODE = 'upgrade';
  UPGRADE.stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  console.log(`builder kit ${VERSION} — upgrade${DRY ? ' (dry run: nothing is written)' : ''}`);
  for (const tool of tools) installTool(tool);
  installCommon();
  writeLock();
  const c = UPGRADE.counts;
  const backups = path.join('.builder', `backup-${UPGRADE.stamp}`);
  console.log(`\n${DRY ? 'Dry run — nothing written. Would be: ' : 'Upgraded: '}${c.updated} updated, ${c.added} added, ${c.unchanged} unchanged, ${c['kept-project-owned']} kept-project-owned${c['kept (by hand)'] ? `, ${c['kept (by hand)']} to re-wire by hand` : ''}${c['kept (local edit)'] ? `, ${c['kept (local edit)']} kept (local edit — see above; --force overwrites)` : ''}.`);
  if (c.updated > 0) console.log(DRY ? `Each updated file would be backed up first under ${backups}/.` : `Every overwritten file was backed up first under ${backups}/ (same relative path) — delete it once satisfied; it is not ignored by git.`);
  console.log(`Next steps:
  1. Read builder/CHANGELOG.md for what changed since your last release, and diff your project-owned files
     (PIPELINE_PROFILE.md, the board rules, the brief templates) against builder/ by hand where it matters.
  2. node builder/cli.js verify
  3. node builder/cli.js features   — settings this release added default to off / not configured until §16 sets them.`);
}

function cmdTargets() {
  console.log('Available --tool values:\n');
  for (const [k, t] of Object.entries(TOOLS)) console.log(`  ${k.padEnd(13)} ${t.label}`);
  console.log(`  all           every tool above except 'generic'`);
}

function profileLib() {
  return require(path.join(KIT, 'scripts', 'lib', 'profile.cjs'));
}

function cmdVerify() {
  let fail = 0;
  const check = (ok, msg) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) fail++; };
  const profileAbs = path.join(CWD, 'PIPELINE_PROFILE.md');
  /**
   * The ledgers live where §16 `paths` says, not where the installer first put them. An adopter whose
   * conventions keep the boards elsewhere moves them and records the move in §16; every script reads it, so
   * `verify` reads it too — otherwise it would fail the one install that followed the profile.
   */
  const { boards: boardsDir, registry: registryFile, decisions: decisionsFile } = ledgerPaths();

  console.log('Install:');
  check(fs.existsSync(profileAbs), 'PIPELINE_PROFILE.md exists at repo root');
  check(fs.existsSync(path.join(CWD, boardsDir, 'README.md')), `${boardsDir}/README.md (board rules) exists (paths.boards)`);
  check(fs.existsSync(path.join(CWD, registryFile)), `${registryFile} exists (paths.registry)`);
  /**
   * A ledger has exactly one home, and the checkers cannot see the other one.
   *
   * WHY. Until 0.13.2 the installer copied to its own defaults whatever §16 said, so a re-run at a moved
   * install left a blank board dir, registry and decision log at the defaults beside the real ones. The
   * installer is fixed, but a repo that already ran the buggy upgrade still holds them — and every checker
   * reads §16, so all of them pass over the twin in silence. That is the whole failure: a blank file wearing
   * the kit's own header reads as "nothing deferred, nothing decided" with the authority of a real ledger.
   * Detecting it is the only thing that turns a silent second truth into a deletion someone performs.
   *
   * Only the kit's OWN filenames are checked, and only where §16 moved that ledger — a project that keeps an
   * unrelated `tasks/` directory is not accused of anything, because `tasks/README.md` is the kit's file.
   */
  const twins = [
    ['tasks', 'tasks/README.md', boardsDir, 'paths.boards'],
    ['tasks', 'tasks/_session-board.template.md', boardsDir, 'paths.boards'],
    ['DEFERRED_TASKS.md', 'DEFERRED_TASKS.md', registryFile, 'paths.registry'],
    ['DECISIONS.md', 'DECISIONS.md', decisionsFile, 'paths.decisions'],
  ].filter(([def, file, configured]) => configured !== def && fs.existsSync(path.join(CWD, file)));
  check(
    twins.length === 0,
    twins.length === 0
      ? 'no ledger left at a default path that §16 moved'
      : `left at a default path that §16 moved: ${twins.map(([, file, configured, key]) => `${file} (${key} says "${configured}")`).join(', ')} — a second, unreconciled ledger the checkers cannot see; move any content into the §16 copy, then delete it`,
  );
  check(
    fs.existsSync(path.join(SCRIPTS_HOME, 'board-progress.mjs')) &&
      fs.existsSync(path.join(SCRIPTS_HOME, 'board-check-all.mjs')),
    'board scripts installed (scripts/board-{progress,check-all}.mjs)',
  );
  check(
    fs.existsSync(path.join(SCRIPTS_HOME, 'board-render.mjs')) &&
      fs.existsSync(path.join(SCRIPTS_HOME, 'board-watch.mjs')) &&
      fs.existsSync(path.join(SCRIPTS_HOME, 'lib', 'board-parse.cjs')),
    'run-board tooling installed (scripts/board-{render,watch}.mjs + scripts/lib/*.cjs)',
  );
  const checkers = ['features.mjs', 'claims-check.mjs', 'output-check.mjs', 'handoff-pack.mjs', 'handoff-check.mjs', 'ledger-row.mjs', path.join('lib', 'profile.cjs')];
  const missing = checkers.filter((s) => !fs.existsSync(path.join(SCRIPTS_HOME, s)));
  check(missing.length === 0, `checkers installed (scripts/{${checkers.join(',')}})${missing.length ? ` — missing: ${missing.join(', ')}` : ''}`);
  const gi = path.join(CWD, '.gitignore');
  check(fs.existsSync(gi) && /^\.pipeline\/?$/m.test(fs.readFileSync(gi, 'utf8')), '.pipeline/ gitignored');

  const claude = fs.existsSync(path.join(CWD, '.claude', 'agents', 'module-planner.md'));
  const dot = fs.existsSync(path.join(CWD, '.builder', 'personas', 'module-planner.md'));
  check(claude || dot, 'personas installed (.claude/agents/ or .builder/personas/)');

  const wired = Object.values(TOOLS)
    .map((t) => t.pointer)
    .filter((p, i, a) => a.indexOf(p) === i)
    .filter((p) => fs.existsSync(path.join(CWD, p)) && fs.readFileSync(path.join(CWD, p), 'utf8').includes(MARKER));
  check(wired.length > 0, `pointer block wired (${wired.join(', ') || 'none found'})`);

  if (fs.existsSync(profileAbs)) {
    console.log('Profile:');
    const prof = fs.readFileSync(profileAbs, 'utf8');
    const placeholders = (prof.match(/<[^<>\n]{2,80}>/g) || []).length;
    const confirms = (prof.match(/⚠ CONFIRM/g) || []).length;
    check(placeholders === 0, `no template placeholders left (found ${placeholders})`);
    check(confirms === 0, `no unresolved "⚠ CONFIRM" lines (found ${confirms})`);
    check(!prof.includes('Delete this note block'), 'template note block removed (profile was actually filled)');
    /**
     * §16 is what every optional check reads. A profile without it still runs — every optional check is then
     * off and says so — but `verify` is the moment an adopter expects to learn that, so it fails here.
     */
    const settings = profileLib().parse(prof);
    check(settings.found, '§16 pipeline-settings block present (```json pipeline-settings)');
    check(settings.errors.length === 0, `pipeline settings valid (${settings.errors.length} problem(s))`);
    for (const e of settings.errors) console.log(`        ${e}`);
  }

  console.log(fail === 0 ? '\nAll checks passed — pipeline ready.' : `\n${fail} check(s) failed — see above.`);
  process.exit(fail === 0 ? 0 : 1);
}

function cmdFeatures() {
  const lib = profileLib();
  const loaded = lib.load(CWD);
  console.log(loaded.found ? `settings: ${path.relative(CWD, loaded.path)} §16` : 'settings: no pipeline-settings block found — defaults in use');
  for (const name of Object.keys(lib.FEATURES)) console.log(`  ${lib.feature(loaded.settings, name).line}`);
  if (loaded.errors.length > 0) {
    console.log(`\n${loaded.errors.length} settings problem(s):`);
    for (const e of loaded.errors) console.log(`  ${e}`);
    process.exit(1);
  }
  process.exit(0);
}

// --------------------------- check-ledgers ----------------------------------
// Mechanical gates over tasks/*.md + DEFERRED_TASKS.md. Modeled on the source project's
// DR-gates: every one of these rules exists because a hand-swept ledger silently rotted.
const BOARD_STATUSES = ['PLANNED', 'IN-PROGRESS', 'DONE', 'DROPPED'];
const REGISTRY_STATUSES = ['DEFERRED', 'NOW UNBLOCKED', 'DONE', 'DROPPED'];

/**
 * Pipe tables as `{ headers, rows }`, each row keeping its own cells.
 *
 * WHY A TABLE AND NOT A ROW. This used to return bare cell arrays and every rule then read a FIXED
 * POSITION — status at index 3, evidence at index 4. A ledger whose rows carry one column fewer than
 * their header does not fail that read; it passes it, against the wrong cell. Observed on a real board
 * whose `FIX-*` rows omitted the `Cites` cell: the gate reported hundreds of "status not in vocabulary"
 * violations quoting the EVIDENCE prose, and the actual statuses — the thing the gate exists to check —
 * were never examined at all. A check whose predicate measures a cell adjacent to its claim is worse
 * than no check, because its noise reads as the finding.
 */
function parseTables(md) {
  const tables = [];
  let cur = null;
  for (const raw of md.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('|')) { cur = null; continue; } // a blank line or prose ends the table
    // Split on UNESCAPED pipes only. Markdown's cell delimiter is `|` and its literal is `\|` — a table row
    // that quotes a command (`grep -iE "clock\|date"`) is written with the escape, and a parser that splits on
    // every pipe turns one cell into three and then reports the row as ragged. The escape is then removed, so
    // a rule reads the text a person sees.
    const cells = line.replace(/^\||(?<!\\)\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
    if (cur === null) { cur = { headers: cells.map((h) => h.toLowerCase()), rows: [] }; tables.push(cur); continue; }
    if (cells.every((c) => /^[-: ]*$/.test(c))) continue; // the header separator
    cur.rows.push(cells);
  }
  return tables;
}

/**
 * Where a ledger table keeps its id, status and evidence — BY HEADER NAME, so a column inserted or moved
 * shifts nothing. A table with no id-and-status pair of headers is not a ledger table (a board's phase
 * table, a prose table) and is skipped, exactly as the old id-shaped row filter skipped it.
 */
function columnsOf(headers) {
  const find = (re) => headers.findIndex((h) => re.test(h));
  return { id: find(/^(#|id)$/), status: find(/^status$/), evidence: find(/evidence|test-seed/) };
}

const isLedgerTable = (cols) => cols.id >= 0 && cols.status >= 0;

/**
 * The vocabulary term a status cell CLAIMS, or null.
 *
 * WHY THIS IS NOT `vocab.includes(cell)`. People write ledgers in markdown, for people: `**DONE**`,
 * `DONE 2026-09-03`, `DONE (2026-08-26) — CP3 B4`. All three claim DONE, and an exact-match gate failed
 * all three — 146 findings on one repo's ledgers, of which 131 were emphasis and annotation. A gate that
 * fails on typography teaches its readers to ignore it, and then the fifteen that were REAL (`OPEN`,
 * `BUILT`, `CLOSED — by observation`, `needs-ruling`) go unread with the rest.
 *
 * The rule is narrow on purpose: emphasis is stripped, then the cell must BEGIN with a vocabulary term
 * and the remainder must begin with a separator (`—`, `–`, `(`, `[`, `,`, or whitespace). The longest
 * term wins, so `IN-PROGRESS` is not read as a prefix of nothing and `NOW UNBLOCKED` survives its space.
 * `DONEISH` and `CLOSED — by observation` still fail, which is the point. What it cannot catch is an
 * annotation that CONTRADICTS the term (`DONE — pending a ruling`); no parser can, and the exact-match
 * gate could not either, since it already let a trailing date through.
 */
function statusToken(raw, vocab) {
  let t = stripEmphasis(raw);
  const terms = [...vocab].sort((a, b) => b.length - a.length);
  for (const term of terms) {
    if (!t.toUpperCase().startsWith(term.toUpperCase())) continue;
    const rest = t.slice(term.length);
    if (rest === '' || /^[\s(\[,—–]/.test(rest)) return term;
  }
  return null;
}

/** A board status cell with its emphasis removed — what the DEFERRED→<id> form is read from. */
function unemphasised(raw) {
  return stripEmphasis(raw);
}

/**
 * Markdown emphasis removed from a status cell. Bold markers come off WHEREVER they appear, not only when
 * they wrap the whole cell: people bold the claim and leave the annotation plain — `**DONE 2026-08-03** —
 * verified against the mirror` — and a wrap-only strip leaves that cell looking out-of-vocabulary. A lone
 * `*` or `_` is stripped only when it wraps the whole cell, since either can appear inside prose.
 */
function stripEmphasis(raw) {
  const t = String(raw || '').replace(/\*\*|__/g, '').trim();
  const m = /^([*_])([\s\S]*)\1$/.exec(t);
  return (m ? m[2] : t).trim();
}

/**
 * Every ledger row in a file, each with the column map of the table it belongs to. A row whose cell count
 * does not match its own header is reported (LG-6) and NOT read: its cells cannot be mapped to columns, and
 * reading them anyway is the silent mis-measurement this exists to stop. A ragged row is a real defect in
 * the board — a missing cell, an unescaped `|` in prose — and it hid behind the positional read for as long
 * as that read existed.
 */
function* ledgerRows(md, file, note) {
  for (const table of parseTables(md)) {
    const cols = columnsOf(table.headers);
    if (!isLedgerTable(cols)) continue;
    for (const cells of table.rows) {
      if (cells.length !== table.headers.length) {
        const id = cells[0] || '-';
        note(file, id, 'LG-6', `row has ${cells.length} cell(s), its header has ${table.headers.length} [${table.headers.join(' | ')}] — the row was not checked; a missing cell, or an unescaped "|" in prose`);
        continue;
      }
      yield { cells, cols };
    }
  }
}

/** The ledger locations every script agrees on: §16 `paths`, or the installer's defaults when there is no profile. */
function ledgerPaths() {
  const { settings } = profileLib().load(CWD);
  const p = settings?.paths ?? {};
  return {
    boards: p.boards || 'tasks',
    registry: p.registry || 'DEFERRED_TASKS.md',
    decisions: p.decisions || 'DECISIONS.md',
  };
}

function cmdCheckLedgers() {
  const problems = [];
  const note = (file, row, rule, msg) => problems.push({ file, row, rule, msg });
  const { boards: boardsDir, registry: registryFile } = ledgerPaths();

  // Registry first (boards cross-reference it)
  const regPath = path.join(CWD, registryFile);
  const regIds = new Set();
  if (!fs.existsSync(regPath)) note(registryFile, '-', 'LG-0', 'registry file missing');
  else {
    const raw = fs.readFileSync(regPath, 'utf8');
    if (raw.includes('⚠ VERIFY'))
      note(registryFile, '-', 'LG-4', 'unresolved "⚠ VERIFY" flag — resolve it, either way');
    for (const { cells, cols } of ledgerRows(raw, registryFile, note)) {
      const id = cells[cols.id];
      const status = cells[cols.status];
      if (!/^[A-Za-z0-9_.-]+$/.test(id)) continue; // prose/example rows
      if (regIds.has(id)) note(registryFile, id, 'LG-1', 'duplicate registry id');
      regIds.add(id);
      if (status && !statusToken(status, REGISTRY_STATUSES))
        note(registryFile, id, 'LG-2', `status "${status}" not in registry vocabulary [${REGISTRY_STATUSES.join(', ')}] — out-of-vocabulary rows are silently dropped by anything that counts`);
    }
  }

  /**
   * Boards. A gate that finds no input must fail, not pass: a boards directory that is missing, or that holds no
   * board, used to loop over nothing and print PASS — which is exactly the reading an adopter gets after moving
   * the boards and forgetting §16. Before the first run there are legitimately no boards; wire this gate into CI
   * once the first board exists, as the board rules say. Until then the failure names the path it looked in.
   */
  const tasksDir = path.join(CWD, boardsDir);
  const boards = fs.existsSync(tasksDir)
    ? fs.readdirSync(tasksDir).filter((f) => f.endsWith('.md') && f !== 'README.md' && !f.startsWith('_'))
    : [];
  if (!fs.existsSync(tasksDir)) note(boardsDir, '-', 'LG-0', `boards directory missing — paths.boards says ${JSON.stringify(boardsDir)}; nothing was checked`);
  else if (!boards.length) note(boardsDir, '-', 'LG-0', `no boards found under ${boardsDir}/ — an empty input set is not a pass; wire this gate in once the first board exists`);
  for (const b of boards) {
    const rel = `${boardsDir}/${b}`; // forward slashes: the report is what a person cites, on any host
    for (const { cells, cols } of ledgerRows(fs.readFileSync(path.join(tasksDir, b), 'utf8'), rel, note)) {
      const id = cells[cols.id];
      const status = cells[cols.status];
      const evidence = cols.evidence >= 0 ? cells[cols.evidence] : '';
      if (!/^(T|C|IC-|FIX-?)\d+/i.test(id)) continue; // not a task row
      const bare = unemphasised(status);
      const def = bare.match(/^DEFERRED(?:→|->)\s*`?([^`\s]+)`?/);
      const term = statusToken(bare, BOARD_STATUSES);
      if (def) {
        const ref = def[1].trim();
        if (!regIds.has(ref)) note(rel, id, 'LG-3', `DEFERRED→${ref} has no matching row in ${registryFile}`);
      } else if (!term) {
        note(rel, id, 'LG-2', `status "${status}" not in board vocabulary [${BOARD_STATUSES.join(', ')}, DEFERRED→<id>]`);
      }
      if (term === 'DONE' && (!evidence || evidence === '—' || evidence === '-' || evidence === ''))
        note(rel, id, 'LG-5', 'DONE row without named test evidence — an unevidenced DONE is invalid (board rule)');
    }
  }

  // Report
  if (problems.length === 0) {
    console.log(`check-ledgers: PASS — ${boards.length} board(s), ${regIds.size} registry row(s), 0 violations.`);
    process.exit(0);
  }
  console.log(`check-ledgers: FAIL — ${problems.length} violation(s):\n`);
  for (const p of problems) console.log(`  [${p.rule}] ${p.file} :: ${p.row} — ${p.msg}`);
  console.log('\nRules: LG-0 a ledger the gate could not read · LG-1 unique registry ids · LG-2 in-vocabulary statuses · LG-3 DEFERRED→id must exist in registry · LG-4 no unresolved ⚠ VERIFY · LG-5 DONE needs evidence · LG-6 a row that does not match its own header');
  process.exit(1);
}

// --------------------------- run --------------------------------------------
/**
 * `builder run <name> [args…]` — a kit script, run from the kit with the PROJECT as its working directory and
 * BUILDER_PROJECT_ROOT naming it (a script that used to find the project as its own parent folder reads that).
 * Its exit code is the command's. No name = the list of scripts.
 */
function cmdRun(args) {
  const [name, ...rest] = args;
  if (!name) {
    const list = (dir, prefix) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /\.(mjs|cjs|js)$/.test(f)).map((f) => prefix + f.replace(/\.(mjs|cjs|js)$/, '')) : []);
    const names = [...list(path.join(KIT, 'scripts'), ''), ...list(path.join(KIT, 'tooling', 'experimental'), 'experimental/')].sort();
    console.log(`builder kit ${VERSION} — scripts (${RUN} run <name> [args]):`);
    for (const n of names) console.log(`  ${n}`);
    return;
  }
  const file = kitScript(name);
  if (!file) die(`no kit script "${name}" — list them with: ${RUN} run`);
  const r = require('child_process').spawnSync(process.execPath, [file, ...rest], {
    cwd: CWD,
    stdio: 'inherit',
    env: { ...process.env, BUILDER_PROJECT_ROOT: CWD },
  });
  if (r.error) die(`${name}: ${r.error.message}`);
  process.exit(r.status === null ? 1 : r.status);
}

// --------------------------- arg parsing ------------------------------------
function die(msg) { console.error(`error: ${msg}`); process.exit(1); }

function main() {
  // Every line the CLI prints names the kit where it is (kitPaths above): `npx builder verify`, not a builder/ folder
  // the project does not have.
  for (const k of ['log', 'error']) {
    const write = console[k].bind(console);
    console[k] = (...a) => write(...a.map((x) => (typeof x === 'string' ? kitPaths(x) : x)));
  }
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) die(`Node ${process.versions.node} — the builder kit needs Node 18 or newer`);

  const argv = process.argv.slice(2);
  const cmd = argv[0];
  DRY = argv.includes('--dry-run');
  NO_EXTRAS = argv.includes('--no-extras');
  EXPERIMENTAL = argv.includes('--experimental');
  FORCE = argv.includes('--force');

  if (cmd === '--version' || cmd === '-v' || cmd === 'version') return console.log(VERSION);
  if (cmd === 'run') return cmdRun(argv.slice(1));
  if (cmd === 'targets') return cmdTargets();
  if (cmd === 'verify') return cmdVerify();
  if (cmd === 'features') return cmdFeatures();
  if (cmd === 'check-ledgers') return cmdCheckLedgers();
  if (cmd === 'check-targets') return cmdCheckTargets();
  if (cmd !== 'unpack' && cmd !== 'upgrade') {
    console.log(`builder kit ${VERSION}`);
    console.log('usage: node builder/cli.js <unpack|upgrade|targets|verify|features|check-ledgers|check-targets|--version> [--tool <list|all>] [--dry-run] [--no-extras] [--experimental]');
    console.log('       node builder/cli.js unpack --tool claude-code,codex');
    console.log('       node builder/cli.js upgrade --tool claude-code --dry-run   (pass the same --tool/--models/--no-extras/--experimental as the original unpack)');
    process.exit(cmd ? 1 : 0);
  }

  const m = argv.indexOf('--models');
  if (m !== -1 && argv[m + 1]) {
    for (const pair of argv[m + 1].split(',')) {
      const [tier, model] = pair.split('=').map((s) => s.trim());
      if (!['strong', 'mid', 'low'].includes(tier) || !model) die(`bad --models entry "${pair}" — use strong=<model>,mid=<model>[,low=<model>]`);
      TIER_TO_CLAUDE_MODEL[tier] = model;
    }
    console.log(`model mapping: strong=${TIER_TO_CLAUDE_MODEL.strong}, mid=${TIER_TO_CLAUDE_MODEL.mid}, low=${TIER_TO_CLAUDE_MODEL.low} (native-format targets only; others record theirs in PIPELINE_PROFILE.md §12)`);
  }

  const i = argv.indexOf('--tool');
  if (i === -1 || !argv[i + 1]) die(`${cmd} requires --tool (see 'targets' for the list, or use 'all')`);
  let tools = argv[i + 1].split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (tools.includes('all')) tools = Object.keys(TOOLS).filter((k) => k !== 'generic');
  const unknown = tools.filter((t) => !TOOLS[t]);
  if (unknown.length) die(`unknown tool(s): ${unknown.join(', ')} — run 'node builder/cli.js targets'`);
  if (cmd === 'upgrade') cmdUpgrade([...new Set(tools)]);
  else cmdUnpack([...new Set(tools)]);
}

main();
