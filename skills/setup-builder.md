---
name: setup-builder
description: Use to set up, re-verify, or upgrade the builder pipeline kit in this repository — harness detection, CLI unpack, docs-driven profile discovery, the batched human-confirm pass, optional hardening, and the dry-run proof. Trigger on "set up the builder kit", "install the pipeline", "onboard this repo to the builder", "re-verify the builder setup", or "upgrade the builder kit". First-time bootstrap: paste builder/SETUP_PROMPT.md instead (this skill isn't installed yet).
---

# Setup-builder — onboard a repo to the pipeline (agent-executed)

You are the setup operator. The kit lives in `builder/`; the target is THIS repository. Work the
phases in order; each ends with a visible checkpoint. Ask the human only at the two marked
points — batch everything else.

## Phase 0 — preflight

- Confirm cwd = repo root and `builder/agents/` exists (if not, stop: the kit isn't pasted yet).
- Confirm `node --version` ≥ 14 (else fall back to `builder/scripts/unpack.sh|.ps1` — covers
  claude-code/codex only — and say so).
- Record `git status --porcelain | wc -l` (setup doesn't require clean; the number goes in the
  final report so the human can separate kit files from their own edits).
- **Upgrade mode:** if `PIPELINE_PROFILE.md` already exists and is filled, this is a re-verify/
  upgrade run — skip Phase 3, run the CLI (copy-if-absent adds only new kit files), diff the
  kit's `CHANGELOG.md` against what's installed, and jump to Phase 5.

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
- Recommendation shape: **strong** (plan · code · standards/security audits · review) = the best
  reasoning model the subscription allows; **mid** (test · vuln-audit · docs) = the cheaper
  workhorse tier. Offer a budget variant (mid = cheapest capable model) if cost was mentioned.

**1c. Propose the other §12 settings per harness:** parallel audit dispatch (supported vs
sequential fresh sessions) · reasoning-effort/thinking budget if the harness exposes one ·
permission/autonomy mode (read-only seats must be able to run inspection commands; the pipeline
must still stop at the human seam) · tool-scoping enforcement (native vs git-status
verification).

**Ask the human to confirm targets + models + settings in ONE batched question.**

## Phase 2 — unpack (with the confirmed models)

```bash
node builder/cli.js unpack --tool <confirmed-list> --models strong=<model>,mid=<model>
```

`--models` applies to native-format targets (currently claude-code — baked into the installed
agents' frontmatter). For every other confirmed harness, record the confirmed mapping + settings
in `PIPELINE_PROFILE.md` **§12** during Phase 3 — that section is where dispatchers read it.
Show the install summary verbatim. The CLI never overwrites and pointer blocks are
marker-guarded, so re-runs are safe. (`--no-extras` only if the human asked for a lean install.)

## Phase 3 — discovery (fill the profile from THIS repo's docs)

Execute `builder/DISCOVERY.md` exactly: sweep this repo's conventions files → doc trees →
machine-readable truth (scripts, CI, schemas) → catalogue-shaped files; fill every
`PIPELINE_PROFILE.md` section with citations; explicit `N/A — <why>` where empty; mark
underivable decisions (oracles, protected paths, stance, human seam) `⚠ CONFIRM`.
**Never** import the kit's source-project rules; delete template examples this repo lacks.
Fill **§12** from Phase 1's confirmed mapping — one row per confirmed harness, including the
"how a phase is launched at that model" column and the four harness-settings lines.

## Phase 4 — the confirm batch 🧑‍💼

Present ALL `⚠ CONFIRM` items as one batched question set, each with your recommended answer.
Apply the rulings; delete the template's leading note block; log non-obvious rulings as `D-n`
rows in `DECISIONS.md`.

## Phase 5 — optional hardening (offer, never assume)

| Offer | If accepted |
|---|---|
| **Universal pre-commit guard** (any agent — offer first) | fill `hooks/protected-paths-precommit.sh`'s `PROTECTED` list from profile §4, show the enable command (`cp` into `.git/hooks/pre-commit`), apply only on explicit yes |
| Ledger gate in CI | add `node builder/cli.js check-ledgers` to the CI pipeline / pre-push |
| Harness-specific earlier interception (if the harness has one) | e.g. Claude Code: fill `protected-paths.js`'s `PROTECTED` list, show the exact `settings.json` `PreToolUse` snippet (in the hook's header), apply only on explicit yes. Other harnesses: mirror profile §4 into their policy/rules mechanism if any |
| graphify + post-merge sync | only if wanted: install per `skills-extra/README.md`, initial `/graphify` run, `cp builder/hooks/graphify-post-merge.sh .git/hooks/post-merge` |

## Phase 6 — verify + dry run

1. `node builder/cli.js verify` — fix every FAIL (placeholders left = Phase 3 incomplete).
2. Pick the smallest real backlog item, dispatch the `module-planner` persona on it, and check
   its output: `.pipeline/<key>/plan.md` exists, every decision cites a source from THIS repo,
   BLOCKERS are honest (a planner that guessed instead of blocking means the profile wording
   needs tightening — fix and re-run).

## Phase 7 — generate the developer guide

Generate `DEVELOPER_GUIDE.md` at the repo root from `builder/templates/developer-guide.md`:
fill every `{{…}}` from the **filled** profile and this setup run (tools installed, hardening
state, commands, oracles, protected paths, harness-specific invocation note); drop the
utility-skill rows that weren't installed and the sections marked *(omit if N/A)*; delete the
template's note block. **No placeholder may survive** — grep the result for `{{` before moving
on. If a `DEVELOPER_GUIDE.md` already exists (upgrade mode), regenerate to a scratch path, show
the human a diff, and apply only on their yes.

## Phase 8 — report

One screen: targets installed · profile digest (stack, oracles, protected paths, golden path or
"none yet — first module is human-led") · rulings logged · hardening state · verify + dry-run
results · `DEVELOPER_GUIDE.md` generated · uncommitted-file count from Phase 0 · and the exact
starter command: *"Build the `<X>` module through the pipeline."* Point the team to
`DEVELOPER_GUIDE.md` first, `builder/USAGE.md` for depth.
