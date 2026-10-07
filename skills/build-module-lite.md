---
name: build-module-lite
description: Build one module FAST — the first half of the build-module-pipeline (index gate → deferred sweep → planner → coder → tester → free checks) at full strength, then STOP and queue the module in <boards>/_gate-queue.md as BUILT-UNGATED. The second half (drift, four auditors, docs, review, behavioural gate, ledger, version, merge) runs later over several queued modules via build-module-lite-gate-batch. Requires features.liteSplit enabled. Nothing built here merges until the gate batch passes.
---

# Build-module lite (feature `liteSplit` — experimental)

**The first half of [`build-module-pipeline`](build-module-pipeline.md), cut at the end of P3.** Same
orchestrator role, same seats, same brief, same non-negotiables, same TDD loop, same claims check, same full
P3 tiers. What this skill does *not* do — P3b drift, the four auditors, docs, review, the behavioural gate,
the ledger audit, the version bump, the handoff pack, the merge — is not skipped: it is **owed**, recorded as
`OWED` in `<boards>/_gate-queue.md`, and discharged by
[`build-module-lite-gate-batch`](build-module-lite-gate-batch.md). A module built here is not delivered until
that batch closes it `GATED`.

**Feature gate.** `features.liteSplit` in §16. Not enabled → `node scripts/gate-queue.mjs` prints
`liteSplit: experimental — not enabled` and refuses; run the full pipeline instead. Enabled on purpose, its
measurement is owed (EXPERIMENTS.md).

**This file restates nothing it can point at.** Every step below names the full playbook's step; read that step
there and do it exactly as written, except where a line here says otherwise. One source of instructions is
how the two halves stay equivalent — a copy would drift.

**Why split at all.** Building several modules back to back and auditing them together costs less wall clock
than one full run per module, and the bar does not move: every audit the full pipeline runs still runs, per
module, against that module's own diff, before anything merges. What the split trades is rework: a defect
found late can force changes in modules built on top of the flawed one. The batch cap bounds that.

## Models

The orchestrator is this session, on `models.orchestrator`; seats route by their persona tier exactly as in the
full playbook — never override a seat's model. `features.orchestratorModel` on → run the orchestrator check
before step 0. An `unmeasured` result is not a pass: record it in the state file with the reason.

## Before step 0 — where the session runs

- **Start the orchestrating session inside the batch worktree.** Seats run in the session's own directory, not
  the one a command `cd`s into. If the session cannot start there, put `WORK IN: <absolute path of the batch
  worktree>` as the first line of **every** dispatch.
- **After any interrupted dispatch** (a user message, a timeout), assume the seat is **still running**: seats
  keep writing and committing after the orchestrator sees "interrupted". Before re-dispatching, read the log,
  the board and the harness's list of running agents; adopt what it finished — never start a second writer in
  the same worktree.

## Batch branch — one per batch, modules in sequence

- The **first** lite build of a batch cuts `lite/<batch-id>` from the integration branch in its own worktree.
  Every later lite build of the same batch commits **on that branch, after** the previous module — build order
  is branch order, and the gate batch replays it.
- **Dependencies are a real copy in the worktree whenever the run generates code into them** (an ORM client, a
  schema-derived type package). A linked or shared dependency folder lets one worktree's generate overwrite
  another session's generated output mid-run. A link is fine only for a run that generates nothing.
- **Index (step 0):** a code/doc index built per checkout is absent in a fresh worktree. Copy it in before step
  0, or record the absent verdict line exactly as the index check prints it and tell the index-using seats to
  fall back to plain search.
- One open batch at a time. `gate-queue add` refuses past `features.liteSplit.cap` open modules (exit `3`):
  run the gate batch. **Trigger the gate batch at `features.liteSplit.trigger`** open modules.
- Before starting: `node scripts/gate-queue.mjs status`. If a queued module is not `BUILT-UNGATED`-clean (a lite
  phase shows `OWED`), finish that one first.
- **Tiers.** If the project serialises tier runs behind a lock, a busy answer means wait and re-run — **never
  race the lock** and never cite a selective run as the evidence a full tier would have produced. **When tiers
  are held** (another team's release window): P2 row evidence may be a single-file test run, quoted with its
  totals line and marked `by-file (tiers held)` in Notes — but **P3 does not close on by-file evidence**; the
  full tiers run in P3 or the run waits. A remote tier runner counts as evidence only under the project's own
  rule for it.
- **Refreshing the batch branch from the integration branch** — merge, never rebase (a rebase rewrites the shas
  every `DONE` stamp points at). The merge moves shared files, so every queued module's P3/P3a go `OWED`
  again. That is expected: the gate batch re-proves them in its step 1.

## Run it

| Step | Do | Full-playbook reference | Lite difference |
|---|---|---|---|
| 0 | Index freshness gate | *Run it* 0 | index per the Batch-branch note above |
| 0b | Deferred sweep | *Run it* 0b | none |
| 0.5 | Track selection | *Phase 0.5* | none — lite is a split point, not a track; the board header reads `Track: <track> · lite (gate batch owed)` |
| 1 | Plan — `module-planner`, triaged blockers, board, plan check | *Run it* 1 | the board gets a status line under its header: `**Status:** BUILDING` |
| 2 | Code — `module-builder` in batches of `features.builderBatch.rows`, TDD per row, one commit per row at green, claims check at the end | *Run it* 2 | see the P2 notes below |
| 3 | Test — `module-tester`; the full tiers (`commands.tiers`); invariant candidates covered as story journeys | *Run it* 3 | none — candidate coverage belongs to P3 and is **not** owed to the batch. A candidate whose subject is a sibling module not yet built becomes `DEFERRED→<registry-ID>` naming that module |
| 3a | Free checks: the typecheck (`commands.typecheck`), the linter, and the architecture tier | — (new) | zero model tokens; a boundary break caught here costs one module, not a batch |
| 4 | **Queue hand-off, then stop** | — | below |

**P2 notes.**
- **A new module's scaffold row also updates every repo-wide oracle that counts or lists modules** (a roster, a
  fingerprint keyed by module) — creating the folder alone turns them red. Say in the row's Notes that a
  module **count** moved, not an effect, so the gate batch's drift step can tell the two apart.
