#!/usr/bin/env node
/*
 * builder-kit CLI — unpack the builder pipeline kit into the current repo.
 *
 * Zero dependencies; Node >= 14. Run from the TARGET repo root (the repo you pasted
 * the builder/ folder into):
 *
 *   node builder/cli.js unpack --tool claude-code
 *   node builder/cli.js unpack --tool claude-code,codex
 *   node builder/cli.js unpack --tool all [--dry-run] [--no-extras]
 *   node builder/cli.js unpack --tool claude-code --models strong=opus,mid=haiku
 *   node builder/cli.js targets
 *   node builder/cli.js verify
 *   node builder/cli.js check-ledgers     (mechanical board/registry gates — wire into CI)
 *
 * --no-extras skips the optional utility skills in skills-extra/ (status-and-next, caveman,
 * graphify, ledger-audit — see skills-extra/README.md).
 *
 * Safe by design: copy-if-absent (never overwrites), pointer blocks are appended once
 * (marker-guarded), --dry-run previews everything. The kit itself is inert until you run this.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const KIT = __dirname; // builder/
const CWD = process.cwd();
const MARKER = '<!-- builder-kit:pipeline -->';
const SKILLS = ['build-module-pipeline', 'scaffold-module', 'module-readiness-check', 'setup-builder'];

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

// --------------------------- small helpers ---------------------------------
let DRY = false;
let NO_EXTRAS = false;
const log = (tag, p) => console.log(`${tag.padEnd(15)}${p}`);

function copyIfAbsent(src, dst) {
  const abs = path.join(CWD, dst);
  if (fs.existsSync(abs)) return log('skip (exists):', dst);
  if (!DRY) {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.copyFileSync(src, abs);
  }
  log(DRY ? 'would install:' : 'installed:', dst);
}

function writeIfAbsent(dst, content) {
  const abs = path.join(CWD, dst);
  if (fs.existsSync(abs)) return log('skip (exists):', dst);
  if (!DRY) {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  log(DRY ? 'would install:' : 'installed:', dst);
}

function appendPointerOnce(dst, block) {
  const abs = path.join(CWD, dst);
  const existing = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
  if (existing !== null && existing.includes(MARKER)) return log('skip (wired):', dst);
  if (!DRY) {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, (existing ? existing.replace(/\s*$/, '\n\n') : '') + block + '\n');
  }
  log(DRY ? 'would wire:' : 'wired:', dst);
}

function agentFiles() {
  return fs.readdirSync(path.join(KIT, 'agents')).filter((f) => f.endsWith('.md'));
}

// Persona frontmatter is harness-NEUTRAL (capabilities + tier). Adapters that have a native
// agent format transform it at install time; everyone else consumes it as-is (prompt text).
const CAP_TO_CLAUDE_TOOLS = {
  'read-only': 'Read, Grep, Glob, Bash',
  code: 'Read, Grep, Glob, Edit, Write, Bash',
  'test-only': 'Read, Grep, Glob, Edit, Write, Bash', // scope narrowed by the persona text itself
  docs: 'Read, Grep, Glob, Edit, Write, Bash',
};
// Default tier→model mapping for adapters with a native model field. Override per install with
// --models strong=<x>,mid=<y> (the setup-builder skill picks these by inspecting the user's
// harness/subscription). Only harnesses with a native agent format need this — everyone else
// records their mapping in PIPELINE_PROFILE.md §12 instead.
let TIER_TO_CLAUDE_MODEL = { strong: 'opus', mid: 'sonnet' };

function toClaudeAgent(content) {
  const end = content.indexOf('---', 4);
  if (end === -1) return content;
  const fm = content.slice(4, end);
  const get = (k) => ((fm.match(new RegExp(`^${k}: (.*)$`, 'm')) || [])[1] || '').split('#')[0].trim();
  const cap = get('capabilities') || 'read-only';
  const tier = get('tier') || 'strong';
  const nf = `---\nname: ${get('name')}\ndescription: ${get('description')}\ntools: ${CAP_TO_CLAUDE_TOOLS[cap] || CAP_TO_CLAUDE_TOOLS['read-only']}\nmodel: ${TIER_TO_CLAUDE_MODEL[tier] || 'opus'}\n---`;
  return nf + content.slice(end + 3);
}

function copyTransformed(src, dst, fn) {
  const abs = path.join(CWD, dst);
  if (fs.existsSync(abs)) return log('skip (exists):', dst);
  if (!DRY) {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, fn(fs.readFileSync(src, 'utf8')));
  }
  log(DRY ? 'would install:' : 'installed:', dst);
}

function copyDirIfAbsent(srcDir, dstDir) {
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
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
  project's own docs.
- **Orchestrator playbook:** ${playbook}.
- **Personas:** ${personas}.
- **Ledgers:** task boards in \`tasks/\`, deferred work in \`DEFERRED_TASKS.md\`, run artifacts in
  \`.pipeline/\` (gitignored). The pipeline never merges — it hands MERGE-READY to a human.
- **Utility skills** (if installed — see \`builder/skills-extra/README.md\`): \`status-and-next\`
  to open a session (verify state fresh, pick the next item, emit its brief), \`graphify\` for
  cheap scoped doc/architecture lookups (query the graph before re-reading big docs), \`caveman\`
  for compressed replies, \`ledger-audit\` for periodic unearned-status sweeps of the ledgers.`;
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
  if (t.style === 'native') {
    for (const f of agentFiles()) copyTransformed(path.join(KIT, 'agents', f), path.join('.claude', 'agents', f), toClaudeAgent);
    for (const s of SKILLS) copyIfAbsent(path.join(KIT, 'skills', `${s}.md`), path.join('.claude', 'skills', s, 'SKILL.md'));
    // Guardrail hook: copied, never armed — enabling in settings.json is a deliberate human act.
    copyIfAbsent(path.join(KIT, 'hooks', 'protected-paths.js'), path.join('.claude', 'hooks', 'protected-paths.js'));
    /**
     * Copied, never armed — same rule as the fence hook above. The settings entry is the user's
     * deliberate act (`PostToolUse`, matcher `Write|Edit|MultiEdit|Bash`), and hooks are read at
     * session start, so one added mid-session does not fire until the next one.
     */
    copyIfAbsent(path.join(KIT, 'hooks', 'board-render.js'), path.join('.claude', 'hooks', 'board-render.js'));
  } else {
    for (const f of agentFiles()) copyIfAbsent(path.join(KIT, 'agents', f), path.join('.builder', 'personas', f));
    for (const f of fs.readdirSync(path.join(KIT, 'skills'))) copyIfAbsent(path.join(KIT, 'skills', f), path.join('.builder', 'playbooks', f));
  }
  if (!NO_EXTRAS) {
    const base = t.style === 'native' ? path.join('.claude', 'skills') : path.join('.builder', 'skills');
    for (const name of extrasList()) copyDirIfAbsent(path.join(KIT, 'skills-extra', name), path.join(base, name));
  }
  if (t.mdc) writeIfAbsent(t.pointer, pointerBlock(tool));
  else appendPointerOnce(t.pointer, pointerBlock(tool));
}

