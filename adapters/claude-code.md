# Adapter — Claude Code

> **Commands.** Written for the npm-package install: a kit script runs as `npx builder-pipeline run <name>`. With the
> kit copied in as a `builder/` folder ([`UNPACK.md`](../UNPACK.md)), run it from the project's `scripts/` copy with Node.

One adapter among eleven. It is privileged in nothing, but it has the richest native integration:
personas register as subagents, skills as `/skills`, hooks can see and change a tool call before
or after it runs, and every dispatch leaves a transcript the pack can read for accounting.

Everything harness-specific in the pack lives here and in `hooks/claude-code/`. The other adapters
say, line by line, what each item becomes without this harness.

## File placement

`npx builder-pipeline unpack --tool claude-code --dry-run` prints every destination. It is the
authority if this table and the CLI ever disagree.

| Kit file | Target |
|---|---|
| `agents/*.md` (10) | `.claude/agents/*.md`. **Frontmatter transformed at install:** the neutral `capabilities` / `tier` / `effort` become Claude Code's `tools` / `model` / `effort` (read-only → no Edit/Write; strong → opus, mid → sonnet unless `--models` says otherwise) |
| `skills/build-module-pipeline.md` | `.claude/skills/build-module-pipeline/SKILL.md` |
| `skills/references/*.md` (graph query block, review template) | beside the pipeline skill, `.claude/skills/build-module-pipeline/references/` |
| `skills/scaffold-module.md` · `module-readiness-check.md` · `setup-builder.md` · `orchestrator.md` · `spec-author.md` | `.claude/skills/<name>/SKILL.md` |
| `templates/orchestrator-plan.md` · `orchestrator-worker-brief.md` | `specs/orchestrator-plan.template.md` · `specs/orchestrator-worker-brief.template.md` |
| `templates/task-board.md` | `tasks/README.md` |
| `templates/deferred-registry.md` | `DEFERRED_TASKS.md` (repo root) |
| `templates/module-brief.md` | `specs/module-brief.template.md` (or your briefs dir) |
| `PIPELINE_PROFILE.template.md` | `PIPELINE_PROFILE.md` (repo root, **filled**, §16 included) |
| `scripts/*.mjs` + `scripts/lib/*.cjs` + `oracles/` | **Package install: not copied.** They run from the package as `npx builder-pipeline run <name>` (`npx builder-pipeline run` lists them). Folder copy (`builder/`): `scripts/`, `scripts/lib/`, `scripts/oracles/` (plain Node, harness-independent) |
| `hooks/claude-code/*.cjs` | `.claude/hooks/` — **copied, never registered.** Registering is a person's act (below). Package install: the scripts those hooks load are vendored beside them under `.claude/hooks/kit/`, never read from `node_modules` |
| `hooks/protected-paths.cjs`, `hooks/board-render.cjs` | `.claude/hooks/` — same rule. Register `protected-paths.cjs` on `PreToolUse` with the matcher `Edit\|Write\|MultiEdit\|NotebookEdit\|Bash\|PowerShell` (its header has the snippet): a matcher without `Bash`/`PowerShell` leaves the shell route unguarded, and one without `NotebookEdit` leaves notebook writes unguarded |
| `agents/experimental/page-keeper.md` | `.claude/agents/page-keeper.md` — only with `--experimental` |
| `agents/experimental/progress-reporter.md` | `.claude/agents/progress-reporter.md` — only with `--experimental`; `capacity-steward` is in the ten above and installs read-only (no Edit/Write) |
| `tooling/experimental/page-shell.{cjs,mjs}` | only with `--experimental`. Package install: not copied, run as `npx builder-pipeline run experimental/page-shell`. Folder copy: `scripts/experimental/` |

`scripts/unpack.sh claude-code` / `scripts/unpack.ps1 claude-code` does the copies without Node,
but without the frontmatter transform.

## Post-copy wiring

