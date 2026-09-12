# Adapter — Claude Code

One adapter among ten. It is privileged in nothing, but it has the richest native integration:
personas register as subagents, skills as `/skills`, hooks can see and change a tool call before
or after it runs, and every dispatch leaves a transcript the pack can read for accounting.

Everything harness-specific in the pack lives here and in `hooks/claude-code/`. The other adapters
say, line by line, what each item becomes without this harness.

## File placement

`node builder/cli.js unpack --tool claude-code --dry-run` prints every destination. It is the
authority if this table and the CLI ever disagree.

| Kit file | Target |
|---|---|
| `agents/*.md` (9) | `.claude/agents/*.md`. **Frontmatter transformed at install:** the neutral `capabilities` / `tier` / `effort` become Claude Code's `tools` / `model` / `effort` (read-only → no Edit/Write; strong → opus, mid → sonnet unless `--models` says otherwise) |
| `skills/build-module-pipeline.md` | `.claude/skills/build-module-pipeline/SKILL.md` |
| `skills/references/*.md` (graph query block, review template) | beside the pipeline skill, `.claude/skills/build-module-pipeline/references/` |
| `skills/scaffold-module.md` · `module-readiness-check.md` · `setup-builder.md` | `.claude/skills/<name>/SKILL.md` |
| `templates/task-board.md` | `tasks/README.md` |
| `templates/deferred-registry.md` | `DEFERRED_TASKS.md` (repo root) |
| `templates/module-brief.md` | `specs/module-brief.template.md` (or your briefs dir) |
| `PIPELINE_PROFILE.template.md` | `PIPELINE_PROFILE.md` (repo root, **filled**, §16 included) |
| `scripts/*.mjs` + `scripts/lib/*.cjs` + `oracles/` | `scripts/`, `scripts/lib/` (plain Node, harness-independent) |
| `hooks/claude-code/*.js` | `.claude/hooks/` — **copied, never registered.** Registering is a person's act (below) |
| `hooks/protected-paths.js`, `hooks/board-render.js` | `.claude/hooks/` — same rule |
| `agents/experimental/page-keeper.md` | `.claude/agents/page-keeper.md` — only with `--experimental` |
| `tooling/experimental/page-shell.{cjs,mjs}` | `scripts/experimental/` — only with `--experimental` |

`scripts/unpack.sh claude-code` / `scripts/unpack.ps1 claude-code` does the copies without Node,
but without the frontmatter transform.

## Post-copy wiring

1. **Models.** The install transform maps `tier: strong` → `opus`, `mid` → `sonnet`; override at
   install with `--models strong=<x>,mid=<y>` (the setup skill picks these by inspecting your
   subscription). To change later, edit the installed `.claude/agents/` files — never
   `builder/agents/`, which stays neutral. Keep strong models where profile §12 puts them.
2. **Effort.** A persona may carry `effort:` (`low` … `max`). It overrides the session's effort for
   that seat only. The pack ships the docs seat at `low`: it writes prose from facts it is handed,
   and it is a small share of any run's spend. Other seats inherit the session's effort.
3. **Skills routing.** Agents reference skills by name; Claude Code resolves them once installed.
   Optionally add `skills: [scaffold-module]` to `module-builder.md` and
   `skills: [module-readiness-check]` to `module-reviewer.md` so they preload.
4. **CLAUDE.md.** Add:
   > Module builds go through the `build-module-pipeline` skill. Project grounding for all
   > pipeline personas is `PIPELINE_PROFILE.md` (repo root).
5. **.gitignore.** Add `.pipeline/` and your `paths.logs` directory.
6. **Settings** — the block below, merged into `.claude/settings.json` by a person.

## Settings

```json
{
  "env": { "CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH": "1" },
  "hooks": {
    "PreToolUse": [
      { "matcher": "Read",
        "hooks": [{ "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/.claude/hooks/registry-read-guard.js\"" }] },
      { "matcher": "Write|Edit|MultiEdit",
        "hooks": [{ "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/.claude/hooks/reviewer-write-guard.js\"" }] }
    ],
    "PostToolUse": [
      { "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/.claude/hooks/bash-output-cap.js\"" }] }
    ]
  }
}
```

Take only the entries whose feature you switched on in §16. **Hooks and settings are read at
session start**: an entry added mid-session does nothing until the next session.

### Subagent spawn depth: set it to 1

