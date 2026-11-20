# Spec — pipeline-cost-2: the escalation discipline that the harder benchmark measured

Module: pipeline-cost-2
Status: ratified
Ratified-by: George ("proceed as recommended", 20 November 2026, on the kit improvement plan; the spec text is ratified under the autonomy mandate of 16 November 2026; see Decision log)

> The second round of cost work. Source: the kit improvement plan of 20 November 2026 (project document), read from
> batches `full-01`, `hard-01` and `g12-after-E` (Library `benchmark/`). It extends `specs/pipeline-sizing.spec.md`
> (REQ-2001 to REQ-2010) and `specs/pipeline-cost.spec.md` (REQ-2011 to REQ-2020). Maintainer-only; it does not ship.

## Intent

> "9 of 50 hard-01 kit runs scheduled a timer although the foreground rule is in the skill; those runs cost 1.64 USD
> and 19.7 minutes and lost their `Track:` line. 7 of 50 runs went FULL on the planner's reading, at 4.12 USD against
> 2.72 for ADDITIVE. T9 escalated to ADDITIVE in 4 of 5 g12 seeds for one new error code in `src/shared`. Two MEDIUM
> runs picked an auditor the rule does not name." — kit improvement plan, 20 November 2026.

## Scope

- In: a hook that denies timer tools while a run is open (REQ-2022) · the rule that only `track-check` or the brief
  raises the track (REQ-2023) · the shared catalogue allowance of `track-check` (REQ-2024) · the deterministic auditor
  on MEDIUM (REQ-2027) · the after rows of EXPERIMENTS §25 and the new §26.
- Out, reserved for the third round (`pipeline-cost-3`): REQ-2021 seat model parity, REQ-2025 SOLO entry without a
  size hint, REQ-2026 the context budget on SOLO and SMALL. REQ-2028 (the pinned package call) is in PR #45.

### INVARIANTS

- Zero dependencies and Node 18. CommonJS logic in `scripts/lib/track-check.cjs` and `hooks/claude-code/foreground-guard.cjs`.
- The hook ships `experimental-off` behind `features.foregroundGuard`; copied, never armed (the hook rule of REQ-1816).
- `track-check` reads no profile feature (REQ-2009). `--shared` is a flag the orchestrator fills from profile §5.
- The chain stays `SOLO → SMALL → MEDIUM → FIX → ADDITIVE → FULL`, one direction.
- A new dependency, a protected path or a new permission key never stays below `ADDITIVE`, on any track.

## Actors

| Actor | Source |
|---|---|
| the orchestrator | skills/build-module-pipeline.md |
| `module-planner` | agents/module-planner.md |
| a person who reads the report | templates/module-report.md |

## Requirements

| Id | Requirement | Actor | Kind | Source |
|---|---|---|---|---|
| REQ-2022 | The kit ships `hooks/claude-code/foreground-guard.cjs`, a `PreToolUse` hook on `ScheduleWakeup`, `CronCreate` and `Monitor`. With `features.foregroundGuard` on and a run open (any file in a run folder under `paths.runs` written in the last `openHours`, default 12), the hook denies the call (exit 2) and names REQ-2004; with `scope: "project"` it denies the call whenever the key is on. Off, or without a trusted profile, it passes. | the orchestrator | refusal | intent, D146 |
| REQ-2023 | Only `track-check` or the brief raises the track. The planner returns a `Track hint:` and never changes the track. `FULL` is entered from the brief's `Size hint:` or a broken `ADDITIVE` limit (a new bounded context named in the brief), not from a seat's reading. The report's `Track:` line names what raised the track. | the orchestrator, `module-planner` | constraint | intent, D147 |
| REQ-2024 | `track-check --shared` takes a comma-separated list that names the shared catalogue files of profile §5. A listed file that existed at the base and only gained lines counts as a source file but not as a module; the answer line ends with `; shared additions:` and the files, and `--json` carries `sharedAdditions`. A removed or changed line in a listed file is an ordinary edit. | the orchestrator | behaviour | intent, D148 |
| REQ-2027 | On `MEDIUM`, the auditor is `invariant-auditor` unless the orchestrator's own reading of the diff finds a new public operation or query parameter, then `security-auditor`. `track-check --medium --json` carries `auditor: invariant-auditor`. `standards-auditor` and `vuln-auditor` never run on `MEDIUM`. | the orchestrator | constraint | intent, D149 |

