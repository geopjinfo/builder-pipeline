# 🏗️ Builder — a portable multi-agent module-factory kit

<p align="center">
  <img alt="agent-agnostic" src="https://img.shields.io/badge/agents-agnostic_by_design-critical?style=flat-square">
  <img alt="pipeline" src="https://img.shields.io/badge/pipeline-10_phases-blue?style=flat-square">
  <img alt="personas" src="https://img.shields.io/badge/personas-9_agents-8A2BE2?style=flat-square">
  <img alt="harnesses" src="https://img.shields.io/badge/harnesses-10_supported-success?style=flat-square">
  <img alt="deps" src="https://img.shields.io/badge/CLI_dependencies-zero-brightgreen?style=flat-square">
  <img alt="node" src="https://img.shields.io/badge/node-%E2%89%A514-339933?style=flat-square&logo=node.js&logoColor=white">
  <img alt="portable" src="https://img.shields.io/badge/install-copy%E2%80%91paste_portable-orange?style=flat-square">
  <img alt="inert" src="https://img.shields.io/badge/at_rest-100%25_inert-lightgrey?style=flat-square">
</p>

A self-contained, project-agnostic packaging of the **build-module-pipeline** mechanism proven on
a production modular-monolith backend (15+ shipped modules): an orchestrated, persona-per-phase
agent pipeline that builds one feature module at a time — planned, coded TDD-first, tested
adversarially, audited in parallel, documented, and gate-reviewed — with durable ledgers so no
work is silently lost and no "done" is unearned.

> **Inert by design.** Nothing activates in a repo that merely *contains* `builder/` — no agents,
> skills, hooks, or config register until you run the unpack CLI in the target repo. And the kit
> never imports its source project's rules: `PIPELINE_PROFILE.md` is filled by reading the
> **target** project's own docs (the [`DISCOVERY.md`](DISCOVERY.md) step).

---

## 🗺️ The pipeline at a glance

```mermaid
flowchart LR
    subgraph HUMAN["🧑‍💼 Human"]
        BRIEF["✍️ Brief"]
        RULE["⚖️ Rulings"]
        MERGE["🔀 Merge + tag"]
    end

    subgraph PIPELINE["🤖 Orchestrated pipeline"]
        direction LR
        P0["0️⃣ Track<br/><i>orchestrator</i>"]
        P1["1️⃣ Plan + digest<br/><i>module-planner</i>"]
        P2["2️⃣ Code (TDD)<br/><i>module-builder</i>"]
        P3["3️⃣ Test + stories<br/><i>module-tester</i>"]
        P3B["3️⃣b Drift<br/><i>deterministic</i>"]
        subgraph P4["4️⃣ Audit — parallel"]
            direction TB
            A1["🏛️ standards"]
            A2["🔐 security"]
            A3["🐛 vuln"]
            A4["🧭 invariant"]
        end
        P5["5️⃣ Docs<br/><i>docs-maintainer</i>"]
        P6["6️⃣ Review<br/><i>module-reviewer</i>"]
        P65["6️⃣½ Behavioural gate<br/><i>the real app</i>"]
        P7["7️⃣ Close-out<br/><i>orchestrator</i>"]
    end

    BRIEF --> P0 --> P1 --> P2 --> P3 --> P3B --> P4 --> P5 --> P6
    P6 -->|MERGE-READY| P65 --> P7 --> MERGE
    P3 -.->|defects| FIX(("🔁 FIX-n<br/>loop-back"))
    P3B -.->|effect vanished| FIX
    P4 -.->|findings| FIX
    P65 -.->|new failure| FIX
    P6 -.->|CHANGES-REQUIRED| FIX
    FIX -.-> P2
    P1 -.->|BLOCKING only| RULE
    P4 -.->|NEEDS-RULING| RULE
    RULE -.->|resume| P1
```

Every dashed line is a **feedback loop**; the pipeline stops for a human only at brief-time
rulings, BLOCKERS, and the final merge — everything else self-corrects via the loop-back
protocol (same blocker twice → escalate to you).

## 🧠 The one-page mental model

