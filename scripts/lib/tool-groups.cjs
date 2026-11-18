/**
 * Tool groups — which group of the kit each installed file belongs to (`npx builder-pipeline unpack --tools <group>[,<group>]`).
 *
 * The kit is a set of tools. A project that runs its own orchestrator wants the audit gates and nothing else; a team
 * that writes specs wants the spec stage alone. `--tools` names the groups to install, and every file `unpack` or
 * `upgrade` places goes through groupOf() on its DESTINATION path. The six groups come from the Builder Toolkit Brief:
 *
 *   spec          the spec authoring skill, spec-check, spec-trace-check and the spec template
 *   audit         the review and audit gates: the reviewer and auditor personas, the audit skills, claims-check,
 *                 output-check, fix-rate, inventory, board-import, the citation, contract and wiring checkers
 *   orchestrator  the batch orchestrator skill, orch and its libraries, orchestrator-check, the plan and worker-brief
 *                 templates, worktree-sweep (the lanes)
 *   hooks         hooks/ and the guard scripts, hook-trust, and (package layout) the scripts vendored beside them
 *   evals         cost-window, seat-peaks, the experimental tooling (scripts/experimental/)
 *   pipeline      everything else: the build-module-pipeline skills, the build personas, setup, the boards tooling
 *   hygiene       repo hygiene in the project (specs/repo-hygiene.spec.md): branch-sweep, run-sweep and the checks that follow
 *
 * `core` is not a group a user names: it is the set every install carries, because several groups need it — the
 * pointer block, PIPELINE_PROFILE.md, the ledger seeds, `features`, `choices`, and each scripts/lib file that two or
 * more groups' scripts require. A lib that one group's scripts require alone belongs to that group.
 *
 * Every installed file belongs to exactly ONE group (`tests/toolkit-unpack-groups.test.mjs` walks the real install
 * list and fails on any file groupOf() does not place, so a new file cannot slip past). With no `--tools` nothing is
 * filtered and the install is the one it always was.
 */
'use strict';

const GROUPS = ['spec', 'audit', 'orchestrator', 'hooks', 'evals', 'pipeline', 'hygiene'];
const CORE = 'core';

/** Personas (agents/*.md, agents/experimental/*.md, skills-extra/<x>/agents/*.md), by name. */
const PERSONAS = {
  'module-planner': 'pipeline',
  'module-builder': 'pipeline',
  'module-tester': 'pipeline',
  'docs-maintainer': 'pipeline',
  'page-keeper': 'pipeline',
  'module-reviewer': 'audit',
  'invariant-auditor': 'audit',
  'security-auditor': 'audit',
  'standards-auditor': 'audit',
  'vuln-auditor': 'audit',
  'repo-auditor': 'audit',
  // 2.1.0 (M15): the read-only explainer of the capacity governor's record goes with the orchestrator
  'capacity-steward': 'orchestrator',
  // 2.1.0: the progress reporter persona (experimental) goes with the orchestrator, whose skill starts the watcher
  'progress-reporter': 'orchestrator',
  // 2.1.0 (M21): the read-only judge of a hygiene report goes with the hygiene checks it reads
  'repo-steward': 'hygiene',
};

/** Skills (skills/*.md, skills-extra/<name>/), by name. `references` is the pipeline skill's own folder. */
const SKILLS = {
  'spec-author': 'spec',
  orchestrator: 'orchestrator',
  'build-module-pipeline': 'pipeline',
  'scaffold-module': 'pipeline',
  'module-readiness-check': 'pipeline',
  'setup-builder': 'pipeline',
  'build-module-lite': 'pipeline',
  'build-module-lite-gate-batch': 'pipeline',
  'builder-init': 'pipeline',
  'persona-detect': 'pipeline',
  // skills/state-template.md: the pipeline skill's run cursor, installed under its references/ (see DL-3 in the spec).
  'state-template': 'pipeline',
  references: 'pipeline',
  // skills-extra/
  adr: 'pipeline',
  caveman: 'pipeline',
  'e2e-harness': 'pipeline',
  graphify: 'pipeline',
  'status-and-next': 'pipeline',
  'ledger-audit': 'audit',
  'qa-audit': 'audit',
  'repo-audit': 'audit',
};

