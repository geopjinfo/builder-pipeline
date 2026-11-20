Track: <TRACK> — <reason: the measured size, or the brief's hint, or the escalation that set it>
Phases: 0 <run | skipped (<reason>)> · 0.5 run (<TRACK>) · 0.7 <…> · 1 <…> · 2 <…> · 3 <…> · 3b <…> · 4 <…> · 5 <…> · 6 <…> · 6.5 <…> · 7 run

<!-- The final report of a `build-module-pipeline` run (kit: `builder/templates/module-report.md`; installed once as
     `specs/module-report.template.md`, project-owned). The first two lines above are the report's first two lines,
     whatever the track and however the run ended: a blocked run, an early stop and a `Needs a human` ending included
     (REQ-2007, REQ-2017). Every phase of the table appears once, as `run` or `skipped (<reason>)`. A skip reason is the
     track (`SMALL`, `MEDIUM`, `FIX`, `RULINGS`), `no <capability>` for a profile §14 gap, or `not configured` for a
     feature that is off. A skip is never a pass. Delete this comment and every `<…>` when you fill the report. -->

## Verdict

<MERGE-READY | CHANGES-REQUIRED | BLOCKED> — <the reviewer's verdict with its evidence, or the orchestrator's own on a
track with no reviewer seat; never upgraded by the absence of a person>

## Summary

<what shipped, in at most five lines: the module, the requirement ids covered, the interfaces or keys added>

## Evidence

- typecheck: <the result line, quoted>
- <tier name>: <the result line, quoted — one line per tier of `commands.tiers`; a selective run is never evidence>
- track-check: <the `SOLO:` | `SMALL:` | `MEDIUM:` | `ESCALATE:` line, quoted>
- <each optional check that ran: its last line — or `<feature>: not configured`>

## Needs a human

<each human-only decision the run recorded (a gate waiver, a `NEEDS-RULING`, a `GRANT-ASK`, a `BLOCKING` triage), with
the assumption the run took and what changes if a person rules the other way — or `none`>

## Open findings

<each auditor or reviewer finding that survived the run, as `FIX-n · file:line · rule · minimal fix` — or `none`>

## Deferred

<each `DEFERRED→<registry-id>` row and each `SPLIT` finding, with its registry id — or `none`>

## Handoff pack

<the path under `paths.handoffs`, and the `handoff-check` result line — or `none (<TRACK>: no pack)`>
