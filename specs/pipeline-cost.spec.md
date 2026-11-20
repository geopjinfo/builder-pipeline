# Spec — pipeline-cost: a MEDIUM track, a SOLO path and a report template cut the cost of one-module changes

Module: pipeline-cost
Status: ratified
Ratified-by: George (decision card of 19 November 2026, "No claim; fix gaps, harder bed"; the spec text is ratified under the autonomy mandate of 16 November 2026; see Decision log)

> The kit's own spec for the three cost gaps the full benchmark found (`EXPERIMENTS.md` §25, G1 to G3; Library
> `benchmark/full-01/`, 19 November 2026). It extends `specs/pipeline-sizing.spec.md` (REQ-2001 to REQ-2010). It is
> maintainer-only and does not ship in the package.

## Intent

> "16 of 75 kit runs escalated to ADDITIVE at 4.94 USD each, ten times a SMALL run, with no gain in solved cells. The
> triggers were a migration, a new table, a new CLI report kind, a fifth file. A SMALL run itself costs 3 to 5 times a
> bare run on a one-line change; the seat is the cost. 3 of 75 reports had no `Track:` line." — EXPERIMENTS §25,
> 19 November 2026. George: no accuracy claim; fix the gaps experimental-off and measure them.

## Scope

- In: a `MEDIUM` track between `SMALL` and `ADDITIVE` behind `features.mediumTrack` (G1) · a `SOLO` path for a
  production-source change the orchestrator makes itself behind `features.soloTrack` (G2) · a report template with the
  `Track:` and `Phases:` lines fixed in it (G3) · the `--medium` and `--solo` readings of `track-check`.
- Out: a change to the `SMALL` limits (D140 keeps them) · a change to the auditors' own text · the size of the skill
  text loaded per call (`DEF-SIZING-1`) · the harder test bed (a benchmark decision).

### INVARIANTS

Every requirement below holds inside these.

- Zero dependencies and Node 18. CommonJS logic in `scripts/lib/track-check.cjs`.
- Both features ship `experimental-off`. With a feature off, the skill behaves as `specs/pipeline-sizing.spec.md`
  says: no `MEDIUM` row, no `SOLO` path for a production-source diff, every run dispatches at least one seat.
- The track is a floor, not a ceiling. The chain is `SOLO → SMALL → MEDIUM → FIX → ADDITIVE → FULL`, one direction.
- `track-check` reads no profile feature (REQ-2009). The feature state gates the flag the orchestrator passes, not
  the script.
- Absent evidence is never a pass: a skipped phase is named with the track as the reason.
- A new dependency, a protected path or a new permission key never stays below `ADDITIVE`, on any track.

## Actors

| Actor | Source |
|---|---|
| the orchestrator (the session that runs the skill) | skills/build-module-pipeline.md |
| a person who writes the brief and reads the report | templates/module-brief.md, templates/module-report.md |
| `module-builder`, `security-auditor`, `invariant-auditor` | agents/ |

## Requirements

Kind: `behaviour` (what succeeds) · `refusal` (what is refused, and why) · `effect` (what a success leaves behind) ·
`constraint` (always true). Source: `intent`, a decision id, or an open-question id.

