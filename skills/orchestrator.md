---
name: orchestrator
description: Use to run a batch of work from a plan — the commander and hub above the module pipeline. It digests a plan artifact into rows, resolves every inferred cell from the project's own sources, splits the rows into disjoint lanes with a level by rule (full pipeline, lite pipeline, or a SOLO agent), gets the human's OK, places each lane on a seat (a secondary-account terminal worker, or the primary account), routes eligible jobs to an API-credit headless worker, watches finish notices, merges finished lanes one at a time through the gates, and records everything so a killed session resumes from the state file. Requires features.orchestrator on. Trigger on "/orchestrator <plan>", "orchestrate this plan", "run the plan in lanes", "resume the orchestrator run". Not for building one module — that is build-module-pipeline.
---

# Orchestrator — the commander above the pipeline (feature `orchestrator`)

**The orchestrator is a layer above the pipeline, not a replacement for it.** It never builds anything itself.
Each lane worker runs exactly what a person would have run by hand — [`build-module-pipeline`](build-module-pipeline.md),
[`build-module-lite`](build-module-lite.md) (then [`build-module-lite-gate-batch`](build-module-lite-gate-batch.md)),
or one SOLO agent — on its own branch, board and worktree. The orchestrator decides *what runs where*, keeps the
lanes from touching each other, carries messages between them, and owns the merge order.

**Feature gate.** `features.orchestrator` in §16. Not enabled → every `node scripts/orch.mjs` command prints
`orchestrator: not configured` and does nothing: run the rows one at a time through the pipeline instead. The
credit lane is a separate switch, `features.orchestrator.credit.enabled`; off → the credit commands say
`credit lane: not configured`, and credit-eligible jobs run in their lane like any other work.

**Fixed steps live in `node scripts/orch.mjs`** (its header lists every command and exit code). This file is the
judgement. Templates: `templates/orchestrator-plan.md` and `templates/orchestrator-worker-brief.md` in the pack,
installed as `specs/orchestrator-plan.template.md` and `specs/orchestrator-worker-brief.template.md`. State:
`.pipeline/orchestrator/runs/<run>/state.json` plus `events.jsonl` in the primary checkout.

## 1. You route and record. You never read code.

- **Read only:** `orch` output, a result file's **first line**, heads-up files, plan rows. Never open the source
  tree or a diff: work that needs code reading goes to a worker (or a credit `code-reading` job) with a brief
  pointer. A commander that reads code runs out of context before the batch ends.
- **First action of every session, including after a kill or a compaction: `node scripts/orch.mjs status`.** Act
  only on its `next:` lines; never rebuild the run from scrollback. For each lane still `LAUNCHED` on the secondary
  seat, start `orch watch <run> <lane>` again in the background — that re-arms the finish notice the dead session
  held.
- **Two orchestrators on one run double-launch.** Take the run lease (`orch lease <run> --holder <name>`) and pass
  `--holder <name>` on every state change; another holder's live lease refuses you (exit 3).

## 2. Intake — from the person's artifact to an approved split

1. **A plan in the template's shape** goes straight to step 3. **Anything else** (a board, a list, a page) first:
   `orch digest <artifact>`. It keeps what the artifact states and marks what it inferred `⚠ CONFIRM`; rows the
   artifact marks finished, and every line that became no row, are listed under **Unmapped**.
2. **Resolve every `⚠ CONFIRM` from the project's sources** — search the docs and ledgers, decide, record the
   decision in the decision log (`paths.decisions`) with its citation, clear the cell. Read Unmapped: a missed task
   becomes a row, background stays. Ask the human **only** what no source settles. `orch digest --check <plan>`
   lists what is still open (exit 10 while anything is).
3. `orch preflight` — the project's own checks. Exit 6 = **one lane only**: say which checks failed and never work
   around one. No checks configured is also one lane.
4. `orch split <plan> --out .pipeline/orchestrator/runs/<run>/lanes.json`, then
   `orch init <run> --lanes … --mode <the preflight mode>`. `split` refuses while a CONFIRM is open.
5. **Show the human the split and wait.** Post `orch status <run> --split` (lanes, risks, levels, tracks, dispatch,
   reasons, queued hot files). On their OK: `orch approve <run> --by <who>`, and record the approval in the
   decision log. Nothing launches before it (`next` says `AWAIT-APPROVAL`).

