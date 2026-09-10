# Adapter — Claude Code

One adapter among ten — privileged in nothing, but it has the richest native integration:
personas register as subagents, skills as `/skills`, and a `PreToolUse` hook can intercept
protected-path edits before they happen.

## File placement

| Kit file | Target |
|---|---|
| `agents/*.md` (8) | `.claude/agents/*.md` — **frontmatter transformed at install**: the kit's neutral `capabilities`/`tier` become Claude Code's `tools`/`model` (read-only → no Edit/Write; strong→opus, mid→sonnet — adjust post-install) |
| `skills/build-module-pipeline.md` | `.claude/skills/build-module-pipeline/SKILL.md` |
| `skills/scaffold-module.md` | `.claude/skills/scaffold-module/SKILL.md` |
| `skills/module-readiness-check.md` | `.claude/skills/module-readiness-check/SKILL.md` |
| `templates/task-board.md` | `tasks/README.md` |
| `templates/deferred-registry.md` | `DEFERRED_TASKS.md` (repo root) |
| `templates/module-brief.md` | `specs/module-brief.template.md` (or your briefs dir) |
| `PIPELINE_PROFILE.template.md` | `PIPELINE_PROFILE.md` (repo root, **filled**) |

`scripts/unpack.sh claude-code` / `scripts/unpack.ps1 claude-code` does the copies.

## Post-copy wiring

1. **Models:** the install transform maps `tier: strong` → `opus`, `mid` → `sonnet` by default;
   override at install with `--models strong=<x>,mid=<y>` (the setup skill picks these by
   inspecting your subscription). To change later, edit the installed `.claude/agents/` files —
   never `builder/agents/` (the kit source stays neutral). Keep strong models on plan / code /
   audit-nuance / final-review per profile §12.
2. **Skills routing:** agents reference skills by name (`module-readiness-check`,
   `scaffold-module`); Claude Code resolves these automatically once installed. Optionally add
   `skills: [scaffold-module]` to `module-builder.md` and `skills: [module-readiness-check]` to
   `module-reviewer.md` frontmatter so they preload.
3. **CLAUDE.md:** add:
   > Module builds go through the `build-module-pipeline` skill. Project grounding for all
   > pipeline personas is `PIPELINE_PROFILE.md` (repo root).
4. **.gitignore:** add `.pipeline/`.
5. **Optional hardening (recommended once the pipeline is trusted):** enforce protected paths
   (profile §4) with a `PreToolUse` hook that blocks Edit/Write to those globs — guardrails by
   hook beat guardrails by goodwill. Same for any banned code patterns you can grep.

## The run board, while the run happens

Start the watcher once when the board is materialised, and leave it for the whole run:

```
npm run board:watch          # or: node scripts/board-watch.mjs
```

Claude Code runs it as a background Bash task; nothing else needs typing, because a coder flipping a
row to `IN-PROGRESS` is already a write to `tasks/<key>.md` and the watcher renders on that. Stop it
at close-out — an unsupervised watcher outlives the session that started it.

Belt and braces: copy `builder/hooks/board-render.js` into `.claude/hooks/` and add a `PostToolUse`
entry matching `Write|Edit|MultiEdit|Bash`. It re-renders any stale board after a tool write, which
covers the case where nobody started the watcher. **Hooks are read at session start** — a hook added
mid-session does not fire until the next one.

## Dispatch semantics

- The orchestrator (main session) runs the `build-module-pipeline` skill and dispatches personas
  via the Agent tool by `subagent_type` (the frontmatter `name:`).
- Phase-4 auditors: **one message, three Agent calls** — they run concurrently.
- Subagents cannot spawn subagents — sequencing stays in the orchestrator, by design.
- Thread only distilled artifacts (paths, findings lists) between dispatches, per the skill.

## qa-audit (if installed)

- **Probe families and per-module pack authoring fan out** — dispatch them as parallel subagents;
  they are independent. The RUN itself stays one process: it owns a live environment, and two
  runners against one stack corrupt each other's fixtures.
- Long runs (image build + full sweep) belong in the background; report from the written report
  file, never from scrollback — the file is the artifact, the console is not.
- The transcript is large by design. Read the summary tables and grep it; do not page it into
  context.
