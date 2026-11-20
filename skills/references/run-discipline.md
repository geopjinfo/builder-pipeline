# Run discipline — the long form

Part of the `build-module-pipeline` skill. The skill keeps each rule; this file keeps why, the
measured cases behind it, and the optional hooks and checks that support it.

## Who runs this playbook

A person's session, for one module; or a lane worker dispatched by the batch
orchestrator ([`orchestrator`](../orchestrator.md), feature `orchestrator`), which splits a multi-row plan into lanes
and runs this playbook once per row in each lane's own worktree and branch. The playbook is the same either way: a
lane worker's brief (`templates/orchestrator-worker-brief.md`) names its rows, owned files and result path, and the
batch orchestrator — not the run — owns the merge order. `orchestrator: not configured` → one run per module, by
hand, as below.

## The board is the one progress surface — why

Every extra surface is one more place for status to disagree, and in one adopting
project the mirror instructions went unfollowed for whole runs while the board stayed current.

## One writer at a time — the case behind it

In one adopting project two parallel FIX lanes left three stray cells welded to line 1 of the
board, and both lanes detected and repaired it independently — which is luck, not a design.

## Never run a test suite bare — why, and worker pools

A raw multi-megabyte test log read mid-run lands in the middle of the orchestrator's context — the
position least likely to be acted on — and buries the loop-back list. If the harness supports it,
size test worker pools from free memory, not core count — oversubscription costs correctness
(timeouts that read as regressions), not just time.

*Optional, Claude Code only:* `hooks/claude-code/bash-output-cap.cjs` (`features.bashCap`) caps the
orchestrator's own shell output while keeping every error line. It does not cap subagents — see
`adapters/claude-code.md`.

## The state file survives a compaction

**Every phase gate is a compact-safe checkpoint**: you cannot schedule a compaction,
only make sure that wherever one lands the run survives it. *Optional, Claude Code only:*
`hooks/claude-code/reanchor-after-compact.cjs` (`features.reanchor`) hands the compacted session
those three items — paths, the `Now:` line, the open `FIX-n` rows verbatim — so a summary cannot
lose them; you still read the files. Feature off → `reanchor: not configured`.

## The fixed dispatch header — why six fields

A seat that receives the same six fields every time cannot be
under-briefed — the source project's worst planning failure was an input failure, not a reasoning
one.

## The orchestrator's own model

Choose it on capability, not on a guessed saving — measure cost afterwards with
`node scripts/cost-window.mjs --since <iso> --until <iso>` rather than assuming it. In one adopting
project the declared orchestrator model went unused for several consecutive runs while the decision
was recorded as done; declaring it in `models.orchestrator` makes the divergence visible.

## Before step 0 — the orchestrator model check (optional; warns, never refuses)

```
node scripts/orchestrator-check.mjs
node scripts/seat-models.mjs
```

`seat-models` (REQ-2029) compares the `model:` line of every installed agent with `models.strong` /
`models.mid` of §16. One `DRIFT:` line per agent and exit `1` means the seats would run on another
model than the profile declares — the benchmark measured Opus seats under a profile that said Sonnet.
Run `node scripts/seat-models.mjs --write` to put them in step, then go on. A profile without models,
or another harness, prints one line and exits `0`.

Exit `5` means this session is not on `models.orchestrator`: switch the session's model, or record
in `state.md` that the run proceeds on the other one. The choice is the operator's; the check only
makes it visible. No transcript to read is reported as unmeasured, never as a pass. Feature off →
record `orchestratorModel: not configured` in `state.md`. The rendered board's orchestrator row
reports the model the run actually used, where the harness keeps that record.

## Stop at `run.end` — why one run per session

The orchestrator re-reads its whole context on every
turn, so every turn after the run has ended pays for the entire run again: in one adopting project
most of the orchestrator's spend in a session came after its run had ended.
