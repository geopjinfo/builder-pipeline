# hooks/ — mechanical guardrails (opt-in)

<img alt="principle" src="https://img.shields.io/badge/principle-hooks_%3E_goodwill-red?style=flat-square">
<img alt="agnostic" src="https://img.shields.io/badge/universal_layer-any_agent-success?style=flat-square">
<img alt="enable" src="https://img.shields.io/badge/enabling-manual%2C_deliberate-orange?style=flat-square">

Personas *promise* to respect protected paths; hooks make it **mechanical**. Enforcement comes in
two layers — the universal layer works with **any** coding agent; adapter layers just intercept
earlier where a harness supports it.

| Layer | File | How it enforces | Enable |
|---|---|---|---|
| 🌍 **Universal** (any agent, any harness — the backstop) | `protected-paths-precommit.sh` | git `pre-commit`: rejects commits whose staged files touch a `PIPELINE_PROFILE.md` §4 path; `BUILDER_UNLOCK=<tag>` env grant for sanctioned work | fill its `PROTECTED` list → `cp builder/hooks/protected-paths-precommit.sh .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit` |
| 🌍 **Universal** | `node builder/cli.js check-ledgers` | ledger gates LG-1…LG-5 over boards + registry, CI-ready exit codes | add to CI / pre-push |
| 🌍 **Universal** | phase diff check (no file — a practice) | after any read-only phase: `git status --porcelain` must be empty; the tester's diff must touch test paths only | write it into your CI or review habit (see `adapters/generic.md`) |
| 🔌 Adapter: Claude Code | `protected-paths.js` | `PreToolUse` hook blocks the edit **before it happens** (earlier than pre-commit) | copied to `.claude/hooks/` by the CLI's claude-code target; fill `PROTECTED`, then add the settings snippet from the file header — the CLI never arms it |
| 🔌 Adapter: Claude Code | `board-render.js` | `PostToolUse`: re-renders any run board whose page is older than its own run log — the belt to `board-watch.mjs`'s braces, for the writes a watcher misses (none started, one killed, a host without recursive `fs.watch`). Never blocks: exit 0 on any input, any failure | copy to `.claude/hooks/`, add a `PostToolUse` entry matching `Write|Edit|MultiEdit|Bash` |
| 🔌 Adapter-neutral (git) | `graphify-post-merge.sh` | post-merge: background incremental graphify re-extraction + deferred-semantic-sync marker; no-op until graphify adopted | `cp builder/hooks/graphify-post-merge.sh .git/hooks/post-merge && chmod +x .git/hooks/post-merge` |

Rules of thumb:

- **Always enable the universal layer** — it holds regardless of which agent (or human) made the
  change. Adapter hooks are an upgrade, never a substitute.
- Arming anything that changes agent behaviour repo-wide is a **human's deliberate act** — the
  CLI copies hook files but never activates them.
- If your harness has its own hook/guard system (Cursor rules constraints, other CLIs' policy
  files), mirror the same `PROTECTED` list there — one source of truth: profile §4.