| Principle | What it means |
|---|---|
| 🎼 **One orchestrator, nine personas** | The main agent never writes module code. It dispatches one fresh, role-scoped subagent per phase, threads *distilled artifacts* between them, and owns the gate-fail loop. |
| 📄 **All specifics in one file** | Every persona loads `PIPELINE_PROFILE.md`. Personas define *how a phase behaves*; the profile defines *what is true in this project*. Port the kit by rewriting one file, not nine. |
| 📚 **Ledgers beat memory** | Git-tracked task board per module, cross-module deferred registry, written plan + review per run. Agents are stateless; the files are the truth. |
| 🖥️ **A run you can watch** | The board renders to one offline HTML page — step timeline, files produced, per-seat model / time / tokens / cost from the harness's own records. A watcher keeps it current; a row flip alone moves it. Unmeasured cells are em-dashes, never zeroes. |
| ⚔️ **Adversarial gates** | Tester extends (never rewrites) the coder's tests; four parallel auditors with different lenses — the fourth asking whether the system is still *coherent* afterwards, which no other seat and no test tier asks; the reviewer re-verifies every finding at its cited `file:line`. |
| ✅ **Every DONE is earned** | Close-out re-opens each row's evidence and checks the assertion *entails* the claim — the three fake-done shapes are hunted by name ([`DESIGN.md`](DESIGN.md) §11). |

## 📦 What's in the box

```
builder/
├── 📖 README.md                  ← you are here
├── 🧠 DESIGN.md                  ← WHY it works — 14 principles + failure lessons
├── ⚡ SETUP_PROMPT.md            ← paste-into-agent bootstrap — drives the whole setup end-to-end
├── 🔧 UNPACK.md                  ← HOW to install (agent-executable; details behind the CLI)
├── 🕹️ USAGE.md                   ← HOW to operate — stop points, resumption, troubleshooting
├── 🔍 DISCOVERY.md               ← agent prompt: fill the profile from the TARGET project's docs
├── ⚙️ cli.js                     ← the unpacker — zero-dep Node CLI (unpack / targets / verify /
│                                    check-ledgers / check-targets)
├── 📄 PIPELINE_PROFILE.template.md ← the ONE per-project grounding file
├── 🤖 agents/                    ← 9 generic persona definitions (one per phase/seat)
├── 📜 skills/                    ← 4 workflow recipes (pipeline · scaffold · readiness-check · setup)
├── 🧾 templates/                 ← ledger formats (module brief · task board · session board ·
│                                    deferred registry · decision log · developer-guide generator)
├── 🎁 skills-extra/              ← optional utilities: caveman · graphify · ledger-audit ·
│                                    e2e-harness · qa-audit · repo-audit · adr
├── 🛡️ hooks/                     ← mechanical guardrails (protected-paths · graphify-post-merge, opt-in)
├── 🗒️ CHANGELOG.md               ← kit version history
├── 🔌 adapters/                  ← harness run notes (claude-code · codex · generic)
└── 🛟 scripts/                   ← unpack.sh / unpack.ps1 (no-Node fallback) + board-progress /
                                     board-check-all (computed bar + CI gate) + board-render /
                                     board-watch + lib/ — the live run board and its watcher
```

## 🚀 Quick start

> **⚡ Zero-thought path:** paste `builder/` into the repo, then paste
> [`SETUP_PROMPT.md`](SETUP_PROMPT.md) into your agent — it drives ALL five steps below
> (detect harness → unpack → discovery → confirm batch → hardening offer → verify → dry run),
> **generates a project-specific `DEVELOPER_GUIDE.md`** for your team, and installs itself as
> the `setup-builder` skill for re-runs and upgrades. The manual steps:

```mermaid
flowchart LR
    S1["📋 1. Paste builder/<br/>into target repo"] --> S2["⚙️ 2. node builder/cli.js<br/>unpack --tool …"]
    S2 --> S3["🔍 3. Run DISCOVERY.md<br/>in your agent"] --> S4["✅ 4. cli.js verify"]
    S4 --> S5["✍️ 5. Write brief +<br/>run the pipeline"]
```

**1.** Paste `builder/` into the target repo root.

**2.** Unpack for your tool(s) — one command, safe to re-run, never overwrites:

```bash
node builder/cli.js unpack --tool <your-agent>
```

