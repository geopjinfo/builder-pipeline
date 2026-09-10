# Adapter — any capable agent

The kit assumes nothing harness-specific. To port it to any agent (Gemini CLI, Cursor, aider, a
raw API loop, a human team), preserve these invariants — everything else is free:

## The invariants (what makes it the same mechanism)

1. **One phase = one fresh context** whose system/first prompt is exactly: the persona file +
   `PIPELINE_PROFILE.md` + the distilled inputs the playbook names. Nothing else. If contexts
   can't be isolated, do an explicit reset and re-paste only those three things.
2. **Distilled artifacts between phases** — file paths and structured findings lists, never raw
   file contents or prior transcripts.
3. **Role scoping honoured** — read-only seats make no edits; the tester touches test files only;
   nobody edits protected paths. If the harness can't enforce it, verify with `git status` after
   each read-only phase.
4. **The ledgers are files on disk** — task board, deferred registry, plan, review. Any harness
   can write files; the mechanism's memory is the repo, not the context window.
5. **The loop-back protocol** — consolidated verified blocker list → coder ("fix exactly these")
   → re-run affected phases → two-strike escalation to the human.
6. **The close-out** — board closed, every DONE's evidence re-verified, registry swept, version
   bumped, handoff table emitted, human merges.

## Minimal mapping table

| Kit concept | Any-harness equivalent |
|---|---|
| Subagent dispatch | fresh session / new chat / fresh API conversation |
| Agent frontmatter `tools:` | instruction + post-phase `git status` verification |
| Agent frontmatter `model:` | per-session model choice (profile §12), or strongest available |
| Skill | a playbook file the orchestrator (agent or human) follows |
| Parallel auditors | 3 concurrent sessions, or sequential (independent; order irrelevant) |
| TodoWrite / task list | the task board file itself |

## Scaling down (see DESIGN.md for the full rationale)

Small project or budget: merge the four auditors into one persona carrying all four checklists;
skip the docs phase if there are no product docs. **Never** merge coder and reviewer, never drop
the board, never skip the close-out DONE audit — those three are the mechanism.

## qa-audit (if installed)

The invariants, in priority order — everything else is free:

1. **One runner per environment at a time.** Concurrency belongs in authoring and analysis, never
   in the run; two runners share fixtures and corrupt each other.
2. **The artifacts are the interface** — report, worklist, transcript are files on disk. Any
   harness (or a human with a terminal) can produce and read them; nothing depends on a session.
3. **The read-only rule is enforced in code**, not by the agent remembering it. If your harness
   cannot enforce it, run `check-targets` in CI so the config is still gated.
4. **Absent evidence renders as UNKNOWN.** Whatever generates the report must distinguish "no
   data" from "nothing wrong" — this is the one thing a human reviewer cannot recover later.