function installCommon() {
  console.log('\n[common] ledgers + profile');
  copyIfAbsent(path.join(KIT, 'templates', 'task-board.md'), path.join('tasks', 'README.md'));
  copyIfAbsent(path.join(KIT, 'templates', 'deferred-registry.md'), 'DEFERRED_TASKS.md');
  copyIfAbsent(path.join(KIT, 'templates', 'module-brief.md'), path.join('specs', 'module-brief.template.md'));
  copyIfAbsent(path.join(KIT, 'templates', 'decision-log.md'), 'DECISIONS.md');
  copyIfAbsent(path.join(KIT, 'templates', 'session-board.md'), path.join('tasks', '_session-board.template.md'));
  copyIfAbsent(path.join(KIT, 'PIPELINE_PROFILE.template.md'), 'PIPELINE_PROFILE.md');

  /**
   * The board scripts, not just the board rules. A progress bar that is TYPED is a claim nobody
   * re-derives — the rows move and the bar does not, and the board then reports last week's number
   * with this week's authority. These make it a projection of the Status column instead, and fail
   * the gate when it drifts. Shipping the template without them leaves the rule unenforceable.
   * Wire `board-check-all.mjs` into the gate chain (profile §8).
   */
  for (const s of ['board-progress.mjs', 'board-check-all.mjs', 'board-render.mjs', 'board-watch.mjs']) {
    copyIfAbsent(path.join(KIT, 'scripts', s), path.join('scripts', s));
  }

  /**
   * The rendered run board and its readers.
   *
   * A markdown board says what the rows ARE; it cannot hold what a run DID — the order things
   * happened in, the files each step produced, which seat spent what. That lived only in a
   * transcript, which is exactly what a context compaction discards. `board-render.mjs` joins the
   * board to an append-only run log (`.pipeline/<key>/run.jsonl`) and to the harness's own dispatch
   * records, and writes one self-contained page. `board-watch.mjs` keeps it current so nobody has
   * to remember a render command — a page that is only fresh when asked is usually stale.
   *
   * Ship the readers too, or the renderer is inert.
   */
  for (const s of ['board-rows.cjs', 'board-parse.cjs', 'run-log.cjs', 'transcript-usage.cjs', 'pricing.cjs', 'board-freshness.cjs']) {
    copyIfAbsent(path.join(KIT, 'scripts', 'lib', s), path.join('scripts', 'lib', s));
  }

  const gi = path.join(CWD, '.gitignore');
  const has = fs.existsSync(gi) && /^\.pipeline\/?$/m.test(fs.readFileSync(gi, 'utf8'));
  if (has) log('skip (exists):', '.gitignore (.pipeline/)');
  else {
    if (!DRY) fs.appendFileSync(gi, `${fs.existsSync(gi) ? '\n' : ''}.pipeline/\n`);
    log(DRY ? 'would append:' : 'appended:', '.gitignore (.pipeline/)');
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
  for (const tool of tools) installTool(tool);
  installCommon();
  console.log(`\n${DRY ? 'Dry run — nothing written.' : 'Unpacked.'} Next steps:
  1. Open builder/DISCOVERY.md in your AI agent → it fills PIPELINE_PROFILE.md from THIS
     project's docs (not the kit's source project).
  2. Answer the agent's "⚠ CONFIRM" questions; then run: node builder/cli.js verify
  3. Write a brief from specs/module-brief.template.md and start:
     "Build the <X> module through the pipeline."`);
}

function cmdTargets() {
  console.log('Available --tool values:\n');
  for (const [k, t] of Object.entries(TOOLS)) console.log(`  ${k.padEnd(13)} ${t.label}`);
  console.log(`  all           every tool above except 'generic'`);
}

function cmdVerify() {
  let fail = 0;
  const check = (ok, msg) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) fail++; };
  const profileAbs = path.join(CWD, 'PIPELINE_PROFILE.md');

  console.log('Install:');
  check(fs.existsSync(profileAbs), 'PIPELINE_PROFILE.md exists at repo root');
  check(fs.existsSync(path.join(CWD, 'tasks', 'README.md')), 'tasks/README.md (board rules) exists');
  check(fs.existsSync(path.join(CWD, 'DEFERRED_TASKS.md')), 'DEFERRED_TASKS.md exists');
  check(
    fs.existsSync(path.join(CWD, 'scripts', 'board-progress.mjs')) &&
      fs.existsSync(path.join(CWD, 'scripts', 'board-check-all.mjs')),
    'board scripts installed (scripts/board-{progress,check-all}.mjs)',
  );
  check(
    fs.existsSync(path.join(CWD, 'scripts', 'board-render.mjs')) &&
      fs.existsSync(path.join(CWD, 'scripts', 'board-watch.mjs')) &&
      fs.existsSync(path.join(CWD, 'scripts', 'lib', 'board-parse.cjs')),
    'run-board tooling installed (scripts/board-{render,watch}.mjs + scripts/lib/*.cjs)',
  );
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
  }

  console.log(fail === 0 ? '\nAll checks passed — pipeline ready.' : `\n${fail} check(s) failed — see above.`);
  process.exit(fail === 0 ? 0 : 1);
}

