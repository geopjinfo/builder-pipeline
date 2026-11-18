# Adapter — Codex (and similar single-agent CLIs)

> **Commands.** Written for the npm-package install: a kit script runs as `npx builder-pipeline run <name>`. With the
> kit copied in as a `builder/` folder ([`UNPACK.md`](../UNPACK.md)), run it from the project's `scripts/` copy with Node.

Codex has no persona-subagent registry, so the mapping preserves the kit's real invariant —
**fresh, role-scoped context per phase** — using fresh sessions instead of subagents.

## Native layout (`adapters/lib/codex.cjs`)

Codex now has custom agents, repo skills and hooks. The renderer in `adapters/lib/codex.cjs` (pure: text in,
`{ path, content }` out) produces the native form below, and `unpack --tool codex` installs it (the `.builder/` placement
further down is now only what the no-Node fallback `scripts/unpack.sh codex` writes). The hook script is copied to
`.codex/hooks/` and the `hooks.json` block is printed, not written. `npx builder-pipeline doctor --tool codex` lists
what is partial or unsupported here. Checked against the official docs on 2026-11-14:
[subagents](https://developers.openai.com/codex/subagents), [skills](https://developers.openai.com/codex/skills),
[hooks](https://developers.openai.com/codex/hooks), [AGENTS.md](https://developers.openai.com/codex/guides/agents-md)
(each now redirects to `learn.chatgpt.com/docs/…`).

| Neutral source | Codex target |
|---|---|
| `agents/<name>.md` | `.codex/agents/<name>.toml`: `name`, `description`, `developer_instructions` (the persona body, with the seat's tool limits as its first paragraph); `model` only when `--models` maps the tier (no Codex defaults ship); `model_reasoning_effort` from `effort:` |
| `skills/<name>.md` | `.agents/skills/<name>/SKILL.md` (frontmatter `name` + `description`). Antigravity reads the same folder; the files are written once |
| guards | `.codex/hooks.json`: `protected-paths.cjs` on `PreToolUse` · `Bash`, its path resolved from `git rev-parse --show-toplevel`. Codex runs a project hook only after `/hooks` review, so writing the file arms nothing |
| pointer | `AGENTS.md` |

**What Codex does not do per agent, so the kit does not pretend it does.** The docs say `sandbox_mode` and
`approval_policy` in a custom agent file do not override the parent session: every agent inherits the session's sandbox
and approvals, and instructions do not create a read-only sandbox. So no `sandbox_mode` is written. A read-only seat is
held by its instructions and by the post-phase `git status --porcelain` check below. The renderer also returns the
seat's neutral `access` (`read-only`, `own-file`, `write`, `publish`) for the orchestrator to check against. An
unrecognised capability is `read-only`.

Not wired, each for a documented reason (the module's `unconfirmed` list):

- `protected-paths.cjs` on `apply_patch`. Codex puts the patch text in `tool_input.command`; the hook judges file
  tools by `tool_input.file_path`, so a patch would pass unjudged. Only `Bash` is registered.
- The reviewer write guard and registry read guard. Both need the dispatching seat's name in the hook input, and the
  tool-event field tables document none.
- The Bash output cap. A `PostToolUse` hook can replace a result with feedback, not with a digest.

## File placement

`npx builder-pipeline unpack --tool codex --dry-run` prints every destination and is the authority.

| Kit file | Target |
|---|---|
| `agents/*.md` (10) | `.codex/agents/*.toml` (no-Node fallback: `.builder/personas/*.md`); `capacity-steward` is read-only, so its first paragraph says no edits; `agents/experimental/progress-reporter.md` only with `--experimental` |
| `skills/*.md` + `skills/references/` | `.agents/skills/<name>/SKILL.md` + `.agents/skills/build-module-pipeline/references/` (no-Node fallback: `.builder/playbooks/`) |
| `hooks/protected-paths.cjs` | `.codex/hooks/protected-paths.cjs` — copied, never armed |
| `templates/task-board.md` | `tasks/README.md` |
| `templates/deferred-registry.md` | `DEFERRED_TASKS.md` (repo root) |
| `templates/module-brief.md` | `specs/module-brief.template.md` |
| `scripts/*.mjs` + `scripts/lib/*.cjs` + `oracles/` | **Package install: not copied.** They run from the package as `npx builder-pipeline run <name>`. Folder copy (`builder/`): `scripts/`, `scripts/lib/`, `scripts/oracles/` (plain Node, harness-independent) |
| `PIPELINE_PROFILE.template.md` | `PIPELINE_PROFILE.md` (repo root, **filled**, §16 included) |

`scripts/unpack.sh codex` / `scripts/unpack.ps1 codex` does the copies without Node. `hooks/claude-code/`
and the experimental files are not installed for this target — see the table at the end.

## AGENTS.md wiring

`unpack --tool codex` writes the pointer block into the repo's `AGENTS.md` itself, between the
`builder-kit:pipeline` markers, and leaves the rest of the file byte for byte. The block names the
`build-module-pipeline` skill under `.agents/skills/`, the custom agents under `.codex/agents/`
(spawned by name), and the post-phase `git status --porcelain` check. Do not paste a second copy.
When Antigravity or an `AGENTS.md`-reading dotBuilder tool is installed in the same command, the one
block speaks for all of them.

## Running the phases

The orchestrator session opens the `build-module-pipeline` skill (`.agents/skills/build-module-pipeline/SKILL.md`)
and, where the playbook says "dispatch persona X", spawns the custom agent `X` from `.codex/agents/X.toml`. Each
agent gets its own context with the distilled inputs the playbook names for that phase (paths and findings lists,
never raw dumps). Never run two phases in one context. Phase-4 auditors are independent: spawn them concurrently
if your setup allows, else one after another.

The agent files cannot hold a seat's tool limits (see "What Codex does not do per agent" above): the limits are the
first paragraph of each agent's `developer_instructions`, and the post-phase check below catches a seat that crossed
them. Never start a second pipeline from inside a phase: one run ↔ one branch ↔ one board ↔ one version bump.

### No-Node fallback (`scripts/unpack.sh codex` / `scripts/unpack.ps1 codex`)

Without Node the fallback copies the neutral files into `.builder/` instead: personas to `.builder/personas/`,
skills to `.builder/playbooks/`. It writes no pointer, so add to the repo's `AGENTS.md` by hand:

> Module builds follow `.builder/playbooks/build-module-pipeline.md`. Project grounding for every
> phase is `PIPELINE_PROFILE.md`. When the playbook says "dispatch persona X": start a **fresh
> session** whose first message is (1) the persona file `.builder/personas/X.md`, (2) the
> distilled inputs the playbook names for that phase (paths + findings lists — never raw dumps),
> and nothing else. Never run two phases in one context. Honour each persona's tool restrictions
> (read-only seats make no edits; the tester edits test files only) even though the harness does
> not enforce them.

Two workable modes for that layout:

- **Orchestrator session** — one session opens the playbook and drives phases by launching one
  `codex exec` child run per phase. Each child's prompt is the persona file's text followed by an
  `INPUTS:` block (brief path, profile path, the distilled findings the playbook names) and the line
  "Produce your Output contract." Build that prompt in a file under `.pipeline/<key>/` and pass it
  the way your Codex version accepts a prompt. Phase-4 auditors: four concurrent child runs if your
  environment allows, else sequential (order is irrelevant — they are independent).
- **Human-conducted** — the human plays orchestrator: opens a fresh Codex chat per phase, pastes
  persona + inputs, carries the distilled outputs forward. Slower but fully faithful.

A fresh session cannot dispatch another session, so the no-nested-run rule holds by construction.

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

Start `npx builder-pipeline run board-watch` in a second terminal when the board is materialised, and stop
it at close-out. There is no after-tool-call hook here, so the watcher is the only automatic path.
If it is not running, the page is only as fresh as the last explicit
`npx builder-pipeline run board-render <key>`.

**The board file is the one progress surface.** Do not keep a parallel to-do list in the session.

## What each Claude-Code-only step becomes here

| Claude Code step | Here |
|---|---|
| Instruction lint on edit | no post-edit hook. Run `npx builder-pipeline run instruction-lint` before committing any instruction-file change; the P7 record gate runs it anyway |
| Bash output cap hook | unavailable. Route every suite through the tier runner's digest (`commands.tier`), and never paste raw suite output into a phase |
| Registry read guard hook | instruction only: seats read one row with `npx builder-pipeline run ledger-row registry <ID>`; check a seat's transcript if in doubt |
| Reviewer write guard hook | post-phase `git status --porcelain`: the only change the reviewer may leave is its review file |
| Re-anchor after compaction | unavailable. After any compaction, re-read `state.md`, the board's `phase:status` block and the open `FIX-n` rows by hand before the next dispatch (the playbook's rule) |
| Session-start index refresh | unavailable. The P1 index gate (`npx builder-pipeline run index-check`) is the catch; for the graphify example, `autosync.py --trigger p1` refreshes under the shared lock and embed limit |
| Subagent spawn depth 1 | not needed: fresh sessions cannot dispatch |
| Prompt-cache TTL by replay | unavailable: no such settings are exposed |
| `effort:` frontmatter | ignored. Use a per-run reasoning setting if your Codex version has one (profile §12) |
| Orchestrator model check | `npx builder-pipeline run orchestrator-check` prints `unmeasurable here`: no transcript it can read |
| Per-seat cost accounting (`costAccounting`, `seat-peaks`, `cost-window`) | partial. With `reader: "codex"`, `npx builder-pipeline run cost-window --since <iso> --until <iso>` reads the Codex rollout files under `$CODEX_HOME/sessions` (or `--transcripts <dir>`) and sums each session's tokens per model; one session file is one dispatch, its seat the session's `agent_role` or `codex-session`. The kit ships no OpenAI rates, so a session is unpriced (its tokens are shown, never `$0.00`) unless `--rates <file>` names a table. `seat-peaks` prints "unmeasurable" with its reason, and the agents table renders em-dashes (see below) |
| Live page · Workflow-driven runs · advisor A/B | unavailable |
| Batch orchestrator (`orchestrator`, `scripts/orch.mjs`) | runs as is: plain Node over git, with every seat action a command template you fill for this harness (`launchCommand`, `stateCommand`, `stopCommand`, `usageCommand`). A primary-seat pipeline lane is its own session. The credit worker adapter ships for Claude Code only — keep `credit.enabled` false here until one exists for this harness |
| Language server plugin | unavailable as a plugin; any editor integration you run yourself is outside the pipeline |

Codex keeps no per-dispatch usage records of the shape the board's accounting reader expects, so
the per-seat model / wall-clock / token / cost columns render as em-dashes. That is the designed
### Worker recipe (a lane on a Codex account)

How a lane starts on an account whose `worker` is `codex` (`features.accounts`; the rulebook is
`skills/references/account-selection.md`):

- **Start.** `npx builder-pipeline run orch gate-launch <run> <lane>` prints the account, its caps and the filled command.
  The account's `command` is the template; the kit fills `{brief}`, `{worktree}`, `{result}`, `{branch}`,
  `{account}`, `{maxTurns}` and `{timeoutMinutes}`.
- **Environment.** `CODEX_HOME` is the account's dir (`accounts/<name>/` under the accounts home, or the account's
  `configDir`); `auth.json` and `config.toml` live there. No `OPENAI_*` variable is inherited: a key enters the
  account once through `codex login --with-api-key` and is never stored by the kit.
- **Flags.** Headless: `codex exec --json -s read-only` for a reading role (an auditor, the reviewer, a tester
  that only reads) or `-s workspace-write` for a building role, with `--output-schema <schema file>` so the result
  carries the fields the verdict needs. Codex has no turn-cap flag: the runner owns the timeout (`timeoutMinutes`)
  and `maxTurns` is recorded on the launch line only. A review job uses the harness's review subcommand on the lane's
  diff. Resume: `codex exec resume <id>` under the same `CODEX_HOME` only.
- **What the kit cannot enforce here.** No hook runs: the registry guard, the reviewer write guard and the bash cap
  are instructions, checked by `git status --porcelain` after the phase. No per-path deny rule exists, so a
  path-root account (a `content` list) is refused on this worker rather than half-enforced. The sandbox is the
  harness's own (`-s`), not the kit's. Usage is read from the session's own rate-limit records (unmeasured when
  none is written).

Codex keeps no per-dispatch usage records of the shape the accounting reader expects, so the
per-seat model / wall-clock / token / cost columns render as em-dashes. That is the designed
outcome, not a failure: every other section — rows, steps, gates, files, ceiling — is unaffected,
and an em-dash says *unmeasured* where a zero would claim a measurement nobody took. Set
`features.costAccounting` to `off` so the board says so, or to `on` with `reader: "codex"` to
measure spend windows with `cost-window`: it reads the `token_count` events of each rollout file
(`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`), sums the differences between the cumulative
totals per model, and lists any file whose shape it does not recognise as `unmeasurable` with the
line number. The format it reads is written down in `specs/toolkit-cost-codex.spec.md` (maintainer
repository).

## qa-audit (if installed)

- No parallel dispatch: run the phases sequentially in one session, or split across fresh sessions
  using the written artifacts as the handoff (report + worklist + transcript are files, so nothing
  needs to survive in context).
- Pack authoring is one module per session — the requirement rows, state machine and deferral
  registry for a single module are a comfortable context; two modules are not.
- Confirm the environment choice explicitly before the run; there is no interactive prompt to
  fall back on mid-flight.
