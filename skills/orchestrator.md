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
4. **Index freshness, once per batch** (only when `features.graph` is configured; otherwise record
   `graph: not configured` and go on). Lanes run in fresh worktrees that hold no index, and a lane worker cannot
   stop to ask a person. So the index is brought up to date here, in the primary checkout, and every lane copies
   it (§3 step 2). Run `node scripts/index-check.mjs` and branch on its exit code:
   - `0` fresh → go on.
   - `11` code behind → run `features.graph.syncFree` (free), re-check.
   - `10` / `12` docs pending → run `features.graph.sync` (it embeds up to `features.graph.autoLimitKb`),
     re-check.
   - Still `10` / `12` because the pending docs are **above** the limit → **ask the human now, once for the
     batch**: the pending count, the size, and that the embed spends model tokens. Embed on a yes; on a no,
     record the decline. Either way, write the decision in the decision log with the final `verdict:` line.
   - `3` / `4` / `1` → record the verdict (and the error for `1`); lanes locate with plain search.

   The final `verdict:` line is the batch's **Graph line**. It goes in the split you post at step 6 and in every
   lane brief.
5. `orch split <plan> --out .pipeline/orchestrator/runs/<run>/lanes.json`, then
   `orch init <run> --lanes … --mode <the preflight mode>`. `split` refuses while a CONFIRM is open.
6. **Show the human the split and wait.** Post `orch status <run> --split` (lanes, risks, levels, tracks, dispatch,
   reasons, queued hot files) with the batch's Graph line. On their OK: `orch approve <run> --by <who>`, and record
   the approval in the decision log. Nothing launches before it (`next` says `AWAIT-APPROVAL`).

**Levels are set by rule, with the reason logged per row** (`builder/scripts/lib/orch-plan.cjs`): risk high → **Full** →
the full pipeline; record-only with no production-source file → **Micro** → SOLO; everything else **Standard** →
`features.orchestrator.standardPipeline` (full, or lite). Your one judgement: **raise** a level when the plan
under-flags a row — add a `level` hint and re-split. Never lower one. **Lanes start at `maxLanes`**; raise them only
with `split --max-lanes N --measured <file>`, the file holding measured runs that show the test host and the accounts
carried the load. With a standing `features.orchestrator.capacity` policy, `split --measured <file>` alone sizes the
split from the file's last reading for the capacity seat.

## 3. Place and launch a lane

For each `LAUNCH <lane>` line, in order:

1. `orch claim <run> <lane>` — exit 3 means another live lane holds one of its files: do not launch; re-split, or
   wait for the holder to merge.
2. Create the lane worktree on the lane branch, cut from `target`, and install what its tiers need. `orch worktree
   <run> <lane>` creates it (a fresh branch, `features.accounts.worktree.include` files copied in, only the roots of
   a path-root account); `gate-launch` creates it the same way when it is absent. If a
   `linkDirs` entry (an installed dependency tree) is linked from the primary checkout instead, never let the lane
   reinstall there: a reinstall deletes THROUGH the link and empties the install every lane shares.
   `orch link-guard <worktree> --brief <file>` says so (exit 4 a link · 3 a link and a brief naming any reinstall
   step — `gate-launch` refuses that lane); unlink it yourself with the command it prints before the launch. No brief
   wording exempts it.
   **Copy the index** (when `features.graph` is configured): copy the primary checkout's index folder, the one
   `features.graph.check` reads (`graphify-out/` for graphify), into the lane worktree. It is gitignored, so the
   worktree starts without it. Leave out the per-checkout lock, log and status files (for graphify: `.sync.lock`,
   `.sync.log`, `.autosync-status.json`). Copy, never link: the lane's free code sync rewrites the index for the
   lane's own diff and must not touch the primary's. Then run `node scripts/index-check.mjs` in the worktree. An
   `absent` verdict there means the copy failed: fix it before the launch.
3. Write the brief from the worker-brief template into the lane's `brief` path: its rows, its files, its dispatch,
   its `Account:` line (the account `next` places it on), the rules, the done-test, the result path. Pointers, never
   pasted docs. `orch brief <run> <lane>` prints the skeleton with the lane facts and the account filled in
   (`--write` writes it once, never over an existing brief); you fill the rest.