| Id | Requirement | Actor | Kind | Source |
|---|---|---|---|---|
| REQ-2011 | With `features.mediumTrack` on, Phase 0.5 has a `MEDIUM` track. A change takes it when every limit holds: at most `maxFiles` (default 6) production source files, all in one module directory, no new dependency, no new permission key, no protected path, and at most one addition inside the module: a new migration, a new table, or a new public operation (a route, a CLI command or report kind, a query parameter). | the orchestrator | behaviour | intent, D142 |
| REQ-2012 | `MEDIUM` runs Phase 2 as one `module-builder` dispatch with TDD, then the orchestrator itself runs `commands.typecheck` and every tier, then Phase 4 as one auditor dispatch: `security-auditor` for a new public operation or query parameter, `invariant-auditor` for a new migration, a new table, or a change with no addition. Findings go to one builder re-dispatch at most. A finding that survives is listed in the report under `Open findings` and the verdict is `CHANGES-REQUIRED`. No planner, tester, docs or reviewer seat, no board, no pack. The report names each skipped phase with `MEDIUM` as the reason. | the orchestrator | behaviour | intent, D142 |
| REQ-2013 | When a `MEDIUM` limit breaks, by the builder's return or by `track-check --medium`, the run escalates to `ADDITIVE` and continues from Phase 1 with the diff as context. With the feature off, a broken `SMALL` limit escalates to `ADDITIVE` as REQ-2003 says, and the `MEDIUM` row is not offered. | the orchestrator | refusal | D142 |
| REQ-2014 | With `features.soloTrack` on, `SOLO` also admits a production-source change of at most `maxFiles` (default 2) production source files in one module with no new behaviour: no new operation, table, permission key, dependency, migration or protected path. The orchestrator makes the change itself with TDD (a red test first, then the change) and dispatches no seat. | the orchestrator | behaviour | intent, D143 |
| REQ-2015 | After the edit, a `SOLO` run runs `track-check --since BASE --solo`, then `commands.typecheck` and every tier once, and quotes the result lines in the report. A `SMALL` line continues the run as `SMALL`: one builder dispatch completes the diff. An `ESCALATE` line follows REQ-2003. | the orchestrator | behaviour | D143 |
| REQ-2016 | With `features.soloTrack` off, rule 1 (a production-source diff never goes `SOLO`) and the one-seat rule of the run discipline stand unchanged. This is an amendment to the invariant of `specs/pipeline-sizing.spec.md`, in force only while the feature is on. | the orchestrator | constraint | D143 |
| REQ-2017 | The kit ships `templates/module-report.md`. `unpack` and the two fallback installers copy it once to `specs/module-report.template.md` as a project-owned file. Its first two lines are the `Track:` and `Phases:` lines, followed by `Verdict`, `Summary`, `Evidence`, `Needs a human`, `Open findings`, `Deferred` and `Handoff pack` sections. The skill's Finish step says to fill this template, and the filled report keeps the two lines first. | a person who reads the report | effect | intent, D144 |
| REQ-2018 | `track-check --since BASE --medium [N]` prints `MEDIUM: n source files in 1 module — <reading>` and exits 3 when a `SMALL` limit breaks but every `MEDIUM` limit holds: at most N (default 6) files, one module, no dependency change, at most one new migration. `--solo [N]` prints `SOLO: n source file(s) in 1 module` and exits 0 when at most N (default 2) files changed in one module with no dependency change and no new migration. Without the flags, the output and the exit codes are unchanged. `--json` carries the track. | the orchestrator | behaviour | intent, D145 |
| REQ-2019 | `track-check` still reads no profile feature and has no `not configured` state. The skill text tells the orchestrator to pass `--medium` only with `features.mediumTrack` on and `--solo` only with `features.soloTrack` on. | the orchestrator | constraint | REQ-2009, D145 |
| REQ-2020 | `mediumTrack` and `soloTrack` are §16 keys with state `experimental-off` and a `maxFiles` number (6 and 2), measured in EXPERIMENTS §25. `features` prints each line with the §25 decision. FEATURES.md, the profile template, GUIDE.md and USAGE.md name both. | a person who reads the docs | effect | D142, D143 |

## Acceptance criteria