1. **Models.** The install transform maps `tier: strong` → `opus`, `mid` → `sonnet` unless the
   project declares its models: `models.strong` / `models.mid` in `PIPELINE_PROFILE.md` §16 reach
   the agents at `unpack` and `upgrade` (REQ-2021), and `--models strong=<x>,mid=<y>` on the command
   wins over both (the setup skill picks these by inspecting your subscription). To change later,
   edit §16 and run `npx builder-pipeline run seat-models --write` (REQ-2029; without `--write` it
   reports each agent whose `model:` line differs from §16) — never edit `builder/agents/`, which
   stays neutral. Keep strong models where profile §12 puts them.
2. **Effort.** A persona may carry `effort:` (`low` … `max`). It overrides the session's effort for
   that seat only. The pack ships the docs seat at `low`: it writes prose from facts it is handed,
   and it is a small share of any run's spend. Other seats inherit the session's effort.
3. **Skills routing.** Agents reference skills by name; Claude Code resolves them once installed.
   Optionally add `skills: [scaffold-module]` to `module-builder.md` and
   `skills: [module-readiness-check]` to `module-reviewer.md` so they preload.
4. **CLAUDE.md** — done by `unpack`: it appends the pointer block between the `builder-kit:pipeline`
   markers and leaves the rest of the file byte for byte. Check it is there; do not paste a second copy.
5. **.gitignore** — done by `unpack`: it appends `.pipeline/` and `<paths.logs>/bash/` (the output cap's
   logs) when they are not listed yet. Add the rest of your `paths.logs` directory by hand if it should
   stay untracked.
6. **Settings** — the block below, merged into `.claude/settings.json` by a person.

## Settings

