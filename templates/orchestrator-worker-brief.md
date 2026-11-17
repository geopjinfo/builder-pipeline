# Orchestrator worker brief — template

The orchestrator fills one per lane at the lane's `brief` path (`<runs>/orchestrator/runs/<run>/briefs/<lane>.md`,
printed by `orch status`). The worker — a secondary-seat terminal session or a primary-seat sub-agent — gets only
this file: its rows, its files, the rules, the done-test and where to write the result. Fill every `<…>`. Keep it to
pointers: link the plan rows and the docs, never paste them.

---

```markdown
# Brief — <run>/<lane>  (<level>/<track> · dispatch <full|lite|solo>)

## Your rows (in this order)
| row | title | level/track | reason |
|---|---|---|---|
| <id> | <title> | <level>/<track> | <reason from lanes.json> |

Source of truth for each row: <tracker row / requirement / ticket pointer>.
How to run them:
- dispatch full → the build-module-pipeline skill for track <track>, one run per row, brief from
  templates/module-brief.md;
- dispatch lite → the build-module-lite skill (the gate batch runs later, before anything merges);
- dispatch solo → no pipeline: do the record change yourself — SOLO may never touch production source.

## Your files
- Owned (claimed for you; edit freely): <ownedFiles>
- Hot (shared; edit only as the row requires, expect the merge queue to serialise them): <hotFiles>
- Anything else: do NOT edit. If a row needs another file, stop and write `RESULT: FAIL needs <file>`.

## Where you work
- First step, before anything else: confirm that the skill your dispatch names (and every plugin it needs) is
  available in this session. If one is missing, write `RESULT: FAIL missing <what>` as line 1 of the result file
  and stop. A lane without its skills would run the pipeline from memory.
- Account: <account> (worker <worker>, pays <pays>) — the account the orchestrator placed this lane on (`orch next`; the
  rules are in the orchestrator skill's `references/account-selection.md`). Run on it only. Never resume this lane on
  another account; a lane that must move starts again from its branch with a new brief.
- Worktree: <worktree>   Branch: <branch> (cut from <target>)
- Never: push, force, reset --hard, delete branches or worktrees, rewrite history, touch the release branch,
  local settings files, unlocks or the allow list.
- Tests: <the tiers this lane may run itself, e.g. unit + the affected-tests command>. Do NOT run the heavy tiers
  the orchestrator owns (<e.g. integration, gates>). Report `READY: <tiers> @ <sha>` and the orchestrator runs them
  through `orch merge`.
- Output files: write every tier/command output under `<worktree>/<logs dir>/` (gitignored). Never redirect to
  `../` or to the worktree root: loose files in the parent folder are never cleaned up, and untracked files in the
  worktree root make it dirty, so the worktree sweep keeps it forever.
- Context budget: your thread dispatches and decides only. Heavy steps (reading specs, building rows, seats, packs)
  go to one sub-agent that returns at most 10 lines (`RESULT` · sha · digest · wrote · ids · open · next) with the
  full output in a file. Run long tiers detached where the harness allows. Update `<runs>/<key>/state.md` after every
  step; after a reset or a compaction read `state.md`, then continue.
- On entry, check `<registry>` for deferred rows this lane unblocks; fold them into the board and list them here:
  <ids, or "none — checked">.
- Records go where the profile puts them: the board `<boards>/<key>.md`, decisions in `<decisions>`, deferrals in
  `<registry>`, questions to the human through the profile's channel (§13).
- Index: copied into this worktree from the primary. The batch's Graph line is `<graph verdict line>`, decided in
  `<decision log ref>`. At the pipeline's index step, run the free code sync if the check says code is behind.
  Never stop to ask about pending docs: the orchestrator already settled that for the batch. Record the batch
  decision on your `Graph:` line and go on.

## Seats the orchestrator runs on credit (fill or delete)
<For each gate-queue key: "P4 auditors: run by the orchestrator on the credit lane (`orch credit-audit`); do NOT
dispatch them. When the gate queue reaches P4 OWED and `<runs>/<key>/findings-*.json` are not all present, stop with
`RESULT: PASS WAIT-P4 <key> @ <sha>`; the orchestrator runs them, marks P4 and resumes you." Add the same line for the
P3 module-tester if the orchestrator routed it (`--tester`). If a FIX of yours re-opens P4, stop again with WAIT-P4.>

## Version at release
Your release step takes the next free version above the target branch's at commit time. Parallel lanes may take the
same number: the ORCHESTRATOR re-versions at merge time if yours was taken (version files, changelog heading,
generated files that carry it — one commit). Do not hold a version back or guess ahead.

## Rules
The project's instruction file and `PIPELINE_PROFILE.md` apply in full. Never invent an oracle entry (profile §3).
A track is a floor (the playbook's track rules).

## Done-test
<the exact command(s) and expected digest that prove this lane is done>

## Result — write it to <result>
Line 1: `RESULT: PASS <one line>` or `RESULT: FAIL <one line>`.
Then: commits (sha + subject), tests run with their digest lines, the READY line, records written (paths + ids),
open questions (paths). End your turn when it is written. The orchestrator reads line 1 and opens the rest only on
demand.
```
