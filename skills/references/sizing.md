# Sizing the run — the SMALL track, the foreground rule, the unattended mode and the report header

Part of the `build-module-pipeline` skill (`specs/pipeline-sizing.spec.md`, REQ-2001 to REQ-2010; decisions D134 to
D138). The skill keeps the track row and the three rules; this file keeps the steps and the reasons.

## Why the pipeline must size itself (D134)

A benchmark of the kit on five small tasks (two to six files each) showed the gap. Of 15 runs, 8 ran no seat at all
after the skill was read, 5 ran one or two seats, and 2 ran the full pipeline: 8 and 14 subagents, 21 and 30 minutes,
for a change of three files. The skill offered no sanctioned small path, so each run improvised one. The cost spread was
0.17 to 8.03 USD for work of the same size. SMALL is the sanctioned small path; its limits are fixed numbers, not a
profile feature, so a project cannot leave the gap open by default (D135).

## The SMALL limits (REQ-2001)

A change is SMALL when every one of these holds. One broken limit is an escalation, never a judgement call.

1. At most **4 production source files** change. Tests, docs, boards, ledgers, handoffs, lock files and the profile do
   not count.
2. All of them sit in **one module directory** (the folder under the source root: `src/report/…` is the module `report`).
3. **No new public operation, table, permission key or dependency.** A new route, a new migration, a new catalogue
   key or a new `package.json` dependency is ADDITIVE or more.
4. **No protected path** (profile §4).
5. The brief's `Size hint:` line agrees, or is absent. A hint of `ADDITIVE` or larger wins over a small diff.

`node scripts/track-check.mjs --since <base>` measures limits 1 to 3 from git (REQ-2008): it prints
`SMALL: n source files in m module(s)` and exits 0, or one `ESCALATE: <reason>` line per broken limit and exits 1.
It reads no profile feature and has no off state (REQ-2009). Limit 4 and the "new public operation or permission key"
part of limit 3 are the orchestrator's reading of the diff against profile §4 and §3.

## The SMALL run (REQ-2002, REQ-2003)

```
Phase 0.5   pick SMALL from the brief and the Size hint; write `Track: SMALL — <reason>` in state.md
Phase 2     one `module-builder` dispatch, foreground, TDD per change (red → green), returns the diff summary
            then: node scripts/track-check.mjs --since <base>   (exit 0 → stay SMALL; exit 1 → escalate, below)
Phase 3     the orchestrator itself runs `commands.typecheck` and every `commands.tiers` tier through the log wrapper,
            and quotes each result line in the report (a selective run is never evidence)
Phase 7     the report (header below). No board, no handoff pack, no version bump unless profile §11 asks for one
```

Skipped and named in the report: P1 plan, P3 tester seat, P4 audit, P5 docs, P6 review, P6.5 behavioural gate, each
as `skipped (SMALL)`. A SMALL run dispatches exactly one seat. The claims check and the hand-back check of Phase 2 still
apply to the builder's return.

**Escalation.** When the builder's return or `track-check` shows a broken limit, the run continues from Phase 1 as
`ADDITIVE` (or higher, by the table) with the builder's diff as the planner's context. Nothing is thrown away and
nothing is re-done; the diff becomes the first batch's evidence. A run never finishes as SMALL with a broken limit, and
no run de-escalates: SOLO → SMALL → FIX → ADDITIVE → FULL is the only direction.

## Every seat runs in the foreground (REQ-2004, D136)

Dispatch a seat and wait for its return in the same step. Concurrent seats (the four auditors) are one message with
several dispatches, and all of them return before the next step. Never schedule a timer, a wake-up or a sleep to wait
for a seat. In the benchmark the two full-pipeline runs spent most of 21 and 30 minutes in 20, 5, 4 and 2 minute
wake-ups while the background seats had already finished; a background dispatch plus a timer is the slowest shape a
run can take and adds nothing to its coverage.

## Unattended mode — `Human: none` (REQ-2005, REQ-2006, D137)

A brief line `Human: none`, or a session nobody is watching (a batch lane, a benchmark, a scheduled run), makes the run
unattended. The run then:

- records every human-only decision — a gate waiver, a `NEEDS-RULING`, a `GRANT-ASK`, a `BLOCKING` triage, an
  escalation that needs authorization (PLATFORM) — in `state.md` and in the report under a `Needs a human` heading,
  each with the assumption the run took and what changes if a person rules the other way;
- ends with its verdict. It never ends in a question or a wait for a reply.

**The verdict is never upgraded.** A recorded behavioural-gate skip stays `CHANGES-REQUIRED` in the reviewer's verdict;
the report says so and names the waiver as the open item under `Needs a human`. `MERGE-READY` is earned by evidence,
never by the absence of a person. With `Human: available` (the default) the run asks as before.

## The report header (REQ-2007, D138)

The first two lines of every final report, whatever the track:

```
Track: SMALL — 2 source files in src/report, no new operation, no new dependency
Phases: 0 run · 0.5 run (SMALL) · 1 skipped (SMALL) · 2 run (1 builder dispatch) · 3 run (orchestrator: typecheck PASS, unit 212/212) · 3b skipped (no drift oracle) · 4 skipped (SMALL) · 5 skipped (SMALL) · 6 skipped (SMALL) · 6.5 skipped (SMALL) · 7 run
```

Every phase of the table appears once, as `run` or `skipped (<reason>)`. A phase that is absent from the line was not
run and not recorded, which the close-out audit treats as a gap. The skipped reasons a report may use: `SMALL`, the
track's own phase list (`FIX`, `RULINGS`), `no <capability>` for a profile §14 gap, and `not configured` for a feature
that is off. A skip is never a pass; the behavioural-gate rule above still applies.
