# 🏗️ Builder — a portable multi-agent module-factory kit

<p align="center">
  <img alt="agent-agnostic" src="https://img.shields.io/badge/agents-agnostic_by_design-critical?style=flat-square">
  <img alt="pipeline" src="https://img.shields.io/badge/pipeline-13_phases-blue?style=flat-square">
  <img alt="personas" src="https://img.shields.io/badge/personas-11_agents-8A2BE2?style=flat-square">
  <img alt="harnesses" src="https://img.shields.io/badge/--tool_targets-11-success?style=flat-square">
  <img alt="deps" src="https://img.shields.io/badge/CLI_dependencies-zero-brightgreen?style=flat-square">
  <img alt="node" src="https://img.shields.io/badge/node-%E2%89%A518-339933?style=flat-square&logo=node.js&logoColor=white">
  <img alt="install" src="https://img.shields.io/badge/install-npm-orange?style=flat-square">
  <img alt="inert" src="https://img.shields.io/badge/at_rest-100%25_inert-lightgrey?style=flat-square">
</p>

A self-contained, project-agnostic packaging of the **build-module-pipeline** mechanism: an orchestrated,
persona-per-phase agent pipeline that builds one feature module at a time — planned, coded TDD-first, tested
adversarially, audited in parallel, documented, and gate-reviewed — with durable ledgers so no work is silently lost
and no "done" is unearned.

Built and used by its author on one production backend. That project's data cannot ship (the kit keeps no project
ids). Published measurements start with 2.0.0 ([`EXPERIMENTS.md`](EXPERIMENTS.md)).

It ships as an npm package (`builder-pipeline`, from the npm registry or from a git tag) with a zero-dependency Node
CLI, `builder`. It works with **Claude Code, Codex and Antigravity** natively, and with any other agent that reads
`AGENTS.md` (or its own rules file) through prompt files.

> **Inert by design.** Installing the package activates nothing — no agents, skills, hooks or config register until
> setup runs in the project. And the kit never imports its source project's rules: `PIPELINE_PROFILE.md` is filled
> by reading **your** project's own docs (the [`DISCOVERY.md`](DISCOVERY.md) step).

---

## 🚀 Getting started

### 1. Install

Node 18 or newer. From the project root, pin a release tag:

```
npm i -D github:geopjinfo/builder-pipeline#<tag>
npx --no-install builder-pipeline --version
```

The tag is the version: every project names exactly one, and nothing changes until you bump it. After the one
fetch the kit runs offline. Always type `npx --no-install builder-pipeline`: it runs the installed copy and stops when
there is none. The same command without `--no-install`, typed outside an installed project, fetches a package of that
name from the npm registry, and the kit is not published there.

### 2. Paste the one setup prompt

Open your AI tool at the project root and paste this line (from [`SETUP_PROMPT.md`](SETUP_PROMPT.md)), with `<tag>`
replaced by the release you installed:

```
Set up builder in this project: run `npx github:geopjinfo/builder-pipeline#<tag> bootstrap`, then follow the builder-init skill.
```

`bootstrap` adds one thing — the `builder-init` skill, for each AI tool it detects — and the skill does the rest,
with you confirming each decision.

| Tool | Where `bootstrap` puts the skill | Run setup again later |
|---|---|---|
| Claude Code | `.claude/skills/builder-init/SKILL.md` | `/builder-init` |
| Codex | `.agents/skills/builder-init/SKILL.md` | `$builder-init` |
| Antigravity | `.agents/skills/builder-init/SKILL.md` | ask for the `builder-init` skill by name |

Several tools in one project: `bootstrap` adds the skill for each; run `builder-init` from any one of them — the
choices file is shared. Any other agent: `npx --no-install builder-pipeline unpack --tool <target>` (see `npx --no-install builder-pipeline targets`), then open
[`DISCOVERY.md`](DISCOVERY.md) in it.

### 3. Greenfield or brownfield

`builder-init` decides from what is in the repository (`npx --no-install builder-pipeline inventory` prints the evidence):

- **Greenfield** — an empty or near-empty repository. The skill interviews you (what is built, for whom, stack,
  domain) and drafts `PIPELINE_PROFILE.md` from your answers.
- **Brownfield** — existing code, docs and agent setup. The skill reads them, lists every skill, agent, persona and
  hook you already have, scores each against the kit, and shows one table — keep yours / use the kit's / keep both
  (the kit's renamed `builder-<name>`) — with reasons, before anything is installed.

Then it installs (`npx --no-install builder-pipeline unpack`), fills the profile from your docs, verifies (`npx --no-install builder-pipeline verify`) and runs
the persona detector (`persona-detect`), which proposes personas for your project and makes none an agent until you
confirm it.

### 4. What setup will and will not touch

| Will | Will not |
|---|---|
| add the kit's personas, skills and pointer block for the tools you chose | overwrite, rename or delete any of **your** skills, agents, personas or hooks — **your items win**: a clash nobody decided is skipped and reported, never installed |
| record each keep / kit / both answer in **`builder.choices.json`** (commit it), so a later `upgrade` never undoes it | arm a hook — hooks are copied, never armed; enabling one is your act |
| record what it wrote, file by file, in **`builder.lock.json`** (commit it) | touch the text around its pointer block in `CLAUDE.md` / `AGENTS.md` — only the marked block is the kit's |
| seed the project-owned files once: `PIPELINE_PROFILE.md`, the boards, the deferred registry, the decision log, the brief templates | rewrite a project-owned file once it exists — not on `unpack`, not on `upgrade` |
| append `.pipeline/` to `.gitignore` | copy the kit's scripts into the project (installed as a package they run from it: `npx --no-install builder-pipeline run <name>`) |

**Local edits are kept.** A kit-owned file you changed since the kit wrote it (the lock says so) is reported
`kept (local edit)` on upgrade, not overwritten; `--force` overwrites it after a backup. Better: move the change
into the profile or an overlay ([`GUIDE.md`](GUIDE.md) § Extending), where upgrades cannot reach it.

### 5. Build a module

No requirement rows yet? With `features.specAuthoring` on, say *"Write the spec for `<X>`"* first: the `spec-author`
skill turns the intent into `specs/<X>.spec.md` (requirement rows, acceptance criteria, API contract) for you to
ratify, and the pipeline refuses to start on a draft. Then write a brief from `specs/module-brief.template.md` and tell the agent: *"Build the `<X>` module through the
pipeline."* [`USAGE.md`](USAGE.md) is the operator's runbook from there — where the pipeline stops for you, what it
records, how to resume, and the troubleshooting table.

## ⬆️ Updating

1. Read [`CHANGELOG.md`](CHANGELOG.md) for the entries between your tag and the new one.
2. Bump the one dependency line: `npm i -D github:geopjinfo/builder-pipeline#<new-tag>`.
3. Preview, then apply, with the same tools you installed for:

   ```
   npx --no-install builder-pipeline upgrade --dry-run
   npx --no-install builder-pipeline upgrade            # tools, models and extras come from builder.lock.json; --prune removes what a release dropped
   ```

   Kit-owned files are refreshed, each backed up first to `.builder/backup-<stamp>/`; local edits are kept; your
   choices are applied again; project-owned files are never touched.
4. `npx --no-install builder-pipeline verify`, `npx --no-install builder-pipeline features` (settings a release adds default to off) and `npx --no-install builder-pipeline doctor`.
5. **From 1.x:** 2.0.0 has one command, `builder-pipeline`. In your own scripts, CI and instruction files, change the
   command name after `npx` from `builder` to `builder-pipeline`. `upgrade` does not rewrite project-owned files, so
   the project makes this edit itself ([`GUIDE.md`](GUIDE.md) § "From 1.x: the command name").

## ⌨️ Every command

`npx --no-install builder-pipeline <command>` (folder layout, with the kit copied in as a `builder/` folder: `node builder/cli.js <command>` — see
[`UNPACK.md`](UNPACK.md)). `npx --no-install builder-pipeline` with no command prints the same list.

