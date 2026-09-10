# Adapter — Codex (and similar single-agent CLIs)

Codex has no persona-subagent registry, so the mapping preserves the kit's real invariant —
**fresh, role-scoped context per phase** — using fresh sessions instead of subagents.

## File placement

| Kit file | Target |
|---|---|
| `agents/*.md` (8) | `.builder/personas/*.md` |
| `skills/*.md` (3) | `.builder/playbooks/*.md` |
| `templates/task-board.md` | `tasks/README.md` |
| `templates/deferred-registry.md` | `DEFERRED_TASKS.md` (repo root) |
| `templates/module-brief.md` | `specs/module-brief.template.md` |
| `PIPELINE_PROFILE.template.md` | `PIPELINE_PROFILE.md` (repo root, **filled**) |

`scripts/unpack.sh codex` / `scripts/unpack.ps1 codex` does the copies.

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

- **Orchestrator session** — one session opens the playbook and drives phases by launching
  `codex exec` child runs (one per phase), passing the persona file + inputs as the prompt, and
  collecting each phase's Output-contract text. Phase-4 auditors: three concurrent `codex exec`
  invocations if your environment allows, else sequential (order is irrelevant — they are
  independent).
- **Human-conducted** — the human plays orchestrator: opens a fresh Codex chat per phase, pastes
  persona + inputs, carries the distilled outputs forward. Slower but fully faithful.

Example per-phase invocation:

```bash
codex exec "$(cat .builder/personas/module-planner.md)

INPUTS:
- Module brief: specs/briefs/<moduleKey>.md
- Profile: PIPELINE_PROFILE.md
Produce your Output contract."
```

## Enforcement gaps to compensate for

Codex won't enforce tool scoping or model tiers per persona, so:

- After a read-only phase (planner, auditors, reviewer), run `git status --porcelain` — any
  modification from those phases is a protocol violation; revert it and note it.
- The tester's diff must touch test paths only — check before accepting its verdict.
- Model tiers: if your Codex setup supports per-run model selection, map profile §12; otherwise
  run everything on the strongest available model (the tiering is a cost optimization, not a
  correctness requirement).

## qa-audit (if installed)

- No parallel dispatch: run the phases sequentially in one session, or split across fresh sessions
  using the written artifacts as the handoff (report + worklist + transcript are files, so nothing
  needs to survive in context).
- Pack authoring is one module per session — the requirement rows, state machine and deferral
  registry for a single module are a comfortable context; two modules are not.
- Confirm the environment choice explicitly before the run; there is no interactive prompt to
  fall back on mid-flight.

## The run board, while the run happens

`node scripts/board-watch.mjs &` when the board is materialised; stop it at close-out. There is no
`PostToolUse` equivalent here, so the watcher is the only automatic path — if it is not running, the
page is only as fresh as the last explicit `node scripts/board-render.mjs <board>`.

Codex keeps no per-dispatch usage records of the shape `transcript-usage.cjs` reads, so the
per-seat model / wall-clock / token / cost columns render as em-dashes. That is the designed
outcome, not a failure: every other section — rows, steps, gates, files, ceiling — is unaffected,
and an em-dash says *unmeasured* where a zero would claim a measurement nobody took.
