# Spec — pipeline-sizing: the pipeline picks its depth from the work, runs seats in the foreground, and never waits for a person who is not there

Module: pipeline-sizing
Status: ratified
Ratified-by: George (benchmark pilot-01 recommendation approved 18 November 2026, "proceed as recommended"; the spec text is ratified under the autonomy mandate of 16 November 2026; see Decision log)

> The kit's own spec for the three gaps the benchmark pilot found in the `build-module-pipeline` skill (project Library
> `benchmark/pilot-01/pilot-report.md` and `gaps.md`, 18 November 2026). It follows the installed spec template and the
> shape of `specs/repo-hygiene.spec.md`. It is maintainer-only and does not ship in the package.

## Intent

> "The `build-module-pipeline` skill does not decide how deep to go. Of 15 kit runs, 2 ran the full pipeline (8 and 14
> subagents, 4.7 and 8.0 USD, 21 and 30 minutes mostly spent waiting on timers, and ending in 'waiting for your
> waiver'), 5 ran one or two seats, 8 ran no seat at all. Same arm, costs from 0.17 to 8.03 USD." — pilot report,
> 18 November 2026, approved by George: "proceed as recommended".

## Scope

- In: a `SMALL` track in Phase 0.5 with a mechanical floor rule and an escalation rule · a foreground rule for every
  seat dispatch · an unattended mode (`Human: none`) that records human-only decisions instead of waiting · a phase
  checklist in every final report · `track-check`, a free script that measures a change against the `SMALL` limits
  from git · the brief template's `Human:` line.
- Out: the size of the skill text loaded per call (the second cost part in the pilot; deferred, registry row
  `DEF-SIZING-1`) · a §16 feature for the limits (the limits are fixed numbers in the skill; D135) · any change to
  the lite split (`liteSplit`), which is a split point, not a track · a change to the orchestrator batch skill.

### INVARIANTS

The checker treats these as non-negotiable (D45). Every requirement below holds inside them.

- Zero dependencies and Node 18. CommonJS logic in `scripts/lib/track-check.cjs`, an `.mjs` entry. `git` and Node
  built-ins only.
- The track is a floor, not a ceiling (pipeline skill, Phase 0.5, rule 2). `SMALL` sits below `FIX` and above
  `SOLO`. A run escalates up, never down. A production-source diff still never goes `SOLO`.
- No seat is ever dispatched to be polled. A dispatch returns, or the run records a seat failure. The orchestrator
  never sets a timer, a wake-up or a sleep to wait for a seat.
- Absent evidence is never a pass: a phase the track skips is named as skipped, with the track as the reason, in
  the report and in `state.md`.
- A human-only decision is never invented. In unattended mode it is recorded with the assumption taken, and the run
  ends with a verdict that names it; the decision stays open for a person.
- A spec change after ratification is an amendment row in this file (D45). Amendments AM-1 to AM-3 of
  `specs/pipeline-cost.spec.md` (19 November 2026) scope the SOLO invariant and the REQ-2003 escalation target to the
  state of `features.soloTrack` and `features.mediumTrack`, and move the REQ-2007 header into `templates/module-report.md`.

## Actors

| Actor | Source |
|---|---|
| the orchestrator (the session that runs the skill) | skills/build-module-pipeline.md |
| a person who writes the brief and reads the report | templates/module-brief.md |
| an unattended run (a benchmark cell, a batch lane with nobody watching) | benchmark pilot-01; skills/orchestrator.md |
| `module-builder` | agents/ |

## Requirements

Kind: `behaviour` (what succeeds) · `refusal` (what is refused, and why) · `effect` (what a success leaves behind) ·
`constraint` (always true). Source: `intent`, a decision id, or an open-question id.

