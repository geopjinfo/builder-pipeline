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
into the profile or an overlay (below), where upgrades cannot reach it.

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

## 🧩 Extending

- **The profile.** `PIPELINE_PROFILE.md` is the one file that makes the kit concrete: project facts in §1–§15, and in
  §16 one `pipeline-settings` JSON block — commands (`commands.tier`, `typecheck`, …), paths (`paths.boards`,
  `registry`, `decisions`, …), model tiers, protected globs and every optional feature on or off. Every persona and
  every script reads it; nothing in the kit assumes a stack, a test runner or a folder layout of its own.
- **Overlays.** Keep a project's own version of a kit skill or persona instead of editing the kit's: record `keep`
  (yours only) or `both` (yours, plus the kit's as `builder-<name>`) with `npx builder choices set <kind>:<name>
  <keep|kit|both> --by <you>`. Upgrades honour it.
- **Local hooks and gates.** Your hooks stay yours; the kit's are copied, never armed (the settings blocks are in
  `adapters/<tool>.md`). Wire `npx builder check-ledgers` (and `check-targets` with qa-audit) into CI beside your own
  gates; an optional check the project cannot run prints `<feature>: not configured`, never a pass.

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

## 🛠️ Working on the kit itself

For maintainers of this repository, not for projects that install it:

1. Clone it — `git clone https://github.com/geopjinfo/builder-pipeline.git`; Node 18+ and Git are all it needs
   (no `npm install`: zero dependencies).
2. Work on a branch, never on `main`.
3. Keep the suite green from the repo root: `node tests/run.mjs`.
4. Release: bump `package.json` `version`, rename `## [Unreleased]` in `CHANGELOG.md` to `## [X.Y.Z] — YYYY-MM-DD`
   (the suite fails if the two differ), merge into `main`, tag `vX.Y.Z` (annotated) and push `main` with the tag.
   Projects pick it up by bumping their dependency to the new tag and running `npx builder upgrade` + `verify`.

The full routine, with what to check at each step, is in [`RELEASING.md`](RELEASING.md) (kept in the repo, not
shipped in the package).

## 📁 Copying the kit as a folder (secondary)

Without npm, a release archive of the kit can be extracted at the project root as a `builder/` folder, and the
commands run as `node builder/cli.js <command>` — the folder layout (`builder/` folder) form of `npx builder`. That path, and how to receive
a release archive safely, is in [`UNPACK.md`](UNPACK.md); the package install above is the primary path.

---

# How it works

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
        P7["7️⃣ Close-out + handoff pack<br/><i>orchestrator</i>"]
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
| 🎼 **One orchestrator, nine personas** | The main agent never writes module code. It dispatches one fresh, role-scoped subagent per phase, threads *distilled artifacts* between them, and owns the gate-fail loop. One run = one branch, one board, one version bump — and one session. |
| 📄 **All specifics in one file** | Every persona loads `PIPELINE_PROFILE.md`. Personas define *how a phase behaves*; the profile defines *what is true in this project*, and its §16 holds the machine-readable settings every script reads. Port the kit by rewriting one file, not nine. |
| 📚 **Ledgers beat memory** | Git-tracked task board per module (the one progress surface), cross-module deferred registry, written plan + review per run, one handoff pack at close-out. Agents are stateless; the files are the truth. |
| 🖥️ **A run you can watch** | The board renders to one offline HTML page — step timeline, files produced, per-seat model / time / tokens / cost from the harness's own records. A watcher keeps it current; a row flip alone moves it. Unmeasured cells are em-dashes, never zeroes. |
| ⚔️ **Adversarial gates** | Tester extends (never rewrites) the coder's tests; four parallel auditors with different lenses — the fourth asking whether the system is still *coherent* afterwards, which no other seat and no test tier asks; the reviewer re-verifies every finding at its cited `file:line`. |
| 🧾 **Records checked by scripts** | Counts, citations, plan / findings / review shapes and the handoff pack are checked by scripts at the phase that writes them — before a reviewer spends judgement on them. |
| 🔎 **Every check declared** | An optional check the project cannot run prints `<feature>: not configured`. It never passes silently, and a half-configured feature fails validation. |
| ✅ **Every DONE is earned** | Close-out re-opens each row's evidence and checks the assertion *entails* the claim — the three fake-done shapes are hunted by name ([`DESIGN.md`](DESIGN.md) §11). |

## 👥 The nine personas

Each persona declares a **tier**, not a model; `PIPELINE_PROFILE.md` maps `strong` / `mid` to your harness's models.

| Phase | Persona | Tier | Writes | Job |
|---|---|---|---|---|
| 1 | `module-planner` | strong | plan only | Requirements → cited build plan + task board + blocker list |
| 2 | `module-builder` | strong | source + tests | TDD per board row: seeded failing test → red → green → refactor |
| 3 | `module-tester` | strong | tests only | Coverage gaps, real-datastore integration, permission matrix, forced-failure rollback |
| 4 | `standards-auditor` | strong | — | Boundaries, layering, contracts, naming |
| 4 | `security-auditor` | strong | — | AuthZ, scope, secrets/PII, input hardening |
| 4 | `vuln-auditor` | mid | — | Injection, double-apply, unbounded queries, I/O inside transactions |
| 4 | `invariant-auditor` | strong | — | Is the system still *coherent* after the call succeeded? |
| 5 | `docs-maintainer` | mid | docs only | API contract, module README, user docs |
| 6 | `module-reviewer` | strong | review only | Re-verifies every finding at its `file:line`; MERGE-READY or CHANGES-REQUIRED |

Auditors are read-only. A seat that finds a source defect reports it — only the coder fixes, via a `FIX-n` row.

## 🧭 Pick the rigour: tracks

Not every job is a module build. The track is chosen with the brief and confirmed by the planner.

| Track | Use for | Phases run |
|---|---|---|
| **FULL** | a new module / feature cluster | all — digest authored at P1 |
| **ADDITIVE** | a new field or operation on an existing module | all — digest refreshed; all four auditors kept |
| **PLATFORM** | shared / foundation code | all + named human authorization; standards auditor is primary; wiring check mandatory |
| **FIX** | a *verified* blocker list | all except the planner (the blocker list is the plan) |
| **RULINGS** | decision / doc-authority work | 0.5 → 1 → 7 — no coder, no tester |
| **SOLO** | ledger / docs / test-only | no pipeline, but declared — **never** for a production-source diff |

```mermaid
flowchart LR
    SOLO["SOLO"] -->|"needs a source change"| FIX["FIX"]
    FIX -->|"must decide what to build"| ADD["ADDITIVE"]
    ADD -->|"new bounded context"| FULL["FULL"]
```

**The track is a floor, not a ceiling:** a run may escalate up mid-flight, never down (recorded as a board row).
Work that belongs to another module or track becomes a `SPLIT` finding — a deferred-registry row plus a proposed
separate run. The pipeline never starts another pipeline.

## ✂️ Lite split (experimental, `features.liteSplit`)

For throughput, the pipeline can be cut in two: build now, gate later in a batch.

```mermaid
flowchart LR
    subgraph LITE["build-module-lite (per module)"]
        L1["Plan"] --> L2["Code TDD"] --> L3["Test"] --> L4["free checks"]
    end
    L4 --> Q[("gate queue<br/>BUILT-UNGATED")]
    Q -->|"trigger reached, up to cap"| G1
    subgraph GB["build-module-lite-gate-batch (up to 4 modules)"]
        G1["batch-wide drift / gates / integration"] --> G2["per module: 4 auditors → docs → review"]
        G2 --> G3["behavioural gate"] --> G4["version + handoff → GATED"]
    end
    G2 -.->|findings| FIXL(("FIX-n")) -.-> G2
```

Each module ends exactly where a full run would have left it. **Nothing merges until `GATED`.**

## 🎛️ Batch orchestrator (opt-in, `features.orchestrator`)

Above the module pipeline sits `orch` — a commander that runs a **whole plan** in parallel lanes. The orchestrator
session only routes and records; it never reads code. Fixed steps live in `scripts/orch.mjs`, judgement in the
`orchestrator` skill. State is a file, so a killed session resumes from `orch status`.

```mermaid
flowchart TD
    A["📄 Any plan artifact<br/>(markdown / HTML / board)"] --> D["orch digest<br/>rows · inferred cells = ⚠ CONFIRM"]
    D --> C{"every CONFIRM<br/>resolved from docs?"}
    C -- no --> R["search docs → decide + record<br/>ask the human only if undefined"] --> C
    C -- yes --> P["orch preflight<br/>parallel or single mode"]
    P --> S["orch split<br/>disjoint lanes · level per row"]
    S --> H{"🧑‍💼 human<br/>approves the split?"}
    H -- OK --> L["claim → worktree → brief → launch<br/>(placed by the usage guard)"]
    L --> W["orch watch<br/>DONE / stall notice — no polling"]
    W --> G["READY → gates · integration · e2e<br/>· behavioural gate"]
    G --> M["orch merge<br/>one lane at a time into target"]
    M --> REC["decision log · board · state.json"]
```

**Levels are set by rule and logged per row** — the orchestrator may raise one, never lower it:

```mermaid
flowchart LR
    ROW["plan row"] --> Q1{"risk flag?<br/>money · workflow · migration<br/>platform · permission · cross-module"}
    Q1 -- yes --> FULLL["🔴 Full<br/>full pipeline"]
    Q1 -- no --> Q2{"record-only,<br/>no production source?"}
    Q2 -- yes --> MICRO["⚪ Micro<br/>SOLO"]
    Q2 -- no --> STD["🟡 Standard<br/>full or lite pipeline<br/>(standardPipeline)"]
```

Lanes never share a file (`orch claim` refuses overlap); each lane gets its own git worktree and branch. The lane
count starts at `maxLanes` and rises only with measured evidence that the machine and accounts carried the load.
Controls: `orch status` · `next` · `preflight` · `pause` · `stop` · `resume`.

### 🛰️ Progress, restarts and artifacts

The orchestrator is built to be killed. Its memory is **files in the repo**, never the conversation and never a
published page.

```mermaid
flowchart LR
    IN["📄 plan artifact<br/>(markdown / HTML page)"] -->|"orch digest — input only"| PLAN["plan.md"]
    PLAN --> STATE[("state.json + events.jsonl<br/>runs/&lt;run&gt;/")]
    STATE -->|"orch status → next: lines"| ORCH["orchestrator session<br/>(fresh or restarted)"]
    ORCH -->|"every launch, merge, decision"| STATE
    BOARD["task board per module"] -->|"page-keeper (experimental livePage)"| PAGE["🖥️ live progress page"]
    PAGE -.->|"never read back"| X["✗"]
```

| What | Role | Survives a restart? |
|---|---|---|
| Plan artifact | **Input.** `orch digest` turns any markdown/HTML plan into rows | it is the source, not state |
| `state.json` + `events.jsonl` | **The run's state.** Lanes, levels, claims, approvals, launches, merges | yes — the first action of every session is `orch status`; it acts only on the `next:` lines |
| Task board + decision log | Per-module progress and every decision, git-tracked | yes |
| Live progress page (`features.livePage`, experimental) | A **one-way projection** of a module board for people to watch (per-seat model, time, tokens, cost) | rebuilt from the board; nothing reads state from it |

A restarted session re-arms a watcher for each lane still `LAUNCHED` and carries on. It never rebuilds a run from
scrollback, and it never reads state from a published page: the page can be stale, the files cannot.

### 👥 Multi-account seats

Work runs on **seats**: the primary account (where the orchestrator session lives), an optional secondary account
(terminal workers), and an optional API-credit lane. Usage is read fresh before every launch.

```mermaid
flowchart TD
    J["lane or job to place"] --> CR{"credit-eligible job<br/>and credit.enabled?"}
    CR -- yes --> CL["💳 credit lane<br/>headless, API key"]
    CR -- no --> SEC{"secondary under<br/>its limit (80%)?"}
    SEC -- yes --> SW["🖥️ secondary seat<br/>terminal worker"]
    SEC -- no --> PRI{"primary under<br/>its limit (60%)?"}
    PRI -- yes --> PW["🏠 primary seat<br/>sub-agent or own session"]
    PRI -- no --> HOLD["⛔ USAGE-HOLD<br/>launch nothing, tell the human"]
```

| Seat | Runs | Never runs |
|---|---|---|
| **Primary** (orchestrator account) | the orchestrator; SOLO lanes as sub-agents; pipeline lanes in their own session; the test slot and every merge | — |
| **Secondary** | lane workers in their own worktree (plan → build → test) | merges |
| **Credit lane** | bounded jobs: `code-reading`, `record-fixes`, `docs`, `sweeps`, the tester and the four auditor seats | building, planning, reviewing, orchestrating |

The primary limit sits below the secondary's because the orchestrator session itself runs there. Limits are
`features.orchestrator.limits`. The plan accounts never receive the API key.

### 💳 Credit lane (only with `credit.enabled`)

```mermaid
flowchart LR
    PREP["orch credit-prep<br/>kind · scope · model floor"] --> RUN["orch credit-run<br/>(shell holding the key)"]
    RUN --> OK{"result"}
    OK -- "PASS, no file changes" --> DONE["✅ done"]
    OK -- "PASS, files changed" --> REV["⏸ REVIEW PENDING<br/>orch credit-review"] --> DONE
    OK -- "account fault<br/>cap · credit out · API error · 429" --> FB["↪ fallback<br/>secondary → primary"]
    OK -- "job fault<br/>scope · denied · no PASS" --> FIXB["✋ no fallback<br/>fix the brief"]
```

- **Meter + caps:** `orch credit` shows the period, spend across every worktree, what is left and the pace needed;
  `dailyCapUsd` stops one bad day spending the period. Running jobs reserve their budget under a machine-wide lock.
- **Lapsing budget:** `CREDIT-FILL` says how far behind pace spend is and names light jobs to queue.
- **Quality floors:** each job kind refuses a model below its floor (`models.strong` / `models.mid`); every prompt
  carries the evidence rules and must end `RESULT: PASS`.
- **Review hold fails closed:** `orch merge` refuses a lane while a credit job that changed its files is unreviewed.
- **Auditors on credit:** a lane parked at `WAIT-P4` gets its four auditors via `orch credit-audit`; if the credit
  lane is busy, the lane self-audits instead of waiting.

## 📚 Where the truth lives

```mermaid
flowchart LR
    PROF["PIPELINE_PROFILE.md<br/>project facts + §16 settings"] --> SEATS["every persona<br/>and every script"]
    SEATS --> BOARD["task board per module"]
    SEATS --> REG["deferred registry"]
    SEATS --> DEC["decision log"]
    BOARD --> PAGE["live HTML run page"]
    BOARD --> PACK["handoff pack at close-out"]
    REG --> PACK
    DEC --> PACK
```

Every build checks the deferred registry on entry (did I unblock a row?) and updates it on exit.

## 📦 What's in the box

```
builder-pipeline/   (the package; a folder copy is builder/)
├── 📖 README.md                  ← you are here
├── 🧠 DESIGN.md                  ← WHY it works — 22 principles + failure lessons
├── 🧪 EXPERIMENTS.md             ← unproven items and the measurement that decides each
├── ⚡ SETUP_PROMPT.md            ← the one setup prompt (bootstrap, then the builder-init skill)
├── 🔧 UNPACK.md                  ← the folder-copy install path (secondary)
├── 🕹️ USAGE.md                   ← HOW to operate — stop points, record points, troubleshooting
├── 🔍 DISCOVERY.md               ← agent prompt: fill the profile (§1–§16) from the TARGET project
├── ⚙️ cli.js                     ← zero-dep Node CLI: bootstrap · inventory · choices · unpack ·
│                                    upgrade · verify · features · doctor · check-ledgers ·
│                                    check-targets · personas-check · run · targets
├── 🧩 cli/                       ← the setup commands' modules (inventory · bootstrap · doctor)
├── 📄 PIPELINE_PROFILE.template.md ← the ONE per-project file; §16 = pipeline settings (JSON)
├── 🤖 agents/                    ← 9 generic personas + experimental/ (page-keeper)
├── 📜 skills/                    ← recipes (pipeline · lite split · scaffold · readiness-check ·
│                                    setup) + the batch orchestrator above them (opt-in)
│                                    + references/ (index query block, review template)
├── 🧾 templates/                 ← ledger formats (module brief · task board · session board ·
│                                    deferred registry · decision log · developer-guide generator ·
│                                    orchestrator plan + worker brief)
├── 🎁 skills-extra/              ← optional utilities: caveman · graphify · ledger-audit ·
│                                    e2e-harness · qa-audit · repo-audit · adr
├── 🛡️ hooks/                     ← universal guards + claude-code/ (output cap · registry read
│                                    guard · reviewer write guard) — copied, never armed
├── 🔌 adapters/                  ← harness notes (claude-code · codex · generic), incl. what each
│                                    Claude-Code-only step becomes elsewhere
├── 🛟 scripts/                   ← board tooling (progress · check-all · render · watch) and the
│                                    checkers: features · index-check · orchestrator-check ·
│                                    claims-check · citations-check · line-citations-check ·
│                                    output-check · handoff-pack / handoff-check · ledger-row ·
│                                    decision-index · wiring-check · instruction-budget ·
│                                    ratchet-refresh · fix-rate · seat-peaks · cost-window ·
│                                    contract-oracle · rules-module · mutation-step · orch (batch
│                                    orchestrator: lanes, seats, merge queue, credit lane) + lib/
├── 🔮 oracles/                   ← contract-oracle adapters (OpenAPI 3)
├── 📐 examples/                  ← ast-grep rules with fixtures · wiring/ (seam kinds for a
│                                    TypeScript DI service) · jest-tier-runner/ (one tier runner for
│                                    a JS project, + its instruction-trailer CI entry) — examples,
│                                    not defaults
├── 🧰 tooling/                   ← PORTING.md (the run economy) · optional/ (index sync with lock,
│                                    limit and session hook; caveman) · experimental/ (live page
│                                    shell · graph-trial report · persona generator)
├── ✅ tests/                     ← the kit's own suite (node tests/run.mjs in the kit repo; not shipped)
└── 🗒️ CHANGELOG.md               ← kit version history
```

## 🎁 Bundled utility skills (optional)

| Skill | Superpower | Badge |
|---|---|---|
| 🦴 **caveman** | ~75% token-cut reply mode with auto-clarity for warnings | ![self-contained](https://img.shields.io/badge/self--contained-yes-brightgreen?style=flat-square) |
| 🕸️ **graphify** | repo → persistent queryable knowledge graph; cheap doc lookups | ![needs python pkg](https://img.shields.io/badge/needs-python_pkg-yellow?style=flat-square) |
| 🔎 **ledger-audit** | hunts unearned DONEs across boards, registry, trackers | ![self-contained](https://img.shields.io/badge/self--contained-yes-brightgreen?style=flat-square) |
| 🧪 **e2e-harness** | OpenAPI-driven breadth e2e with a drift gate — model works only on the delta | ![needs api contract](https://img.shields.io/badge/needs-API_contract-yellow?style=flat-square) |
| 🛰️ **repo-audit** | whole-repo sweep through the auditor lenses + systemic-pattern synthesis | ![reuses kit personas](https://img.shields.io/badge/reuses-kit_personas-brightgreen?style=flat-square) |
| 📜 **adr** | house-format decision records; promote `DECISIONS.md` rulings to full ADRs | ![self-contained](https://img.shields.io/badge/self--contained-yes-brightgreen?style=flat-square) |

Details + pipeline wiring: [`skills-extra/README.md`](skills-extra/README.md).

## 🧬 Provenance

Extracted 2026-08 from a production platform where this pipeline built 15+ modules, and uplifted
2026-09 with true accounting, record checkers, fixed output shapes, declared optional features and
labelled experiments. Every rule exists because its absence caused a real defect there; the war
stories are kept (anonymized) in [`DESIGN.md`](DESIGN.md) so future tuners know which rules are
load-bearing.

> 📶 Nothing the pack requires needs the internet. Badges and Mermaid diagrams are optional
> renderings: in an offline viewer the badges degrade to alt-text and the diagrams remain as
> readable code.
