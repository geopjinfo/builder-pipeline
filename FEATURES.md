# 📋 Features — everything the kit does, on one page

> **Commands.** Written for the npm-package install: the CLI is `npx builder-pipeline <command>` and a kit script runs as
> `npx builder-pipeline run <name>`. With the kit copied in as a `builder/` folder ([`UNPACK.md`](UNPACK.md)), the CLI is
> `node builder/cli.js <command>` and a script runs from the project's `scripts/` copy with Node (folder layout).

**Support columns** come from `npx builder-pipeline doctor --tool claude-code,codex,antigravity --json` and `adapters/*.md`:
**yes** = supported natively · **partial** = the kit relies on instructions or a by-hand step there · **no** = not
available · **any** = plain Node or git, harness-independent. **Status:** **stable** = on, or installed and used as
is · **opt-in** = a §16 feature (`PIPELINE_PROFILE.md`) that is `off` until you configure it, or a hook that is copied
and never armed · **unmeasured** = on by default, benefit not yet measured · **experimental** = `experimental-off`
until you opt in ([`EXPERIMENTS.md`](EXPERIMENTS.md)). `npx builder-pipeline features` prints the live state in a project.

## Setup and maintenance

| Feature | What it does | How to use | Claude Code | Codex | Antigravity | Status | Docs |
|---|---|---|---|---|---|---|---|
| Install | the package, from the npm registry (from 2.0.0) or pinned to a release tag; inert until setup runs | `npm i -D builder-pipeline` or `npm i -D github:geopjinfo/builder-pipeline#<tag>` | any | any | any | stable | [README](README.md) |
| Bootstrap | adds only the `builder-init` skill, for each detected (or named) tool, and — run through npx — adds the kit to the project as a devDependency so later `npx builder-pipeline` runs it | `npx builder-pipeline bootstrap [--tool <list>]` | yes — `.claude/skills/` | yes — `.agents/skills/` | yes — `.agents/skills/` | stable | [SETUP_PROMPT](SETUP_PROMPT.md) |
| `builder-init` skill | greenfield (interview) or brownfield (read the repo); installs, fills the profile, verifies, runs the persona detector | `/builder-init` · `$builder-init` · ask for it by name | yes | yes | yes | stable | [skills/builder-init.md](skills/builder-init.md) |
| Inventory + overlap review | lists the project's own skills, agents, personas and hooks and scores their overlap with the kit | `npx builder-pipeline inventory [--json] [--threshold n]` | any | any | any | stable | [README](README.md) |
| Choices | one keep / kit / both decision per clashing item, in `builder.choices.json`; upgrades honour it | `npx builder-pipeline choices list\|set\|unset\|check` | any | any | any | stable | [GUIDE § Extending](GUIDE.md) |
| Unpack | installs personas, skills, pointer block, templates; copy-if-absent, undecided clashes skipped | `npx builder-pipeline unpack --tool <list\|all> [--dry-run] [--no-extras] [--experimental] [--models …] [--tools …]` | yes | yes | yes | stable | [UNPACK](UNPACK.md), [adapters/](adapters/) |
| Tool groups | installs one part of the kit: `spec`, `audit`, `orchestrator`, `hooks`, `evals` or `pipeline`, plus the core files every install carries; the lock records the groups and `upgrade` repeats them; `verify` names them | `npx builder-pipeline unpack --tool <list> --tools <group>[,<group>]` | yes | yes | yes | stable | [UNPACK § Install one tool group](UNPACK.md) |
| Other `--tool` targets | `generic`, `opencode`, `gemini`, `cursor`, `copilot`, `windsurf`, `cline`, `aider`: prompt files under `.builder/` + a pointer in the tool's rules file | `npx builder-pipeline targets` | — | — | — | partial (doctor) | [adapters/generic.md](adapters/generic.md) |
| Lock file + upgrade | `builder.lock.json` records what the kit wrote and the install's tools and flags; upgrade reports files a release dropped (`--prune` removes them); upgrade refreshes kit-owned files with a backup, keeps local edits (`--force` overrides), never touches project-owned files | `npx builder-pipeline upgrade --tool <list> [--dry-run]` | any | any | any | stable | [README § Updating](README.md) |
| Uninstall | removes the kit's files for chosen tools and its pointer block, keeps project-owned and edited files | `npx builder-pipeline uninstall --tool <list> \| --all [--dry-run]` | yes | yes | yes | stable | [USAGE](USAGE.md) |
| Commit hygiene | commits and PRs carry human authors only: the pointer block tells every agent, and a git `commit-msg` hook strips agent co-author trailers and "Generated with" lines whatever wrote the commit; `doctor` says whether it is armed | `npx builder-pipeline git-hooks` (once per clone) | yes | yes | yes | stable | [USAGE](USAGE.md) |
| Verify | checks the install and `PIPELINE_PROFILE.md`, including its §16 settings block | `npx builder-pipeline verify` | any | any | any | stable | [README](README.md) |
| Features | which optional checks are on, off, unmeasured or experimental | `npx builder-pipeline features` | any | any | any | stable | [EXPERIMENTS](EXPERIMENTS.md) |
| Doctor | per tool, each kit feature supported, partial or unsupported, and why | `npx builder-pipeline doctor [--tool <list>] [--json]` | any | any | any | stable | [README § Per-tool support](README.md) |
| Run | runs a kit script in the project folder; no name lists them | `npx builder-pipeline run [<script> [args]]` | any | any | any | stable | [README](README.md) |
| Profile + discovery | `PIPELINE_PROFILE.md`: project facts §1–§15, machine-readable settings in §16, filled from the project's own docs | `DISCOVERY.md` prompt; `npx builder-pipeline verify` | any | any | any | stable | [DISCOVERY](DISCOVERY.md), [template](PIPELINE_PROFILE.template.md) |
| Persona detector | proposes the project's personas (users, delivery roles, approvers); none becomes an agent until confirmed | `persona-detect` skill; `npx builder-pipeline personas-check` | yes | yes | yes | stable | [skills/persona-detect.md](skills/persona-detect.md) |

