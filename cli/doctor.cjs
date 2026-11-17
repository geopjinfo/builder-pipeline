'use strict';
/*
 * `builder doctor [--tool <list|all>] [--json]` — per tool, which kit features it supports, partly supports or cannot
 * support, and why.
 *
 * WHY. Each harness holds a different subset of what the kit relies on. A seat limit Codex cannot narrow per agent, or
 * a guard Antigravity never runs, reads as protection unless something says otherwise; the orchestrator then trusts a
 * limit nobody enforces. The rows below are the known limits; each native adapter's own `unconfirmed` list
 * (adapters/lib/<tool>.cjs, checked against the harness docs) is printed with them, word for word. A report: exit 0.
 *
 * ACCOUNTS (REQ-701, REQ-107; D22, D37). After the tool blocks, one `[accounts]` section: one advisory row per account
 * in `features.accounts` with its readiness line (the same assessment `npx builder-pipeline accounts` prints — the built-in
 * probes run here, so a stub on PATH is what a test gives it), or one row `accounts: not configured`, or, while the
 * profile still carries the 1.0 seat keys (`seats`, `limits`, `secondaryConfigDir`, `credit`), exactly one row
 * `profile: legacy seats, run npx builder-pipeline accounts migrate`. Advisory means the exit code never changes. `--json`
 * carries the same rows as a last element `{ section: 'accounts', advisory: true, rows }`.
 */

const fs = require('fs');
const path = require('path');

const S = 'supported';
const P = 'partial';
const U = 'unsupported';
const row = (feature, status, note) => ({ feature, status, note });

const NATIVE = {
  'claude-code': [
    row('personas', S, 'native subagents in .claude/agents/, dispatched by name'),
    row('skills', S, 'native skills in .claude/skills/'),
    row('pointer', S, 'CLAUDE.md block'),
    row('per-seat tool limits', S, 'each subagent gets its own tools list (capabilities → tools)'),
    row('model tiers', S, 'model per agent (--models strong=…,mid=…,low=…)'),
    row('effort', S, 'effort per agent'),
    row('protected-paths hook', S, 'copied to .claude/hooks/, never armed — merge the settings block in adapters/claude-code.md'),
    row('reviewer-write-guard / registry-read-guard', S, 'copied, never armed; the hook input names the dispatching agent'),
    row('bash-output-cap', S, 'copied, never armed'),
  ],
  codex: [
    row('personas', S, 'custom agents in .codex/agents/*.toml'),
    row('skills', S, 'skills in .agents/skills/'),
    row('pointer', S, 'AGENTS.md block'),
    row('per-seat tool limits', P, 'sandbox not narrowable per agent (sandbox_mode/approval_policy are inherited from the parent session); limits are instruction-held and checked with git status after each phase'),
    row('model tiers', P, 'no kit defaults; --models codex.<tier>=<model>, else the agent inherits the session model'),
    row('effort', S, 'model_reasoning_effort per agent'),
    row('protected-paths hook', P, 'Bash only: apply_patch edits are not judged by protected-paths; copied to .codex/hooks/, never armed — write .codex/hooks.json from the block unpack prints, then review it with /hooks'),
    row('reviewer-write-guard / registry-read-guard', U, 'no agent name in hooks: the tool-hook input documents no dispatching-agent field'),
    row('bash-output-cap', U, 'PostToolUse cannot replace a result with a digest'),
  ],
  antigravity: [
    row('personas', S, 'custom agents in .agents/agents/*.md'),
    row('skills', S, 'skills in .agents/skills/'),
    row('pointer', P, 'AGENTS.md block; GEMINI.md is read too and the order between them is undocumented'),
    row('per-seat tool limits', P, 'tools are whole-tool grants, not paths: test-only, docs and the reviewer\'s one file are instruction-held and checked with git status after each phase'),
    row('model tiers', P, 'inherit | flash | pro only (--models antigravity.<tier>=…)'),
    row('effort', U, 'no effort field per agent; dropped'),
    row('hooks', U, 'hooks not written: the kit hooks\' input/output shape differs from .agents/hooks.json and exit codes are undocumented'),
  ],
};

/** Every dotBuilder tool: the kit as prompt files, held by the operator. */
const DOT_BUILDER = (pointer) => [
  row('personas', P, 'prompt files in .builder/personas/ — a fresh session per phase, started by hand'),
  row('skills', P, 'playbooks in .builder/playbooks/, read on request'),
  row('pointer', S, `${pointer} block`),
  row('per-seat tool limits', P, 'instruction-held; check git status after each phase'),
  row('model tiers', P, 'recorded in PIPELINE_PROFILE.md §12, applied by hand'),
  row('effort', U, 'no per-seat effort'),
  row('hooks', U, 'not installed for this tool (the protected-paths pre-commit hook in hooks/ works with any tool)'),
];

