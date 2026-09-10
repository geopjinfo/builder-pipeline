# skills-extra — utility skills bundled with the kit

> **One of these is no longer optional.** Pipeline phase **6.5** runs the behavioural gate, phase
> **3b** reads its drift oracles and phase **1** writes its module digest — so `qa-audit` is now
> load-bearing wherever the application can be containerised. If it is absent or profile §14 is
> unfilled, those phases degrade to a **recorded skip**, which the reviewer treats as
> CHANGES-REQUIRED until a human waives it. Absent evidence is never a pass.

Installed by `cli.js` alongside the pipeline (skip with `--no-extras`). Each is independent of
the pipeline — useful on its own, more useful together.

| Skill | What it does | Portability notes |
|---|---|---|
| 🦴 **caveman** | Ultra-compressed reply mode (~75% token cut) with intensity levels and auto-clarity overrides for security/irreversible warnings. Great default for long agent sessions. | Fully self-contained prompt skill; works in any harness. In Claude Code you can auto-arm it per repo with a small `SessionStart` hook that injects "caveman active" context. |
| 🕸️ **graphify** | Turns the repo (code + docs + papers) into a persistent, queryable knowledge graph (`graphify-out/`) with community detection; `graphify query "<question>"` answers architecture questions from the graph instead of re-reading big docs. Makes the personas' "scoped retrieval" rule dramatically cheaper. | Requires the external `graphify` Python package (the skill's Step 1 installs it via uv/pipx). This copy is the Windows/PowerShell variant — adjust shell snippets on other platforms; its own reference docs mention Claude-Code-specific wiring, but the core `graphify` commands are plain CLI and work from any agent. Not air-gap friendly unless the package is pre-installed. |
| 🔎 **ledger-audit** | Read-only audit of the claim ledgers (task boards, deferred registry, trackers) for **unearned status** — DONEs whose evidence proves something adjacent, missing positive controls, partial acceptance coverage, cross-ledger drift. The deep, judgment-based complement to the mechanical `cli.js check-ledgers` gates. | Fully self-contained prompt skill; works in any harness. |
| 🧪 **e2e-harness** | Build + operate an OpenAPI-driven full-API e2e suite: contract-as-oracle scenario packs, per-operation **drift gate** so the model only regenerates the delta, real-infra runs, deterministic report. Breadth insurance on top of the pipeline's per-module depth tests. | Pattern skill (guides the build in *your* stack). Hard requirement: an OpenAPI/API contract **generated from code** — adopting one is a human decision if absent. |
| 🛡️ **qa-audit** | The REAL app on real infrastructure, nothing stubbed. Two halves: **declaration-derived** — requirement packs asserting what the business asked AND what it forbade, a side-effect inventory extracted from code (a *second* drift oracle catching what a contract hash cannot), adversarial probes, a redacted call transcript — and **invariant-derived**, which is the layer that finds what a declaration-derived suite structurally CANNOT: global transcript invariants, reflexive/system-safety cases, a hostile-input battery, per-module semantic digests, an adversarial story taxonomy, and a seeded monkey walk. | Pattern skill (guides the build in *your* stack). Needs a containerisable app + a machine-readable requirement source. Builds ON `e2e-harness` — same scenarios, second transport. Two universal rules: a shared environment must be enforced read-only **in code**, and the auditor OBSERVES unruled cases rather than inventing expectations for them. |
| 🛰️ **repo-audit** | Whole-repo read-only sweep: gate baseline → every module through the kit's three auditor lenses → verify-before-accept → dedup + **systemic-pattern** extraction → one ranked report in `audits/`. Catches the cross-module drift no single build gate can see. | Reuses the kit's own auditor personas — nothing extra to install. Parallel fan-out on Claude Code; sequential fresh sessions elsewhere. |
| 🧭 **status-and-next** | Session-start planning pass: re-verify repo + tracker + deferred-registry state from scratch (trust nothing cached), report deltas and owed status flips, then emit the single next unblocked item as a full pipeline brief per the module-brief template. Read-only except the report; flags-never-acts on irreversible items (merges, tags, releases). | Fully self-contained prompt skill; reads `PIPELINE_PROFILE.md` §11 (ledgers) / §2 (gates) / §5 (fences) when present. |
| 📜 **adr** | House-format Architecture Decision Records: when to promote a `DECISIONS.md` ruling into a full ADR, the template, sequential numbering, Accepted-is-immutable + supersede flow, index cross-linking. | Fully self-contained prompt skill; respects protected doc dirs via the run's handoff pack. |

## Wiring into the pipeline

- **graphify:** after installing, run `/graphify` once on the repo, then add to
  `PIPELINE_PROFILE.md` §1/§3: *"Doc/architecture lookups: query the graphify graph first."*
  Keep it fresh with `hooks/graphify-post-merge.sh` (see `hooks/README.md`).
- **ledger-audit / check-ledgers:** `cli.js check-ledgers` is the cheap mechanical gate (CI,
  every merge); the `ledger-audit` skill is the deep pass (per-module at close-out, repo-wide on
  a schedule).
- **e2e-harness:** build it once the API contract exists (a pipeline-sized task); then wire
  `test:e2e` + `test:e2e:drift` into profile §2 and treat drift failures as merge blockers.
- **qa-audit:** fill `PIPELINE_PROFILE.md` §14 at setup (requirement source, effect sources,
  environments, redaction fields, **conventions** and **disposable actors**) and start from
  `templates/qa-targets.md` + `templates/requirement-pack.md`. Run `cli.js check-targets` in CI — a
  shared datastore must be read-only and that cannot rest on prose. Build it AFTER `e2e-harness` — it
  reuses those scenarios through a second transport, so building it first means writing the suite twice.
  Wire `qa:run` into profile §2 as a release gate (not a per-commit one; it stands up infrastructure).
  Its effect-drift oracle belongs in the normal gate chain, where it is cheap.
  **Phase C is separately stageable and worth doing in order:** global transcript invariants first
  (deterministic, free, and it closes the whole "crashed instead of refusing" class at once), then the
  invariant registry (`templates/invariant-registry.md`), then the hostile-input battery, then digests
  → stories (`templates/module-digest.md`, `templates/story-pack.md`), and the seeded monkey last.
  Digest staleness belongs in the gate chain beside the two drift oracles. The coverage list it
  produces —
- **repo-audit:** run after every 3–5 modules or quarterly; systemic findings feed template/
  profile §7 fixes (one root-cause fix, not N patches) — rule them in `DECISIONS.md`, record the
  big ones with the `adr` skill.
- **adr:** the run's handoff pack (§E docs) is where a build's "warranted ADR" surfaces —
  write it with this skill before the merge so record and code land together.
- **status-and-next:** the front door to every pipeline run — run it at session start, take its
  brief, hand that to `build-module-pipeline`. Its step-1 verification is also the cheap standing
  defence against building from a stale summary after context compaction.
- **caveman:** purely ergonomic; no pipeline coupling.
