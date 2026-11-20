# Sizing the run — the SMALL track, the MEDIUM and SOLO steps, the foreground rule, the unattended mode and the report header

Part of the `build-module-pipeline` skill (`specs/pipeline-sizing.spec.md`, REQ-2001 to REQ-2010, decisions D134 to
D138; `specs/pipeline-cost.spec.md`, REQ-2011 to REQ-2020, decisions D142 to D145; `specs/pipeline-cost-2.spec.md`,
REQ-2022 to REQ-2024 and REQ-2027, decisions D146 to D149). The skill keeps the track rows and the three rules; this
file keeps the steps and the reasons.

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
no run de-escalates: SOLO → SMALL → MEDIUM → FIX → ADDITIVE → FULL is the only direction. With `features.mediumTrack`
on, a broken SMALL limit inside the MEDIUM limits continues as MEDIUM (below) instead of ADDITIVE.

## The MEDIUM step — `features.mediumTrack` (REQ-2011 to REQ-2013, D142; experimental-off)

The full benchmark (`EXPERIMENTS.md` §25) measured why SMALL runs escalate: a new migration, a new table, a new CLI
report kind, a fifth file, each inside one module. The ADDITIVE pipeline then cost ten times a SMALL run for the same
result. MEDIUM is the step between them. It exists only while `features.mediumTrack` is on; with the feature off the
MEDIUM row is not offered and a broken SMALL limit escalates to ADDITIVE as before.

A change is MEDIUM when every one of these holds:

1. At most **6 production source files** (`features.mediumTrack.maxFiles`) change, all in **one module directory**.
2. **At most one addition** inside the module: a new migration, a new table, or one new public operation (a route, a
   CLI command or report kind, a query parameter).
3. **No new dependency, no new permission key, no protected path.** Each of these is ADDITIVE or more, on every track.

```
Phase 0.5   pick SMALL or MEDIUM from the brief and the Size hint; write `Track: <track> — <reason>` in state.md
Phase 2     one `module-builder` dispatch, foreground, TDD per change, returns the diff summary
            then: node scripts/track-check.mjs --since <base> --medium   (exit 0 SMALL; exit 3 MEDIUM; exit 1 escalate)
Phase 3     the orchestrator itself runs `commands.typecheck` and every `commands.tiers` tier and quotes each result line
Phase 4     one auditor dispatch, foreground, with the diff and the reading from track-check as its brief:
              `security-auditor`  for a new public operation or query parameter (authorization scope is where it fails)
              `invariant-auditor` for a new migration or table, or for a 5 to 6 file change with no addition
            findings → one re-dispatch of the builder at most; a finding that survives it goes to `Open findings`
            and the verdict is CHANGES-REQUIRED
Phase 7     the report. No board, no handoff pack
```

Skipped and named in the report: P1 plan, P5 docs, P6 review, P6.5 behavioural gate, each as `skipped (MEDIUM)`; P3 is
`run (orchestrator: …)` because the tiers ran, with no tester seat. A MEDIUM run dispatches two seats, three with the re-dispatch. The claims check and the hand-back
check of Phase 2 still apply. A broken MEDIUM limit (a seventh file, a second module, a second addition, a dependency)
continues from Phase 1 as `ADDITIVE` with the diff as context, exactly as a broken SMALL limit does.

```
Track: MEDIUM — 5 source files in src/report, one new migration, no new dependency
Phases: 0 run · 0.5 run (MEDIUM) · 0.7 skipped (not configured) · 1 skipped (MEDIUM) · 2 run (1 builder dispatch) · 3 run (orchestrator: typecheck PASS, unit 214/214) · 3b skipped (no drift oracle) · 4 run (1 auditor: invariant-auditor, 0 findings) · 5 skipped (MEDIUM) · 6 skipped (MEDIUM) · 6.5 skipped (MEDIUM) · 7 run
```

## The SOLO path — `features.soloTrack` (REQ-2014 to REQ-2016, D143; experimental-off)

The same benchmark measured the SMALL track at 3 to 5 times a bare run on a one-line change: the seat is the cost.
With `features.soloTrack` on, SOLO also admits a production-source change of at most **2 production source files**
(`features.soloTrack.maxFiles`) in **one module** with **no new behaviour**: no new operation, table, permission key,
dependency, migration or protected path. The orchestrator makes the change itself and dispatches **no seat**. With the
feature off, rule 1 stands as written: a production-source diff never goes SOLO, and every run dispatches a seat.