The harness's default lets a subagent dispatch subagents of its own, several levels deep. The
pipeline must not nest: **one run is one branch, one board, one version bump**, and a run started
inside another run's branch would write a second board and a second bump into a diff that is
already under review. Earlier versions of the pack assumed the harness forbade nesting. It does
not, so the rule is now enforced by the setting above rather than by that assumption. With depth
1, the orchestrator dispatches seats and seats dispatch nothing.

### Prompt-cache TTL: decide by replay, not by one run

Claude Code exposes `promptCacheTtl` (the main session) and `subagentPromptCacheTtl` (seats),
each short (5 minutes) or long (1 hour). A long-TTL cache write bills higher than a short one; a
cache that expires between turns is rewritten instead of read. Which is cheaper depends on how long
each context sits idle, and that differs by role.

Do not decide with a one-run A/B: one run is noise. **Replay your own transcripts at each TTL.**
For every turn, take the gap since the previous turn in the same context; a gap over the TTL turns
that turn's cached prefix from a read into a write. Price both totals at your current rate table.
In one adopting project the replay split the answer: the main session was cheaper on the long TTL
and the seats on the short one, because the orchestrator sits idle while seats run, while a seat's
turns follow each other closely. Confirm that the harness build which actually runs your pipeline
sessions honours both keys. A CLI on `PATH` can be a different version from the one an app
launches.

## Hooks

| Hook | Event | What it does | Needs from §16 |
|---|---|---|---|
| `bash-output-cap.js` | `PostToolUse` · `Bash` | An output over `features.bashCap.limitBytes` is written whole under `paths.logs`. The context gets every error-shaped line with its line number, the tail, and the log path. The tier runner's output, already a digest, passes through. Never fails the tool call: any error leaves the original output in place | `bashCap` on · `limitBytes` · `paths.logs` |
| `registry-read-guard.js` | `PreToolUse` · `Read` | Blocks a seat named in `features.registryGuard.seats` from reading the whole registry, and names the row reader instead: `node scripts/ledger-row.mjs registry <ID>`. The orchestrator carries no seat identity in the hook input and keeps Read | `registryGuard` on · `seats` · `paths.registry` · `rowReader` on |
| `reviewer-write-guard.js` | `PreToolUse` · `Write\|Edit\|MultiEdit` | The reviewer may write exactly one kind of file: its review, `<runs>/<key>/review-pass<n>.md`. Every other write by that seat is blocked. A grant of Write to one file is only a grant if something enforces the one file | `reviewTemplate` on · `paths.runs` |