**Levels are set by rule, with the reason logged per row** (`scripts/lib/orch-plan.cjs`): risk high → **Full** →
the full pipeline; record-only with no production-source file → **Micro** → SOLO; everything else **Standard** →
`features.orchestrator.standardPipeline` (full, or lite). Your one judgement: **raise** a level when the plan
under-flags a row — add a `level` hint and re-split. Never lower one. **Lanes start at `maxLanes`**; raise them only
with `split --max-lanes N --measured <file>`, the file holding measured runs that show the test host and the accounts
carried the load.

## 3. Place and launch a lane

For each `LAUNCH <lane>` line, in order:

1. `orch claim <run> <lane>` — exit 3 means another live lane holds one of its files: do not launch; re-split, or
   wait for the holder to merge.
2. Create the lane worktree on the lane branch, cut from `target`, and install what its tiers need.
3. Write the brief from the worker-brief template into the lane's `brief` path: its rows, its files, its dispatch,
   the rules, the done-test, the result path. Pointers, never pasted docs.
4. **Place it where `next` says** (`on secondary` / `on primary`). Placement follows `features.orchestrator.seats`
   and each seat's usage `limits`; read usage fresh before every launch (`orch usage-read <run>`, or
   `orch usage <run> <seat> <pct>` by hand). The primary seat's limit sits below the secondary's, because this
   session runs on that account too. `USAGE-HOLD` / `USAGE-UNKNOWN` → launch nothing and say why.
   - **Secondary seat — a terminal worker on the second account.** `orch gate-launch <run> <lane>` refuses a lane
     `next` does not say to launch and records the git config/hooks baseline; run the `launch` command it prints,
     then `orch set <run> <lane> status=LAUNCHED seat=secondary sessionId=<id>`, then start
     `orch watch <run> <lane>` **in the background** — its exit is the finish notice (0 DONE · 7 stall).
   - **Primary seat.** A SOLO lane: dispatch a sub-agent with the brief pointer; it writes its details to the result
     path and returns one line. A pipeline lane (full or lite) needs a session of its own on the primary account —
     seats never dispatch, so a sub-agent cannot run a pipeline's seats. Then
     `orch set <run> <lane> status=LAUNCHED seat=primary sessionId=<id>`.
   - Never start a worker in a permission-bypass mode.

## 4. While lanes run — the hub

- **Messages carry pointers, never content**: "brief at X; write the result to Y"; "heads-up at Z".
- **Never poll, never sleep-loop.** The watcher records the notice itself; `orch wait <run>` blocks until the run
  logs an event (at most 110 s per call). A primary-seat sub-agent's one-line return is its notice:
  `orch notice <run> <lane>`.
- `DONE` means line 1 of the result was read → `orch enqueue <run> <lane>`. A finish with no result file, or a
  changed git config or hook, is `STALLED` — never DONE.
- **Stall** (watcher exit 7, or a `STALL` / `CHECK` line): a `blocked` session is parked on a prompt nobody can
  answer — name the prompt from the session's last lines, stop it, fix the cause in the brief or the launcher,
  relaunch. On a second stall move the lane to the other seat and tell the human. A stalled or failed lane's work is
  pinned by snapshot refs (`orch snapshots <run>`) before anything else touches it.