| Command | What it does |
|---|---|
| `bootstrap [--tool <list>]` | only the builder-init skill, for the detected (or named) tools |
| `inventory [--json] [--threshold n]` | the project's own skills/agents/personas/hooks and their overlap with the kit |
| `choices list\|set\|unset\|check` | the per-item keep / kit / both decisions (builder.choices.json) |
| `unpack --tool <list\|all> [--tools <groups>]` | install (copy-if-absent; undecided clashes are skipped); `--tools` installs one tool group or several (`spec`, `audit`, `orchestrator`, `hooks`, `evals`, `pipeline`; default all) |
| `upgrade [--tool <list\|all>] [--prune]` | refresh kit-owned files (backup first; `--force` over local edits); tools and flags default to the install's, recorded in the lock; files a release dropped are reported `stale`, `--prune` removes them |
| `uninstall --tool <list> \| --all [--dry-run]` | remove the kit's files for those tools and its pointer block; project-owned and locally edited files are kept and named |
| `git-hooks [--dry-run]` | arm the `commit-msg` hook in this clone: commits carry human authors only (agent `Co-Authored-By:` trailers and "Generated with" lines are stripped); never overwrites a hook already there |
| &nbsp;&nbsp;`[--dry-run] [--no-extras] [--experimental] [--models strong=x,mid=y \| codex.<tier>=x \| antigravity.<tier>=x]` | options for `unpack` / `upgrade` |
| `verify` | the install and `PIPELINE_PROFILE.md`, including its §16 settings block |
| `features` | which optional checks are on, off, unmeasured or experimental |
| `doctor [--tool <list>] [--json]` | per tool: each kit feature supported, partial or unsupported, and why |
| `check-ledgers [--boards <dir>] [--registry <file>]` | the mechanical board / registry gates — wire into CI; the flags name another tool's ledgers in place of §16 `paths` |
| `accounts migrate [--dry-run]` | rewrite the 1.0 orchestrator seat keys (`seats`, `limits`, `secondaryConfigDir`, `credit`) into `features.accounts`; only the settings block changes, with a `PIPELINE_PROFILE.md.bak` backup |
| `accounts add \| note \| key \| remove \| list \| migrate` | manage the accounts in `features.accounts` (§16): `add <name> --worker <w> --pays <p>` writes one account and makes its folder, `note` replaces its note, `key <name>` takes the API key with echo off (never on the command line; stored 0600 in the account's own folder, or handed to `codex login`), `key --remove` and `remove` take them out again (the folder stays), `list [--json]` shows key present or absent, lease state and key file mode; `migrate [--dry-run]` rewrites the 1.0 seat keys (`seats`, `limits`, `secondaryConfigDir`, `credit`) into accounts, settings block only, with a `PIPELINE_PROFILE.md.bak` backup |
| `accounts [--json]`, `accounts add \| note \| key \| remove \| list \| migrate` | `accounts` alone prints the readiness report (one block per account, as `gh auth status`; exit 1 when any account is not ready, 0 with `--json`; `accounts: not configured` with the feature off); the subcommands manage the accounts in `features.accounts` (§16): `add <name> --worker <w> --pays <p>` writes one account and makes its folder, `note` replaces its note, `key <name>` takes the API key with echo off (never on the command line; stored 0600 in the account's own folder, or handed to `codex login`), `key --remove` and `remove` take them out again (the folder stays), `list [--json]` shows key present or absent, lease state and key file mode; `migrate [--dry-run]` rewrites the 1.0 seat keys (`seats`, `limits`, `secondaryConfigDir`, `credit`) into accounts, settings block only, with a `PIPELINE_PROFILE.md.bak` backup |
| `doctor [--tool <list>] [--json]` | per tool: each kit feature supported, partial or unsupported, and why; then one advisory `accounts` row per account with its readiness (or `profile: legacy seats, run npx --no-install builder-pipeline accounts migrate`); the exit code is unchanged |
| `accounts migrate [--dry-run]` | rewrite the 1.0 orchestrator seat keys (`seats`, `limits`, `secondaryConfigDir`, `credit`) into `features.accounts`; only the settings block changes, with a `PIPELINE_PROFILE.md.bak` backup |
| `accounts` · `accounts add\|note\|key\|remove\|list` | the readiness report (one block per account, exit 1 when one is not ready) and the registry commands; they land with the accounts-commands change of the 2.0.0 release — [GUIDE § Accounts](GUIDE.md) |
| `check-ledgers` | the mechanical board / registry gates — wire into CI |
| `check-targets` | qa-audit environment safety — wire into CI |
| `personas-check` | the persona roster check (`scripts/personas-check.mjs`) |
| `run capacity --once \| --watch` | the capacity governor (`features.capacity`, §16): one tick writes `<orch root>/capacity.json`, and the lane cap reads it as one more min() term — [GUIDE § Capacity governor](GUIDE.md) |
| `run report --once \| --watch` | the progress reporter (`features.reporter`, §16): one report per interval to stdout, a file, a webhook or a command, only on change — [GUIDE § Progress reporter](GUIDE.md) |
| `run [<script> [args]] [--config <path>]` | a kit script, run in the project folder; no name lists them; `--config` names a settings file for a project with no profile (below) |
| `targets` | the `--tool` values |
| `--version` | the kit version |

## 🔌 Per-tool support

What `npx --no-install builder-pipeline doctor --tool claude-code,codex,antigravity,generic` reports (run it in your project for the tools
you installed; *partial* = the kit relies on instructions or a by-hand step there):

| Feature | Claude Code | Codex | Antigravity | Any other agent (`generic` and the other prompt-file targets) |
|---|---|---|---|---|
| personas | supported — native subagents, `.claude/agents/` | supported — `.codex/agents/*.toml` | supported — `.agents/agents/*.md` | partial — prompt files in `.builder/personas/`, a fresh session per phase by hand |
| skills | supported — `.claude/skills/` | supported — `.agents/skills/` | supported — `.agents/skills/` | partial — playbooks in `.builder/playbooks/` |
| pointer | supported — `CLAUDE.md` | supported — `AGENTS.md` | partial — `AGENTS.md`; `GEMINI.md` is read too, order undocumented | supported — `AGENTS.md` (or the tool's rules file) |
| per-seat tool limits | supported — a tools list per subagent | partial — sandbox not narrowable per agent; checked with `git status` after each phase | partial — whole-tool grants; checked with `git status` | partial — instruction-held |
| model tiers | supported — `--models strong=…,mid=…,low=…` | partial — no kit defaults; `--models codex.<tier>=…` | partial — inherit / flash / pro | partial — recorded in profile §12 |
| effort | supported | supported — `model_reasoning_effort` | unsupported | unsupported |
| protected-paths hook | supported — copied, never armed | partial — Bash only (`apply_patch` not judged); copied, never armed | unsupported — not written | unsupported — the pre-commit hook in `hooks/` works with any tool |
| reviewer-write / registry-read guards | supported — copied, never armed | unsupported — no agent name in hook input | unsupported | unsupported |
| bash output cap | supported — copied, never armed | unsupported | unsupported | unsupported |

Below the matrix, `doctor` adds advisory rows that never change the exit code: one `accounts` row per account, one
`capacity` row (`features.capacity`; load is unmeasured on Windows) and one `reporter` row (`features.reporter`, the
`orch status` line, never a URL).

The native targets are `claude-code`, `codex` and `antigravity`. The other `--tool` targets — `generic`, `opencode`, `gemini`, `cursor`, `copilot`, `windsurf`, `cline`, `aider` — install as prompt files under `.builder/`, each with its pointer in its own instruction or rules file (`npx --no-install builder-pipeline targets` lists them).

## 🧰 One tool, without the pipeline

Each kit tool also runs in a project that never adopted the pipeline. The checks that are on by default
(`check-ledgers`, `output-check`, `claims-check`, `fix-rate`, `inventory`) need nothing. An opt-in check reads its
settings from a file when there is no `PIPELINE_PROFILE.md`: `builder.config.json` in the project root, or the file
`--config <path>` (`BUILDER_CONFIG`) names. The file holds the bare JSON of profile §16 and is validated the same way;
when a profile exists it is the one source and the file is ignored and said. `npx --no-install builder-pipeline run features` names the source
in use.

```
npx --no-install builder-pipeline unpack --tool claude-code --tools audit
npx --no-install builder-pipeline run features --config kit.json
npx --no-install builder-pipeline check-ledgers --boards work/boards --registry work/REGISTRY.md
npx --no-install builder-pipeline run board-import --format ralph prd.json --out tasks/imported.md
npx --no-install builder-pipeline run spec-check specs/orders.spec.md
npx --no-install builder-pipeline run spec-trace-check docs/requirements.md --tests tests --packs packs
npx --no-install builder-pipeline run instruction-lint AGENTS.md CLAUDE.md
npx --no-install builder-pipeline run instruction-budget AGENTS.md --max-lines 200
npx --no-install builder-pipeline run worktree-sweep --target main --idle-hours 6
```

`board-import` writes another tool's task file (ralph `prd.json`, Spec Kit `tasks.md`) as a kit build board: what the
source states is kept, what the importer infers is marked `⚠ CONFIRM`, every unmapped line is listed, and a DONE whose
source names no test keeps an empty evidence cell so `check-ledgers` reports it (LG-5). `spec-check` on a `.md` path and
`spec-trace-check` on named files with `--tests` / `--packs` run with the default settings while their feature is off,
and say so on their first line. The spec for this is `specs/toolkit-standalone.spec.md` in the repository.
The three hygiene checks do the same on named targets: `instruction-lint <file>…` and `instruction-budget <file>…
[--max-lines <n>]` check the named files with the default settings (no baseline: the lint's ratchet is reported, not
enforced). `worktree-sweep --target <branch> [--idle-hours <n>]` judges every worktree against that branch as a dry run;
`--apply` removes, and no hold command runs from defaults. Each says so on its first line, and a flag without its value, an
unknown flag or a named file that does not exist is a usage error. The spec is `specs/toolkit-hygiene-standalone.spec.md`.

`unpack --tools <group>[,<group>]` installs one part of the kit: `spec`, `audit`, `orchestrator`, `hooks`, `evals` or
`pipeline`, plus the core files every install carries (the pointer block, the profile, the ledger seeds, the shared
libraries). The lock records the groups and `upgrade` repeats them; with no `--tools` the install is unchanged. The
groups are listed in [`UNPACK.md` § Install one tool group](UNPACK.md); the spec is `specs/toolkit-unpack-groups.spec.md`.

## 📚 Documentation

| Doc | Read it for |
|---|---|
| [`FEATURES.md`](FEATURES.md) | every feature on one page: what it does, how to start it, per-tool support, status |
| [`GUIDE.md`](GUIDE.md) | how it works: the pipeline, personas, tracks, the lite split, the batch orchestrator, extending, what is in the box |
| [`USAGE.md`](USAGE.md) | the operator's runbook: stop points, record points, resuming, troubleshooting |
| [`DESIGN.md`](DESIGN.md) | why it works: the principles and the failures behind them |
| [`EXPERIMENTS.md`](EXPERIMENTS.md) | the unproven features and the measurement that decides each |
| [`SETUP_PROMPT.md`](SETUP_PROMPT.md) · [`DISCOVERY.md`](DISCOVERY.md) · [`UNPACK.md`](UNPACK.md) | the setup prompt · filling the profile · the folder-copy install |
| [`adapters/`](adapters/) | per-tool notes: Claude Code, Codex, Antigravity, any other agent |
| [`llms.txt`](llms.txt) | the same map for an AI agent, readable from `node_modules` |
| [`AGENTS.md`](AGENTS.md) · [`RELEASING.md`](RELEASING.md) | working on the kit repository itself, and releasing it (in the repo, not shipped in the package) |

## 📏 Evidence

The kit has been measured, and the measurement did not show what we hoped. A pre-registered benchmark (19 Nov 2026:
600 runs, ten setups, 15 tasks on one 3,000-line TypeScript service, one Sonnet-class model, hidden tests, a blind
grader) found **no evidence that the kit solves more tasks than a bare agent or a plain `CLAUDE.md`**: every setup
solved 93 to 100 percent of its runs. On that bed the kit cost 1.42 USD per run against 0.13 for a plain `CLAUDE.md`,
and 4.75 times as much on one-line tasks. What the kit did measurably more of: audit trail (the judge's score 0.68
against 0.43), added tests, and zero waits, leaks or new dependencies. The numbers, the gaps they opened and the
measurement that decides each proposed fix are in [`EXPERIMENTS.md`](EXPERIMENTS.md) §24 and §25. Until a harder
bed shows a difference, do not read this kit as a way to get more tasks right; read it as a way to get a recorded,
reviewed, scoped change at a known extra cost.

## 🛠️ Working on the kit itself

For maintainers of this repository, not for projects that install it: the rules for changing the kit are in
[`AGENTS.md`](AGENTS.md), the release routine in [`RELEASING.md`](RELEASING.md) (both kept in the repo, not shipped).

## 📁 Copying the kit as a folder (secondary)

Without npm, a release archive of the kit can be extracted at the project root as a `builder/` folder, and the
commands run as `node builder/cli.js <command>` — the folder layout (`builder/` folder) form of `npx --no-install builder-pipeline`. That path, and how to receive
a release archive safely, is in [`UNPACK.md`](UNPACK.md); the package install above is the primary path.
