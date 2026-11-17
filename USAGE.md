# 🕹️ USAGE — running builds day to day (the human operator's runbook)

<p align="center">
  <img alt="audience" src="https://img.shields.io/badge/audience-human_operator-blue?style=flat-square">
  <img alt="stop points" src="https://img.shields.io/badge/stop_points-3-orange?style=flat-square">
  <img alt="resumable" src="https://img.shields.io/badge/interrupted%3F-fully_resumable-success?style=flat-square">
</p>

Setup done (`unpack` → `DISCOVERY` → `verify` all green)? This is what operating the pipeline
looks like from your side of the desk. The agent-facing mechanics live in the installed
`build-module-pipeline` skill; this page is your view: what to say, what happens, where the
pipeline **stops and waits for you**, what it **records** along the way, and what to do at each
point.

> **Commands.** Written for the npm-package install: `npx builder-pipeline <command>`, and a kit script as
> `npx builder-pipeline run <name>`. With the kit copied in as a `builder/` folder instead ([`UNPACK.md`](UNPACK.md)),
> run the CLI through `builder/cli.js` with Node, and a kit script from the project's `scripts/` copy.

## Running one module build

### 0. Spec it first (opt-in, `features.specAuthoring`)

When a module has an intent but no requirement rows, say *"Write the spec for `<moduleKey>`."* The
`spec-author` skill interviews the intent into `specs/<moduleKey>.spec.md` — requirement rows,
Given/When/Then acceptance criteria, an OpenAPI 3 contract, the oracle entries it would need (as
*pending* amendments, never invented), and its open questions. Answer the questions, rule the
amendments, then **you** flip `Status: ratified` and `Ratified-by:` and run
`npx builder-pipeline run spec-check <moduleKey> --ratified`. The pipeline's step 0.7 refuses a draft, so a run can
never start on requirements nobody ratified. `--rows`, `--pack` and `--contract <out.json>` print the
tracker rows, the requirement-pack skeleton and the contract file the later phases read.

### 1. Write the brief (5–15 minutes, the highest-leverage step)

Copy `specs/module-brief.template.md` → `specs/briefs/<moduleKey>.md` and fill it. Delete lines
that don't apply. The lines people skip are exactly where escaped defects come from — the
boundary decision (§2), exact catalogue keys (§4), and the access-scope shape (§5) deserve real
thought. If you can't answer a section, that's a finding in itself: answer it before the build,
not during.

### 2. Start it — in a fresh session

> Build the `<moduleKey>` module through the pipeline. Brief: `specs/briefs/<moduleKey>.md`.

That's the whole incantation. (Claude Code: the skill triggers on this phrasing. Codex/other:
open the playbook per your tool's pointer block — it walks the same steps.) **One run per
session**: start each build in a new session, and do not reuse the session afterwards.

### 3. What you'll see happen

```mermaid
flowchart TD
    P0["0️⃣ Orchestrator model check — warns, never refuses"] --> SWEEP["🔄 Entry sweep of DEFERRED_TASKS.md"]
    SWEEP --> STOPA{{"🛑 STOP A — you rule:<br/>fold-in vs defer-again"}}
    STOPA --> IDX{"🧭 Index gate<br/>fresh · recorded · not configured?"}
    IDX -->|"stale and unrecorded"| REFRESH["refresh the index,<br/>or record the verdict"] --> IDX
    IDX -->|ok| PLAN["1️⃣ Plan → plan.md (shape checked) + task board"]
    PLAN --> STOPB{{"🛑 STOP B — BLOCKERS?<br/>oracle gap · boundary event · spec gap"}}
    STOPB -->|none / resolved| CODE["2️⃣ Code — TDD per row, in batches<br/>claims check at the end"]
    CODE --> TEST["3️⃣ Test — adversarial extension + stories"]
    TEST --> DRIFT["3️⃣b Drift — contract + declared effects"]
    DRIFT --> AUDIT["4️⃣ Audit — 🏛️ 🔐 🐛 🧭 in parallel<br/>findings shape checked"]
    AUDIT --> DOCS["5️⃣ Docs — claims check at the end"]
    DOCS --> REVIEW["6️⃣ Review — review file shape checked"]
    REVIEW --> QA["6️⃣½ Behavioural gate —<br/>the REAL app, disposable env"]
    TEST & DRIFT & AUDIT & QA & REVIEW -.->|blockers| LOOP(("🔁 FIX-n<br/>auto loop-back")) -.-> CODE
    LOOP -.->|"same blocker ×2"| ESC{{"🛑 escalation —<br/>fix the upstream truth"}}
    AUDIT -.->|NEEDS-RULING| STOPB
    QA -->|green delta| CLOSE["7️⃣ Close-out — board closed,<br/>DONEs re-verified, registry swept,<br/>version bumped, handoff pack checked"]
    CLOSE --> STOPC{{"🛑 STOP C — you review the<br/>handoff pack, merge, tag"}}
    STOPC --> END(["run.end — the session stops"])
```