**Where the cap takes effect — probed, not assumed.** A disposable project was driven headless with
a large payload and a small negative control. In the **main session** the large output was replaced
and the small one passed untouched. **Inside a subagent** the hook fired (its input carried the
agent's id), but the seat still received the raw output. So the cap protects the orchestrator's
context, where tool output accumulates across the whole run. It does not shrink a seat's context.
Seats get the same protection by running suites through the tier runner's digest.

The guards read the dispatching seat's name from the hook input, which the harness supplies for
subagent tool calls. A guard blocks with exit code 2 and says what to do instead.

### Session-start index refresh (optional)

If §16 has `features.graph` on, arm `tooling/optional/session-sync-hook.js` (copied into your hooks
folder) on `SessionStart`. It starts the index sync **detached**, so it never delays the session.
Through `autosync.py --trigger session` it shares the lock and the automatic-embed limit with your
other triggers.

- **When it speaks:** only when the previous run left docs above the limit.
- **When it stays silent:** no index, no interpreter, or `INDEX_SYNC_SKIP` set.
- **Another index tool:** it is written for the graphify example; keep its shape and change the
  command it spawns (see [`tooling/optional/README.md`](../tooling/optional/README.md)).

It catches docs that arrive with no commit or merge. Without it, the P1 index gate still refuses a
stale index.

Belt and braces for the board: `hooks/board-render.js` on `PostToolUse` matching
`Write|Edit|MultiEdit|Bash` re-renders any stale board after a tool write. It covers the case where
nobody started the watcher.

## Dispatch semantics

- The orchestrator (main session) runs the `build-module-pipeline` skill and dispatches personas
  with the Agent tool by `subagent_type` (the frontmatter `name:`).
- Phase-4 auditors: **one message, four Agent calls** (standards, security, vuln, invariant). They
  run concurrently.
- Seats dispatch nothing (spawn depth 1). Sequencing lives in the orchestrator.
- Thread only distilled artifacts (paths, findings lists) between dispatches, per the skill.
- **The board file is the one progress surface.** Do not mirror rows into the harness's to-do
  tool. A second surface drifts from the first, and nobody reconciles it.
- **One run per session; stop at `run.end`.** Follow-up work takes a new key, board and session.

## The orchestrator model is a session setting, so it needs a check

A seat's model is fixed in its frontmatter. The orchestrator's model is whatever the session was
started on. Nothing in a file pins it, so a run can silently use the wrong one. With
`models.orchestrator` set and `features.orchestratorModel` on, run this at P0:

```
node scripts/orchestrator-check.mjs
```

It reads the current session's transcript and compares the observed model with the declared one.
A mismatch **warns** (exit 5) and never refuses: the model is a cost and capability choice, not a
correctness gate. A session with no readable transcript is **unmeasured**, never a pass. It is a P0
command rather than a `SessionStart` hook, because a hook cannot tell a pipeline session from any
other session.

## Accounting: per-seat cost from the harness's own records

With `features.costAccounting` on (`reader: "claude-code"`), `node scripts/board-render.mjs <key>`
fills the agents table from the transcripts Claude Code writes, never from a seat's own report:

- **Each seat from its own transcript** — the per-dispatch subagent file under the session, with
  its metadata. That includes **background dispatches**, whose result never passes through the
  orchestrator's turn. A transcript repeats a message across several lines, so turns are
  de-duplicated by message id before tokens are summed.
- **The orchestrator's own turns**, scoped to the sessions and the time window of *this* run. A
  session that ran other work before or after is not billed to the run.
- **An unmeasured seat is an em-dash**, never `$0.00`. A total that includes an unmeasured seat is
  labelled partial, because a partial sum shown as a total is a false figure.
- **The rate table is versioned** (`scripts/lib/pricing.cjs`). A figure is derived at a named rate
  version, and the table and its version change together. One adopting project found every rate in
  its hand-typed table wrong when it was checked against the published prices.

Instruments that read the same records: `node scripts/cost-window.mjs` (spend over a time window,
for before/after comparisons), `node scripts/seat-peaks.mjs` (per-dispatch peak context, which is
how the builder-batch setting is judged).

## Experimental (installed only with `unpack --experimental`)

Each item has its measurement in [`EXPERIMENTS.md`](../EXPERIMENTS.md) and a §16 state of
`experimental-off` until someone turns it on on purpose.

- **The live page** (`features.livePage`). A read-only page that shows the run as it happens,
  published to the harness's hosted artifact store. `node scripts/board-render.mjs <key> --json`
  writes **one document per section, each under the store's per-document cap** (256 KiB in the store
  this was built against; the limit is a parameter). An oversized section is split into parts that
  add back to the whole; it is never truncated. `page-shell.cjs` is the page: it reads the documents
  live, **viewers read, only the owner writes**, and it has no click-to-advance. `page-keeper` is a
  low-effort seat that can read, run the render command and publish, and **can never write** a repo
  file, the board or the run log. A seat that writes its own accounting is self-reporting the
  numbers the board checks. **Per-seat cost may appear on the page only if the page is
  organisation-internal**, and only labelled as derived at a named rate version, so it never reads
  as an invoice. Not yet probed: whether an agent inside a Workflow receives the publish tool. That
  is the pilot's first step.
- **Workflow-driven runs.** A Workflow script drives P2 → P6.5 with the FIX loop, using the
  installed agent files as agent types and the output checkers on every result. The session keeps
  P0–P1 and every human decision: scripts have no file or shell access of their own, and a running
  Workflow takes no mid-run human input. **A Workflow may be launched only on the user's explicit
  opt-in for that session.** The pack never starts one on its own judgement.
- **Builder on a mid model with a strong advisor** (`features.advisorBuilder`). The advisor setting
  is **session-wide**, and there is no per-subagent advisor field. Switching it on for the builder
  switches it on for every compatible seat, so a live A/B would measure the whole pipeline. Compare
  on a replay of one frozen run in a builder-only session instead.

## Optional: a language server for code navigation

A code-intelligence plugin backed by a language server can give the builder and the auditors
go-to-definition and find-references instead of text search. It needs both the plugin and the
language-server binary installed on the machine. Treat it as optional: its effect on a run has not
been measured.

## qa-audit (if installed)

- **Probe families and per-module pack authoring fan out** — dispatch them as parallel subagents;
  they are independent. The RUN itself stays one process: it owns a live environment, and two
  runners against one stack corrupt each other's fixtures.
- Long runs (image build + full sweep) belong in the background; report from the written report
  file, never from scrollback — the file is the artifact, the console is not.
- The transcript is large by design. Read the summary tables and grep it; do not page it into
  context.
