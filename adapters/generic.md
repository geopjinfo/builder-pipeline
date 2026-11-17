# Adapter — any capable agent

> **Commands.** Written for the npm-package install: a kit script runs as `npx builder-pipeline run <name>`. With the
> kit copied in as a `builder/` folder ([`UNPACK.md`](../UNPACK.md)), run it from the project's `scripts/` copy with Node.

The kit assumes nothing harness-specific. To port it to any agent (Gemini CLI, Cursor, aider, a
raw API loop, a human team), preserve these invariants — everything else is free:

## The invariants (what makes it the same mechanism)

1. **One phase = one fresh context** whose system/first prompt is exactly: the persona file +
   `PIPELINE_PROFILE.md` + the distilled inputs the playbook names. Nothing else. If contexts
   can't be isolated, do an explicit reset and re-paste only those three things.
2. **Distilled artifacts between phases** — file paths and structured findings lists, never raw
   file contents or prior transcripts.
3. **Role scoping honoured** — read-only seats make no edits; the tester touches test files only;
   the reviewer writes only its review file; nobody edits protected paths. If the harness can't
   enforce it, verify with `git status` after each read-only phase.
4. **The ledgers are files on disk** — task board, deferred registry, plan, review, handoff pack.
   Any harness can write files; the mechanism's memory is the repo, not the context window.
5. **The loop-back protocol** — consolidated verified blocker list → coder ("fix exactly these")
   → re-run affected phases → two-strike escalation to the human.
6. **The close-out** — board closed, every DONE's evidence re-verified, claims checked, registry
   swept, version bumped, handoff pack written and checked, human merges.
7. **One run per session, and no nested runs** — one run is one branch, one board, one version
   bump. Stop at `run.end`; follow-up work takes a new key and a new session.

## Minimal mapping table

| Kit concept | Any-harness equivalent |
|---|---|
| Subagent dispatch | fresh session / new chat / fresh API conversation |
| Agent frontmatter `tools:` | instruction + post-phase `git status` verification |
| Agent frontmatter `model:` | per-session model choice (profile §12), or strongest available |
| Agent frontmatter `effort:` | a per-session reasoning setting if the harness has one; otherwise ignored |
| Skill | a playbook file the orchestrator (agent or human) follows |
| Parallel auditors | 4 concurrent sessions, or sequential (independent; order irrelevant) |
| Progress tracking | **the board file is the one progress surface** — no parallel to-do list |

## What each Claude-Code-only step becomes here

| Claude Code step | Any harness |
|---|---|
| Instruction lint on edit | no post-edit hook. Run `npx builder-pipeline run instruction-lint` before committing any instruction-file change; the P7 record gate runs it anyway |
| Bash output cap hook | unavailable. Route every suite through the tier runner's digest (`commands.tier`); never paste raw suite output into a context |
| Registry read guard hook | instruction only: seats read one row with `npx builder-pipeline run ledger-row registry <ID>` |
| Reviewer write guard hook | post-phase `git status --porcelain`: the reviewer may leave only its review file |
| Protected-path hook | the universal pre-commit guard in `hooks/` (it holds for any agent) |
| Re-anchor after compaction | unavailable. After any compaction, re-read `state.md`, the board's `phase:status` block and the open `FIX-n` rows by hand before the next dispatch (the playbook's rule) |
| Session-start index refresh | unavailable. The P1 index gate (`npx builder-pipeline run index-check`) is the catch; for the graphify example, `autosync.py --trigger p1` refreshes under the shared lock and embed limit |
| Subagent spawn depth 1 | the no-nested-run rule, by instruction; a fresh session that cannot dispatch satisfies it by construction |
| Prompt-cache TTL by replay | unavailable unless your harness exposes cache settings; if it does, the replay method in `adapters/claude-code.md` applies unchanged |
| Orchestrator model check | `npx builder-pipeline run orchestrator-check` prints `unmeasurable here` |
| Per-seat cost accounting | em-dashes in the agents table; set `features.costAccounting` to `off` so the board says so |
| Live page · Workflow-driven runs · advisor A/B | unavailable |
| Batch orchestrator (`orchestrator`, `scripts/orch.mjs`) | runs as is: plain Node over git, with every seat action a command template you fill for this harness (`launchCommand`, `stateCommand`, `stopCommand`, `usageCommand`). A primary-seat pipeline lane is its own session. The credit worker adapter ships for Claude Code only — keep `credit.enabled` false here until one exists for this harness |
| Language server plugin | unavailable as part of the pipeline |

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