/** Scripts (scripts/<name>.mjs), by name. */
const SCRIPTS = {
  'spec-check': 'spec',
  'spec-trace-check': 'spec',
  // M20 repo hygiene, code and docs (REQ-1839, D93)
  'deps-check': 'hygiene',
  'docs-check': 'hygiene',
  'dead-code': 'hygiene',
  'claims-check': 'audit',
  'output-check': 'audit',
  'fix-rate': 'audit',
  inventory: 'audit',
  'board-import': 'audit',
  'citations-check': 'audit',
  'line-citations-check': 'audit',
  'contract-oracle': 'audit',
  'index-check': 'audit',
  'outbound-check': 'audit',
  'wiring-check': 'audit',
  'rules-module': 'audit',
  'mutation-step': 'audit',
  'ratchet-refresh': 'audit',
  'decision-index': 'audit',
  'personas-check': 'audit',
  orch: 'orchestrator',
  'orchestrator-check': 'orchestrator',
  'worktree-sweep': 'orchestrator',
  'branch-sweep': 'hygiene',
  'run-sweep': 'hygiene',
  'attribution-check': 'hygiene',
  'artifact-check': 'hygiene',
  hygiene: 'hygiene', // the runner and the completion gate
  'cost-window': 'evals',
  'seat-peaks': 'evals',
  features: CORE,
  choices: CORE,
  'board-check-all': 'pipeline',
  'board-progress': 'pipeline',
  'board-render': 'pipeline',
  'board-watch': 'pipeline',
  'gate-queue': 'pipeline',
  'handoff-check': 'pipeline',
  'handoff-pack': 'pipeline',
  'instruction-budget': 'pipeline',
  'instruction-lint': 'pipeline',
  'ledger-row': 'pipeline',
  // 2.0.0 accounts line: the loop runner and the account key helper go with the orchestrator; the evidence programme
  // scripts with evals; readme-badges is the kit's own README reader (core, like features)
  'board-loop': 'orchestrator',
  // 2.1.0: the capacity governor is one more term in the orchestrator's lane-cap rule (M15)
  capacity: 'orchestrator',
  report: 'orchestrator', // 2.1.0 M16: the progress reporter
  // M19 tree hygiene (REQ-1811 to REQ-1813, REQ-1839)
  'ignore-check': 'hygiene',
  'size-check': 'hygiene',
  'secret-scan': 'hygiene',
  'account-key': CORE,
  experiments: 'evals',
  'first-value': 'evals',
  'readme-badges': CORE,
};

/**
 * Libraries (scripts/lib/<name>.cjs), by name. A lib required by the scripts of one group belongs to it; one required
 * by two or more groups (or by the CLI itself) is core. The test checks this against the real require closure.
 */
const LIBS = {
  'spec-check': 'spec',
  'spec-trace': 'spec',
  // M20 repo hygiene libs (REQ-1839, D93); dead-code requires deps-check and ratchet
  'deps-check': 'hygiene',
  'docs-check': 'hygiene',
  'dead-code': 'hygiene',
  'claims-check': 'audit',
  'fix-rate': 'audit',
  inventory: 'audit',
  'board-import': 'audit',
  citations: 'audit',
  'line-citations': 'audit',
  'contract-oracle': 'audit',
  'index-check': 'audit',
  'report-rules': CORE, // the rules of features.reporter, read by the settings loader (every group)
  report: 'orchestrator', // the progress reporter (2.1.0 M16) and its channels ship with the orchestrator
  notify: 'orchestrator',
  'outbound-guard': CORE, // the outbound guard is read by the audit, orchestrator, pipeline, evals and spec groups
  wiring: 'audit',
  'rules-module': 'audit',
  'mutation-summary': 'audit',
  ratchet: CORE, // ratchet-refresh (audit) and dead-code (hygiene) both read the bank (M20)
  'decision-index': 'audit',
  personas: 'audit',
  // every scripts/lib/orch-*.cjs is the orchestrator's (groupOf matches the prefix)
  'orchestrator-check': 'orchestrator',
  'worktree-sweep': CORE, // the orchestrator's sweep and run-sweep (hygiene) share its tree helpers
  'branch-sweep': 'hygiene',
  'run-sweep': 'hygiene',
  'attribution-check': 'hygiene',
  'artifact-check': 'hygiene',
  'hygiene-match': 'hygiene', // the glob rules the gate checks share
  hygiene: CORE, // the runner and the gate rows; the progress reporter (orchestrator) reads its record through it (REQ-1836)
  capacity: 'orchestrator', // 2.1.0 (M15): read by orch-state, orch, board-loop and the capacity command
  'bash-cap': 'hooks',
  reanchor: 'hooks',
  // M19 tree hygiene libs (REQ-1839); secret-scan.cjs is also what the two hooks load (HOOK_LOADS)
  'hygiene-cli': 'hygiene',
  'ignore-check': 'hygiene',
  'size-check': 'hygiene',
  'secret-scan': 'hygiene',
  'board-freshness': 'pipeline',
  'board-parse': CORE, // read by the pipeline boards tooling and by the progress reporter (orchestrator), 2.1.0
  'page-docs': 'pipeline',
  'run-log': CORE,
  'table-row': 'pipeline',
  'instruction-budget': 'pipeline',
  'instruction-lint': CORE, // the lint (pipeline) and docs-check (hygiene) both require its resolver (M20, D92)
  // shared by two or more groups, or by cli.js
  profile: CORE,
  'run-hint': CORE,
  'output-check': CORE,
  'board-rows': CORE,
  'handoff-check': CORE,
  'gate-queue': CORE,
  pricing: CORE,
  'session-usage': CORE,
  'transcript-usage': CORE,
  choices: CORE,
  'tool-groups': CORE,
  // 2.0.0 accounts line. cli.js and cli/accounts.cjs (core) require the registry, the paths, the probes, the secrets,
  // the lease, the wrappers, the lock, the gateway policy and the error rule, so all of them are core; the worker
  // adapters' helpers and the loop runner are the orchestrator's; experiments is read by `features` (core).
  'accounts-registry': CORE,
  'account-paths': CORE,
  'account-probes': 'orchestrator',
  'account-secrets': CORE,
  'account-lease': CORE,
  'account-errors': 'orchestrator',
  'account-policy': 'orchestrator',
  'account-wrappers': CORE,
  'accounts-lock': CORE,
  'gateway-policy': CORE,
  accounts: 'orchestrator',
  'codex-ratelimits': 'orchestrator',
  'codex-usage': 'evals',
  experiments: CORE,
  'srt-check': CORE,
  gateways: CORE, // scripts/lib/gateways/: the adapters behind `accounts policy` (cli.js)
  'worker-env': 'orchestrator',
  'worker-errors': 'orchestrator',
  'worker-runner': 'orchestrator',
  'worker-verdict': 'orchestrator',
  'board-loop': 'orchestrator',
  // M8: the second reader is orch-plan's (orchestrator); router-hint is advisory and wired to no command yet, so core
  'family-review': 'orchestrator',
  'router-hint': CORE,
};