| Id | Req | Verb | Given | When | Then |
|---|---|---|---|---|---|
| AC-2011 | REQ-2011 | assert | the skill text | read at Phase 0.5 | the track table has a `MEDIUM` row that names `features.mediumTrack`, 6 files, one module, one addition (migration, table, public operation) and the escalation triggers (dependency, permission key, protected path) |
| AC-2012a | REQ-2012 | assert | the sizing reference | read | the `MEDIUM` steps name one `module-builder` dispatch, the orchestrator's typecheck and tiers, one auditor dispatch with the choice rule (`security-auditor` / `invariant-auditor`), one re-dispatch at most, `Open findings`, `skipped (MEDIUM)`, no board, no pack |
| AC-2012b | REQ-2012 | assert | a `MEDIUM` run | it finishes | the `Phases:` line marks P1, P5, P6 and P6.5 `skipped (MEDIUM)`, P3 `run (orchestrator: …)` and P4 `run (1 auditor: …)` |
| AC-2013 | REQ-2013 | assert | the skill and the reference | read | a broken `MEDIUM` limit continues from Phase 1 as `ADDITIVE`; the chain is `SOLO → SMALL → MEDIUM → FIX → ADDITIVE → FULL`; with the feature off the `MEDIUM` row is not offered |
| AC-2014 | REQ-2014 | assert | the skill and the reference | read | the `SOLO` row and rule 1 name `features.soloTrack`, 2 files, one module, no new behaviour, a red test first, no seat |
| AC-2015 | REQ-2015 | assert | the reference | read | the `SOLO` steps run `track-check --since <base> --solo`, then typecheck and every tier once; a `SMALL` line means one builder dispatch; `ESCALATE` follows REQ-2003 |
| AC-2016 | REQ-2016 | assert | the skill | read | rule 1 and the one-seat rule stand, with the exception scoped to `features.soloTrack` on |
| AC-2017a | REQ-2017 | assert | `templates/module-report.md` | read | its first two lines start with `Track:` and `Phases:`; it has the eight sections |
| AC-2017b | REQ-2017 | assert | `unpack` into an empty project, and each fallback installer | run | `specs/module-report.template.md` exists and is project-owned (not rewritten by `upgrade`) |
| AC-2017c | REQ-2017 | assert | the skill's Finish step 6 | read | it names the `module-report` template and says the first two lines of the filled report are the template's |
| AC-2018a | REQ-2018 | assert | 5 files in `src/report/`, no other change | `track-check --since BASE --medium` | prints `MEDIUM: 5 source files in 1 module — 5 source files changed, limit 4`, exit 3 |
| AC-2018b | REQ-2018 | assert | 2 files in `src/report/` plus one new file under `src/report/migrations/` | `--medium` | prints a `MEDIUM:` line with `new migration` as the reading, exit 3 |
| AC-2018c | REQ-2018 | assert | 7 files in `src/report/` | `--medium` | prints `ESCALATE: 7 source files changed, limit 6`, exit 1 |
| AC-2018d | REQ-2018 | assert | 5 files in `src/report/` and a new dependency | `--medium` | exit 1, the dependency reason printed |
| AC-2018e | REQ-2018 | assert | 2 files in `src/report/`, no other change | `--medium` | prints `SMALL: 2 source files in 1 module`, exit 0 (SMALL wins when it holds) |
| AC-2018f | REQ-2018 | assert | 1 file in `src/report/` | `--solo` | prints `SOLO: 1 source file in 1 module`, exit 0 |
| AC-2018g | REQ-2018 | assert | 3 files in `src/report/` | `--solo` | prints `SMALL: 3 source files in 1 module`, exit 0 |
| AC-2018h | REQ-2018 | assert | one new migration under `src/report/` | `--solo` alone | prints `ESCALATE: new migration …`, exit 1 (a migration is never SOLO; without `--medium` it escalates as REQ-2008 says) |
| AC-2018i | REQ-2018 | assert | `--medium 8` with 7 files | run | `MEDIUM:` exit 3; `--json` has `"track": "MEDIUM"` |
| AC-2018j | REQ-2018 | assert | 5 files, no flag | `track-check --since BASE` | `ESCALATE: 5 source files changed, limit 4`, exit 1 (unchanged) |
| AC-2019 | REQ-2019 | assert | the script and its library | read | neither loads `profile.feature`; the skill text scopes `--medium` to `features.mediumTrack` and `--solo` to `features.soloTrack` |
| AC-2020a | REQ-2020 | assert | the `FEATURES` table | read | `mediumTrack` is `{ state: 'experimental-off', maxFiles: 6 }` and `soloTrack` is `{ state: 'experimental-off', maxFiles: 2 }`, both with `experiment: '§25'` |
| AC-2020b | REQ-2020 | assert | `features` in an empty project | run | prints `mediumTrack: experimental-off — not enabled; its measurement is EXPERIMENTS.md §25 · decision: not yet measured (…)` and the same for `soloTrack` |
| AC-2020c | REQ-2020 | assert | FEATURES.md, PIPELINE_PROFILE.template.md, GUIDE.md, USAGE.md | read | each names both keys |

