---
name: status-and-next
description: Use to re-verify the project's true state from scratch and hand back the next unblocked build item as a full paste-ready pipeline brief. Trigger on "/status-and-next", "double check our progress", "what's next in line", "status and next", "give me the next pipeline prompt", or at the start of any session resuming lead-side planning. Read-only except the report; never acts on irreversible items (merges, tags, releases).
---

# Status & next — verify fresh, pick one, brief it

The recurring lead ask between pipeline runs: *what is actually true, and what do we build next?*
Three steps, in order. **Trust nothing cached** — compacted summaries, agent memory, and prior
session facts are hypotheses to re-verify, never inputs. The failure this guards against is real:
a brief was once nearly issued for work a ruling had already retired, because the "next item" came
from a stale summary instead of the live tracker.

Load `PIPELINE_PROFILE.md` first if present — §11 names the ledgers (boards, deferred registry,
trackers), §2 the gate commands, §5 the protected/fenced paths.

**Without a profile.** The project has not adopted the pipeline. Read its state with the kit tools on named
targets, each of which runs with the default settings and says so on its first line:
`npx builder check-ledgers --boards <dir> --registry <file>` · `npx builder run spec-check <file>.md` ·
`npx builder run claims-check --files <file>…` · `npx builder inventory` ·
`npx builder run instruction-lint <file>…` · `npx builder run instruction-budget <file>… [--max-lines <n>]` ·
`npx builder run worktree-sweep --target <branch>` (a dry run; `--apply` removes). A line that says
`not configured` is not a pass: name it in the report as a check that did not run.

## 1. Re-verify state from scratch

Run and read, in parallel where possible:

- `git branch --show-current` · `git log --oneline -8` · `git status --short` — tip, branch,
  version file, and **anything dirty that is not yours** (in-flight doc syncs are common; they
  must never be swept into a commit).
- The module/status tracker the profile names. If it is a CSV, count the status column **by
  header index, never by substring match** (sibling columns collide) and **never by raw grep over
  whole rows** (other status columns double-count). Dump the full row for every module that is
  neither finished nor unstarted.
- For each withheld/in-progress module, chase its cited blocker to the **current** authority:
  deferred-registry row → requirement row status → any named ruling/erratum. A tracker cell can
  cite a blocker that has since CLOSED (retirement, ruling, landed migration) — the requirement
  row and registry status outrank the tracker's prose.
- Open boards: the active `tasks/<key>.md`, any follow-ups board, the deferred registry's open
  section. Note which open rows belong to **another party** (the decision workspace or the lead — never closable
  from this side) vs this side.

## 2. Report deltas, then pick ONE

Report: what changed since the last recorded session, which cached facts proved stale, what is
owed by whom (this side / the doc owner / the lead), and any irreversible items parked
(merge-to-mainline, annotated tags, releases) — **flag those, never act on them**.

Then name the **single next unblocked build item**: plain build work, in an unfenced module, with
every stated dependency verified landed. Queue discipline: close withheld/remediation items before
opening new-wave modules; rebuild any queue from the live trackers, never from stale planning
docs. If the next item needs a ruling first (fenced module, unstated business rule), the
deliverable is the escalation in the ruling channel, not a brief.

## 3. Emit the full pipeline brief

Write the item as a FULL brief per the project's module brief template (the kit's
`templates/module-brief.md` / the 12-section shape) — no condensed form. Non-negotiables:

- AuthZ keys **verbatim-verified** against the project's permission catalogue (never invented;
  missing key → the brief says STOP-and-flag).
- The boundary/platform fork settled or explicitly handed to the planner **with the verified
  facts it needs** (e.g. what event payloads actually carry, which migrations actually landed —
  grep, don't assume).
- Cross-module touches pre-authorized narrowly (additive, via the module's published facade) or
  fenced off; branch base named (the integration branch, never mainline); dirty-tree caution
  included when applicable.
- Ends with the brief's closing tables: files + endpoints, the autonomous-decision log, and the
  PRE/POST-merge doc/tracker handoff pack — **including any tracker flips found owed in
  step 1**, even ones independent of this build.
- The template's standing clause (search → decide+record → escalate) pasted in verbatim.