4. **Place it where `next` says** (`on <account>`). Which account a job may go to — ready only, the content class
   against the project's visibility, the role against the account's `roles`, the soft limit and `needs-account`, the
   pays order with `api-key` last, holds and the one retry, never a resume across accounts — is the rulebook
   `build-module-pipeline/references/account-selection.md` (installed beside the pipeline skill). The kit enforces its fixed parts inside
   `next`, `claim` and `gate-launch`; the judgement parts are yours. In 1.0 terms placement follows `features.orchestrator.seats`
   and each seat's usage `limits`; read usage fresh before every launch (`orch usage-read <run>`, or
   `orch usage <run> <seat> <pct>` by hand). The primary seat's limit sits below the secondary's, because this
   session runs on that account too. `USAGE-HOLD` / `USAGE-UNKNOWN` → launch nothing and say why.
   - **Secondary seat — a terminal worker on the second account.** `orch gate-launch <run> <lane>` refuses a lane
     `next` does not say to launch and records the git config/hooks baseline; run the `launch` command it prints,
     then `orch set <run> <lane> status=LAUNCHED seat=secondary sessionId=<id>`, then start
     `orch watch <run> <lane>` **in the background** — its exit is the finish notice (0 DONE · 7 stall). Take the
     session id from the launch log with `orch launch-id <log>` (Claude Code): a resume with flags starts a COPY,
     and the first id in the log is the old session, whose `done` would stall the lane at once.
   - **Primary seat.** A SOLO lane: dispatch a sub-agent with the brief pointer; it writes its details to the result
     path and returns one line. A pipeline lane (full or lite) needs a session of its own on the primary account —
     seats never dispatch, so a sub-agent cannot run a pipeline's seats. `features.orchestrator.primaryLaunch`
     says who starts it: `manual` (the default) → ask the human to start it in the lane worktree with the brief
     pointer; `app-session` → start it yourself through the harness's session tool, in the lane worktree, with the
     brief pointer as its whole prompt (the adapter names the tool and its limits). Either way, then
     `orch set <run> <lane> status=LAUNCHED seat=primary sessionId=<id>`. The session's turn-end note is only a
     trigger: read line 1 of the result file before `orch notice <run> <lane>`, as for any primary-seat lane.
   - Never start a worker in a permission-bypass mode.

## 4. While lanes run — the hub

At run start, beside `board-watch` and the lane watchers, start the progress reporter once in the background when
`features.reporter` is on: `npx builder-pipeline run report --watch`. It sends one report per interval on the configured
channels, only on change, and never fails the run; a second start exits at once naming the live watcher's pid.