```json
{
  "env": { "CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH": "1" },
  "hooks": {
    "PreToolUse": [
      { "matcher": "Read",
        "hooks": [{ "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/.claude/hooks/registry-read-guard.cjs\"" }] },
      { "matcher": "Write|Edit|MultiEdit",
        "hooks": [{ "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/.claude/hooks/reviewer-write-guard.cjs\"" }] },
      { "matcher": "Write|Edit|MultiEdit",
        "hooks": [{ "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/.claude/hooks/secret-write-guard.cjs\"" }] },
      { "matcher": "ScheduleWakeup|CronCreate|Monitor",
        "hooks": [{ "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/.claude/hooks/foreground-guard.cjs\"" }] }
    ],
    "PostToolUse": [
      { "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/.claude/hooks/bash-output-cap.cjs\"" }] }
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

**Every hook runs only committed code.** A hook starts outside the permission prompt, so it loads
`scripts/lib/*.cjs` or spawns `scripts/*.mjs` (package install: the vendored copies under `.claude/hooks/kit/`) only when that file and every local file it requires are
byte-for-byte the blob at HEAD (`hook-trust.cjs`, copied next to the hooks; it hashes the bytes and never
trusts `git status`, whose index flags and fsmonitor an agent can set). An uncommitted change to
that code switches the hook to its safe fallback until the change is committed. The guards keep their
defaults, and the advisory hooks say they did not run.

| Hook | Event | What it does | Needs from §16 |
|---|---|---|---|
| `bash-output-cap.cjs` | `PostToolUse` · `Bash` | An output over `features.bashCap.limitBytes` is written whole under `paths.logs`. The context gets every error-shaped line with its line number, the tail, and the log path. The tier runner's output, already a digest, passes through. Never fails the tool call: any error leaves the original output in place | `bashCap` on · `limitBytes` · `paths.logs` |
| `registry-read-guard.cjs` | `PreToolUse` · `Read` | Blocks a seat named in `features.registryGuard.seats` from reading the whole registry, and names the row reader instead: `npx builder-pipeline run ledger-row registry <ID>`. The orchestrator carries no seat identity in the hook input and keeps Read | `registryGuard` on · `seats` · `paths.registry` · `rowReader` on |
| `instruction-lint-on-edit.cjs` | `PostToolUse` · `Edit\|Write\|MultiEdit` | When the edited file is an instruction file, runs `npx builder-pipeline run instruction-lint --files <it>`. A failure goes back to the agent as a blocking decision with the lint's lines, so a dead path or a bare line reference is fixed in the same turn. Never fails the tool call | `instructionLint` on · `files` |
| `reanchor-after-compact.cjs` | `SessionStart` · `compact` | After a compaction, hands the session each run in flight: its `state.md` with the `Now:` line, the board and its first open phase, and the open `FIX-n` rows copied verbatim. It reads files only and makes no model call; no run in flight means no output. The orchestrator still re-reads the files: this only stops a summary from losing where they are | `reanchor` on · `maxRuns` · `paths.runs` · `paths.boards` |
| `reviewer-write-guard.cjs` | `PreToolUse` · `Write\|Edit\|MultiEdit` | The reviewer may write exactly one kind of file: its review, `<runs>/<key>/review-pass<n>.md`. Every other write by that seat is blocked. A grant of Write to one file is only a grant if something enforces the one file | `reviewTemplate` on · `paths.runs` |
| `secret-write-guard.cjs` | `PreToolUse` · `Write\|Edit\|MultiEdit` | The content of a Write and the new text of an Edit or MultiEdit is scanned with the outbound guard's secret shapes (`scripts/lib/outbound-guard.cjs` SHAPES, D88); a hit denies the write naming the kind, never the text. A path in `features.secretScan.allow` passes. The shapes and the loader come through hook trust; untrusted, the hook passes and says so — the pre-commit scan (`hooks/secret-scan-precommit.sh`, any tool) still holds | `secretScan` on · `allow` |
| `foreground-guard.cjs` | `PreToolUse` · `ScheduleWakeup\|CronCreate\|Monitor` | While a pipeline run is open (a `<paths.runs>/<key>/state.md` written in the last `openHours`), a timer tool call by the orchestrator is denied with the foreground rule as the reason (REQ-2004, REQ-2022): the seat is dispatched and waited for in the same step. Off, or without a trusted profile, the hook passes. A failure in the hook allows the call | `foregroundGuard` on · `openHours` · `paths.runs` |
| `lane-gate.cjs` | `TaskCompleted` · `Stop` | Runs the lane's gate (its test command) before a headless worker may call its work done. Exit 0 lets the completion through; a failed gate returns exit 2 with the gate output as the reason, so the verdict stays open. The kit writes this entry into a lane's `--settings` pin only, with the marker `builder-pipeline-lane-gate`, so the entry can be found and removed; it never enters a project's live settings | `accounts` on · the lane's gate command |
| `lane-shell-allow.cjs` | `PreToolUse` · `Bash` | The loop worker's gate command in its two normalised forms (D69): with a `cd <own worktree> &&` prefix (no `..`, no other directory, no second command) or one `\| head -n N` / `\| tail -n N`. An accepted command answers `permissionDecision: allow`; any other command gets no answer and the exact allow list denies it as before. Written into the loop's `--settings` pin only, with the marker `builder-pipeline-lane-gate` | `boardLoop` on · the lane's gate command and worktree |

**Where the cap takes effect — probed, not assumed.** A disposable project was driven headless with
a large payload and a small negative control. In the **main session** the large output was replaced
and the small one passed untouched. **Inside a subagent** the hook fired (its input carried the
agent's id), but the seat still received the raw output. So the cap protects the orchestrator's
context, where tool output accumulates across the whole run. It does not shrink a seat's context.
Seats get the same protection by running suites through the tier runner's digest.

**Seats: a pre-run cap (not shipped yet).** A `PreToolUse` hook that returns
`hookSpecificOutput.updatedInput.command` *is* applied inside a subagent — probed, and it still applies
with no `permissionDecision` in the output. One adopting project uses that to cap seat output: the hook
rewrites an allow-listed long-output command (test runners, type-checkers, linters, `git log|diff|show`,
recursive greps, `find`) so its output goes whole to `paths.logs`, and the seat receives this same digest,
with the command's own exit code restored. The rules it follows, if you build one before the pack ships it:
- **Seats only.** Fire only when the hook input carries an agent id. The main session keeps the
  `PostToolUse` cap above.
- **Allow-list, not rewrite-all.** Bounded reads (`cat`, `head`, a plain `grep -n`) stay raw. A digest of
  them only forces a second read of the log.
- **Never drop an error line.** End the rewritten command with this digest, not a bare `tail`.
- **No `permissionDecision`.** Return `updatedInput` only. An `allow` would turn the cap into a
  permission bypass for every allow-listed command.
- **One cap per call.** Print `PRECAP_MARK` as the first output line and name `bash-precap` in the
  command. `digest()` passes a marked result through, and `EXEMPT` matches the rewritten command.
- **Leave alone:** pipes, stdout redirects, heredocs, multi-line commands, backgrounding, `exit`, and
  interactive programs. Restore the exit code with `(exit $rc)`, not `exit $rc`, because the shell
  persists between calls.

`BUILDER_NO_BASH_CAP=1` opts a command out of both caps. The `Bash` matcher does not cover other shell
tools.

The guards read the dispatching seat's name from the hook input, which the harness supplies for
subagent tool calls. A guard blocks with exit code 2 and says what to do instead.

### Session-start index refresh (optional)

If §16 has `features.graph` on, copy `tooling/optional/session-sync-hook.cjs` from the kit into
`.claude/hooks/` **by hand** — `unpack` does not install it — and arm it on `SessionStart`. It starts the index sync **detached**, so it never delays the session.
Through `autosync.py --trigger session` it shares the lock and the automatic-embed limit with your
other triggers.

- **When it speaks:** only when the previous run left docs above the limit.
- **When it stays silent:** no index, no interpreter, `INDEX_SYNC_SKIP` set, or index scripts that
  differ from HEAD. It needs `hook-trust.cjs` beside it in the hooks folder (`npx builder-pipeline unpack --tool
  claude-code` copies it with the guards); without it, it starts nothing.
- **The merge trigger:** the post-merge block `sync-hook.sh` installs runs this same hook with
  `--trigger merge`, so both triggers get the same trust check and isolated interpreter.
- **Another index tool:** it is written for the graphify example; keep its shape and change the
  command it spawns (see [`tooling/optional/README.md`](../tooling/optional/README.md)).

It catches docs that arrive with no commit or merge. Without it, the P1 index gate still refuses a
stale index.

Belt and braces for the board: `hooks/board-render.cjs` on `PostToolUse` matching
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
- **One writer at a time.** Agent calls dispatched in a single message run concurrently, and a row
  flip is a read-modify-write of the whole board file — so concurrent seats clobber each other.
  When you dispatch more than one at once, tell each not to touch the board, take their row
  outcomes from their final messages, and write the rows yourself.
- **One run per session; stop at `run.end`.** Follow-up work takes a new key, board and session.

## The orchestrator model is a session setting, so it needs a check

A seat's model is fixed in its frontmatter. The orchestrator's model is whatever the session was
started on. Nothing in a file pins it, so a run can silently use the wrong one. With
`models.orchestrator` set and `features.orchestratorModel` on, run this at P0:

```
npx builder-pipeline run orchestrator-check
```

It reads the current session's transcript and compares the observed model with the declared one.
A mismatch **warns** (exit 5) and never refuses: the model is a cost and capability choice, not a
correctness gate. A session with no readable transcript is **unmeasured**, never a pass. It is a P0
command rather than a `SessionStart` hook, because a hook cannot tell a pipeline session from any
other session.

## Accounting: per-seat cost from the harness's own records

With `features.costAccounting` on (`reader: "claude-code"`), `npx builder-pipeline run board-render <key>`
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

Instruments that read the same records: `npx builder-pipeline run cost-window` (spend over a time window,
for before/after comparisons), `npx builder-pipeline run seat-peaks` (per-dispatch peak context, which is
how the builder-batch setting is judged).

## The batch orchestrator on Claude Code (feature `orchestrator`)

`scripts/orch.mjs` is plain Node and harness-neutral: everything seat-specific is a command template in
`features.orchestrator`. The values below are what one adopting project runs on Claude Code; check each against
your CLI version before relying on it.

- **Two plan accounts on one machine.** The second account keeps its own config dir: set
  `secondaryConfigDir` (for example `.claude-secondary`, under your home) and log in once with
  `CLAUDE_CONFIG_DIR` pointing at it. Every child process must start with **every inherited `CLAUDE*` variable
  removed** — an inherited one makes the child a nested session of the one that launched it.
- **`launchCommand`** starts a secondary-seat worker: an interactive `claude` session in the lane worktree, with
  `CLAUDE_CONFIG_DIR` set to the secondary dir, `CLAUDE*` cleared, any API key removed from its environment, the
  permission mode your project uses (never a bypass mode), and a first message pointing at `{brief}` and `{result}`.
  Keep it in a small script beside your other tooling and reference the script from the template. A folder the
  account has never opened shows a trust prompt nobody is there to answer: open each lane folder once by hand, or
  reuse long-lived lane folders (list them in `features.worktreeSweep.reserved`). A background launch
  (`claude --bg`) logs its session id; record it with `npx builder-pipeline run orch launch-id <log>`, never the first id in
  the log: `--resume <id>` with flags starts a COPY and names the old session first, and the old session's `done`
  would stall the lane at once (exit 1 while the copy id is not in the log yet). It reads UTF-16 logs too
  (PowerShell's `*>`).
- **`stateCommand`** reports one word for a session. The secondary account keeps its own session registry, so the
  orchestrating session's own messaging cannot reach a secondary worker by name; read `claude agents --json --all`
  under the secondary config dir and print the session's state (`working`, `done`, `idle`, `blocked`, `failed`,
  `stopped`). Without it, `orch watch` still finishes on the result file and stalls on the clock.
- **`stopCommand`**: `claude stop {session}` under the secondary config dir.
- **`usageCommand`**: `claude -p "/usage"` under the seat's config dir is a local command (no model turn) whose
  output carried "N% used" lines; the highest is recorded. Recent CLI versions print a cost and token summary
  with no percentage: that reading is recorded as `usage.unknown` with its first lines, the seat stays unmeasured
  (never 0%), and the next seat is read. Record a percentage by hand with `orch usage <run> <seat> <pct>`.
- **Primary-seat pipeline lanes.** With spawn depth 1 a sub-agent cannot dispatch the pipeline's seats, so a
  primary-seat lane that runs a pipeline is its own session on the primary account; only a SOLO lane runs as a
  sub-agent of the orchestrating session.
- **`primaryLaunch: "app-session"`** (Claude desktop app only). The orchestrator starts that session itself with
  the app's session tool (`start_session`: a fresh session, the lane worktree as its folder, the brief pointer as
  its prompt) and records the returned id. The lane then shows in the sidebar, where the human can open it in split
  view or ask it questions through a side chat without adding to its context. Three limits, all observed:
  - **Plugins installed at local scope may not load** in an app-started session, although a CLI session in the same
    folder loads them. The brief's first step therefore checks that the pipeline skill and every plugin it needs
    are present, and writes `RESULT: FAIL missing <what>` as line 1 of the result file when one is not.
  - **The turn-end note is cut at about 400 characters**, so it is a trigger only. Line 1 of the result file stays
    the contract.
  - **A permission prompt parks the session.** Handle it like a stall: name the prompt, fix the brief or the
    settings, relaunch.

  Terminal-only setups keep `manual`. Cloud sessions are never used for lanes: they need network access an
  air-gapped project does not have.
- **Shells.** In Windows PowerShell, `npm run x -- --flag` can drop the flags: call `npx builder-pipeline run orch …`
  directly. A version manager that swaps Node may also drop the globally installed CLI; reinstall it per Node
  version.

### Worker recipe (a lane on a Claude Code account)

How a lane starts on an account whose `worker` is `claude-code` (`features.accounts`; the rulebook is
`skills/references/account-selection.md`):

- **Start.** `npx builder-pipeline run orch gate-launch <run> <lane>` prints the launch line: the account, its `maxTurns` and
  `timeoutMinutes`, the `--settings` pin and the filled command (the account's own `command`, else `launchCommand`).
  Run that line; never a line you typed yourself.
- **Environment.** `CLAUDE_CONFIG_DIR` is the account's dir (`accounts/<name>/` under the accounts home, or the
  account's `configDir`). Every inherited `CLAUDE*` variable is cleared, and no API key or auth token is in the
  environment: a plan account signs in through its own store, a key account through `apiKeyHelper` in the account's
  own `settings.json`. The pin (`--settings <run>/pins/<lane>.settings.json`) carries the account's env block, its
  config dir, its `baseUrl` and the deny rules of a path-root account; it never carries a key.
- **Flags.** Headless: `claude -p --output-format json --json-schema <schema file> --permission-mode <the project's mode>
  --permission-prompts none --max-turns <maxTurns>`; the runner owns the wall-clock timeout (`timeoutMinutes`).
  Interactive terminal lane: the same config dir and pin, the project's permission mode, a first message pointing at
  `{brief}` and `{result}`. Resume: `--resume <id>` under the same config dir only — a resume on another account
  starts a copy with no memory of the lane.
- **What the kit cannot enforce here.** The folder trust prompt (open each lane folder once by hand); what the model
  does inside the permission mode you chose; a hook or env block the account's user-scope settings add (the settings
  scan refuses the keys it knows, not every key); the subscription's own rate-limit clock (a `LIMIT` hold reads the
  reset time the harness reports); a sign-in that expired between the assessment and the launch (the `AUTH` hold
  then names `claude auth login`).

**The credit worker** (`credit.worker: "claude-code"`, `scripts/lib/orch-worker-claude-code.cjs`) runs
`claude -p --output-format stream-json --verbose` with the prompt on stdin, `--permission-mode dontAsk` and an exact
allow list, `--strict-mcp-config`, `--setting-sources project` (your repo's hooks and fences still apply; user and
local settings do not), `--no-session-persistence` and a per-job `--max-budget-usd`. Never `--bare`: it would skip
the repo's own fence hooks. It runs in a clean guard config dir under your home (`credit.guardDir`, default
`.claude-credit-worker`); a guard dir holding user memory, plugins or MCP servers is refused.

- **The key comes from the shell, never from the pack.** Start `orch credit-run` in a shell whose profile exports
  `ANTHROPIC_API_KEY` (and keep that export out of your interactive sessions, or every interactive `claude` bills
  the credit). The worker's first stream event must say `apiKeySource` is that key; a plan-account fallback must
  say `none`, and is stopped before any model call when it would bill the key.
- **Model floor.** `models.strong` / `models.mid` are matched as substrings of `--model`, so a family name
  (`opus`, `sonnet`) works for both short and full ids.
- **Test hooks.** `BUILDER_CREDIT_WORKER_BIN` points the lane at a stub binary (the pack's tests use
  `tests/fixtures/orch/stub-worker.cjs`); it must be an absolute path to an existing file.

## Experimental (installed only with `unpack --experimental`)

Each item has its measurement in [`EXPERIMENTS.md`](../EXPERIMENTS.md) and a §16 state of
`experimental-off` until someone turns it on on purpose.

- **The live page** (`features.livePage`). A read-only page that shows the run as it happens,
  published to the harness's hosted artifact store. `npx builder-pipeline run board-render <key> --json`
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