```
Phase 0.5   pick SOLO from the brief's Size hint (one or two named files, no new behaviour); write `Track: SOLO — <reason>`
Phase 2     the orchestrator edits: a red test first, then the change (TDD), nothing else
            then: node scripts/track-check.mjs --since <base> --solo   (`SOLO:` exit 0 → stay; `SMALL:` → below; `ESCALATE:` → REQ-2003)
Phase 3     the orchestrator runs `commands.typecheck` and every tier once and quotes each result line
Phase 7     the report. No board, no handoff pack
```

A `SMALL:` line (3 or 4 files, or a change that grew) continues the run as SMALL: one `module-builder` dispatch reviews
and completes the diff with the orchestrator's edit as context, then Phase 3 runs again. An `ESCALATE:` line follows
REQ-2003. The run never de-escalates and never finishes as SOLO with a diff past the limit. Rule 1 exists because a
solo run once shipped with the gate chain red (`references/tracks-and-scope.md`); this path keeps the red test and the
full tiers, so the lesson holds.

## Who raises the track (REQ-2023, D147)

Only a measured limit or the brief raises the track. `track-check` raises it when a file, module, dependency or
migration limit breaks; the orchestrator raises it for a protected path, a permission key or a new public operation it
reads in the diff; the brief raises it with `Size hint:`. The planner returns `Track hint: <track> — <reason>` and the
orchestrator records the hint in `state.md`, then keeps the track unless one of those three says otherwise. FULL is
entered from the `Size hint:` or a new bounded context the brief names, never from a seat's reading.

Why: on the harder benchmark bed, 7 of 50 kit runs went FULL on the planner's reading at 4.12 USD per run against 2.72
for ADDITIVE. Every one of those cells was solved by a bare agent at 0.20 to 0.35 USD. The planner sees the docs; it
does not see the cost, and it cannot measure the diff that does not exist yet.

## The shared catalogue allowance (REQ-2024, D148)

Profile §5 names the shared catalogue files: the files every module adds a line to, such as `src/shared/errors.ts` or a
config key list. Pass them to `track-check` as `--shared <file,file>`. A listed file that existed at the base and only
gained lines counts as a source file but not as a module, and the answer line ends with
`; shared additions: <files>`. A removed or changed line in a listed file is an ordinary edit and counts its module.

Why: one new error code in `src/shared` was the only second module in 4 of 5 escalations of one benchmark task, and in
every escalation of two tasks on the harder bed. The catalogue exists to be added to; an addition changes no caller.

## The MEDIUM auditor (REQ-2027, D149)

One auditor runs on MEDIUM. `invariant-auditor` for a new migration, a new table or a plain 5 to 6 file change; this is
what `track-check --medium --json` reports as `auditor`. `security-auditor` when the orchestrator's own reading of the
diff finds a new public operation or a new query parameter; git cannot see a route, so this part is the orchestrator's.
`standards-auditor` and `vuln-auditor` never run on MEDIUM. Write the choice and its reason in the `Phases:` line.

## The foreground guard (REQ-2022, D146; `features.foregroundGuard`, experimental-off)

With the key on, the hook `hooks/claude-code/foreground-guard.cjs` (installed to `.claude/hooks/`, armed by the
settings entry in `adapters/claude-code.md`) denies `ScheduleWakeup`, `CronCreate` and `Monitor` while a run is open:
any file in a `<runs>/<key>/` folder written in the last `openHours` (default 12). With `scope: "project"` it denies them
whenever the key is on, run or no run; the first batch showed that a SMALL run writes no `state.md` and a FULL run
writes it late, so a run-folder reading alone let timer calls through (D152). The denial names REQ-2004. The rule below
is unchanged; the hook makes it hold when the text is forgotten.

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

The first two lines of every final report, whatever the track. Fill the installed `module-report` template
(`specs/module-report.template.md`; kit: `builder/templates/module-report.md`); the two lines are its first two
(REQ-2017), so a report written from it cannot open with prose:

```
Track: SMALL — 2 source files in src/report, no new operation, no new dependency
Phases: 0 run · 0.5 run (SMALL) · 1 skipped (SMALL) · 2 run (1 builder dispatch) · 3 run (orchestrator: typecheck PASS, unit 212/212) · 3b skipped (no drift oracle) · 4 skipped (SMALL) · 5 skipped (SMALL) · 6 skipped (SMALL) · 6.5 skipped (SMALL) · 7 run
```

Every phase of the table appears once, as `run` or `skipped (<reason>)`. A phase that is absent from the line was not
run and not recorded, which the close-out audit treats as a gap. The skipped reasons a report may use: `SMALL`, `MEDIUM`,
the track's own phase list (`FIX`, `RULINGS`), `no <capability>` for a profile §14 gap, and `not configured` for a feature
that is off. A skip is never a pass; the behavioural-gate rule above still applies.