## Acceptance criteria

| Id | Req | Verb | Given | When | Then |
|---|---|---|---|---|---|
| AC-2022a | REQ-2022 | assert | `features.foregroundGuard` on, `.pipeline/k/state.md` written now | `ScheduleWakeup` | `decide` blocks and the reason names REQ-2004 and the state file |
| AC-2022b | REQ-2022 | assert | the same, `state.md` 13 hours old | `ScheduleWakeup` | passes |
| AC-2022c | REQ-2022 | assert | the key off | `CronCreate` | passes |
| AC-2022d | REQ-2022 | assert | the key on, a run open | `Bash` | passes (not a timer tool) |
| AC-2022e | REQ-2022 | assert | the hook as a process with malformed stdin | run | exit 0 |
| AC-2022g | REQ-2022 | assert | the key on, a run folder with only `run.jsonl` written now (no state.md) | `ScheduleWakeup` | blocks and the reason names that file |
| AC-2022h | REQ-2022 | assert | the key on with `scope: project`, no run folder at all | `Monitor` | blocks and the reason names the scope |
| AC-2022f | REQ-2022 | assert | `FEATURES`, the profile template, FEATURES.md, adapters/claude-code.md, hooks/README.md | read | each names `foregroundGuard` as `experimental-off` with `openHours` 12 |
| AC-2023a | REQ-2023 | assert | the skill | read | Phase 0.5 says the planner returns a track hint and never raises the track; FULL is entered from the Size hint or a broken ADDITIVE limit |
| AC-2023b | REQ-2023 | assert | `agents/module-planner.md` | read | the `## Track` section returns a hint and says the orchestrator keeps the track |
| AC-2024a | REQ-2024 | assert | 2 files in `src/api/` and one added line in `src/shared/errors.ts` | `--shared src/shared/errors.ts` | `SMALL: 3 source files in 1 module; shared additions: src/shared/errors.ts`, exit 0 |
| AC-2024b | REQ-2024 | assert | the same change | no `--shared` | `ESCALATE: 2 modules touched (api, shared), limit 1`, exit 1 (unchanged) |
| AC-2024c | REQ-2024 | assert | a changed line in `src/shared/errors.ts` beside 2 files in `src/api/` | `--shared src/shared/errors.ts` | `ESCALATE: 2 modules touched …`, exit 1 |
| AC-2024d | REQ-2024 | assert | 5 files in `src/api/` and an added line in `src/shared/errors.ts` | `--shared src/shared/errors.ts --medium` | `MEDIUM: 6 source files in 1 module — 6 source files changed, limit 4; shared additions: src/shared/errors.ts`, exit 3, `--json` has `auditor: invariant-auditor` |
| AC-2027 | REQ-2027 | assert | the skill and the sizing reference | read | the MEDIUM steps name `invariant-auditor` as the default, `security-auditor` for a public operation, and exclude the other two |

## Expected effect and measurement

Written before the re-run. Batch `round-one` in the benchmark: arm E on T3, T5, T8, T9, T11, T14 (the g12 cells, 30
cells) and on T16, T17, T18, T21 at 3 seeds (12 cells), kit at this spec's commit, keys `mediumTrack`, `soloTrack`
and `foregroundGuard` `experimental-on`, `--shared src/shared/errors.ts,src/shared/config.ts` in the arm profile.