Watch progress any time by opening `tasks/<moduleKey>.md` — it's the live, git-tracked truth and
the one progress surface. `.pipeline/<moduleKey>/plan.md` and `review.md` are the run's full audit
trail.

Every board row lives this lifecycle:

```mermaid
stateDiagram-v2
    direction LR
    [*] --> PLANNED: from plan §Tasks / C-n / FIX-n
    PLANNED --> INPROGRESS: coder writes the seed test (red)
    INPROGRESS --> DONE: green + test file cited
    PLANNED --> DROPPED: human ruling (reason logged)
    INPROGRESS --> DEFERRED: blocked → registry row created
    DONE --> DEFERRED: close-out audit — evidence ≠ claim
    DONE --> [*]
    DROPPED --> [*]
    DEFERRED --> [*]: resurfaces via entry sweep of a later build
```

## The stop points — where the pipeline waits for YOU

**A. Deferred candidates (entry).** The pipeline lists registry rows this module might unblock
and asks fold-in or defer-again per row. Rule each explicitly — there is deliberately no silent
auto-folding. A fold-in becomes a planned board row; a defer-again is recorded with your ruling.

**A½. Spec gate (entry, with `features.specAuthoring` on).** Step 0.7 runs `spec-check <key> --ratified`.
A missing or draft spec stops the run before the planner is dispatched: author or finish the spec,
ratify it yourself, say "resume". Nothing here is an agent failure — a ratification is a human act.

**B. BLOCKERS (after planning, or any time).** Only `BLOCKING`-class items stop the run — a gap the
docs already settle is decided and recorded, and a `NEEDS-RULING` item proceeds on a stated
assumption while it waits for you. Three kinds reach you, all meaning "a human decision is missing,
not an agent failure":
- *Missing catalogue entry* (permission key, error code, state name) → add it to the oracle
  yourself, or reject the need; then say "resume".
- *Boundary event* (the design needs a protected-path edit) → grant an explicit unlock for this
  build (and revert it after merge), or redirect the design. Never let the agent work around it.
- *Spec gap/contradiction* → resolve the spec, then resume. If the agent guessed instead of
  stopping, that's a bug in your profile wording — tighten it.
- *`NEEDS-RULING` from the invariant auditor* → a coherence case the project has no rule for, with
  the observed behaviour attached. **It is not a defect and not a pass.** Rule it; do not let anyone
  "fix" it first, because fixing it *is* ruling it.

**C. MERGE-READY handoff (the end).** The pipeline never merges, pushes, or opens PRs. You get a
summary, the requirement-traceability result, and **the handoff pack**: one file for the run under
`paths.handoffs`, with §A progress · §B tracker flips (when a tracker is configured) · §C decisions ·
§D registry changes · §E docs owed · §F merge conditions. Each item carries a `RESPONSE REQUIRED`
line. Your close-out: run the gates + full integration tier yourself, review the diff, merge, tag,
answer the pack, revert any unlock — and check every ruling you made during the run has its row in
`DECISIONS.md`.

**Unscheduled stop — two-strike escalation.** If the same blocker survives two fix loops the
pipeline stops and tells you. This almost always means the plan or a spec is wrong, not the code.
Read the blocker, fix the upstream truth (profile, oracle, spec, brief), then resume.

## The record points — what the pipeline checks and writes on its own

None of these wait for you unless they fail. Each is a script, and each prints
`<feature>: not configured` when §16 has it off.

| When | Command | What it means |
|---|---|---|
| P0 | `npx builder-pipeline run orchestrator-check` | The session's model vs `models.orchestrator`. Exit 5 is a **warning**, never a refusal; no readable transcript is *unmeasured*, not a pass |
| P1, before the planner | `npx builder-pipeline run index-check` | Knowledge-index freshness. `0` fresh · `3` absent · `4` unmeasurable · `10` docs pending · `11` code behind · `12` both. With `features.graph` on, a non-zero exit that is not recorded in the run's state file **refuses the planner**: refresh (code refresh is free; doc embedding spends tokens, and above the automatic limit a person decides) or record the verdict. With it off: `graph: not configured`, and the run goes on |
| P1 · P4 · P6 | `npx builder-pipeline run output-check plan\|findings\|review <file>` | The plan, each findings block and the review have their fixed shape; a malformed one goes back to its seat |
| End of P2 and P5 | `npx builder-pipeline run claims-check --run <key>` | Every recorded count re-run, every `file:line` still points at its content, no retracted phrase, every owed note resolves |
| P7 | `npx builder-pipeline run handoff-pack <key>` then `npx builder-pipeline run handoff-check <file>` | The handoff pack is generated from the board, run log and registry, then checked. **Close-out cannot finish on a failing pack** |
| After P7 | — | `run.end` is logged and the session stops. Follow-up work takes a new key, board and session |