- **Messages carry pointers, never content**: "brief at X; write the result to Y"; "heads-up at Z".
- **Capacity governor** (`features.capacity`, default off; 2.1.0): at run start, start
  `npx builder-pipeline run capacity --watch` in the background beside the board watcher (one watcher per orch root
  holds a pid lease; a second one exits saying so). Its record is one more term in the lane cap: `orch next`
  prints `CAPACITY: lanes capped at N of M — <signal>`, `gate-launch --resume` counts it as a slot limit, and the
  loop runner holds at 0 lanes (stop reason `capacity` after `holdMaxMinutes`). It lowers only and never stops a
  lane. When the line has bound for `explainAfterTicks` ticks, or a person asks why fewer lanes run, dispatch the
  read-only `capacity-steward` persona: it explains the binding signal with its figures and drafts one profile
  change and one decision row. Never raise the cap yourself.
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
  to the worker. If a FIX moved the lane's code after `gate-queue add`, `node scripts/gate-queue.mjs retip <key> --tip
  <sha>` first — the credit jobs read the queue's RECORDED range.
- **`SELF-AUDIT <lane>`** (instead of ENQUEUE): the lane is at WAIT-P4 but the credit lane is busy with other work and
  holds no seat job of the lane's own. Resume the worker to run its owed seats itself:
  `orch gate-launch <run> <lane> --resume` (refused unless `next` offers SELF-AUDIT for it and a lane slot is free).
- **`ADD-LANES`** (only with `features.orchestrator.capacity`): the capacity seat is freshly measured under its
  percentage and fewer than `laneCap` lanes are live. Pull that many rows from the run's plan into a new split for the
  human's OK; never start lanes the human has not approved.
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
   from the lane worktree, or from anywhere with `--queue <worktree>` (a worktree of this repo; the prep command
   prints the exact line). One runner per queue; one job per target worktree at a time, whichever queue it came
   from. Read-only kinds run first, writing kinds last. Never read, print or set the key yourself.
3. Read the verdict line, and every `REFUSED <job>: <reason>` the queue summary lists. Job faults — a denied action,
   a change outside scope, a git config or hook change, no `RESULT: PASS` — never fall back: fix the brief. Account
   faults — over a cap, credit out, an API error, a 429 — fall back down `credit.fallback` (secondary, then primary)
   on their own. A dirty-tree refusal names the credit job whose verdict left the files: review and commit (or
   revert) that diff first.
   - **Re-run a finished job** only with `orch credit-run <run> <task> --rerun [--queue-only]`: the old verdict moves
     aside and the meter keeps it. Refused while its review is PENDING or REJECTED; after FAILED-INTEGRITY or
     FAILED-SCOPE, restore git config/hooks and remove the stray files first, then add `--cleared-by <you>`.
4. **Review before merge.** A job that changed files is `REVIEW PENDING` (`status`, `next` and `credit` list it).
   Read its diff against the evidence rules in its prompt, then `orch credit-review <run> <task> --by <you>`, or
   `--reject "<why>"`; a rejected job's changes are reverted, then `--reverted`. A moved-aside verdict that still
   holds the lane is signed with `--verdict <file>`. `orch merge` refuses a lane holding a pending or rejected job in
   any queue of the repo, and a lane whose worktree folder is gone (its hold cannot be read).
5. `orch credit` is the meter (period, spend across every worktree, moved-aside verdicts included, running jobs'
   budgets reserved; today against `dailyCapUsd`); `orch set workers off` stops every credit start. For a lapsing
   budget, `CREDIT-FILL` says how far behind pace the spend is and names light jobs to queue.

## 6. Merge, conflicts, records

- **Merge one lane at a time:** confirm nothing else is running heavy tiers on this machine, then
  `orch merge <run> --slot-ok`. It builds the merge on `orch/integration` from the target's current tip, runs
  `gates` there, and moves `target` by compare-and-swap only on green — never the release branch unless the profile
  makes it the target. Exit 12: the target is checked out somewhere; run the printed `git merge --ff-only`, then
  merge again.
- **Version at merge.** Lanes release in parallel, so two can claim the same next version. Before merging a lane
  whose version is not above the target's, re-version it in its worktree: the project's version files, the
  changelog heading, and any generated file that carries the version, in one commit. Then merge it and record the
  decision. With `features.orchestrator.mechanical` set, `orch merge` does this itself for the files it names: the
  lane's bump is applied on top of the target, its changelog section re-versioned with a note line, JSON manifests
  merged by key and append-only ledgers by line; any other conflict still stops, and the heads-up names both sets.
- **Stale claims.** A claim held by a paused run, by a MERGED or FAILED lane, or by a run that no longer exists blocks
  new claims on the same files. `orch release-stale` lists them. `--apply` frees them only after you have confirmed
  that the new lane owns the same work; record that in the decision log. A live run's claim is never stale.
- **Exit 4 = conflict or target moved.** A heads-up file is written; send the human its path. Brief the lane worker:
  merge the target into its branch in its own worktree, keep both sides' planned work, re-run its tiers,
  `orch enqueue` again.
- **Exit 5 = gates red, or HYGIENE GATE FAIL.** Send the lane a FIX pointer with the gates log path; tell the human.
- **The completion gate in the merge.** With `hygiene-gate` among `features.orchestrator.gates` (a list:
  `["hygiene-gate", "<gates command>"]`), `orch merge` runs `hygiene --gate --since <target>` over the lane's diff in
  the integration worktree before the gates command. A FAIL row refuses the merge: exit 5 with the rows on stderr,
  the lane FAILED and out of the queue like gates red, the rows in its gates log. Send the lane one FIX pointer per
  failing row. A soft finding in a lane's hygiene report (`hygiene --json`) goes to the `repo-steward` persona
  (read-only: keep, fix or allow with a reason and the §16 row that records it), never to a sweep with `--apply`.
  `hygiene gate: not configured` in the log (no gate check is on) is not a pass: the gates command decides alone,
  and the §16 line that would turn a gate check on is the human's.
- **Never** delete, force-push, reset, rebase a shared branch, rewrite history, or drop planned or built work to
  make a merge pass.
- After each merge: release is automatic (claims); run the worktree sweep the playbook's *Finish* names
  (`node scripts/worktree-sweep.mjs --apply`) — never remove a worktree by hand. `worktreeSweep: not configured` →
  the manual fallback there. Once a lane is MERGED and `features.branchSweep` or `features.worktreeSweep` is on,
  `orch next` prints a `SWEEP branches` / `SWEEP worktrees` line naming the dry run; the removal is the human's,
  and `next` never names `--apply`.

**Staging and commit rules.** Stage files by name, never `git add .` or `git add -A`; inspect
`git diff --cached --name-status` before the commit; a plain commit message and a plain PR title and body with no
attribution trailer and no generated-content footer; remove scratch output before the close-out; run the completion
gate (`hygiene --gate --since <base>`) before the push. A FAIL row is a FIX row, never a line to delete.

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