- **A worker reports `READY: <tiers> @ <sha>`**; the heavy tiers are yours, through the merge (§6). **You own this
  machine's test slot and the merge order** — no other session is asked: run one heavy local tier at a time, and
  never start one while a merge's gates run. `status` and `next` print where the tiers run (`orch set tests
  local|remote`; remote only when the human says).
- **A worker reports `WAIT-P4 <key> @ <sha>`** (only with `credit.enabled`, when its brief routed the P4 auditors to
  credit): `orch credit-audit <run> --key <key> --worktree <lane worktree>` (add `--tester` when the brief routed P3
  too; `--dry` lists the jobs first). It builds each seat's job from the gate queue's own range and changed files, on
  `models.strong` / `models.mid`. Start the credit queue (§5), check every `<runs>/<key>/findings-<seat>.json` with
  `node scripts/output-check.mjs findings … --diff-base <queue base>`, mark P4 in the gate queue, and resume the worker.
  Account faults fall back on their own; a job fault (findings that fail the check) you re-run, or hand the seat back
  to the worker.
- **One writer at a time** applies to the run's records: lane workers write their own boards; you write the run's
  decision rows and nothing in a lane's worktree.

## 5. Credit jobs (only with `credit.enabled`)

Bounded jobs — `code-reading`, `record-fixes`, `docs`, `sweeps`, and the `module-tester`, `standards-auditor`,
`security-auditor`, `invariant-auditor`, `vuln-auditor` seats — may run headless on an API credit balance.
Building, planning, reviewing and orchestrating stay on the plan accounts; the lane refuses them.

1. `orch credit-prep <run> <task> --key <key> --kind <kind> --scope "<globs>" --worktree <lane worktree> --brief <file> --model <id>`.
   It refuses a model below the kind's floor (`models.strong` / `models.mid`), a tester scope outside the test
   roots, and a brief citing a file absent from the worktree (copy gitignored files in first, or `--allow-missing`
   when the job creates it).
2. Start the queue **in a shell that supplies the API key** (the adapter names how): `orch credit-run --all-queued`
   from the lane worktree. Never read, print or set the key yourself.
3. Read the verdict line. Job faults — a denied action, a change outside scope, a git config or hook change, no
   `RESULT: PASS` — never fall back: fix the brief. Account faults — over a cap, credit out, an API error, a 429 —
   fall back down `credit.fallback` (secondary, then primary) on their own.
4. **Review before merge.** A job that changed files is `REVIEW PENDING` (`status`, `next` and `credit` list it).
   Read its diff against the evidence rules in its prompt, then `orch credit-review <run> <task> --by <you>`, or
   `--reject "<why>"`; a rejected job's changes are reverted, then `--reverted`. `orch merge` refuses a lane holding
   a pending or rejected job.
5. `orch credit` is the meter (period, spend across every worktree, today against `dailyCapUsd`); `orch set workers
   off` stops every credit start.

## 6. Merge, conflicts, records

- **Merge one lane at a time:** confirm nothing else is running heavy tiers on this machine, then
  `orch merge <run> --slot-ok`. It builds the merge on `orch/integration` from the target's current tip, runs
  `gates` there, and moves `target` by compare-and-swap only on green — never the release branch unless the profile
  makes it the target. Exit 12: the target is checked out somewhere; run the printed `git merge --ff-only`, then
  merge again.
- **Version at merge.** Lanes release in parallel, so two can claim the same next version. Before merging a lane
  whose version is not above the target's, re-version it in its worktree: the project's version files, the
  changelog heading, and any generated file that carries the version, in one commit. Then merge it and record the
  decision.
- **Stale claims.** A claim held by a paused run, by a MERGED or FAILED lane, or by a run that no longer exists blocks
  new claims on the same files. `orch release-stale` lists them. `--apply` frees them only after you have confirmed
  that the new lane owns the same work; record that in the decision log. A live run's claim is never stale.
- **Exit 4 = conflict or target moved.** A heads-up file is written; send the human its path. Brief the lane worker:
  merge the target into its branch in its own worktree, keep both sides' planned work, re-run its tiers,
  `orch enqueue` again.
- **Exit 5 = gates red.** Send the lane a FIX pointer with the gates log path; tell the human.
- **Never** delete, force-push, reset, rebase a shared branch, rewrite history, or drop planned or built work to
  make a merge pass.
- After each merge: release is automatic (claims); run the worktree sweep the playbook's *Finish* names
  (`node scripts/worktree-sweep.mjs --apply`) — never remove a worktree by hand. `worktreeSweep: not configured` →
  the manual fallback there.

| record | where |
|---|---|
| plan progress | each lane's board `<boards>/<key>.md` (written by its worker) |
| your decisions (CONFIRM resolutions, approvals, level raises, placements moved, stalls, fallbacks) | `paths.decisions`, one row each: what · citation · why · how to reverse |
| deferrals | `paths.registry` |
| questions for the human | the profile's channel (§13), one item each, marked blocking or non-blocking |
| run state | `.pipeline/orchestrator/runs/<run>/` — the state file is the truth, never your memory |

## 7. Pause, stop, close-out

- `orch pause` blocks new launches and merges in every run; `orch stop` also stops each live worker
  (`stopCommand`); `orch resume`, then `status` shows the `RELAUNCH` lines. "Pause" or "stop" from the human means
  now; only their explicit "resume" restarts.
- **Close-out.** When `next` says `RUN COMPLETE`, every lane merged: confirm each lane's board reached its own
  close-out, sweep the worktrees, record the batch result in the decision log, and hand the human one summary —
  lanes, rows, merge shas, decisions taken, open questions.
- **Merged is "In review", never "Reviewed".** A merged row is In review in every merge record, hand-back and
  tracker handoff row. Reviewed is the human's sign-off only: the orchestrator, its workers and the reviewer seat
  never write it — a MERGE-READY verdict is agent review, not human review.
