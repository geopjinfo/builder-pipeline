---
name: build-module-lite-gate-batch
description: Run the second half of the build-module-pipeline over every module that build-module-lite queued as BUILT-UNGATED — batch-wide drift and tiers, then per module in build order the four auditors (each on its own diff), docs, ledger audit and reviewer, then the behavioural gate, the fix loop, the release commit and a GATED close-out — so each module ends exactly where a full pipeline run would have left it. Reads <boards>/_gate-queue.md to know what is already checked and what is owed. Requires features.liteSplit enabled.
---

# Build-module lite — gate batch (feature `liteSplit` — experimental)

**The second half of [`build-module-pipeline`](build-module-pipeline.md), run once over the modules
[`build-module-lite`](build-module-lite.md) queued.** Same orchestrator role, same seats, same order, same
validation commands, same fix-in-run rule, same loop-back, same close-out. The only differences come from doing
several modules at once, and each is named below. Everything else: read the full playbook's step and do exactly
that.

**Who runs it.** A person's session, or the batch orchestrator ([`orchestrator`](orchestrator.md)) once its `lite`
lanes have queued their modules — as one more lane, in its own worktree. The batch's branch then merges through
`orch merge` like any other lane: one at a time, gates first.

## How it knows what to check — the queue

`<boards>/_gate-queue.md` is the record; `node scripts/gate-queue.mjs` is its only writer. Before every decision:

```bash
node scripts/gate-queue.mjs status        # exit 0 nothing owed · 10 something owed
```

It prints, per open module and for the batch, every phase still `OWED` **at HEAD**, and every `DONE @sha` still
valid:
- a phase never done is owed;
- a module phase `DONE @sha` is owed again if a later commit touched that module (its `base..tip` files or its
  module dir) — bookkeeping files and docs-only files excepted;
- a batch check is owed again if any non-bookkeeping file moved since its sha.

**Do what `status` says is owed, in the order below, and nothing it says is done.** Re-run it after every fix
commit — it is the loop's condition, not a report.

## Models and session

As in [`build-module-lite`](build-module-lite.md): the orchestrator on `models.orchestrator`, seats by persona
tier, never overridden; the session starts inside the batch worktree (else `WORK IN: <path>` heads every
dispatch); after an interrupted dispatch assume the seat is still writing and read the log, the boards and the
running agents before re-dispatching; a busy tier lock is waited on, never raced, never replaced by a selective
run. One gate batch per session; `<runs>/gate-batch-<batch-id>/state.md` is this run's state file — rewrite it at
every step gate, re-read it (then `status`, then the batch board) after any compaction.

## Run it

### 0. Entry

1. `node scripts/gate-queue.mjs status` — at least one open module; every lite phase (1, 2, 3, 3a) `DONE`. A lite
   phase `OWED` has two causes. **The lite run is unfinished** → stop, finish it there. **The batch branch was
   refreshed from the integration branch after the lite run** → P3/P3a re-open by design: re-prove them here —
   step 1's tiers plus the typecheck, the linter and the architecture tier — then `mark <key> 3` / `3a` with that
   evidence, and record a decision saying which merge re-opened them.
2. `node scripts/gate-queue.mjs board` → `<boards>/gate-batch-<batch-id>.md` (generated: `B0` batch checks, then
   one counted section per module in build order). This board is the run's progress surface. Keep each module's
   own board too — its P3b–P7 rows flip from `OWED → gate batch` as they close, and `FIX-n` rows go on **the
   module's own board** (mirrored under its section on the batch board). `gate-queue mark` **regenerates** the
   batch board: make hand edits only after the last `mark` / `close`.
3. Per module, open its run log (`<runs>/<key>/run.jsonl`) as the full playbook's step 1 says — every gate,
   step, finding and decision from here on is logged there, and the handoff pack reads it.
4. Deferred sweep (full playbook step 0b) once for the batch.

### 1. Batch checks, first pass — B0

In this order, each through `commands.tier` (never bare), each logged in **every** open module's run log:

| Check | Command | Full-playbook reference |
|---|---|---|
| `3b` | the drift oracles (profile §14) | 3b — never re-baseline to go green |
| `gates` | the gates tier | P6 readiness |
| `integration` | the integration tier | P3 |
| `e2e` | the e2e tier, if the project has one — else record `e2e: not configured` | P6 readiness |

A red is attributed to the module whose `base..tip` owns the failing file → a `FIX-n` on that module (step 5).
**One expected drift exception:** a lite scaffold row re-baselines a fingerprint keyed by module because a new
module folder moves the module **count**. Accept it when the lite board's scaffold row records it and the
baseline diff shows only the new module's entry; any other moved or removed effect is red. Mark each green one:
`node scripts/gate-queue.mjs mark batch <check> --evidence "<command → result line>"`. **Read every tier by its
own exit code** — piping a tier into a pager or `tail` reports the pager's exit, not the tier's.

**Why first:** a red tier found before four auditors read the module is one fix; found after, it is a fix plus
four stale audits.

### 2. Per module, in build order — B1…Bn

For each open module, **one module at a time**, oldest first — module 2's auditors must read a tree in which
module 1's fixes have already landed:

**P4 on credit, when orchestrated.** When this batch runs as a batch-orchestrator lane whose brief says the P4 seats
run on credit, do NOT dispatch them. When P4 is `OWED` and any `<runs>/<key>/findings-<seat>.json` is missing, write
`RESULT: PASS WAIT-P4 <key> @ <sha>` and stop. The orchestrator runs `orch credit-audit`, checks the findings, marks
P4 and resumes you. If one of your FIX rows later re-opens P4, stop with `WAIT-P4` again. Otherwise:

