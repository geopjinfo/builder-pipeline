# Adapter — Google Antigravity

> **Commands.** Written for the npm-package install: a kit script runs as `npx builder run <name>`. With the
> kit copied in as a `builder/` folder ([`UNPACK.md`](../UNPACK.md)), run it from the project's `scripts/` copy with Node.

Antigravity has custom subagents, skills and hooks under one workspace folder, `.agents/`. The renderer in
`adapters/lib/antigravity.cjs` (pure: text in, `{ path, content }` out) produces the layout below from the neutral
personas and skills. `cli.js` writes the files.

Checked against the official docs on 2026-11-14:
[customization discovery](https://antigravity.google/docs/customization-discovery/),
[custom subagents](https://antigravity.google/docs/subagents/), [skills](https://antigravity.google/docs/skills/),
[hooks](https://antigravity.google/docs/hooks/).

## File placement

| Neutral source | Antigravity target |
|---|---|
| `agents/<name>.md` | `.agents/agents/<name>.md`: YAML frontmatter `name`, `description`, `tools` (list), `mainAgent: false`, `subagent: true`, `model`; the body is the persona text, with the seat's tool limits as its first paragraph |
| `skills/<name>.md` | `.agents/skills/<name>/SKILL.md`. Codex reads the same folder; the files are written once |
| pointer | `AGENTS.md` (read in the workspace folder and each parent up to the repo root) |

`.agent/` (singular) is the legacy spelling; the kit writes `.agents/`. Workflows are deprecated in favour of skills, so
none are written.

## Tools and models

| Neutral `capabilities` | `tools` |
|---|---|
| `read-only` (and anything unrecognised) | `view_file`, `list_dir`, `find_by_name`, `grep_search`, `run_command` |
| `read-only` with `writes:` (the reviewer) | the read set + `write_to_file` |
| `code`, `test-only`, `docs` | the read set + `write_to_file`, `replace_file_content`, `multi_replace_file_content` |
| `publish` | the read set: the publishing tool exists only on Claude Code |

Tool names are the ones the docs spell. The docs warn that a misspelt name can hang the agent, so the list is never
built from user text. `run_command` is in the read set because every seat runs inspection commands. As on Claude Code,
that leaves a shell that could write, which is why the post-phase check below exists.

`tier` maps to the documented `model` values: `strong` → `pro`, `mid` and `low` → `flash`. Override with `--models`
using `inherit`, `flash` or `pro`; any other value writes `inherit`. There is no documented effort field, so `effort:` is
dropped.

## Enforcement gaps

`tools` grants whole tools, not paths. Antigravity cannot keep the tester to test files, the docs seat to its doc paths,
or the reviewer to its one review file. Each limit is the first paragraph of the seat's prompt. After every phase, run
`git status --porcelain` and revert anything outside the seat's limit. The [Codex adapter](codex.md) describes the same
check.

### Worker recipe (a lane on an Antigravity account)

The registry (`features.accounts`) accepts the workers `claude-code`, `codex` and `session` in this release; an
Antigravity account is assessed (its probe) but has no launcher of its own. The rulebook is
`skills/references/account-selection.md`.

- **Start.** A person starts the lane by hand in the lane worktree, on the account signed in to the workspace, with
  the brief pointer as the first prompt, then records it: `npx builder run orch set <run> <lane> status=LAUNCHED
  seat=<account> sessionId=<id>`. Headless form, where the installed version has it: `-p --output-format json
  --print-timeout <seconds>` with the timeout from `timeoutMinutes`.
- **Environment.** The account is the one the workspace is signed in to; pays is `subscription` only (no key
  helper, no gateway form). Keep the lane worktree's `.agents/` the kit wrote; add nothing to it for one lane.
- **What the kit cannot enforce here.** No hook runs and no deny rule exists, so the guards are instructions checked
  by `git status --porcelain` after each phase; a path-root account is refused. No usage reader exists: the account
  stays `unmeasured` and only the first account in order may launch unmeasured. No `--settings` pin reaches the
  process, so the settings scan judges the project's files only.

## Not wired (the module's `unconfirmed` list)

- **Hooks.** `.agents/hooks.json` is a documented location. Antigravity sends `toolCall { name, args }` and expects a
  JSON `decision` on stdout, and the docs do not define exit codes. The kit's hooks read `tool_name` / `tool_input`
  and block with exit 2, so none of them would run correctly. No hooks file is written until a shim exists.
- **`tools: []`.** The docs do not say whether an empty list means no tools or all tools, so every agent gets an
  explicit list.
- **`GEMINI.md`.** Antigravity reads it too, but the docs give no order between it and `AGENTS.md`. The pointer goes
  in `AGENTS.md` only.

Steps that are Claude Code only (cost accounting, the live page, Workflow-driven runs, spawn depth) are covered in
the Codex adapter's table. The same answers apply here.
