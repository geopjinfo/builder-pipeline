# 📋 Features — everything the kit does, on one page

> **Commands.** Written for the npm-package install: the CLI is `npx builder <command>` and a kit script runs as
> `npx builder run <name>`. With the kit copied in as a `builder/` folder ([`UNPACK.md`](UNPACK.md)), the CLI is
> `node builder/cli.js <command>` and a script runs from the project's `scripts/` copy with Node (folder layout).

**Support columns** come from `npx builder doctor --tool claude-code,codex,antigravity --json` and `adapters/*.md`:
**yes** = supported natively · **partial** = the kit relies on instructions or a by-hand step there · **no** = not
available · **any** = plain Node or git, harness-independent. **Status:** **stable** = on, or installed and used as
is · **opt-in** = a §16 feature (`PIPELINE_PROFILE.md`) that is `off` until you configure it, or a hook that is copied
and never armed · **unmeasured** = on by default, benefit not yet measured · **experimental** = `experimental-off`
until you opt in ([`EXPERIMENTS.md`](EXPERIMENTS.md)). `npx builder features` prints the live state in a project.

## Setup and maintenance

| Feature | What it does | How to use | Claude Code | Codex | Antigravity | Status | Docs |
|---|---|---|---|---|---|---|---|
| Install | the package, pinned to a release tag; inert until setup runs | `npm i -D github:geopjinfo/builder-pipeline#<tag>` | any | any | any | stable | [README](README.md) |
| Bootstrap | adds only the `builder-init` skill, for each detected (or named) tool, and — run through npx — adds the kit to the project as a devDependency so later `npx builder` runs it | `npx builder bootstrap [--tool <list>]` | yes — `.claude/skills/` | yes — `.agents/skills/` | yes — `.agents/skills/` | stable | [SETUP_PROMPT](SETUP_PROMPT.md) |
| `builder-init` skill | greenfield (interview) or brownfield (read the repo); installs, fills the profile, verifies, runs the persona detector | `/builder-init` · `$builder-init` · ask for it by name | yes | yes | yes | stable | [skills/builder-init.md](skills/builder-init.md) |
| Inventory + overlap review | lists the project's own skills, agents, personas and hooks and scores their overlap with the kit | `npx builder inventory [--json] [--threshold n]` | any | any | any | stable | [README](README.md) |
| Choices | one keep / kit / both decision per clashing item, in `builder.choices.json`; upgrades honour it | `npx builder choices list\|set\|unset\|check` | any | any | any | stable | [GUIDE § Extending](GUIDE.md) |
| Unpack | installs personas, skills, pointer block, templates; copy-if-absent, undecided clashes skipped | `npx builder unpack --tool <list\|all> [--dry-run] [--no-extras] [--experimental] [--models …]` | yes | yes | yes | stable | [UNPACK](UNPACK.md), [adapters/](adapters/) |
| Other `--tool` targets | `generic`, `opencode`, `gemini`, `cursor`, `copilot`, `windsurf`, `cline`, `aider`: prompt files under `.builder/` + a pointer in the tool's rules file | `npx builder targets` | — | — | — | partial (doctor) | [adapters/generic.md](adapters/generic.md) |
| Lock file + upgrade | `builder.lock.json` records what the kit wrote and the install's tools and flags; upgrade reports files a release dropped (`--prune` removes them); upgrade refreshes kit-owned files with a backup, keeps local edits (`--force` overrides), never touches project-owned files | `npx builder upgrade --tool <list> [--dry-run]` | any | any | any | stable | [README § Updating](README.md) |
| Uninstall | removes the kit's files for chosen tools and its pointer block, keeps project-owned and edited files | `npx builder uninstall --tool <list> \| --all [--dry-run]` | yes | yes | yes | stable | [USAGE](USAGE.md) |
| Commit hygiene | commits and PRs carry human authors only: the pointer block tells every agent, and a git `commit-msg` hook strips agent co-author trailers and "Generated with" lines whatever wrote the commit; `doctor` says whether it is armed | `npx builder git-hooks` (once per clone) | yes | yes | yes | stable | [USAGE](USAGE.md) |
| Verify | checks the install and `PIPELINE_PROFILE.md`, including its §16 settings block | `npx builder verify` | any | any | any | stable | [README](README.md) |
| Features | which optional checks are on, off, unmeasured or experimental | `npx builder features` | any | any | any | stable | [EXPERIMENTS](EXPERIMENTS.md) |
| Doctor | per tool, each kit feature supported, partial or unsupported, and why | `npx builder doctor [--tool <list>] [--json]` | any | any | any | stable | [README § Per-tool support](README.md) |
| Run | runs a kit script in the project folder; no name lists them | `npx builder run [<script> [args]]` | any | any | any | stable | [README](README.md) |
| Profile + discovery | `PIPELINE_PROFILE.md`: project facts §1–§15, machine-readable settings in §16, filled from the project's own docs | `DISCOVERY.md` prompt; `npx builder verify` | any | any | any | stable | [DISCOVERY](DISCOVERY.md), [template](PIPELINE_PROFILE.template.md) |
| Persona detector | proposes the project's personas (users, delivery roles, approvers); none becomes an agent until confirmed | `persona-detect` skill; `npx builder personas-check` | yes | yes | yes | stable | [skills/persona-detect.md](skills/persona-detect.md) |

