# {{PROJECT_NAME}} — Developer Guide: building with the pipeline

> **GENERATION TEMPLATE — do not install as-is.** The `setup-builder` skill (Phase 7) generates
> `DEVELOPER_GUIDE.md` at the repo root from this template: replace every `{{…}}` with values
> from the **filled** `PIPELINE_PROFILE.md` and the setup run itself; delete sections marked
> *(omit if N/A)* when they don't apply; delete this note block. The result must be readable by a
> developer who has never seen the kit — no placeholder may survive generation.

<p align="center">
  <img alt="pipeline" src="https://img.shields.io/badge/builds_via-builder_pipeline-blue?style=flat-square">
  <img alt="harness" src="https://img.shields.io/badge/harness-{{HARNESS_BADGE}}-8A2BE2?style=flat-square">
  <img alt="guide" src="https://img.shields.io/badge/generated-{{DATE}}-lightgrey?style=flat-square">
</p>

New modules and features in this repo are built through an orchestrated multi-agent pipeline:
planned, coded TDD-first, tested adversarially, audited in parallel (standards · security ·
vulnerability), documented, and gate-reviewed — with git-tracked ledgers so nothing is silently
lost. This guide is the 10-minute version for developers; deep dives: `builder/USAGE.md`
(operating), `builder/DESIGN.md` (why).

## 🚀 Start a build

1. Copy `specs/module-brief.template.md` → `specs/briefs/<key>.md` and fill it (the boundary
   decision, exact catalogue keys, and scope shape matter most).
2. In {{HARNESS_NAME}}, say:

   > Build the `<key>` module through the pipeline. Brief: `specs/briefs/<key>.md`.

   {{HARNESS_INVOCATION_NOTE}}

3. Watch `tasks/<key>.md` — the live board. The pipeline stops for you only at: deferred-work
   rulings (entry) · BLOCKERS (missing catalogue entry / boundary event / spec gap) · the final
   MERGE-READY handoff. **You** merge and tag; the pipeline never does.

## 🧭 This project's ground truth (from `PIPELINE_PROFILE.md`)

| What | Value here |
|---|---|
| Stack | {{STACK_SUMMARY}} |
| Module layout | {{MODULE_LAYOUT}} |
| Golden-path template | {{TEMPLATE_MODULE_OR_NOTE}} |
| Protected paths (never edit — boundary event) | {{PROTECTED_PATHS_LIST}} |
| Oracles (use verbatim, never invent) | {{ORACLES_TABLE_OR_LIST}} |
| Gate / test commands | {{COMMANDS_SUMMARY}} |
| Integration-tier note | {{INTEGRATION_NOTE}} |

## 📚 Where things live

| Artifact | Path | Notes |
|---|---|---|
| Module briefs | `specs/briefs/` | one per build, from the template |
| Task boards | `tasks/<key>.md` | git-tracked truth; rides the PR |
| Deferred work | `DEFERRED_TASKS.md` | the ONLY deferral home; swept at every build entry |
| Rulings log | `DECISIONS.md` | `D-n` rows; planners cite these instead of re-asking |
| Run artifacts | `.pipeline/<key>/{plan,review}.md` | gitignored audit trail |
| Kit docs & CLI | `builder/` | `node builder/cli.js <verify|check-ledgers|targets>` |

## ✅ Definition of done (what MERGE-READY means)

Gates green ({{GATE_COMMAND}}) · integration tier run explicitly ({{INTEGRATION_COMMAND}}) ·
readiness checklist clean · all four auditors + reviewer PASS · every invariant candidate covered
or deferred · the behavioural-gate result recorded · requirement-traceability table
all-aligned · task board fully closed (`DONE` with test evidence / `DROPPED` reasoned /
`DEFERRED→id`) · `node builder/cli.js check-ledgers` PASS · version bump + changelog entry on
the branch. Then a human reviews, merges, tags {{TAG_CONVENTION}}.

## 🛠️ Utility skills available *(omit rows not installed)*

| Say | Get |
|---|---|
| "caveman mode" | ~75% shorter agent replies (auto-clarity keeps warnings verbose) |
| "graphify query \"<question>\"" | architecture answers from the knowledge graph{{GRAPHIFY_STATE_NOTE}} |
| "ledger audit" | deep unearned-status sweep of boards/registry |
| "audit the repo" | whole-repo 3-lens audit → ranked report in `audits/` |
| "run the api e2e" | OpenAPI-driven breadth suite with drift gate{{E2E_STATE_NOTE}} |
| "write an ADR" | house-format decision record, cross-linked to `DECISIONS.md` |

## 🧯 When something's off

Fast checks: `node builder/cli.js verify` (install/profile) · `node builder/cli.js
check-ledgers` (board/registry drift) · then the troubleshooting table in `builder/USAGE.md`.
Two rules worth memorizing: an agent asking you to rule on a BLOCKER is the mechanism **working**
(never let it guess); and if the same blocker survives two fix loops, the spec/brief is wrong,
not the code.

## 🔧 Setup state of this repo *(filled at generation)*

- Harness targets installed: {{TOOLS_INSTALLED}}
- Guardrail hook: {{HOOK_STATE}} · Ledger gate in CI: {{CI_GATE_STATE}}
- Setup run: {{DATE}} · profile confirmed by: {{HUMAN_NAME}}
- Re-verify or upgrade any time: say *"re-verify the builder setup"* (the `setup-builder` skill).