## API contract

No API contract — the module is skill text, a template, two feature keys and two flags of one script.

## Oracle amendments

| Oracle | Entry | Why | Decision |
|---|---|---|---|
| ORACLE.md | none | no oracle entry is needed | dropped |

## Amendments to specs/pipeline-sizing.spec.md

| Id | Clause | Change | Decision |
|---|---|---|---|
| AM-1 | INVARIANTS, "A production-source diff still never goes SOLO" | holds while `features.soloTrack` is off; with it on, REQ-2014 admits a change of at most 2 files with no new behaviour | D143 |
| AM-2 | REQ-2003, "escalates to ADDITIVE" | with `features.mediumTrack` on, a broken SMALL limit inside the MEDIUM limits escalates to MEDIUM first | D142 |
| AM-3 | REQ-2007, the report header | the two lines are the first two lines of `templates/module-report.md`; the rule is unchanged | D144 |

## Open questions

| Id | Question | Blocks | Answer |
|---|---|---|---|
| Q-1 | Which auditor runs on a MEDIUM change? | REQ-2012 | One, chosen by the addition (D142): `security-auditor` for a new public operation, because authorization scope is where a new route or command fails; `invariant-auditor` for a migration, a table or a plain 5 to 6 file change, because it checks that the system is coherent after the change. The measurement records the findings of both on the 16 escalated runs of `full-01` before the step is widened. Answered 19 November 2026 under the autonomy mandate. |
| Q-2 | Is the report template a §16 feature? | REQ-2017 | No (D144). The header rule is in force (REQ-2007). The template is how the rule is delivered, like the brief template, and a template has no off state. Its keep rule is in §25 (75 of 75 reports with the line). Answered 19 November 2026 under the autonomy mandate. |

## Decision log

| Id | Decision | Why |
|---|---|---|
| D142 | A `MEDIUM` track between `SMALL` and `ADDITIVE`, `experimental-off` as `features.mediumTrack`: one builder dispatch, the orchestrator runs typecheck and the tiers, one auditor dispatch chosen by the addition, one re-dispatch at most, no board, no pack. Limits: 6 files, one module, one addition; a dependency, a permission key or a protected path still escalates. | full-01: 16 of 75 kit runs escalated to ADDITIVE at 4.94 USD for a migration, a table, a CLI kind or a fifth file inside one module, with no gain in solved cells. One auditor keeps the check that exists for exactly those changes at a fraction of the four-auditor cost. |
| D143 | A `SOLO` path for a production-source change of at most 2 files with no new behaviour, `experimental-off` as `features.soloTrack`: the orchestrator edits with TDD, no seat, tiers run once. Rule 1 and the one-seat rule stand while the feature is off. | full-01: SMALL runs cost 3 to 5 times a bare run on a one-line change; the seat is the cost. Rule 1 exists because a solo run once shipped with the gate chain red; the path keeps the red test and the full tiers, so the lesson holds. |
| D144 | The report header moves into `templates/module-report.md`, installed once as `specs/module-report.template.md`; no §16 key. | 3 of 75 reports had no `Track:` line with the rule in the run discipline; a template the orchestrator fills cannot be skipped by prose. A template has no off state. |
| D145 | `track-check` gains `--medium [N]` (exit 3) and `--solo [N]` (exit 0 on a `SOLO` line). Without the flags nothing changes. It still reads no profile feature. | REQ-2009 keeps the script free; the orchestrator, which reads §16 anyway, passes the flag. Exit 3 lets a script tell MEDIUM from SMALL without parsing the line. |