| Id | Requirement | Actor | Kind | Source |
|---|---|---|---|---|
| REQ-2001 | Phase 0.5 has a `SMALL` track. A change takes it when every limit holds: at most 4 production source files change, all inside one module directory, no new public operation, table, permission key or dependency, and no protected path. | the orchestrator | behaviour | intent, D134 |
| REQ-2002 | `SMALL` runs Phase 2 as one `module-builder` dispatch with TDD, then the orchestrator itself runs `commands.typecheck` and every `commands.tiers` tier and quotes their result lines. No planner, tester, auditor, docs or reviewer seat is dispatched, no board and no handoff pack is written, and the report names each skipped phase with `SMALL` as the reason. | the orchestrator | behaviour | intent, D134 |
| REQ-2003 | When a `SMALL` run's builder return, or `track-check --since BASE`, shows a limit broken, the run escalates to `ADDITIVE` (or higher) and continues from Phase 1 with the builder's diff as context. It never finishes as `SMALL` with a broken limit. | the orchestrator | refusal | intent, D134 |
| REQ-2004 | Every seat dispatch is a foreground call: the orchestrator waits for the return in the same step. Concurrent seats are one message with several dispatches that all return before the next step. The orchestrator never schedules a timer, a wake-up or a sleep to wait for a seat. | the orchestrator | constraint | intent, D136 |
| REQ-2005 | A brief may carry `Human: none`. A run that reads it, or that runs in a non-interactive session, is unattended: every human-only decision (a gate waiver, a `NEEDS-RULING`, a `GRANT-ASK`, a `BLOCKING` triage) is recorded in `state.md` and the report under `Needs a human`, with the assumption the run took, and the run ends with its verdict. It never ends in a wait for a reply. | an unattended run | behaviour | intent, D137 |
| REQ-2006 | In unattended mode a recorded behavioural-gate skip stays `CHANGES-REQUIRED` in the reviewer's verdict; the report says so and names the waiver as the open item. The verdict is never upgraded by the absence of a person. | an unattended run | refusal | D137 |
| REQ-2007 | Every final report of the skill opens with `Track: TRACK — REASON` and a `Phases:` line that names each phase of the table as run or skipped, with the reason for a skip. | the orchestrator | effect | intent, D138 |
| REQ-2008 | `track-check --since BASE [--max-files 4] [--src DIRS] [--json]` counts the production source files and module directories changed since the base commit `BASE` from git, ignores test, doc, board and ledger files, and prints `SMALL` with the counts when every limit holds, or `ESCALATE: REASON` (the broken limit) when one does not. Exit 0 within the limits, 1 on a broken limit, 2 outside a git repository or on a bad argument. | the orchestrator | behaviour | intent, D134 |
| REQ-2009 | `track-check` never reads the profile's optional features and has no `not configured` state: it is a free check with no §16 key, like `board-check-all`. | the orchestrator | constraint | D135 |
| REQ-2010 | The brief template carries a `Human:` line (`available` or `none`) and a `Size hint:` line, and the skill reads both at Phase 0.5. | a person who writes the brief | effect | intent |

## Acceptance criteria