## The pipeline

| Feature | What it does | How to use | Claude Code | Codex | Antigravity | Status | Docs |
|---|---|---|---|---|---|---|---|
| Nine personas | planner, builder, tester, four auditors, docs, reviewer; neutral source rendered per tool | installed by `unpack` | yes — `.claude/agents/` | yes — `.codex/agents/*.toml` | yes — `.agents/agents/*.md` | stable | [GUIDE § personas](GUIDE.md), [agents/](agents/) |
| Per-seat tool limits | read-only, test-only, docs-only, the reviewer's one file | from each persona's `capabilities` | yes | partial — instructions + `git status` after each phase | partial — whole-tool grants + `git status` | stable | [adapters/codex.md](adapters/codex.md), [adapters/antigravity.md](adapters/antigravity.md) |
| Model tiers + effort | `strong` / `mid` / `low` per persona, mapped to the tool's models | `--models strong=…,mid=…` · `codex.<tier>=…` · `antigravity.<tier>=…` | yes · effort yes | partial (no kit defaults) · effort yes | partial (`inherit`/`flash`/`pro`) · effort no | stable | [adapters/](adapters/) |
| `build-module-pipeline` | one module through track → plan → TDD build → test → drift → four parallel auditors → docs → review → behavioural gate → close-out, with the `FIX-n` loop | the skill: *"Build the `<X>` module through the pipeline."* | yes — subagents, auditors in parallel | yes — skill; phases per [adapter](adapters/codex.md) | yes — skill + subagents | stable | [GUIDE](GUIDE.md), [USAGE](USAGE.md) |
| Tracks | FULL · ADDITIVE · PLATFORM · FIX · RULINGS · SOLO; a floor, never lowered mid-run | chosen with the brief, confirmed by the planner | yes | yes | yes | stable | [GUIDE § tracks](GUIDE.md) |
| Lite split + gate batch | build now (plan → build → test, queued `BUILT-UNGATED`), gate later over up to `cap` modules; nothing merges until `GATED` | `build-module-lite`, `build-module-lite-gate-batch` skills; `npx builder run gate-queue` · `features.liteSplit` | yes | yes (skills) | yes (skills) | experimental | [EXPERIMENTS §8](EXPERIMENTS.md) |
| Scaffold + readiness | golden-path module copy; Definition-of-Done checklist before a PR | `scaffold-module`, `module-readiness-check` skills | yes | yes | yes | stable | [skills/](skills/) |
| Spec authoring stage | before Phase 1, turns an intent into one `<specs>/<key>.spec.md`: requirement rows, Given/When/Then criteria, an OpenAPI 3 contract, oracle amendments, open questions; a person ratifies it; the pipeline's step 0.7 refuses a draft; `--rows` / `--pack` / `--contract` feed the §3 tracker, the requirement pack and the contract oracle | `spec-author` skill; `npx builder run spec-check <key> [--ratified\|--pack\|--rows\|--contract <out>]` · `features.specAuthoring` | yes | yes | yes | opt-in | [skills/spec-author.md](skills/spec-author.md), [templates/spec.md](templates/spec.md) |
| Setup / upgrade skill | harness detection, unpack, profile discovery, re-verify | `setup-builder` skill | yes | yes | yes | stable | [skills/setup-builder.md](skills/setup-builder.md) |
| Builder batches | P2 dispatches the builder at most `rows` board rows at a time | `features.builderBatch` | yes | yes | yes | unmeasured | [EXPERIMENTS §6](EXPERIMENTS.md) |
| Narrow FIX lane | `FIX-n` rows grouped by file area, each fixer gets only its list; fix-of-fix rate measured | `features.fixLane`; `npx builder run fix-rate` | yes | yes | yes | unmeasured | [EXPERIMENTS §7](EXPERIMENTS.md) |

## Records, ledgers and checks