**P4 — four auditors.** Full playbook step 4, exactly — the one difference: **the diff range is the module's
own.** Every auditor's dispatch carries `DIFF-RANGE: <base>..<tip>` from the queue, and the findings check runs
with `--diff-base <base>`. The auditor seats are read-only: each RETURNS its findings in its final message;
**the orchestrator** writes `<runs>/<key>/findings-<seat>.json` from that return and runs
`node scripts/output-check.mjs findings <runs>/<key>/findings-<seat>.json --diff-base <base>`. Put the checker's
vocabulary in every auditor's return shape: severity `blocker | warning | nit`; verdict
`PASS | PASS-WITH-RULINGS | CHANGES-REQUIRED`. When all four pass: `mark <key> 4`.

**P5 — docs.** Full playbook step 5, including the claims check after it
(`node scripts/claims-check.mjs --run <key> --extended`). `mark <key> 5`. README and other docs-only files the docs seat
writes do **not** re-open P3/P3a/P4; a change to the published contract does, and step 4 re-proves it. Never
run a tier while the docs seat is editing the contract in the same tree.

**P7a — ledger audit, before the reviewer** (full playbook *Fix in-run*, order at close-out). Its findings join
the FIX lane, and that lane's return runs the hand-back check (step 5).

**P6 — review.** Full playbook step 6 — the reviewer gets the module's `base..tip` diff, its plan and the
structured findings; `node scripts/output-check.mjs review <runs>/<key>/review-pass<n>.md`. `mark <key> 6`.

### 3. P6.5 behavioural gate — once, at the batch tip

Full playbook step 6.5 (profile §14), or `behavioural gate: not configured`. A new failure is attributed to the
module whose routes or effects it touches → `FIX-n` there. `mark batch 6.5`.

### 3a. Release commit — BEFORE the final pass

For each module, in build order: the version bump per profile §11 (successive, one per module) + its changelog
entry + any contract regeneration that stamps the version, one commit per module. A lock file or a regenerated
contract is **not** bookkeeping, so this commit re-opens every check — which is exactly why it comes before step
4 and not at close-out: the final pass then proves the released tree, and close-out commits only bookkeeping.

### 4. Final pass — nothing owed at the tip

`node scripts/gate-queue.mjs status`. Every check a fix or the release commit re-opened runs again now, in the
step order above (batch checks first, then per module). Loop until `status` shows nothing owed but `7`.

### 5. Fix loop — any seat, any step

Full playbook *Fix in-run* and *Loop-back*, exactly: verified blockers only → `FIX-n` rows on the owning
module's board → `module-builder` with the list last → always re-run that module's P3 and the drift check. Then
**`status` decides what else re-runs** — do not re-run by feel and do not skip what it lists. A blocker that
survives two loops → stop and escalate. A fix that touches two modules is two `FIX-n` rows and re-opens both.

**Hand-back check after every builder return** — every narrow FIX lane, including the P7a ledger-audit lanes —
before that module's P3 re-run: the full playbook's *Hand-back check* (`claims-check --run <key> --extended`,
`board-check-all --only <key>`). Failure → back to the same FIX lane as new `FIX-n` rows; 2 retries, then stop and
escalate; a foreign ledger red (another module's work in progress) is logged, not blocking. Record the result
line in the FIX row's Notes cell. `gate-queue mark` evidence is unchanged.

### 6. Close-out — per module, in build order

For each module, oldest first, the full playbook's *Finish* items 1–3 and 5: close its board, earn each `DONE`,
update the registry (the version bump was step 3a), then the hygiene report and the completion gate over the
module's range (`node scripts/hygiene.mjs --since <base> --json`, then `node scripts/hygiene.mjs --gate --since <base>
--json`): a hard finding or a `FAIL` row is a FIX row (step 5) and the module does not close; no check on →
`hygiene: not configured`, recorded, never a pass. Then its handoff pack
(`node scripts/handoff-pack.mjs <key> --base <base>` and `node scripts/handoff-check.mjs <handoffs>/<date>-<key>-handoff.md`).
Then:

```bash
node scripts/gate-queue.mjs mark <key> 7 --evidence "<handoff check → result line>"
node scripts/gate-queue.mjs close <key>          # refuses (exit 2) while anything is owed
```

These commits touch only bookkeeping, so they stale nothing. If a close refuses, `status` names what moved — go
back to step 4. When every module is `GATED`, append `run.end` to every module's run log, report, then
`node scripts/gate-queue.mjs reset` in the same commit as the batch board's close.

## Finish

Report per module the full playbook's *Finish* summary, plus the batch lines: modules `GATED` in build order,
versions assigned, FIX rows per module, which checks re-ran because `status` re-opened them. The merge of
`lite/<batch-id>` into the integration branch follows the project's own merge rule, as for a full run.

**Staging and commit rules.** Stage files by name, never `git add .` or `git add -A`; inspect
`git diff --cached --name-status` before the commit; a plain commit message and a plain PR title and body with no
attribution trailer and no generated-content footer; remove scratch output before the close-out; run the completion
gate (`hygiene --gate --since <base>`) before the push. A FAIL row is a FIX row, never a line to delete.

**Worktree cleanup.** Do not remove the batch worktree yourself: the merge has not happened yet. Whoever merges
`lite/<batch-id>` runs `node scripts/worktree-sweep.mjs --apply` from the primary checkout afterwards (the full
playbook's *Finish* item 8): it removes the worktree once it is merged, clean and idle, backs up its gitignored
evidence first, unlinks the `node_modules` junction safely and keeps the branch. `worktreeSweep: not configured`
→ the manual fallback in that item.