## Interruptions and resumption

State lives in files, not in the agent's head — so resumption is cheap. If a session dies or you
stop it: the board shows exactly which rows are DONE (with test evidence) and which aren't.
Restart in a fresh session with:

> Resume the `<moduleKey>` pipeline build. Board: `tasks/<moduleKey>.md`,
> plan: `.pipeline/<moduleKey>/plan.md`. Continue from the first non-DONE row.

If `.pipeline/` was lost (it's gitignored), re-run Phase 1 — the planner regenerates the plan
from the same sources; the board keeps the completed rows.

## Smaller than a module?

For a fix or small feature that doesn't warrant the full phase list, use the FIX or SOLO track
(phase 0.5) — or the pieces directly:
- `scaffold-module` skill — just the golden-path scaffold.
- `module-builder` persona standalone — it then self-runs `module-readiness-check` +
  `standards-auditor` (its file tells it to).
- `module-readiness-check` — pre-PR bar on anything, any time.
- `ledger-audit` (extras) — periodic "are our DONEs real" sweep; schedule it, drift compounds
  silently between audits.

## Removing a tool, or the kit (`uninstall`)

```
npx builder-pipeline uninstall --tool codex --dry-run   # what would go
npx builder-pipeline uninstall --tool codex             # drop one tool
npx builder-pipeline uninstall --all                    # drop the kit
```

It removes only what `builder.lock.json` says the kit wrote, and only files whose bytes still match the lock (each is
backed up under `.builder/backup-<stamp>/` first). A file you edited since is kept and named. A file several tools
share stays while one of them is still installed. The pointer block comes out of each instruction file (or is
re-wired for the tools left), and your text around it stays. `PIPELINE_PROFILE.md`, the ledgers, `builder.choices.json`
and the `.gitignore` lines are never touched. `--all` also removes the vendored hook scripts (`.claude/hooks/kit/`),
any kit-locked `scripts/` copies and, once nothing is left to record, the lock. Uninstalled with npm too? Remove the
dependency afterwards (`npm uninstall builder-pipeline`).

## Commits carry human authors only (`git-hooks`)

The pointer block tells every agent: no `Co-Authored-By:` trailer for an AI agent and no "Generated with …" line in
a commit message or PR body. Agents follow instructions most of the time; the git hook makes it hold every time.

```
npx builder-pipeline git-hooks --dry-run   # where it would go
npx builder-pipeline git-hooks             # arm it in this clone
npx builder-pipeline doctor                # "[repo] commit hygiene: armed"
```

It copies `hooks/commit-msg-no-ai-attribution.sh` to the folder git runs hooks from (`core.hooksPath` when set,
else `.git/hooks/`), changes no git config and writes nothing tracked. Git hooks are not pushed, so each clone arms
it once. The hook removes a `Co-Authored-By:` line naming an agent (Claude, Codex, Copilot, Cursor, Gemini,
Antigravity, ChatGPT/GPT, an @anthropic.com or @openai.com address, …) and the "Generated with <agent>" line, keeps a
human co-author, and never blocks a commit. A commit-msg hook you already have is left alone: the command names it and
prints the one line to add to it.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `verify` fails on placeholders | profile never filled / half-filled | run the kit's `DISCOVERY.md` prompt; answer the `⚠ CONFIRM` batch |
| `verify` reports a §16 error, or a script refuses to start with a settings error | the `pipeline-settings` block is invalid: JSON syntax, more than one block, a feature `on` with a required key empty, an unknown feature name (usually a typo), a `<placeholder>` left in, `commands.tier` without `{tier}` | fix the path the error names. Never set a feature `on` to silence an error, and never delete the block — with no block every optional feature is off |
| A run prints `<feature>: not configured` | that feature's state is `off` in §16 — the default for anything the project was not shown to have | expected if the project lacks the file or tool. To switch it on: install what it needs, set `state: "on"`, fill its required keys, run `npx builder-pipeline verify`, then `npx builder-pipeline run features` |
| Planner not dispatched at P1 | the index gate saw a stale index and no recorded verdict | run the free code refresh; embed pending docs if within the limit (or decide, if above it); or record the verdict in the state file's `Graph:` line |
| `orchestrator-check` exits 5 | the session was started on a different model from `models.orchestrator` | restart the session on the declared model, or proceed and note it — it is a cost and capability choice, not a correctness gate |
| Claims check fails at the end of P2 or P5 | a stale count, a citation whose line moved, a retracted phrase, an owed note naming nothing | fix the record. Never widen the checker to pass a false record |
| Handoff check refuses close-out | a section missing, an item without `RESPONSE REQUIRED`, a fill marker left, a cited id that does not exist | complete the pack; the check names each gap |
| The pack is out of date (a newer release, or the installed files lag the kit's `CHANGELOG.md`) | `unpack` copies only absent files, so an upgrade never overwrites installed ones | bump the dependency tag, run `npx builder-pipeline upgrade` (tools and flags come from `builder.lock.json`; it refreshes kit-owned files after a backup, keeps your local edits, reports files the release dropped as `stale`, and `--prune` removes them), read the CHANGELOG entries since your old version, then `npx builder-pipeline verify` |
| Cost figures look wrong against the bill | the rate table is stale, or accounting is off / unavailable in this harness | compare the kit's `scripts/lib/pricing.cjs` and its version with the published rates. A package install copies no scripts into the project (they run as `npx builder-pipeline run <name>`), so the table is in `node_modules/builder-pipeline/scripts/lib/pricing.cjs`: report it upstream and take the release that fixes it. A folder copy has it at `scripts/lib/pricing.cjs`: update the table and its version together. Em-dashes mean unmeasured, not free |
| `pack tests: Node …` | Node older than 18 | upgrade Node; the pack's scripts and tests need 18 or newer |
| Agent invents a permission key / state name | oracle path in profile §3 wrong, or oracle not listed | fix §3; the persona rule only bites if the oracle is findable |
| Personas don't load (Claude Code) | files not under `.claude/agents/` (unpack run from wrong dir) | re-run `npx builder-pipeline unpack --tool claude-code` from repo root (`--tool` is required); check `verify` |
| Other tools ignore the pipeline | pointer block missing from that tool's instruction file | re-run unpack for that `--tool`; check the file for the `builder-kit:pipeline` marker |
| Coder edits a protected path | harness has no hook enforcement | add one (see `hooks/README.md`); meanwhile reject the diff and re-dispatch |
| A hook registered today does nothing | harness hooks and settings are read at session start | start a new session |
| Board rows DONE without test evidence | persona rules being paraphrased/trimmed | restore verbatim persona files; that rule is load-bearing (DESIGN §7). `npx builder-pipeline check-ledgers` catches it mechanically — wire it into CI |
| `npx builder-pipeline check-targets` fails | safety gate for the `qa-audit` skill: a target whose DATASTORE is shared is marked destructive, an attach target does not declare `shared`, or a credential is embedded in the config | fix the config. Run it in CI — the rule must not depend on someone reading a doc |
| Ledger drift (dangling `DEFERRED→id`, odd statuses) | hand-edited boards/registry | `npx builder-pipeline check-ledgers` — 7 rules (LG-0 unreadable ledger · LG-1 unique registry ids · LG-2 in-vocabulary statuses · LG-3 `DEFERRED→id` exists · LG-4 no unresolved ⚠ VERIFY · LG-5 DONE needs evidence · LG-6 row does not match its header), exits non-zero for CI |
| Board shows a percentage nobody believes | the bar was typed, not computed | `npx builder-pipeline run board-check-all` (`--fix` to rewrite). Wire it into the gate chain — a bar looks like an output even when it is an input, which is how one board sat at "0%" with 8 of 12 rows done |
| Pipeline "finishes" but reviewer never ran | orchestrator drifted from the playbook | ask for the review file's verdict; no verdict = not done, re-run Phase 6 |
| Same blocker loops forever | upstream truth wrong (spec/brief/plan) | that's what two-strike escalation is for — fix the doc, not the code |

## Cost & pacing expectations

One module is a dozen or more agent dispatches: the planner, the builder in batches of at most
`features.builderBatch.rows` rows, the tester, four auditors, docs and the reviewer, plus
loop-backs. Strong-model phases dominate cost; profile §12 is where you trade cost vs. rigor. Where
the harness keeps transcripts and `features.costAccounting` is on, the board shows measured spend
per seat. `npx builder-pipeline run cost-window` and `npx builder-pipeline run seat-peaks` compare runs before and
after a change. `cost-window` reads Claude Code transcripts (`reader: "claude-code"`) or Codex CLI
rollout files (`reader: "codex"`; tokens are shown, cost only with a `--rates` table). Judge any setting change over several runs, never one. Scaling guidance — what may
be merged or skipped and what never — is in `DESIGN.md` §"Tuning".
