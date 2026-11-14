# 🏗️ Builder — a portable multi-agent module-factory kit

<p align="center">
  <img alt="agent-agnostic" src="https://img.shields.io/badge/agents-agnostic_by_design-critical?style=flat-square">
  <img alt="pipeline" src="https://img.shields.io/badge/pipeline-10_phases-blue?style=flat-square">
  <img alt="personas" src="https://img.shields.io/badge/personas-9_agents-8A2BE2?style=flat-square">
  <img alt="harnesses" src="https://img.shields.io/badge/--tool_targets-11-success?style=flat-square">
  <img alt="deps" src="https://img.shields.io/badge/CLI_dependencies-zero-brightgreen?style=flat-square">
  <img alt="node" src="https://img.shields.io/badge/node-%E2%89%A518-339933?style=flat-square&logo=node.js&logoColor=white">
  <img alt="install" src="https://img.shields.io/badge/install-npm_from_a_git_tag-orange?style=flat-square">
  <img alt="inert" src="https://img.shields.io/badge/at_rest-100%25_inert-lightgrey?style=flat-square">
</p>

A self-contained, project-agnostic packaging of the **build-module-pipeline** mechanism proven on
a production modular-monolith backend (15+ shipped modules): an orchestrated, persona-per-phase
agent pipeline that builds one feature module at a time — planned, coded TDD-first, tested
adversarially, audited in parallel, documented, and gate-reviewed — with durable ledgers so no
work is silently lost and no "done" is unearned.

It ships as an npm package (`@geopjinfo/builder-pipeline`, installed from a git tag) with a zero-dependency Node
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
npx builder --version
```

The tag is the version: every project names exactly one, and nothing changes until you bump it. After the one
fetch the kit runs offline.

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
choices file is shared. Any other agent: `npx builder unpack --tool <target>` (see `npx builder targets`), then open
[`DISCOVERY.md`](DISCOVERY.md) in it.

### 3. Greenfield or brownfield

`builder-init` decides from what is in the repository (`npx builder inventory` prints the evidence):

- **Greenfield** — an empty or near-empty repository. The skill interviews you (what is built, for whom, stack,
  domain) and drafts `PIPELINE_PROFILE.md` from your answers.
- **Brownfield** — existing code, docs and agent setup. The skill reads them, lists every skill, agent, persona and
  hook you already have, scores each against the kit, and shows one table — keep yours / use the kit's / keep both
  (the kit's renamed `builder-<name>`) — with reasons, before anything is installed.

Then it installs (`npx builder unpack`), fills the profile from your docs, verifies (`npx builder verify`) and runs
the persona detector (`persona-detect`), which proposes personas for your project and makes none an agent until you
confirm it.

### 4. What setup will and will not touch

| Will | Will not |
|---|---|
| add the kit's personas, skills and pointer block for the tools you chose | overwrite, rename or delete any of **your** skills, agents, personas or hooks — **your items win**: a clash nobody decided is skipped and reported, never installed |
| record each keep / kit / both answer in **`builder.choices.json`** (commit it), so a later `upgrade` never undoes it | arm a hook — hooks are copied, never armed; enabling one is your act |
| record what it wrote, file by file, in **`builder.lock.json`** (commit it) | touch the text around its pointer block in `CLAUDE.md` / `AGENTS.md` — only the marked block is the kit's |
| seed the project-owned files once: `PIPELINE_PROFILE.md`, the boards, the deferred registry, the decision log, the brief templates | rewrite a project-owned file once it exists — not on `unpack`, not on `upgrade` |
| append `.pipeline/` to `.gitignore` | copy the kit's scripts into the project (installed as a package they run from it: `npx builder run <name>`) |

**Local edits are kept.** A kit-owned file you changed since the kit wrote it (the lock says so) is reported
`kept (local edit)` on upgrade, not overwritten; `--force` overwrites it after a backup. Better: move the change
into the profile or an overlay ([`GUIDE.md`](GUIDE.md) § Extending), where upgrades cannot reach it.

### 5. Build a module

Write a brief from `specs/module-brief.template.md` and tell the agent: *"Build the `<X>` module through the
pipeline."* [`USAGE.md`](USAGE.md) is the operator's runbook from there — where the pipeline stops for you, what it
records, how to resume, and the troubleshooting table.

## ⬆️ Updating

1. Read [`CHANGELOG.md`](CHANGELOG.md) for the entries between your tag and the new one.
2. Bump the one dependency line: `npm i -D github:geopjinfo/builder-pipeline#<new-tag>`.
3. Preview, then apply, with the same tools you installed for:

   ```
   npx builder upgrade --tool <your tools> --dry-run
   npx builder upgrade --tool <your tools>
   ```

   Kit-owned files are refreshed, each backed up first to `.builder/backup-<stamp>/`; local edits are kept; your
   choices are applied again; project-owned files are never touched.
4. `npx builder verify`, `npx builder features` (settings a release adds default to off) and `npx builder doctor`.

## ⌨️ Every command

`npx builder <command>` (folder layout, with the kit copied in as a `builder/` folder: `node builder/cli.js <command>` — see
[`UNPACK.md`](UNPACK.md)). `npx builder` with no command prints the same list.

| Command | What it does |
|---|---|
| `bootstrap [--tool <list>]` | only the builder-init skill, for the detected (or named) tools |
| `inventory [--json] [--threshold n]` | the project's own skills/agents/personas/hooks and their overlap with the kit |
| `choices list\|set\|unset\|check` | the per-item keep / kit / both decisions (builder.choices.json) |
| `unpack --tool <list\|all>` | install (copy-if-absent; undecided clashes are skipped) |
| `upgrade --tool <list\|all>` | refresh kit-owned files (backup first; `--force` over local edits) |
| &nbsp;&nbsp;`[--dry-run] [--no-extras] [--experimental] [--models strong=x,mid=y \| codex.<tier>=x \| antigravity.<tier>=x]` | options for `unpack` / `upgrade` |
| `verify` | the install and `PIPELINE_PROFILE.md`, including its §16 settings block |
| `features` | which optional checks are on, off, unmeasured or experimental |
| `doctor [--tool <list>] [--json]` | per tool: each kit feature supported, partial or unsupported, and why |
| `check-ledgers` | the mechanical board / registry gates — wire into CI |
| `check-targets` | qa-audit environment safety — wire into CI |
| `personas-check` | the persona roster check (`scripts/personas-check.mjs`) |
| `run [<script> [args]]` | a kit script, run in the project folder; no name lists them |
| `targets` | the `--tool` values |
| `--version` | the kit version |

## 🔌 Per-tool support

What `npx builder doctor --tool claude-code,codex,antigravity,generic` reports (run it in your project for the tools
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

The native targets are `claude-code`, `codex` and `antigravity`. The other `--tool` targets — `generic`, `opencode`, `gemini`, `cursor`, `copilot`, `windsurf`, `cline`, `aider` — install as prompt files under `.builder/`, each with its pointer in its own instruction or rules file (`npx builder targets` lists them).

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

## 🛠️ Working on the kit itself

For maintainers of this repository, not for projects that install it: the rules for changing the kit are in
[`AGENTS.md`](AGENTS.md), the release routine in [`RELEASING.md`](RELEASING.md) (both kept in the repo, not shipped).

## 📁 Copying the kit as a folder (secondary)

Without npm, a release archive of the kit can be extracted at the project root as a `builder/` folder, and the
commands run as `node builder/cli.js <command>` — the folder layout (`builder/` folder) form of `npx builder`. That path, and how to receive
a release archive safely, is in [`UNPACK.md`](UNPACK.md); the package install above is the primary path.
