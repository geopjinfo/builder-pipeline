# hooks/ — mechanical guardrails (opt-in)

<img alt="principle" src="https://img.shields.io/badge/principle-hooks_%3E_goodwill-red?style=flat-square">
<img alt="agnostic" src="https://img.shields.io/badge/universal_layer-any_agent-success?style=flat-square">
<img alt="enable" src="https://img.shields.io/badge/enabling-manual%2C_deliberate-orange?style=flat-square">

Personas *promise* to respect protected paths, read one registry row, and keep reviews in their
own file. Hooks make those promises **mechanical**. Enforcement comes in two layers. The universal
layer works with **any** coding agent. Adapter layers intercept earlier where a harness supports
it, and each adapter row names what it becomes elsewhere.

| Layer | File | How it enforces | Optional? · needs from `PIPELINE_PROFILE.md` §16 | Enable |
|---|---|---|---|---|
| 🌍 **Universal** (any agent, any harness — the backstop) | `protected-paths-precommit.sh` | git `pre-commit`: rejects commits whose staged files touch a protected path; `BUILDER_UNLOCK=<tag>` env grant for sanctioned work | recommended · its `PROTECTED` list mirrors `protected` | fill its `PROTECTED` list, copy it to `.git/hooks/pre-commit` (or your `core.hooksPath` directory) and make it executable |
| 🌍 **Universal** | `npx builder check-ledgers` | ledger gates LG-1…LG-5 over boards + registry, CI-ready exit codes | recommended · `paths.boards`, `paths.registry` | add to CI / pre-push |
| 🌍 **Universal** | phase diff check (no file — a practice) | after any read-only phase: `git status --porcelain` must be empty; the tester's diff must touch test paths only; the reviewer's only change is its review file | recommended · none | write it into your CI or review habit (see `adapters/generic.md`) |
| 🔌 Adapter: Claude Code | `protected-paths.cjs` | `PreToolUse` hook blocks the write **before it happens** (earlier than pre-commit), on every route: file tools (incl. NotebookEdit) and shell (Bash, PowerShell) — shell write shapes, a link created into a protected folder (after any statement lead, `subst`/`New-PSDrive` included), a relative write after `cd`, code naming a protected path; each judged by where it **lands** through junctions and symlinks, and a hard-linked target fails closed. A data heredoc body or a read-only pipeline that only names a protected path is not a write. The hook's own file defines the set, so it is protected whenever anything is (`BUILDER_UNLOCK=fence`) | optional · `protected` | copied to `.claude/hooks/` by the CLI's claude-code target; fill `PROTECTED`, then add the settings snippet from the file header — the CLI never arms it |
| 🔌 Adapter: Claude Code | `board-render.cjs` | `PostToolUse`: re-renders any run board whose page is older than its own run log — the belt to `board-watch.mjs`'s braces, for the writes a watcher misses (none started, one killed, a host without recursive `fs.watch`). Never blocks: exit 0 on any input, any failure | optional · `paths.boards`, `paths.runs` | copy to `.claude/hooks/`, add a `PostToolUse` entry matching `Write|Edit|MultiEdit|Bash` |
| 🔌 Adapter: Claude Code | `claude-code/bash-output-cap.cjs` | `PostToolUse` · `Bash`: output over the limit goes whole to a log; the context gets every error-shaped line with its number, the tail, and the log path. Takes effect in the **main session only** (probed: inside a subagent the hook fires but the raw output still reaches the seat). Never fails the tool call | optional · `features.bashCap` on, `limitBytes`, `paths.logs` | settings entry in `adapters/claude-code.md` § Settings. **Elsewhere:** unavailable — route suites through the tier runner's digest |
| 🔌 Adapter: Claude Code | `claude-code/registry-read-guard.cjs` | `PreToolUse` · `Read`: blocks a named seat from reading the whole registry and points it at `node scripts/ledger-row.mjs registry <ID>`; the orchestrator keeps Read | optional · `features.registryGuard` on, `seats`, `paths.registry`; `features.rowReader` on | settings entry in `adapters/claude-code.md`. **Elsewhere:** instruction only |
| 🔌 Adapter: Claude Code | `claude-code/reviewer-write-guard.cjs` | `PreToolUse` · `Write|Edit|MultiEdit`: the reviewer may write only `<runs>/<key>/review-pass<n>.md`; any other write by that seat is blocked | optional · `features.reviewTemplate` on, `paths.runs` | settings entry in `adapters/claude-code.md`. **Elsewhere:** post-phase `git status` check |
| 🔌 Adapter-neutral (git) | `graphify-post-merge.sh` | post-merge: background incremental graphify re-extraction + deferred-semantic-sync marker; no-op until graphify adopted. One example of an index merge trigger — see `tooling/optional/README.md` for the contract any index tool should meet | optional · `features.graph` | copy it to `.git/hooks/post-merge` (or your `core.hooksPath` directory) and make it executable |

Rules of thumb:

- **Always enable the universal layer** — it holds regardless of which agent (or human) made the
  change. Adapter hooks are an upgrade, never a substitute.
- Arming anything that changes agent behaviour repo-wide is a **human's deliberate act** — the
  CLI copies hook files but never activates them.
- **A hook whose feature is `off` in §16 is not registered.** Registering it anyway gives a guard
  that reads settings saying it should do nothing. Switch the feature on first, then register it.
- Harness hooks are read at session start. A hook registered mid-session does nothing until the
  next session.
- If your harness has its own hook/guard system (Cursor rules constraints, other CLIs' policy
  files), mirror the same protected list there — one source of truth: the profile.