No target is privileged: personas ship with **harness-neutral frontmatter** (`capabilities` +
`tier`); an adapter with a native agent format transforms it at install time, every other
harness consumes the same files as prompt text.

<details>
<summary><b>Supported <code>--tool</code> targets (10)</b></summary>

| Target | Harness | Install style |
|---|---|---|
| `claude-code` | Claude Code | `.claude/agents/` + `.claude/skills/` (frontmatter transformed: capabilities/tier → tools/model) |
| `codex` | OpenAI Codex CLI | `.builder/` + pointer in `AGENTS.md` |
| `opencode` | OpenCode | `.builder/` + pointer in `AGENTS.md` |
| `gemini` | Gemini CLI | `.builder/` + pointer in `GEMINI.md` |
| `cursor` | Cursor | `.builder/` + rule in `.cursor/rules/*.mdc` |
| `copilot` | GitHub Copilot | `.builder/` + `.github/copilot-instructions.md` |
| `windsurf` | Windsurf | `.builder/` + `.windsurf/rules/` |
| `cline` | Cline / Roo Code | `.builder/` + `.clinerules/` |
| `aider` | aider | `.builder/` + pointer in `CONVENTIONS.md` |
| `generic` | anything else | `.builder/` + pointer in `AGENTS.md` |

Comma-separate several, or `--tool all`. Preview with `--dry-run`; list with
`node builder/cli.js targets`; skip utility skills with `--no-extras`.

</details>

**3.** Open [`DISCOVERY.md`](DISCOVERY.md) in your AI agent — it fills `PIPELINE_PROFILE.md` from
**this target project's own docs** and asks you only what docs can't answer.

**4.** `node builder/cli.js verify` — confirms the install and that the profile is actually
filled. (Later, `check-ledgers` is the CI-ready gate over boards + registry, `check-targets`
guards the qa-audit environment config so a shared datastore can never be audited
destructively, and
[`hooks/`](hooks/README.md) holds the opt-in protected-paths hook.)

**5.** Write a module brief from `specs/module-brief.template.md` and tell the agent:
*"Build the `<X>` module through the pipeline."*

From here, [`USAGE.md`](USAGE.md) is your operator's runbook — the three stop points where the
pipeline waits for you, how to resume an interrupted build, and the troubleshooting table.

## 🎁 Bundled utility skills (optional)

| Skill | Superpower | Badge |
|---|---|---|
| 🦴 **caveman** | ~75% token-cut reply mode with auto-clarity for warnings | ![self-contained](https://img.shields.io/badge/self--contained-yes-brightgreen?style=flat-square) |
| 🕸️ **graphify** | repo → persistent queryable knowledge graph; cheap doc lookups | ![needs python pkg](https://img.shields.io/badge/needs-python_pkg-yellow?style=flat-square) |
| 🔎 **ledger-audit** | hunts unearned DONEs across boards, registry, trackers | ![self-contained](https://img.shields.io/badge/self--contained-yes-brightgreen?style=flat-square) |
| 🧪 **e2e-harness** | OpenAPI-driven breadth e2e with a drift gate — model works only on the delta | ![needs api contract](https://img.shields.io/badge/needs-API_contract-yellow?style=flat-square) |
| 🛰️ **repo-audit** | whole-repo sweep through the 3 auditor lenses + systemic-pattern synthesis | ![reuses kit personas](https://img.shields.io/badge/reuses-kit_personas-brightgreen?style=flat-square) |
| 📜 **adr** | house-format decision records; promote `DECISIONS.md` rulings to full ADRs | ![self-contained](https://img.shields.io/badge/self--contained-yes-brightgreen?style=flat-square) |

Details + pipeline wiring: [`skills-extra/README.md`](skills-extra/README.md).

## 🧬 Provenance

Extracted 2026-08 from a production platform where this pipeline built 15+ modules. Every rule
exists because its absence caused a real defect there; the war stories are kept (anonymized) in
[`DESIGN.md`](DESIGN.md) so future tuners know which rules are load-bearing.

> 📶 Badges and Mermaid diagrams render on GitHub/GitLab and most modern viewers; in an
> air-gapped viewer the badges degrade to alt-text and the diagrams remain as readable code.