| Id | Req | Verb | Given | When | Then |
|---|---|---|---|---|---|
| AC-2001 | REQ-2001 | assert | the skill text | read at Phase 0.5 | the track table has a `SMALL` row naming the five limits (4 files, one module, no new operation/table/permission, no new dependency, no protected path) |
| AC-2002 | REQ-2002 | assert | a `SMALL` run | it finishes | the report's `Phases:` line marks P1, P3, P4, P5, P6 and P6.5 `skipped (SMALL)` and quotes the typecheck and tier result lines |
| AC-2003 | REQ-2003 | assert | a `SMALL` run whose builder changed 5 source files | `track-check --since BASE` runs | it prints `ESCALATE: 5 source files changed, limit 4` and exits 1, and the skill text says the run continues from Phase 1 as `ADDITIVE` |
| AC-2004 | REQ-2004 | assert | the skill text | read | it states the foreground rule and forbids a timer, wake-up or sleep to wait for a seat; the four-auditor dispatch says all four return before Phase 5 |
| AC-2005 | REQ-2005 | assert | a brief with `Human: none` and a reviewer verdict of `CHANGES-REQUIRED` for a skipped gate | the run ends | the report has a `Needs a human` section listing the waiver, and the run has ended (no question to the human is the last message) |
| AC-2006 | REQ-2006 | assert | unattended mode | the gate was skipped | the verdict stays `CHANGES-REQUIRED` |
| AC-2007 | REQ-2007 | assert | any run | the report is written | its first two lines are `Track: …` and `Phases: …` |
| AC-2008a | REQ-2008 | assert | a git repository where 2 files under `src/report/` changed since the base commit `BASE` plus one test file | `track-check --since BASE` | prints `SMALL: 2 source files in 1 module` and exits 0 |
| AC-2008b | REQ-2008 | assert | 5 source files changed | `track-check --since BASE` | prints `ESCALATE: 5 source files changed, limit 4`, exit 1 |
| AC-2008c | REQ-2008 | assert | 2 files in `src/api/` and 1 in `src/jobs/` | `track-check --since BASE` | prints `ESCALATE: 2 modules touched (api, jobs), limit 1`, exit 1 |
| AC-2008d | REQ-2008 | assert | `package.json` changed with a new dependency | `track-check --since BASE` | prints `ESCALATE: dependency change in package.json`, exit 1 |
| AC-2008e | REQ-2008 | assert | not a git repository | `track-check --since x` | exit 2 with a message |
| AC-2008f | REQ-2008 | assert | `--json` | any case | one JSON object with `track`, `files`, `modules`, `reasons` |
| AC-2009 | REQ-2009 | assert | the `FEATURES` table | read | holds no key for track-check, and the script's source does not load `profile.feature` |
| AC-2010 | REQ-2010 | assert | `templates/module-brief.md` | read | contains a `Human:` line with the two values and a `Size hint:` line |

## API contract

No API contract — the module is a skill text, a template and one command-line script.

## Oracle amendments

| Oracle | Entry | Why | Decision |
|---|---|---|---|
| ORACLE.md | none | the module adds no decision rule that an oracle must apply | dropped — no oracle entry is needed |

## Open questions

| Id | Question | Blocks | Answer |
|---|---|---|---|
| Q-1 | Should the `SMALL` limits be §16 keys? | REQ-2001 | No (D135): fixed numbers in the skill text, revisited when a batch measures them; a key per number is configuration nobody has evidence for yet. Answered 18 November 2026 under the autonomy mandate. |

## Decision log

| Id | Decision | Why |
|---|---|---|
| D134 | A `SMALL` track below `FIX`: one builder dispatch, the orchestrator runs typecheck and the tiers itself, no board, no pack; escalation up when a limit breaks. | Pilot-01: 8 of 15 kit runs ran no seat and 2 ran 8 to 14 seats for changes of 2 to 6 files; the skill offered no sanctioned small path, so the orchestrator improvised one each time. |
| D135 | The limits are fixed numbers in the skill, not a §16 feature; `track-check` is a free check with no feature key. | Rule 11 would make a new feature default off, which would leave the gap open by default; a free check has no off state. |
| D136 | Seats run in the foreground; no timer, wake-up or sleep waits for a seat. | Pilot-01 E-T2-s3 and E-T3-s1 spent most of 21 and 30 minutes in 20, 5, 4 and 2 minute wake-ups while background seats had already finished. |
| D137 | `Human: none` makes a run unattended: human-only decisions are recorded with the assumption taken and the run ends with its verdict. The verdict is never upgraded. | Pilot-01 full-pipeline runs ended "waiting on you for a waiver"; in a benchmark or a batch lane nobody answers, and a wait is an unmeasured run. |
| D138 | Every report opens with the track and a phase checklist. | Pilot-01: which phases ran could only be reconstructed from the transcript; a skipped phase must be explicit, never inferred. |