/** Project-owned seeds and the pointer files, by destination. The ledger paths follow §16 `paths`; see groupOf(). */
const FILES = {
  'PIPELINE_PROFILE.md': CORE,
  '.gitignore': CORE,
  'specs/spec.template.md': 'spec',
  'specs/module-brief.template.md': 'pipeline',
  'specs/orchestrator-plan.template.md': 'orchestrator',
  'specs/orchestrator-worker-brief.template.md': 'orchestrator',
  'CLAUDE.md': CORE,
  'AGENTS.md': CORE,
  'GEMINI.md': CORE,
  'CONVENTIONS.md': CORE,
  '.cursor/rules/builder-pipeline.mdc': CORE,
  '.github/copilot-instructions.md': CORE,
  '.windsurf/rules/builder-pipeline.md': CORE,
  '.clinerules/builder-pipeline.md': CORE,
};

/**
 * The folder layout's hooks load the project's own scripts/ copies (hook-trust.cjs: a hook runs only committed code).
 * These scripts and their libraries come with the `hooks` group even when their own group is not selected, so an
 * armed hook never points at a missing file. Checked against hookScripts()' closure by the test.
 */
const HOOK_LOADS = [
  'scripts/board-render.mjs',
  'scripts/instruction-lint.mjs',
  // profile.cjs (2.0.0) requires the account registry, the account paths and the outbound guard, so a hook loads them too
  'scripts/lib/account-paths.cjs',
  'scripts/lib/accounts-registry.cjs',
  'scripts/lib/outbound-guard.cjs',
  'scripts/lib/bash-cap.cjs',
  'scripts/lib/board-freshness.cjs',
  // the pre-commit secret scan and the write guard (REQ-1815, REQ-1816) load the scan and its helper
  'scripts/lib/hygiene-cli.cjs',
  'scripts/lib/secret-scan.cjs',
  'scripts/lib/board-parse.cjs',
  'scripts/lib/board-rows.cjs',
  'scripts/lib/instruction-lint.cjs',
  'scripts/lib/page-docs.cjs',
  'scripts/lib/pricing.cjs',
  'scripts/lib/profile.cjs',
  'scripts/lib/reanchor.cjs',
  'scripts/lib/report-rules.cjs', // profile.cjs validates features.reporter (2.1.0 M16)
  'scripts/lib/run-hint.cjs',
  'scripts/lib/run-log.cjs',
  'scripts/lib/session-usage.cjs',
  'scripts/lib/transcript-usage.cjs',
];