| Feature | What it does | How to use | Claude Code | Codex | Antigravity | Status | Docs |
|---|---|---|---|---|---|---|---|
| Ledger gates | board + registry gates LG-0…LG-6, CI-ready exit codes | `npx builder check-ledgers` | any | any | any | stable | [hooks/README](hooks/README.md) |
| Record checkers | claims (counts, anchored citations, retracted phrases), plan / findings / review shapes, handoff pack, one-row reader | `npx builder run claims-check` · `output-check` · `handoff-pack` / `handoff-check` · `ledger-row` | any | any | any | stable (on: `claims`, `planSchema`, `findingsSchema`, `reviewTemplate`, `handoffPack`, `rowReader`) | [skills/build-module-pipeline.md](skills/build-module-pipeline.md) |
| Opt-in record checkers | citation schemes, line citations against catalogues, decision index | `citations-check` · `line-citations-check` · `decision-index` · `features.citations` / `lineCitations` / `decisionIndex` | any | any | any | opt-in | [template §16](PIPELINE_PROFILE.template.md) |
| Board tooling | progress, check-all, render to one offline HTML page, watcher | `npx builder run board-progress` · `board-check-all` · `board-render <key>` · `board-watch` | yes — plus the `board-render.cjs` hook | partial — watcher only | partial — watcher only | stable | [adapters/codex.md](adapters/codex.md) |
| Cost accounting | per-seat model / time / tokens / cost from the harness's own transcripts; spend windows; peak context | `features.costAccounting`; `cost-window`, `seat-peaks` | yes | no — em-dashes | no — em-dashes | opt-in | [adapters/claude-code.md](adapters/claude-code.md) |
| Orchestrator model check | the session's observed model against `models.orchestrator` | `features.orchestratorModel`; `npx builder run orchestrator-check` | yes | no — "unmeasurable here" | no | opt-in | [adapters/claude-code.md](adapters/claude-code.md) |
| Contract oracle | judges every served request in a transcript against the written contract (OpenAPI 3 adapter) | `features.contractOracle`; `npx builder run contract-oracle` | any | any | any | opt-in | [oracles/](oracles/) |
| Structural rules + ratchets | ast-grep rule hits per area, NEW vs BASELINED; ratcheted lists | `features.rules` / `ratchets`; `rules-module`, `ratchet-refresh` | any | any | any | opt-in | [examples/](examples/) |
| Wiring check | every declared seam has something on the other end | `features.wiring`; `wiring-check` | any | any | any | opt-in | [examples/](examples/) |
| Spec trace | every requirement id has a test or a requirement-pack step (assert · by-design · gap · skipped); an untraced id fails readiness | `features.specTrace`; `spec-trace-check` | any | any | any | opt-in | [skills/references/gate-checks.md](skills/references/gate-checks.md) |
| Mutation step | non-blocking P3 mutation score; survivors become tester rows | `features.mutation`; `mutation-step` | any | any | any | opt-in | [EXPERIMENTS §5](EXPERIMENTS.md) |
| Knowledge index | index freshness gate at P1; graphify example with sync hooks | `features.graph`; `index-check`; [tooling/optional](tooling/optional/README.md) | yes — plus an optional session-start hook, copied by hand (`tooling/optional/session-sync-hook.cjs`; `unpack` does not install it) | partial — P1 gate only | partial — P1 gate only | opt-in | [tooling/optional/README.md](tooling/optional/README.md) |
| Instruction lint + budget | what instruction files state about the repo is still true; line budget per file | `features.instructionLint` / `instructionBudget`; `instruction-lint`, `instruction-budget` | yes — plus a lint-on-edit hook | partial — run before commit | partial — run before commit | opt-in | [adapters/codex.md](adapters/codex.md) |
| Outbound guard | the one door a model-backed check sends through: denied files, secret shapes, env values, size | `features.outboundGuard`; `outbound-check` | any | any | any | opt-in | [EXPERIMENTS §12–15](EXPERIMENTS.md) |
| Worktree sweep | removes finished git worktrees after their branch merged | `features.worktreeSweep`; `worktree-sweep` | any | any | any | opt-in | [template §16](PIPELINE_PROFILE.template.md) |
| qa-audit target safety | refuses an unsafe qa-audit environment | `npx builder check-targets` | any | any | any | stable (with qa-audit) | [skills-extra/README](skills-extra/README.md) |

## Hooks (copied, never armed — enabling one is your act)

