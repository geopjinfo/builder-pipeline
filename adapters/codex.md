# Adapter — Codex (and similar single-agent CLIs)

Codex has no persona-subagent registry, so the mapping preserves the kit's real invariant —
**fresh, role-scoped context per phase** — using fresh sessions instead of subagents.

## File placement

`node builder/cli.js unpack --tool codex --dry-run` prints every destination and is the authority.

| Kit file | Target |
|---|---|
| `agents/*.md` (9) | `.builder/personas/*.md` |
| `skills/*.md` + `skills/references/` | `.builder/playbooks/` |
| `templates/task-board.md` | `tasks/README.md` |
| `templates/deferred-registry.md` | `DEFERRED_TASKS.md` (repo root) |
| `templates/module-brief.md` | `specs/module-brief.template.md` |
| `scripts/*.mjs` + `scripts/lib/*.cjs` + `oracles/` | `scripts/`, `scripts/lib/` (plain Node, harness-independent) |
| `PIPELINE_PROFILE.template.md` | `PIPELINE_PROFILE.md` (repo root, **filled**, §16 included) |

`scripts/unpack.sh codex` / `scripts/unpack.ps1 codex` does the copies without Node. `hooks/claude-code/`
and the experimental files are not installed for this target — see the table at the end.

## AGENTS.md wiring

Add to the repo's `AGENTS.md`:

> Module builds follow `.builder/playbooks/build-module-pipeline.md`. Project grounding for every
> phase is `PIPELINE_PROFILE.md`. When the playbook says "dispatch persona X": start a **fresh
> session** whose first message is (1) the persona file `.builder/personas/X.md`, (2) the
> distilled inputs the playbook names for that phase (paths + findings lists — never raw dumps),
> and nothing else. Never run two phases in one context. Honour each persona's tool restrictions
> (read-only seats make no edits; the tester edits test files only) even though the harness does
> not enforce them.

## Running the phases

Two workable modes:

- **Orchestrator session** — one session opens the playbook and drives phases by launching one
  `codex exec` child run per phase. Each child's prompt is the persona file's text followed by an
  `INPUTS:` block (brief path, profile path, the distilled findings the playbook names) and the line
  "Produce your Output contract." Build that prompt in a file under `.pipeline/<key>/` and pass it
  the way your Codex version accepts a prompt. Phase-4 auditors: four concurrent child runs if your
  environment allows, else sequential (order is irrelevant — they are independent).
- **Human-conducted** — the human plays orchestrator: opens a fresh Codex chat per phase, pastes
  persona + inputs, carries the distilled outputs forward. Slower but fully faithful.

A fresh session cannot dispatch another session, so the no-nested-run rule (one run ↔ one branch
↔ one board ↔ one version bump) holds by construction. Still, never start a second pipeline from
inside a phase.

## Enforcement gaps to compensate for

Codex won't enforce tool scoping or model tiers per persona, so:

- After a read-only phase (planner, auditors, reviewer), run `git status --porcelain` — any
  modification from those phases is a protocol violation; revert it and note it. The reviewer's
  one allowed write is its review file under `.pipeline/<key>/`.
- The tester's diff must touch test paths only — check before accepting its verdict.
- Model tiers: if your Codex setup supports per-run model selection, map profile §12; otherwise
  run everything on the strongest available model (the tiering is a cost optimization, not a
  correctness requirement).

## The run board, while the run happens

Start `node scripts/board-watch.mjs` in a second terminal when the board is materialised, and stop
it at close-out. There is no after-tool-call hook here, so the watcher is the only automatic path.
If it is not running, the page is only as fresh as the last explicit
`node scripts/board-render.mjs <key>`.

**The board file is the one progress surface.** Do not keep a parallel to-do list in the session.

## What each Claude-Code-only step becomes here

| Claude Code step | Here |
|---|---|
| Bash output cap hook | unavailable. Route every suite through the tier runner's digest (`commands.tier`), and never paste raw suite output into a phase |
| Registry read guard hook | instruction only: seats read one row with `node scripts/ledger-row.mjs registry <ID>`; check a seat's transcript if in doubt |
| Reviewer write guard hook | post-phase `git status --porcelain`: the only change the reviewer may leave is its review file |
| Session-start index refresh | unavailable. The P1 index gate (`node scripts/index-check.mjs`) is the catch |
| Subagent spawn depth 1 | not needed: fresh sessions cannot dispatch |
| Prompt-cache TTL by replay | unavailable: no such settings are exposed |
| `effort:` frontmatter | ignored. Use a per-run reasoning setting if your Codex version has one (profile §12) |
| Orchestrator model check | `node scripts/orchestrator-check.mjs` prints `unmeasurable here`: no transcript it can read |
| Per-seat cost accounting (`costAccounting`, `seat-peaks`, `cost-window`) | unavailable. The agents table renders em-dashes (see below) |
| Live page · Workflow-driven runs · advisor A/B | unavailable |
| Language server plugin | unavailable as a plugin; any editor integration you run yourself is outside the pipeline |

Codex keeps no per-dispatch usage records of the shape the accounting reader expects, so the
per-seat model / wall-clock / token / cost columns render as em-dashes. That is the designed
outcome, not a failure: every other section — rows, steps, gates, files, ceiling — is unaffected,
and an em-dash says *unmeasured* where a zero would claim a measurement nobody took. Set
`features.costAccounting` to `off` so the board says so.

## qa-audit (if installed)

- No parallel dispatch: run the phases sequentially in one session, or split across fresh sessions
  using the written artifacts as the handoff (report + worklist + transcript are files, so nothing
  needs to survive in context).
- Pack authoring is one module per session — the requirement rows, state machine and deferral
  registry for a single module are a comfortable context; two modules are not.
- Confirm the environment choice explicitly before the run; there is no interactive prompt to
  fall back on mid-flight.