- **Registry rows are filed in P2**, as a board row of their own: a lite run never reaches the full playbook's
  *Finish*, where the registry is normally updated. Do Finish item 3 (a) and (b) here; the lite exit requires
  every `DEFERRED→<id>` board row to have its matching registry row.
- **Claims check:** `node scripts/claims-check.mjs --run <key> --extended` — call it with `node`; some shells hand `--run`
  to the package manager instead of the script. An identical command runs once per check, so the last hand-back's
  claims result (below) counts when nothing changed since.
- **Hand-back check:** after EVERY builder return (each batch and each FIX lane) run the full playbook's *Hand-back
  check* — `node scripts/claims-check.mjs --run <key> --extended` and `node scripts/board-check-all.mjs --only <key>`.
  Failures go back to the same builder lane as `FIX-n` rows before the tester; 2 retries, then stop and escalate;
  a foreign ledger red is logged, not blocking. Record the result line in the FIX row's Notes cell or in the P2
  evidence below.
- **Proof rows** (a role × route matrix, a query-count guard, a forced-failure rollback) prove code built in
  earlier rows, so their seed cannot start red: write it, then prove it CAN fail by breaking the code under test
  once, and note `green-first, mutation-proven`.
- **A module that adds routes or operations** runs the architecture tier before P2 closes: estate-wide census
  checks in *other* modules' tests move with every new route, and no single-file run sees them.

Loop-back on a tester defect, and the fix-in-run rule, apply exactly as the full playbook's *Loop-back* and
*Fix in-run* sections say. A tester defect is fixed **in this run** — never queued for the batch.
The FIX-lane builder's return runs the hand-back check above before the tester is re-dispatched.

**Decision ids.** Before minting a block of decision ids, search `<decisions>`, the docs, `<boards>` **and
`<runs>`** of the main checkout **and every worktree**: a block reserved by a running plan lives only in that
worktree.

### Step 4 — the queue hand-off

```bash
node scripts/gate-queue.mjs add <key> --base <sha the module started from> --dir <module dir> --batch <batch-id>
node scripts/gate-queue.mjs mark <key> 1  --evidence "<plan check → result line>"
node scripts/gate-queue.mjs mark <key> 2  --evidence "board <n>/<n> settled; hand-back check → <result line @sha>"
node scripts/gate-queue.mjs mark <key> 3  --evidence "<each tier → its totals line>"
node scripts/gate-queue.mjs mark <key> 3a --evidence "typecheck → <line>; lint → <line>; architecture tier → <line>"
node scripts/gate-queue.mjs status
```

`--batch` is read only on the batch's **first** `add`, which fixes the id for the whole batch; left out, it is
derived from the branch name minus `lite/`. Every `--evidence` quotes the result line the command printed —
never a paraphrase, never a selective run. Each `DONE` is stamped with the current sha; if the module's files
change later, the gate batch sees the phase go `OWED` again by itself. Bookkeeping files (`<boards>`, `<runs>`,
handoffs, the decision log, the registry, `features.liteSplit.ledgers`) never re-open anything.

**Deferred requirements.** A requirement this run deferred may still read as open in the project's tracker, and
a requirements gate will stay red until the tracker's owner updates it. Send that update request **now**, at
lite exit, so the answer is back before the gate batch needs green gates.

Then: set the board's P3b–P7 phase rows to `OWED → gate batch`, change the board's status line to
`**Status:** BUILT-UNGATED`, commit the board + queue, rewrite the state file with
`**Now:** BUILT-UNGATED — queued`.

**Never, in a lite run:** bump the version, write the changelog, write the handoff pack, merge, tag, or mark
the work delivered in any tracker. Record decisions and needs-ruling items in `<decisions>` as usual — the gate
batch carries them into the pack.

## Finish

Report: module key, batch branch + position (`n` of cap), rows settled, the `DONE @sha` lines from
`gate-queue status`, what the module owes, and — at the trigger — **"batch ready: run
build-module-lite-gate-batch"**. Stop. One module per session.
