# The run log — events and the watcher

Part of the `build-module-pipeline` skill (step 1, after the board is materialized). The run log is
`<runs>/<key>/run.jsonl`, append-only, opened with a `run.start` event.

## The watcher

Start the watcher **once**, as a separate long-running process (a second terminal, or your
harness's background-task facility), leave it running for the whole run, and never type a render
command again: it re-renders on every write to a board or a run log. A seat flipping a row to
`IN-PROGRESS` is already a write to the board, so the page follows the coder by itself.

## Events

Append one event where each thing happens:

| When | Event | Carries |
|---|---|---|
| run opens | `run.start` | module, track, branch, base, scope |
| every dispatch | `step` | `id`, `phase`, `seat`, `title`, `detail`, `status`, **the harness's agent id** (so the accounting can be joined), `files[]` |
| every tier / gate / optional check run | `gate` | `gate`, `result`, `figure`, `detail`, `log` path |
| every escalation or auditor finding | `finding` / `finding.close` | `id`, `sev`, `finding`, `mechanism`, `closedBy` |
| whenever the reachable total drops | `ceiling` | `item`, `claim`, `reality`, `disposition`, `owner` |
| every decision the run takes | `decision` | `id`, `what`, `why`, `by`, `reversal` — `<decisions>` stays the record; the event is how the page shows it |
| close-out | `run.end` | `verdict`, `rowsDone`, `rowsTotal` |

## Only the orchestrator appends

A seat reports the files it touched in its final message and
you log them; a subagent writing its own accounting would be self-reporting the very numbers the
board exists to check, and the harness already records the honest ones where it keeps dispatch
records (`features.costAccounting`). Log an event where it happens, not at the end — a run that
dies mid-phase must leave a truthful partial log rather than a summary written from memory. A
`ceiling` event is not optional bookkeeping: it is how the run says out loud that it will not
reach what it set out to. Format: `<boards>/README.md`.