/** Tools that look installed here. */
function installedTools(ctx) {
  const has = (p) => fs.existsSync(path.join(ctx.CWD, p));
  const marked = (p) => has(p) && fs.readFileSync(path.join(ctx.CWD, p), 'utf8').includes(ctx.MARKER);
  const out = [];
  if (has('.claude/agents/module-planner.md') || marked('CLAUDE.md') || has('.claude/skills/builder-init/SKILL.md')) out.push('claude-code');
  if (has('.codex/agents/module-planner.toml')) out.push('codex');
  if (has('.agents/agents/module-planner.md')) out.push('antigravity');
  const dot = has('.builder/personas/module-planner.md');
  for (const [k, t] of Object.entries(ctx.TOOLS)) {
    if (t.style === 'native' || !dot || !marked(t.pointer)) continue;
    // AGENTS.md is shared: a dotBuilder AGENTS.md tool is only named when no native tool explains the block.
    if (t.pointer === 'AGENTS.md' && (out.includes('codex') || out.includes('antigravity') || k !== 'generic')) continue;
    out.push(k);
  }
  return out;
}

const LEGACY_ROW = 'profile: legacy seats, run npx builder-pipeline accounts migrate';
const advisory = (note, extra = {}) => ({ feature: 'accounts', status: 'advisory', account: null, worker: null, state: null, ...extra, note });

/**
 * The advisory accounts rows for the project at `cwd`: the legacy row, the not-configured row, or one row per account
 * with its readiness line. Never throws: a profile that does not load gives the not-configured row.
 */
function accountsRows(cwd, env = process.env) {
  const profile = require('../scripts/lib/profile.cjs');
  const registry = require('../scripts/lib/accounts-registry.cjs');
  let settings;
  try {
    settings = profile.load(cwd).settings;
  } catch {
    return [advisory('accounts: not configured', { state: 'off' })];
  }
  if (registry.legacyKeys(settings.features && settings.features.orchestrator).length) return [advisory(LEGACY_ROW, { state: 'legacy' })];
  if (!registry.accountsOn(settings)) return [advisory('accounts: not configured', { state: 'off' })];
  const accounts = require('../scripts/lib/accounts.cjs');
  const probes = require('../scripts/lib/account-probes.cjs');
  const { paths, home } = require('../scripts/lib/account-paths.cjs');
  const base = home(env);
  const now = Date.now();
  const readings = {};
  for (const a of registry.list(settings)) {
    try {
      readings[a.name] = probes.collect(a, paths(base, a.name, a), { env, now });
    } catch (e) {
      readings[a.name] = { probes: { auth: { ok: null, reason: `probe failed: ${e.message}` } }, usage: null };
    }
  }
  return accounts.assessAll(settings, readings, now).map((a) => advisory(`${a.name} (${a.worker}): ${accounts.renderLine(a).slice(a.name.length + 2)}`, { account: a.name, worker: a.worker, state: a.state }));
}

function cmdDoctor(ctx, argv) {
  const i = argv.indexOf('--tool');
  let tools;
  if (i !== -1) {
    if (!argv[i + 1]) ctx.die('doctor --tool needs a list (see targets, or all)');
    tools = argv[i + 1].split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (tools.includes('all')) tools = Object.keys(ctx.TOOLS);
    const unknown = tools.filter((t) => !ctx.TOOLS[t]);
    if (unknown.length) ctx.die(`doctor: unknown tool(s): ${unknown.join(', ')}`);
  } else tools = installedTools(ctx);
  const none = !tools.length;
  if (none) tools = ['claude-code', 'codex', 'antigravity'];
  const report = [...new Set(tools)].map((tool) => ({
    tool,
    label: ctx.TOOLS[tool].label,
    features: NATIVE[tool] || DOT_BUILDER(ctx.TOOLS[tool].pointer),
    unconfirmed: (ctx.ADAPTERS[tool] && ctx.ADAPTERS[tool].unconfirmed) || [],
  }));
  const rows = accountsRows(ctx.CWD);
  if (argv.includes('--json')) return console.log(JSON.stringify([...report, { section: 'accounts', advisory: true, rows }], null, 2));
  console.log(`builder kit ${ctx.VERSION} — doctor${none ? ' (no kit install detected — showing the native tools; pass --tool to pick)' : ''}`);
  for (const t of report) {
    console.log(`\n[${t.tool}] ${t.label}`);
    for (const f of t.features) console.log(`  ${f.status.padEnd(12)}${f.feature} — ${f.note}`);
    if (t.unconfirmed.length) {
      console.log(`  left out on purpose (adapters/lib/${t.tool}.cjs):`);
      for (const u of t.unconfirmed) console.log(`    - ${u}`);
    }
  }
  console.log('\n[accounts] features.accounts — advisory, the exit code is unchanged');
  for (const r of rows) console.log(`  ${r.status.padEnd(12)}${r.feature} — ${r.note}`);
  const hygiene = require('./git-hooks.cjs').status(ctx.CWD, ctx.KIT);
  console.log(`\n[repo] commit hygiene: ${hygiene.state} — ${hygiene.note}`);
  console.log('\npartial = the kit relies on instructions or a by-hand step there; unsupported = the feature does not exist for that tool.');
}

module.exports = { cmdDoctor, installedTools, accountsRows, LEGACY_ROW, NATIVE };