| Change | Expected | Keep rule |
|---|---|---|
| REQ-2022 | 0 timer calls; every report ends the run; wall time of former timer runs falls to the track's mean | 0 timer waits, reports with the `Track:` line 42 of 42 |
| REQ-2023 | 0 FULL runs on T16, T17, T18, T21 (7 of 20 in hard-01) | 0 FULL runs, solved 12 of 12 |
| REQ-2024 | T9 stays MEDIUM where the only second module was `src/shared/errors.ts` (4 of 5 g12 seeds); seeds past 6 files still escalate | the six G1 tasks under 1.00 USD per run (1.44 in g12), solved 30 of 30 |
| REQ-2027 | the auditor matches the reading in every MEDIUM run (2 deviations in g12) | 100 percent |

## API contract

No API contract — the module is one hook, one flag of one script, skill text and a feature key.

## Oracle amendments

| Oracle | Entry | Why | Decision |
|---|---|---|---|
| ORACLE.md | none | no oracle entry is needed | dropped — the hook, the flag and the skill rules name no API behaviour an oracle would check |

## Amendments to earlier specs

| Id | Clause | Change | Decision |
|---|---|---|---|
| AM-4 | pipeline-sizing REQ-2003, "the planner confirms or rejects the track" | the planner returns a hint; only `track-check` or the brief raises the track | D147 |
| AM-5 | pipeline-cost REQ-2012, the auditor choice | unchanged rule, now carried by `track-check --json` and stated as exclusive | D149 |

## Open questions

| Id | Question | Blocks | Answer |
|---|---|---|---|
| Q-1 | Does the hook block a timer in a session that has no run of its own, while another run of the same project is open? | REQ-2022 | Yes, until the open run's `state.md` ages past `openHours`. The hook judges by file age, not by session, because the hook input carries no run identity. The risk is written into EXPERIMENTS §26; a session identity is a third-round question if the batch shows a wrong block. Answered 20 November 2026 under the autonomy mandate. |
| Q-2 | Why does `track-check` not read the shared files from the profile itself? | REQ-2024 | REQ-2009: the script reads no profile feature so that it stays a free check with no off state; the orchestrator, which reads profile §5 anyway, fills `--shared`. Answered 20 November 2026 under the autonomy mandate. |

## Decision log

Kit decision ids continue the kit's own sequence (D145 was the last). The benchmark repository keeps its own sequence.

| Id | Decision | Why |
|---|---|---|
| D146 | A hook denies timer tools while a run is open, behind `features.foregroundGuard` (`experimental-off`, `openHours` 12). | The rule in the skill text was broken in 9 of 50 hard-01 runs and 4 of 45 g12 runs; a hook is the only form the model cannot skip. Off by default per the kit's rule for new checks. |
| D147 | Only `track-check` or the brief raises the track; the planner hints. | 7 of 50 hard-01 runs went FULL at 4.12 USD on the planner's reading; the bare agent solved the same cells at 0.20 to 0.35. |
| D148 | Shared catalogue files that only gain lines do not count as a module. | One new error code in `src/shared` was the only reason T9 escalated in 4 of 5 g12 seeds, and T24 and T25 in hard-01. The catalogue exists to be added to. |
| D152 | The hook reads a run as open from any file in its run folder, not `state.md` alone, and `features.foregroundGuard.scope: "project"` denies the timer tools whenever the key is on. | Batch round-one (20 November 2026): 9 timer calls in 8 cells; the hook blocked 4 and let 5 through because a SMALL run writes no `state.md` and a FULL run (E-T16-s1) wrote it late; those 4 cells took 18 to 21 minutes. A checkout whose sessions exist to run the pipeline has no legitimate timer call, so `project` is the shape for it. |
| D149 | The MEDIUM auditor is `invariant-auditor` by default, `security-auditor` for a public operation, and no other. | g12 ran `vuln-auditor` and `standards-auditor` on MEDIUM against REQ-2012; a stated exclusive rule, carried by the script's output, removes the choice. |
