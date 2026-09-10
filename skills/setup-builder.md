---
name: setup-builder
description: Use to set up, re-verify, or upgrade the builder pipeline kit in this repository — harness detection, CLI unpack, docs-driven profile discovery including the §16 pipeline settings, the batched human-confirm pass, optional hardening, verify + feature states, and the dry-run proof. Trigger on "set up the builder kit", "install the pipeline", "onboard this repo to the builder", "re-verify the builder setup", or "upgrade the builder kit". First-time bootstrap: paste builder/SETUP_PROMPT.md instead (this skill isn't installed yet).
---

# Setup-builder — onboard a repo to the pipeline (agent-executed)

You are the setup operator. The kit lives in `builder/`; the target is THIS repository. Work the
phases in order; each ends with a visible checkpoint. Ask the human only at the two marked
points — batch everything else.

## Phase 0 — preflight

- Confirm cwd = repo root and `builder/agents/` exists (if not, stop: the kit isn't in place yet).
- Confirm there is **no `builder/.git`**. A pack with its own `.git` is a copied working directory,
  not a release archive: stop and ask the human for the release (`builder/UNPACK.md` § Receive the
  pack).
- Confirm `node --version` is 18 or newer. If Node is missing or older, fall back to
  `builder/scripts/unpack.sh` or `unpack.ps1` (claude-code and codex only, no frontmatter
  transform, no checkers), and say so.
- Run `node builder/tests/run.mjs`. Red means a damaged pack or an old Node: stop and report.
- Record how many lines `git status --porcelain` prints (setup doesn't require clean; the number
  goes in the final report so the human can separate kit files from their own edits).
- **Upgrade mode:** if `PIPELINE_PROFILE.md` already exists and is filled, this is a re-verify/
  upgrade run. Run the CLI (copy-if-absent adds only new kit files; changed kit files are never
  overwritten, so list them from the kit's `CHANGELOG.md` for the human to diff), then:
  - if the profile has **no §16 `pipeline-settings` block**, run Phase 3 for §16 only;
  - otherwise skip Phase 3 and jump to Phase 5.

## Phase 1 — choose harness targets, models & settings 🧑‍💼

**1a. Detect targets.** Existing tool config: `.claude/` → claude-code · `AGENTS.md` →
codex/opencode · `GEMINI.md` → gemini · `.cursor/` → cursor ·
`.github/copilot-instructions.md` → copilot · `.windsurf/` → windsurf · `.clinerules/` → cline ·
`CONVENTIONS.md` → aider. Propose the detected set as `--tool` values (full menu:
`node builder/cli.js targets`).

**1b. Propose the tier→model mapping per detected harness.** Personas declare only
`tier: strong|mid`; the concrete models come from the USER'S harness, discovered — never assumed
from the kit's memory (model line-ups change too fast):

- Inspect the harness's own config for available/default models (examples: `~/.claude/`
  settings or the harness UI for Claude Code; `~/.codex/config.toml` or `codex --help` for
  Codex; the harness's config/model-picker elsewhere). If inspection is inconclusive, ASK.
- Recommendation shape: **strong** (plan · code · test · standards/security/invariant audits ·
  review) = the best reasoning model the subscription allows; **mid** (vuln-audit · docs) = the
  cheaper workhorse tier. Offer a budget variant (mid = cheapest capable model) if cost was
  mentioned.
- Propose the **orchestrator's model** too. It is a session setting, not a file, so it goes in
  §16 `models.orchestrator` and is checked at P0 where the harness allows.

**1c. Propose the other §12 settings per harness:** parallel audit dispatch (supported vs
sequential fresh sessions) · reasoning-effort/thinking budget if the harness exposes one (a persona
may carry `effort:`; the docs seat ships at `low`) · permission/autonomy mode (read-only seats must
be able to run inspection commands; the pipeline must still stop at the human seam) · tool-scoping
enforcement (native vs git-status verification). **Claude Code:** recommend subagent spawn depth 1
(the no-nested-run rule) and leave the prompt-cache TTLs at their defaults until a replay of real
transcripts decides them (`builder/adapters/claude-code.md`).

**Ask the human to confirm targets + models + settings in ONE batched question.** Ask in the same
batch whether they want the **experimental** items (default: no).

## Phase 2 — unpack (with the confirmed models)

```
node builder/cli.js unpack --tool <confirmed-list> --models strong=<model>,mid=<model>
```

`--models` applies to native-format targets (currently claude-code — baked into the installed
agents' frontmatter). For every other confirmed harness, record the confirmed mapping + settings
in `PIPELINE_PROFILE.md` **§12** during Phase 3 — that section is where dispatchers read it.
Append `--experimental` only on the human's explicit yes from Phase 1. Show the install summary
verbatim. The CLI never overwrites and pointer blocks are marker-guarded, so re-runs are safe.
(`--no-extras` only if the human asked for a lean install.)

## Phase 3 — discovery (fill the profile from THIS repo's docs)

Execute `builder/DISCOVERY.md` exactly: sweep this repo's conventions files → doc trees →
machine-readable truth (scripts, CI, schemas) → catalogue-shaped files → the tools optional
features need; fill every `PIPELINE_PROFILE.md` section with citations; explicit `N/A — <why>`
where empty; mark underivable decisions (oracles, protected paths, stance, human seam)
`⚠ CONFIRM`. **Never** import the kit's source-project rules; delete template examples this repo
lacks. Fill **§12** from Phase 1's confirmed mapping — one row per confirmed harness, including the
"how a phase is launched at that model" column and the four harness-settings lines.

Fill **§16** per DISCOVERY step 3: `commands`, `paths`, `models`, `protected`, and every feature's
state from what this repository actually has. **Never switch a feature on without the file or
tool it needs** — `off` prints `not configured`, which is honest; `on` with nothing behind it is
not. Experimental features stay `experimental-off` unless the human asked for them in Phase 1.

## Phase 4 — the confirm batch 🧑‍💼

Present ALL `⚠ CONFIRM` items as one batched question set, each with your recommended answer —
including every feature you left `off` that the human might want, with what it would need.
Apply the rulings; delete the template's leading note block; log non-obvious rulings as `D-n`
rows in `DECISIONS.md`.

## Phase 5 — optional hardening (offer, never assume)

| Offer | If accepted |
|---|---|
| **Universal pre-commit guard** (any agent — offer first) | fill `hooks/protected-paths-precommit.sh`'s `PROTECTED` list from profile §4, tell the human how to enable it (copy to `.git/hooks/pre-commit` or the `core.hooksPath` directory, executable), apply only on explicit yes |
| Ledger gate in CI | add `node builder/cli.js check-ledgers` to the CI pipeline / pre-push |
| Harness-specific earlier interception (if the harness has one) | e.g. Claude Code: fill `protected-paths.js`'s `PROTECTED` list, show the exact `settings.json` `PreToolUse` snippet (in the hook's header), apply only on explicit yes. Other harnesses: mirror profile §4 into their policy/rules mechanism if any |
| Claude Code settings and guards — **only for features `on` in §16** | spawn depth 1; `hooks/claude-code/bash-output-cap.js` (`bashCap`), `registry-read-guard.js` (`registryGuard`), `reviewer-write-guard.js` (`reviewTemplate`). Show the exact entries from `builder/adapters/claude-code.md` § Settings; apply only on explicit yes. Remind the human that settings take effect in the next session |
| Knowledge-index triggers | only if `features.graph` is on: the merge trigger, and a session-start trigger where the harness has one, under one lock and the automatic-embed limit (`builder/tooling/optional/README.md`) |

## Phase 6 — verify + dry run

1. `node builder/cli.js verify` — fix every FAIL (placeholders left = Phase 3 incomplete; a §16
   error names the key to fix).
2. `node scripts/features.mjs` — every feature's state. Check that each `on` feature's file or tool
   exists; switch off anything that cannot run yet.
3. Pick the smallest real backlog item, dispatch the `module-planner` persona on it, and check
   its output: `.pipeline/<key>/plan.md` exists, every decision cites a source from THIS repo,
   BLOCKERS are honest (a planner that guessed instead of blocking means the profile wording
   needs tightening — fix and re-run), and `node scripts/output-check.mjs plan .pipeline/<key>/plan.md`
   accepts it.

## Phase 7 — generate the developer guide

Generate `DEVELOPER_GUIDE.md` at the repo root from `builder/templates/developer-guide.md`:
fill every `{{…}}` from the **filled** profile and this setup run (tools installed, hardening
state, commands, oracles, protected paths, feature states, harness-specific invocation note); drop
the utility-skill rows that weren't installed and the sections marked *(omit if N/A)*; delete the
template's note block. **No placeholder may survive** — search the result for `{{` before moving
on. If a `DEVELOPER_GUIDE.md` already exists (upgrade mode), regenerate to a scratch path, show
the human a diff, and apply only on their yes.

## Phase 8 — report

One screen: targets installed · profile digest (stack, oracles, protected paths, golden path or
"none yet — first module is human-led") · feature states (from Phase 6) · rulings logged ·
hardening state · verify + dry-run results · `DEVELOPER_GUIDE.md` generated · uncommitted-file
count from Phase 0 · and the exact starter command, to be given in a fresh session: *"Build the
`<X>` module through the pipeline."* Point the team to `DEVELOPER_GUIDE.md` first,
`builder/USAGE.md` for depth.