## The pipeline

| Feature | What it does | How to use | Claude Code | Codex | Antigravity | Status | Docs |
|---|---|---|---|---|---|---|---|
| Nine personas | planner, builder, tester, four auditors, docs, reviewer; neutral source rendered per tool | installed by `unpack` | yes — `.claude/agents/` | yes — `.codex/agents/*.toml` | yes — `.agents/agents/*.md` | stable | [GUIDE § personas](GUIDE.md), [agents/](agents/) |
| Per-seat tool limits | read-only, test-only, docs-only, the reviewer's one file | from each persona's `capabilities` | yes | partial — instructions + `git status` after each phase | partial — whole-tool grants + `git status` | stable | [adapters/codex.md](adapters/codex.md), [adapters/antigravity.md](adapters/antigravity.md) |
| Model tiers + effort | `strong` / `mid` / `low` per persona, mapped to the tool's models | `--models strong=…,mid=…` · `codex.<tier>=…` · `antigravity.<tier>=…` | yes · effort yes | partial (no kit defaults) · effort yes | partial (`inherit`/`flash`/`pro`) · effort no | stable | [adapters/](adapters/) |
| `build-module-pipeline` | one module through track → plan → TDD build → test → drift → four parallel auditors → docs → review → behavioural gate → close-out, with the `FIX-n` loop | the skill: *"Build the `<X>` module through the pipeline."* | yes — subagents, auditors in parallel | yes — skill; phases per [adapter](adapters/codex.md) | yes — skill + subagents | stable | [GUIDE](GUIDE.md), [USAGE](USAGE.md) |
| Tracks | FULL · ADDITIVE · PLATFORM · FIX · RULINGS · SOLO; a floor, never lowered mid-run | chosen with the brief, confirmed by the planner | yes | yes | yes | stable | [GUIDE § tracks](GUIDE.md) |
| Lite split + gate batch | build now (plan → build → test, queued `BUILT-UNGATED`), gate later over up to `cap` modules; nothing merges until `GATED` | `build-module-lite`, `build-module-lite-gate-batch` skills; `npx builder-pipeline run gate-queue` · `features.liteSplit` | yes | yes (skills) | yes (skills) | experimental | [EXPERIMENTS §8](EXPERIMENTS.md) |
| Scaffold + readiness | golden-path module copy; Definition-of-Done checklist before a PR | `scaffold-module`, `module-readiness-check` skills | yes | yes | yes | stable | [skills/](skills/) |
| Spec authoring stage | before Phase 1, turns an intent into one `<specs>/<key>.spec.md`: requirement rows, Given/When/Then criteria, an OpenAPI 3 contract, oracle amendments, open questions; a person ratifies it; the pipeline's step 0.7 refuses a draft; `--rows` / `--pack` / `--contract` feed the §3 tracker, the requirement pack and the contract oracle | `spec-author` skill; `npx builder-pipeline run spec-check <key> [--ratified\|--pack\|--rows\|--contract <out>]` · `features.specAuthoring` | yes | yes | yes | opt-in | [skills/spec-author.md](skills/spec-author.md), [templates/spec.md](templates/spec.md) |
| Setup / upgrade skill | harness detection, unpack, profile discovery, re-verify | `setup-builder` skill | yes | yes | yes | stable | [skills/setup-builder.md](skills/setup-builder.md) |
| Builder batches | P2 dispatches the builder at most `rows` board rows at a time | `features.builderBatch` | yes | yes | yes | off (set `unmeasured` to switch on) | [EXPERIMENTS §6](EXPERIMENTS.md) |
| Narrow FIX lane | `FIX-n` rows grouped by file area, each fixer gets only its list; fix-of-fix rate measured | `features.fixLane`; `npx builder-pipeline run fix-rate` | yes | yes | yes | off (set `unmeasured` to switch on) | [EXPERIMENTS §7](EXPERIMENTS.md) |