// --------------------------- check-ledgers ----------------------------------
// Mechanical gates over tasks/*.md + DEFERRED_TASKS.md. Modeled on the source project's
// DR-gates: every one of these rules exists because a hand-swept ledger silently rotted.
const BOARD_STATUSES = ['PLANNED', 'IN-PROGRESS', 'DONE', 'DROPPED'];
const REGISTRY_STATUSES = ['DEFERRED', 'NOW UNBLOCKED', 'DONE', 'DROPPED'];

function parseTableRows(md) {
  // Returns arrays of trimmed cells for pipe-table body rows (skips header + separator rows).
  return md
    .split('\n')
    .filter((l) => l.trim().startsWith('|'))
    .map((l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()))
    .filter((cells) => cells.length >= 4 && !/^[-: ]+$/.test(cells[1] || '-') && !/^(#|Id)$/i.test(cells[0]));
}

function cmdCheckLedgers() {
  const problems = [];
  const note = (file, row, rule, msg) => problems.push({ file, row, rule, msg });

  // Registry first (boards cross-reference it)
  const regPath = path.join(CWD, 'DEFERRED_TASKS.md');
  const regIds = new Set();
  if (!fs.existsSync(regPath)) note('DEFERRED_TASKS.md', '-', 'LG-0', 'registry file missing');
  else {
    const raw = fs.readFileSync(regPath, 'utf8');
    if (raw.includes('⚠ VERIFY'))
      note('DEFERRED_TASKS.md', '-', 'LG-4', 'unresolved "⚠ VERIFY" flag — resolve it, either way');
    for (const cells of parseTableRows(raw)) {
      const [id, , , status] = cells;
      if (!/^[A-Za-z0-9_.-]+$/.test(id)) continue; // prose/example rows
      if (regIds.has(id)) note('DEFERRED_TASKS.md', id, 'LG-1', 'duplicate registry id');
      regIds.add(id);
      if (status && !REGISTRY_STATUSES.includes(status))
        note('DEFERRED_TASKS.md', id, 'LG-2', `status "${status}" not in registry vocabulary [${REGISTRY_STATUSES.join(', ')}] — out-of-vocabulary rows are silently dropped by anything that counts`);
    }
  }

  // Boards
  const tasksDir = path.join(CWD, 'tasks');
  const boards = fs.existsSync(tasksDir)
    ? fs.readdirSync(tasksDir).filter((f) => f.endsWith('.md') && f !== 'README.md')
    : [];
  for (const b of boards) {
    const rel = path.join('tasks', b);
    for (const cells of parseTableRows(fs.readFileSync(path.join(tasksDir, b), 'utf8'))) {
      const [id, , status, evidence] = cells;
      if (!/^(T|C|FIX-?)\d+/i.test(id)) continue; // not a task row
      const def = status.match(/^DEFERRED(?:→|->)(.+)$/);
      if (def) {
        const ref = def[1].trim();
        if (!regIds.has(ref)) note(rel, id, 'LG-3', `DEFERRED→${ref} has no matching row in DEFERRED_TASKS.md`);
      } else if (!BOARD_STATUSES.includes(status)) {
        note(rel, id, 'LG-2', `status "${status}" not in board vocabulary [${BOARD_STATUSES.join(', ')}, DEFERRED→<id>]`);
      }
      if (status === 'DONE' && (!evidence || evidence === '—' || evidence === '-' || evidence === ''))
        note(rel, id, 'LG-5', 'DONE row without named test evidence — an unevidenced DONE is invalid (board rule)');
    }
  }

  // Report
  if (!boards.length) console.log('note: no boards found under tasks/ (nothing built yet?) — registry checked only.');
  if (problems.length === 0) {
    console.log(`check-ledgers: PASS — ${boards.length} board(s), ${regIds.size} registry row(s), 0 violations.`);
    process.exit(0);
  }
  console.log(`check-ledgers: FAIL — ${problems.length} violation(s):\n`);
  for (const p of problems) console.log(`  [${p.rule}] ${p.file} :: ${p.row} — ${p.msg}`);
  console.log('\nRules: LG-1 unique registry ids · LG-2 in-vocabulary statuses · LG-3 DEFERRED→id must exist in registry · LG-4 no unresolved ⚠ VERIFY · LG-5 DONE needs evidence');
  process.exit(1);
}

// --------------------------- arg parsing ------------------------------------
function die(msg) { console.error(`error: ${msg}`); process.exit(1); }

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  DRY = argv.includes('--dry-run');
  NO_EXTRAS = argv.includes('--no-extras');

  if (cmd === 'targets') return cmdTargets();
  if (cmd === 'verify') return cmdVerify();
  if (cmd === 'check-ledgers') return cmdCheckLedgers();
  if (cmd === 'check-targets') return cmdCheckTargets();
  if (cmd !== 'unpack') {
    console.log('usage: node builder/cli.js <unpack|targets|verify|check-ledgers|check-targets> [--tool <list|all>] [--dry-run] [--no-extras]');
    console.log('       node builder/cli.js unpack --tool claude-code,codex');
    process.exit(cmd ? 1 : 0);
  }

  const m = argv.indexOf('--models');
  if (m !== -1 && argv[m + 1]) {
    for (const pair of argv[m + 1].split(',')) {
      const [tier, model] = pair.split('=').map((s) => s.trim());
      if (!['strong', 'mid'].includes(tier) || !model) die(`bad --models entry "${pair}" — use strong=<model>,mid=<model>`);
      TIER_TO_CLAUDE_MODEL[tier] = model;
    }
    console.log(`model mapping: strong=${TIER_TO_CLAUDE_MODEL.strong}, mid=${TIER_TO_CLAUDE_MODEL.mid} (native-format targets only; others record theirs in PIPELINE_PROFILE.md §12)`);
  }

  const i = argv.indexOf('--tool');
  if (i === -1 || !argv[i + 1]) die("unpack requires --tool (see 'targets' for the list, or use 'all')");
  let tools = argv[i + 1].split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (tools.includes('all')) tools = Object.keys(TOOLS).filter((k) => k !== 'generic');
  const unknown = tools.filter((t) => !TOOLS[t]);
  if (unknown.length) die(`unknown tool(s): ${unknown.join(', ')} — run 'node builder/cli.js targets'`);
  cmdUnpack([...new Set(tools)]);
}

main();
