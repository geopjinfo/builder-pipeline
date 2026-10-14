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
- Worktree: <worktree>   Branch: <branch> (cut from <target>)
- Never: push, force, reset --hard, delete branches or worktrees, rewrite history, touch the release branch,
  local settings files, unlocks or the allow list.
- Tests: <the tiers this lane may run itself, e.g. unit + the affected-tests command>. Do NOT run the heavy tiers
  the orchestrator owns (<e.g. integration, gates>). Report `READY: <tiers> @ <sha>` and the orchestrator runs them
  through `orch merge`.
- Records go where the profile puts them: the board `<boards>/<key>.md`, decisions in `<decisions>`, deferrals in
  `<registry>`, questions to the human through the profile's channel (§13).

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