| Feature | What it does | How to use | Claude Code | Codex | Antigravity | Status | Docs |
|---|---|---|---|---|---|---|---|
| Protected paths | blocks a write to a protected path before it lands (file tools and shell, through links); §16 `protected` globs add to the list, and the profile itself is then fenced (`BUILDER_UNLOCK=fence`) | fill `PROTECTED`, arm per [adapter](adapters/claude-code.md) | yes | partial — Bash only, `apply_patch` not judged | no — not written | opt-in | [hooks/README](hooks/README.md) |
| Pre-commit fence | the universal backstop: rejects commits touching a protected path; `BUILDER_UNLOCK=<tag>` | copy `hooks/protected-paths-precommit.sh` to `.git/hooks/pre-commit` | any | any | any | opt-in | [hooks/README](hooks/README.md) |
| Reviewer write guard / registry read guard | the reviewer writes only its review file; a named seat reads registry rows, never the whole registry | `features.reviewTemplate` / `registryGuard` | yes | no — no agent name in hook input | no | opt-in | [adapters/claude-code.md § Hooks](adapters/claude-code.md) |
| Bash output cap | large shell output goes to a log; the context gets error lines, the tail and the path (main session only) | `features.bashCap` | yes | no | no | opt-in | [adapters/claude-code.md § Hooks](adapters/claude-code.md) |
| Re-anchor after compaction | hands a compacted session its run files and open `FIX-n` rows | `features.reanchor` | yes | no — re-read by hand | no | opt-in | [adapters/claude-code.md § Hooks](adapters/claude-code.md) |
| Hook trust | every Claude Code hook loads only code byte-identical to HEAD | automatic with the hooks | yes | — | — | stable | [adapters/claude-code.md § Hooks](adapters/claude-code.md) |

## Batch orchestrator (opt-in, `features.orchestrator`)

| Feature | What it does | How to use | Claude Code | Codex | Antigravity | Status | Docs |
|---|---|---|---|---|---|---|---|
| Orchestrator | digests any plan into rows, splits disjoint lanes, sets a level per row, places lanes on seats, merges one lane at a time; state in files, resumes from `orch status` | `orchestrator` skill; `npx builder run orch <digest\|preflight\|split\|claim\|watch\|merge\|status\|…>` | yes — command templates in the adapter | runs as is — you fill the seat command templates | as Codex (adapter defers to it) | opt-in | [GUIDE § orchestrator](GUIDE.md), [skills/orchestrator.md](skills/orchestrator.md) |
| Accounts | the registry of the accounts the orchestrator may place lanes on (worker, who pays, content policy, roles, budget); replaces the 1.0 `seats` / `limits` / `credit` keys, which `npx builder accounts migrate` rewrites once | `features.accounts` (state, `accounts.<name>`); `npx builder accounts migrate [--dry-run]` | yes | see [adapter](adapters/codex.md) | see [adapter](adapters/codex.md) | opt-in | [GUIDE](GUIDE.md) |
| Credit lane | bounded jobs on an API credit balance: meter, daily cap, model floor, review hold | `credit.enabled`; `orch credit-prep` / `credit-run` / `credit-review` | yes — the only shipped worker | no — keep `credit.enabled` false | no | opt-in | [adapters/claude-code.md](adapters/claude-code.md) |
| App-session lanes | the orchestrator starts a primary-seat lane as its own app session | `features.orchestrator.primaryLaunch: "app-session"` | yes — desktop app only | no | no | unmeasured (off) | [EXPERIMENTS §11](EXPERIMENTS.md) |

## Experimental (`experimental-off`; files only with `unpack --experimental`)

| Feature | What it does | Tools | Docs |
|---|---|---|---|
| `livePage` | a read-only live page projected from the board; `page-keeper` seat | Claude Code only | [EXPERIMENTS §1](EXPERIMENTS.md) |
| `graphTrial` | graph query block in three seats, counted from transcripts | Claude Code transcripts only | [§2](EXPERIMENTS.md) |
| `advisorBuilder` | builder on a mid model with a strong advisor, replay A/B | protocol only | [§3](EXPERIMENTS.md) |
| `personas` | role profiles generated from a permission catalogue (`experimental/persona-gen`) | any | [§4](EXPERIMENTS.md) |
| `mutationGate` | a blocking mutation threshold, set from measured runs | any | [§5](EXPERIMENTS.md) |
| `liteSplit` | the lite split above | any | [§8](EXPERIMENTS.md) |
| `tokenEconomizer` · `planReview` | third-party cost plugin on trial lanes · fresh-context plan review | protocol only | [§9–10](EXPERIMENTS.md) |
| `rankedSearch` · `riskHint` · `walkPriority` · `ruleNotes` | cheap-model advice, each through the outbound guard, never a gate | protocol only | [§12–15](EXPERIMENTS.md) |

## Bundled utility skills (installed unless `--no-extras`)

`caveman` · `graphify` · `ledger-audit` · `e2e-harness` · `qa-audit` · `repo-audit` · `status-and-next` · `adr` — what each
does, what it needs and how it wires into the pipeline: [`skills-extra/README.md`](skills-extra/README.md).