/** A "both" choice installs an item renamed builder-<name>; the group is the item's (builder-init is a kit name). */
const lookup = (table, seg) => table[seg] || table[seg.replace(/^builder-/, '')] || null;
const stem = (seg) => seg.replace(/\.(md|toml|cjs|mjs|js)$/i, '');

/**
 * The group of one installed file, from its destination path (posix, relative to the project root), or null when the
 * table does not place it. `ledgers` is §16 `paths` ({ boards, registry, decisions }); the defaults otherwise.
 */
function groupOf(relPath, ledgers = { boards: 'tasks', registry: 'DEFERRED_TASKS.md', decisions: 'DECISIONS.md' }) {
  const p = String(relPath).replace(/\\/g, '/').replace(/^\.\//, '');
  if (FILES[p]) return FILES[p];
  const norm = (x) => String(x).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (p === norm(ledgers.registry) || p === norm(ledgers.decisions)) return CORE;
  if (p === `${norm(ledgers.boards)}/README.md` || p === `${norm(ledgers.boards)}/_session-board.template.md`) return CORE;
  const seg = p.split('/');
  // hooks: .claude/hooks/**, .codex/hooks/**, and the vendored .claude/hooks/kit/**
  if (seg.length >= 2 && seg[1] === 'hooks' && /^\./.test(seg[0])) return 'hooks';
  // personas: .claude/agents/<n>.md, .codex/agents/<n>.toml, .agents/agents/<n>.md, .builder/personas/[experimental/]<n>.md
  if (seg.length >= 3 && ((seg[1] === 'agents' && /^\./.test(seg[0])) || (seg[0] === '.builder' && seg[1] === 'personas'))) {
    return lookup(PERSONAS, stem(seg[seg.length - 1]));
  }
  // skills: .claude/skills/<n>/…, .agents/skills/<n>/…, .builder/skills/<n>/…, .builder/playbooks/<n>.md, .builder/playbooks/references/…
  if (seg.length >= 3 && seg[1] === 'skills' && /^\./.test(seg[0])) return lookup(SKILLS, seg[2]);
  if (seg.length >= 3 && seg[0] === '.builder' && seg[1] === 'playbooks') return lookup(SKILLS, stem(seg[2]));
  // scripts (folder layout): scripts/<n>.mjs, scripts/lib/<n>.cjs, scripts/oracles/**, scripts/experimental/**
  if (seg[0] === 'scripts') {
    if (seg.length === 2) return SCRIPTS[stem(seg[1])] || null;
    if (seg[1] === 'lib' && seg.length === 3) return /^orch-/.test(seg[2]) ? 'orchestrator' : LIBS[stem(seg[2])] || null;
    if (seg[1] === 'lib' && seg[2] === 'gateways') return CORE; // the gateway adapters behind `accounts policy` (cli.js)
    if (seg[1] === 'oracles') return 'audit';
    if (seg[1] === 'experimental') return 'evals';
  }
  return null;
}

/**
 * The files to install for `groups` (an array of group names): every file whose group is selected or core, plus — with
 * `hooks` selected — the scripts the hooks load. `files` is an array of destination paths. Throws on an unknown group
 * or an unmapped file, so a gap in the table is a refusal and never a silent skip.
 */
function select(files, groups, ledgers) {
  const unknown = (groups || []).filter((g) => !GROUPS.includes(g));
  if (unknown.length) throw new Error(`unknown tool group(s): ${unknown.join(', ')} — valid groups: ${GROUPS.join(', ')}`);
  const want = new Set(groups);
  return files.filter((f) => selected(f, want, ledgers));
}

/** True when `relPath` installs for the groups in `want` (a Set). Throws on an unmapped file. */
function selected(relPath, want, ledgers) {
  const g = groupOf(relPath, ledgers);
  if (g === null) throw new Error(`${relPath}: not in any tool group (scripts/lib/tool-groups.cjs) — map it before installing`);
  if (g === CORE || want.has(g)) return true;
  if (want.has('hooks') && HOOK_LOADS.includes(String(relPath).replace(/\\/g, '/'))) return true;
  return false;
}

/** The validated group list for a `--tools` value: `all` (or empty) → null (no filter); else the sorted unique names. */
function parse(value) {
  const names = String(value || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!names.length || names.includes('all')) return null;
  const unknown = names.filter((g) => !GROUPS.includes(g));
  if (unknown.length) throw new Error(`unknown tool group(s): ${unknown.join(', ')} — valid groups: ${GROUPS.join(', ')} (or all)`);
  return [...new Set(names)].sort();
}

module.exports = { GROUPS, CORE, PERSONAS, SKILLS, SCRIPTS, LIBS, FILES, HOOK_LOADS, groupOf, select, selected, parse };