## Records, ledgers and checks

| Feature | What it does | How to use | Claude Code | Codex | Antigravity | Status | Docs |
|---|---|---|---|---|---|---|---|
| Ledger gates | board + registry gates LG-0…LG-6, CI-ready exit codes | `npx builder-pipeline check-ledgers` | any | any | any | stable | [hooks/README](hooks/README.md) |
| Board import | another tool's task file (ralph `prd.json`, Spec Kit `tasks.md`) written as a build board: stated values kept, inferred ones `⚠ CONFIRM`, unmapped lines listed, an unevidenced DONE left for LG-5 | `npx builder-pipeline run board-import --format ralph\|spec-kit <source> --out <board.md>`; no profile needed | any | any | any | stable | [README § One tool](README.md) |
| Settings without a profile | an opt-in check reads `builder.config.json` or the `--config <path>` file (bare §16 JSON, same validation) when there is no `PIPELINE_PROFILE.md`; the profile wins when both exist | `npx builder-pipeline run <script> --config <path>` · `npx builder-pipeline run features` names the source | any | any | any | stable | [README § One tool](README.md) |
| Record checkers | claims (counts, anchored citations, retracted phrases), plan / findings / review shapes, handoff pack, one-row reader | `npx builder-pipeline run claims-check` · `output-check` · `handoff-pack` / `handoff-check` · `ledger-row` | any | any | any | stable (on: `claims`, `planSchema`, `findingsSchema`, `reviewTemplate`, `handoffPack`, `rowReader`) | [skills/build-module-pipeline.md](skills/build-module-pipeline.md) |
| Opt-in record checkers | citation schemes, line citations against catalogues, decision index | `citations-check` · `line-citations-check` · `decision-index` · `features.citations` / `lineCitations` / `decisionIndex` | any | any | any | opt-in | [template §16](PIPELINE_PROFILE.template.md) |
| Board tooling | progress, check-all, render to one offline HTML page, watcher | `npx builder-pipeline run board-progress` · `board-check-all` · `board-render <key>` · `board-watch` | yes — plus the `board-render.cjs` hook | partial — watcher only | partial — watcher only | stable | [adapters/codex.md](adapters/codex.md) |
| Cost accounting | per-seat model / time / tokens / cost from the harness's own transcripts; spend windows; peak context | `features.costAccounting` with `reader: "claude-code"` or `"codex"`; `cost-window [--transcripts <dir>] [--rates <file>]`, `seat-peaks` | yes | partial — `cost-window` reads Codex rollout files (`reader: "codex"`; tokens reported, cost unpriced unless `--rates`); board columns and `seat-peaks` stay em-dashes / "unmeasurable" | no — em-dashes | opt-in | [adapters/codex.md](adapters/codex.md) · [adapters/claude-code.md](adapters/claude-code.md) |
| Orchestrator model check | the session's observed model against `models.orchestrator` | `features.orchestratorModel`; `npx builder-pipeline run orchestrator-check` | yes | no — "unmeasurable here" | no | opt-in | [adapters/claude-code.md](adapters/claude-code.md) |
| Contract oracle | judges every served request in a transcript against the written contract (OpenAPI 3 adapter) | `features.contractOracle`; `npx builder-pipeline run contract-oracle` | any | any | any | opt-in | [oracles/](oracles/) |
| Structural rules + ratchets | ast-grep rule hits per area, NEW vs BASELINED; ratcheted lists | `features.rules` / `ratchets`; `rules-module`, `ratchet-refresh` | any | any | any | opt-in | [examples/](examples/) |
| Wiring check | every declared seam has something on the other end | `features.wiring`; `wiring-check` | any | any | any | opt-in | [examples/](examples/) |
| Spec trace | every requirement id has a test or a requirement-pack step (assert · by-design · gap · skipped); an untraced id fails readiness | `features.specTrace`; `spec-trace-check` | any | any | any | opt-in | [skills/references/gate-checks.md](skills/references/gate-checks.md) |
| Mutation step | non-blocking P3 mutation score; survivors become tester rows | `features.mutation`; `mutation-step` | any | any | any | opt-in | [EXPERIMENTS §5](EXPERIMENTS.md) |
| Knowledge index | index freshness gate at P1; graphify example with sync hooks | `features.graph`; `index-check`; [tooling/optional](tooling/optional/README.md) | yes — plus an optional session-start hook, copied by hand (`tooling/optional/session-sync-hook.cjs`; `unpack` does not install it) | partial — P1 gate only | partial — P1 gate only | opt-in | [tooling/optional/README.md](tooling/optional/README.md) |
| Instruction lint + budget | what instruction files state about the repo is still true; line budget per file; with the feature off, `instruction-lint <file>…` and `instruction-budget <file>… [--max-lines <n>]` check the named files with the default settings and say so | `features.instructionLint` / `instructionBudget`; `instruction-lint`, `instruction-budget` | yes — plus a lint-on-edit hook | partial — run before commit | partial — run before commit | opt-in | [adapters/codex.md](adapters/codex.md) |
| Outbound guard | the one door a model-backed check sends through: denied files, secret shapes, env values, size | `features.outboundGuard`; `outbound-check` | any | any | any | opt-in | [EXPERIMENTS §12–15](EXPERIMENTS.md) |
| Worktree sweep | removes finished git worktrees after their branch merged; with the feature off, `worktree-sweep --target <branch> [--idle-hours <n>]` judges them with the default settings as a dry run (`--apply` removes) and says so | `features.worktreeSweep`; `worktree-sweep` | any | any | any | opt-in | [template §16](PIPELINE_PROFILE.template.md) |
| Branch sweep | MERGED, STALE or KEEP per local branch with the reason; `--apply` writes `refs/builder/branches/<name>` then `git branch -d` (never `-D`); remote branches are listed with the push command, never pushed; with the feature off, `branch-sweep --target <branch> [--stale-days <n>]` judges with the defaults as a dry run and says so | `features.branchSweep`; `branch-sweep` | any | any | any | opt-in | [spec](specs/repo-hygiene.spec.md) |
| Run sweep | old run folders, worktree and upgrade backups and `PIPELINE_PROFILE.md.bak` with size and age; `--apply` moves each by rename into `<logs>/trash/<date>/`; a run with a live lane is KEEP; no recursive delete exists in the module | `features.runSweep`; `run-sweep` | any | any | any | opt-in | [spec](specs/repo-hygiene.spec.md) |
| qa-audit target safety | refuses an unsafe qa-audit environment | `npx builder-pipeline check-targets` | any | any | any | stable (with qa-audit) | [skills-extra/README](skills-extra/README.md) |

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
| Orchestrator | digests any plan into rows, splits disjoint lanes, sets a level per row, places lanes on seats, merges one lane at a time; state in files, resumes from `orch status` | `orchestrator` skill; `npx builder-pipeline run orch <digest\|preflight\|split\|claim\|watch\|merge\|status\|…>` | yes — command templates in the adapter | runs as is — you fill the seat command templates | as Codex (adapter defers to it) | opt-in | [GUIDE § orchestrator](GUIDE.md), [skills/orchestrator.md](skills/orchestrator.md) |
| Accounts | the registry of the accounts the orchestrator may place lanes on (worker, who pays, content policy, roles, budget); replaces the 1.0 `seats` / `limits` / `credit` keys, which `npx builder-pipeline accounts migrate` rewrites once | `features.accounts` (state, `accounts.<name>`); `npx builder-pipeline accounts migrate [--dry-run]` | yes | see [adapter](adapters/codex.md) | see [adapter](adapters/codex.md) | opt-in | [GUIDE](GUIDE.md) |
| Account wrappers and gateway policy | `npx builder-pipeline accounts install` writes one wrapper pair (sh, ps1) and the composed settings per account under the accounts home, recorded in `accounts.lock.json`; `accounts policy show \| dry-run \| apply` drives the gateway through a pinned adapter; `accounts usage-snapshot` writes the numbers the assessment reads; `verify` shows policy drift as an advisory row | `features.accounts.gateway` (kind, version, baseUrl, tokenFile, policyFile) | yes | yes (wrappers) | wrapper only | opt-in | [GUIDE](GUIDE.md) |
| Accounts | the registry of the accounts the orchestrator may place lanes on (worker, who pays, content policy, roles, budget); the readiness report; placement by rule (ready, role, content class, soft limit, `api-key` last); the policy gate and the `--settings` pin before a launch; the rulebook `skills/references/account-selection.md`; replaces the 1.0 `seats` / `limits` / `credit` keys, which `npx builder-pipeline accounts migrate` rewrites once (backup first, idempotent); `npx builder-pipeline doctor` adds one advisory row per account | `features.accounts` (state, `accounts.<name>`); `npx builder-pipeline accounts` (report); `accounts add\|note\|key\|remove\|list` (the registry commands, landing with the 2.0.0 release); `accounts migrate [--dry-run]` | yes | see [adapter](adapters/codex.md) | see [adapter](adapters/codex.md) | opt-in | [GUIDE § Accounts](GUIDE.md) |
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
| `remoteLanes` | a lane on another machine over plain ssh; git through a shared origin is the only data path (`orch remote …`) | Claude Code workers; ssh and git on both hosts | [§18](EXPERIMENTS.md) |
| Experiments summary | `npx builder-pipeline run experiments [--check \| --matrix \| --record <n> --row …]`: one line per EXPERIMENTS section with its decision, the check that refuses a blank or unsupported decision, the trial matrix, and the recording path a scheduled run uses | `scripts/experiments.mjs` | yes | yes | yes | always | [EXPERIMENTS](EXPERIMENTS.md) |
| `boardLoop` | the loop runner above a board: a fresh worker per pass, runner-owned row choice, gate plus verdict, one commit per passing pass, named stops (`npx builder-pipeline run board-loop`, `orch loop`) | Claude Code workers | [§17](EXPERIMENTS.md) |
| `tokenEconomizer` · `planReview` | third-party cost plugin on trial lanes · fresh-context plan review | protocol only | [§9–10](EXPERIMENTS.md) |
| `rankedSearch` · `riskHint` · `walkPriority` · `ruleNotes` | cheap-model advice, each through the outbound guard, never a gate | protocol only | [§12–15](EXPERIMENTS.md) |
| `routerHint` | an account suggestion, a risk flag (content class vs visibility, a Full lane) and whether a second opinion is advised, printed for a lane; never changes a placement; a call goes behind the outbound guard after the data-recipient decision is recorded | any (`features.outboundGuard` on) | [§16](EXPERIMENTS.md) |
| `familyReview` | a second reader for a lane's P4 findings on an account of another worker `family`, at or above the writer's `tier`; off, nothing of it runs | any (`features.accounts` on) | [§16](EXPERIMENTS.md) |

## Bundled utility skills (installed unless `--no-extras`)

`caveman` · `graphify` · `ledger-audit` · `e2e-harness` · `qa-audit` · `repo-audit` · `status-and-next` · `adr` — what each
does, what it needs and how it wires into the pipeline: [`skills-extra/README.md`](skills-extra/README.md).
