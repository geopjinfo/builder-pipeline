# EXPERIMENTS — shipped, not proven

Every item here is in the pack because it has a reasoned case and a way to measure it — and none has
been measured on enough runs to earn a place in the default pipeline. Each entry says what ships,
how to switch it on, the **exact measurement** that promotes or removes it, and what it risks.

**Two kinds.**

- **Experimental** (`experimental-off` by default). Off until you opt in. Any experimental *files*
  (persona, tooling) are installed only by `unpack --experimental` (see `UNPACK.md`); then set the
  feature to `experimental-on` in `PIPELINE_PROFILE.md` §16. While it is on, its measurement is owed.
- **Unmeasured** (`unmeasured` by default). On, because the mechanism is cheap and the reasoning
  sound, but every report says the benefit is unmeasured. Set the feature to `off` to get the
  previous behaviour back.

**The rule for every entry.** A keep/stop call made on zero runs is the impression the entry exists
to replace. Record the call — keep, stop, or change a parameter — as a decision in `paths.decisions`,
with the numbers and the runs they came from, and update this file.

`node scripts/features.mjs` prints the current state of each.

---

## 1. Script-driven run and a live page — `livePage` (experimental)

**What ships.** `node scripts/board-render.mjs <key> --json` (one JSON document per board section,
split never truncated); `tooling/experimental/page-shell.cjs` (a read-only live page that reads those
documents; `node scripts/experimental/page-shell.mjs <key>` writes it); `agents/experimental/page-keeper.md` (a read + shell + publish seat that refreshes the
page and never writes). The pipeline skill itself is unchanged: a script-driven run replaces the
orchestrator's P2 → P6.5 turns with a workflow script that dispatches the same seats, with
schema-checked outputs and the same FIX loop.

**Opt in.** `unpack --experimental`, then `features.livePage.state: "experimental-on"`. *Claude Code
only* — it needs workflow scripts that the user explicitly opts into, and the hosted-page runtime
with a data store; see `adapters/claude-code.md`. Other harnesses: the rendered board file is the
page, and there is nothing to switch on.

**Measurement.** One ADDITIVE run. Its first scripted step probes that a script-dispatched seat
actually receives the publish tool; if not, the refresh becomes an orchestrator step at each phase
gate, and those orchestrator turns are counted. After P7, compare against a comparable skill-driven
run: cost (`node scripts/cost-window.mjs --since <iso> --until <iso>` over each run's window), `FIX-n`
rows raised, and the verdict. **Promote** if FIX rows and verdict are no worse and cost is not higher.
**Remove** otherwise.

**Risk.** A page someone can edit is a second truth — the page must stay a projection, never written
back. Per-seat cost on a shared page is sensitive: show it only on an organisation-internal page,
labelled as derived at a named rate version. A script-driven run hides the orchestrator's judgement
between phases, which is exactly where loop-back decisions are made.

## 2. Graph seat trial — `graphTrial` (experimental)

**What ships.** `skills/references/graph-query.md` (the one query block) and an experimental pointer
to it in `module-planner`, `standards-auditor` and `invariant-auditor`. Each pointer says it applies
only when this feature is `experimental-on`. The block ends every dispatch with a
`graph: <calls> calls, <useful> useful, <dead_end> dead-end` line.
`tooling/experimental/graph-trial-report.mjs` (installed as `scripts/experimental/`) is the
measurement. It reads the harness's own transcripts, never the seats' accounting. Per session and
seat, it counts the index calls: Bash commands matching `callPattern`, split by subcommand. It shows
the seat's claimed return line beside that count and marks any mismatch. Seats outside
`graphTrial.seats` are the control group, and a control seat with calls is flagged. A renamed seat
silently moves into the control group, so keep `seats` equal to your installed seat names. Claude
Code transcripts only.

**Opt in.** `features.graph` configured (a working `check`), then `unpack --experimental` and
`features.graphTrial.state: "experimental-on"` with `callPattern` set. `callPattern` is a regular
expression over the Bash command, with backslashes normalised to `/`. Capture 1 is the subcommand.
Put in it only the subcommands the return line counts as calls. Resolve the block's placeholder
commands for your index tool first. A pointer with no runnable command measures nothing. After each
run: `node scripts/experimental/graph-trial-report.mjs <sessionId>…`.

**Measurement.** Two runs with the trial on **and** a control group: comparable runs with it off,
where no graph instruction reaches the seats by any other route (the brief, the profile). For each
trial seat: graph calls, useful vs dead-end from the return lines, and mismatches between the
claimed counts and the harness's own records of the calls where it keeps them. Across the runs:
whether plan-grounding `FIX-n` rows (a brief or plan citing the wrong source) fall against the
control. **Promote** (useful, fewer grounding fixes) → give `module-builder` the pointer too.
**Remove** (not useful) → drop the pointers and any paid document embedding; keep the free code
re-sync, which costs nothing.

**Risk.** A derived index cited as the authority — the block forbids it, and a reviewer must still
catch it. Self-reported counts — hence the cross-check against the harness records.

## 3. Builder on a mid-tier model with a strong advisor — `advisorBuilder` (experimental)

**What ships.** Nothing but this protocol. The builder seat and its tier are unchanged.

**Opt in.** `features.advisorBuilder.state: "experimental-on"` marks that a replay trial is under
way; the replay runs in its own session.

**Measurement — a replay A/B on a frozen run, never a live one.** An advisor setting may be
session-wide rather than per seat (on Claude Code it is: seats inherit the session's advisor, and
there is no per-seat field). Turning it on for the builder in a live run turns it on for every
strong seat, so no cost or quality change could be attributed to the builder. So: pick a finished run
whose P2 start commit and board rows are recorded. In a dedicated session, replay P2 twice from that
commit in isolated worktrees, dispatching only the builder over the same rows — once as the pipeline
runs it today, once on the mid-tier model with the strong model as advisor. Then run the same P3/P4
seats over both results and compare: `FIX-n` rows raised, defects caught, and builder cost
(`node scripts/cost-window.mjs`). **Promote** only if loop-backs do not grow and cost falls.
**Remove** otherwise.

**Risk.** Quality lost in P2 surfaces as extra loop-backs in P3–P6, where it costs more than it
saved. A replay of one run is a small sample; say so in the decision.

## 4. Role persona profiles from a permission catalogue — `personas` (experimental)

**What ships.** `tooling/experimental/persona-gen.mjs` + `persona.cjs` (installed as
`scripts/experimental/`). They write one profile per role column of the permission catalogue.

- **The generated half** sits between markers and is never typed: the role's keys, plus a
  seeded-login line from an optional JSON map.
- **The drafted half** — scope rules, separation-of-duties limits, abuse goals — keeps its text when
  profiles are regenerated. A profile that has lost its markers is refused, not overwritten.
- **`--check` fails** on:
  - a missing or stray profile;
  - a generated block that differs from the catalogue, naming each hand-added or dropped key;
  - login drift, or a stale key count;
  - a drafted bullet that does not match `citationPattern`.
- It refuses a catalogue with zero role columns.

**Opt in.** `unpack --experimental`, then set `features.personas`:
- `catalogue`, `out` and `citationPattern` are required.
- `keyColumn` / `labelColumn` take a header name or a 0-based index.
- Prefer an explicit `roleColumns` list. Inference, when it is `null`, takes every column that holds
  only the `grant` value, so an "active" flag column would pass for a role.
- `logins` is optional.

Set `state` to `"experimental-on"` and run `node scripts/experimental/persona-gen.mjs`. Draft profiles
only for the roles a run touches, and add `persona-gen.mjs --check` to the run's gates. The
orchestrator attaches the touched roles' profiles to the `security-auditor` and `invariant-auditor`
dispatches.

**Measurement.** Two runs with the profiles attached. For each: actor-class findings (wrong actor,
reflexive acts, separation-of-duties breaks) and the two seats' tokens, against comparable runs
without. **Promote** only if actor-class findings rise without loop-backs growing. **Remove**
otherwise.

**Risk.** A profile is a derived summary — it **locates, never rules**. Drafting profiles for every
role with nothing measuring their effect ships unreviewed summaries into the seats that most need
primary sources.

## 5. Blocking mutation threshold — `mutationGate` (experimental)

**What ships.** The mutation **step** (`features.mutation`, P3, non-blocking — its score is a `gate`
event, logic survivors become tester rows, payload survivors become one row). No threshold ships.

**Opt in.** Configure `features.mutation` and run the step. Switch
`features.mutationGate.state` to `"experimental-on"` only once the measurement below has produced a
threshold.

**Measurement.** After **two runs that logged a `mutation` gate event**, set a blocking threshold
from those measured scores, with **payload survivors counted apart from logic survivors** (the
threshold applies to logic). If both runs score high (roughly 85% or above), close this entry: the
gate would not be needed.

**Risk.** A threshold chosen before a measurement is a number nobody measured. In one adopting
project most surviving mutants were error-payload assertions, so a naive threshold would mostly fail
runs over one assertion type rather than over weak logic tests.

## 6. Builder batches — `builderBatch` (unmeasured, on by default)

**What ships.** P2 dispatches the builder in batches of at most `features.builderBatch.rows` board
rows (default 5), a fresh dispatch each, the builder reading its rows through
`node scripts/ledger-row.mjs board <key> <ROW…>`.

**Why it is on.** Every turn re-reads the whole context window, so the long tail of a dispatch that
has built many rows costs more per turn than a fresh dispatch's startup.

**Measurement.** *Before:* over a window of runs without batching,
`node scripts/seat-peaks.mjs --since <iso> --until <iso> --seat module-builder` — median, p90 and max
peak context per builder dispatch, turns per dispatch — and builder cost per row from
`node scripts/cost-window.mjs` over the same window. *After:* the next run whose P2 has more rows
than one batch, same commands over its window. **Keep** if the p90 peak **and** builder cost per row
both fall. Otherwise raise `rows` and say why, or set the feature `off`.

**Risk.** A batch boundary drops context the next batch must re-read. Rows that share a file split
across batches can conflict. Keep coupled rows in one batch.

## 7. Narrow FIX lane — `fixLane` (unmeasured, on by default)

**What ships.** In the loop-back, `FIX-n` rows are grouped by file area. Each group goes to its own
builder dispatch carrying only the `file:line` list, cites, minimal fixes and the tests to run — no
plan, no board history. `node scripts/fix-rate.mjs [boards…]` measures the fix-of-fix rate: the share
of `FIX-n` rows that repair another `FIX-n` row of the same board. Its rule counts a row only when a
repair cue sits near the reference — a mere mention of another FIX row is not a repair.

**Why it is on.** Loop-backs are a material share of run cost, and a fixer that re-reads the whole
plan pays for context a localized fix does not need.

**Measurement.** Before the first use, record the baseline:
`node scripts/fix-rate.mjs <boards>/<recent-run>.md …` over your recent run boards. After **two runs
that looped back through the lane**, run `node scripts/fix-rate.mjs <boards>/<key1>.md <boards>/<key2>.md`.
**Keep** if the rate is at or below the baseline **and** loop-back cost did not rise
(`node scripts/cost-window.mjs` over the loop-back phases). Otherwise set the feature `off` and
return to one whole-list re-dispatch with the plan.

**Read the rate against the board before you trust it — it under-counts in one specific way.** The
predicate only scores a repair when a repair cue sits near the referenced row's **id**. A fix row
that names the *artifact* it repairs — the spec file, the helper, the constant — rather than the id
of the row that introduced it scores **zero**, so a board whose real rate is well above baseline can
report `0.0%`. That is the worst available failure for this metric: it fails toward *keep*, silently,
on the exact evidence that should have retired the lane. Before any keep/drop call, hand-read the fix
rows once and ask of each whether it exists because an earlier fix row created the defect. If the two
answers disagree, the hand count wins and the predicate is the thing to fix first.

**A corollary for the whole file: a measurement that can only fail toward "keep" is not a
measurement.** Every experiment here is judged by a number; check which way each number fails before
you let it decide.

**Risk.** A fixer without the plan can fix the cited line and break an invariant the plan stated —
which shows up exactly as a rising fix-of-fix rate. A lane judged on zero loop-backs is not judged.

## 8. Split module pipeline — `liteSplit` (experimental)

**What ships.** Two skills and one script: `build-module-lite` (the playbook's steps 0–3 at full strength,
plus the free checks, then the module is queued `BUILT-UNGATED` and the run stops), `build-module-lite-gate-batch`
(every later phase — drift, the four auditors on each module's own diff, docs, ledger audit, review, the
behavioural gate, the release commit, close-out — over up to `cap` queued modules), and
`node scripts/gate-queue.mjs`, which records each finished phase with the sha it was proven at and re-opens it
when that module's code moves afterwards. The bar does not move: nothing merges until the batch closes it `GATED`.

**Opt in.** Set `features.liteSplit.state` to `"experimental-on"`; tune `cap` (hard limit of open modules),
`trigger` (when to run the batch), and `ledgers` / `docsOnly` (extra path patterns the queue treats as
bookkeeping, or as docs that re-open no module phase). Off, `gate-queue` refuses and the lite skills do not run.

**Measurement.** Over **one full batch of at least `trigger` modules**, compare against the same number of full
runs: total orchestrator + seat wall clock (`node scripts/cost-window.mjs`), fix rows per module
(`node scripts/fix-rate.mjs`), and how many checks `gate-queue status` re-opened after a fix. **Keep** if wall
clock fell and fix rows per module did not rise; **stop** if late findings forced rework in modules built on top
of the flawed one more than once per batch. One real module has been through both halves so far — not a batch.

**Risk.** A defect found at the batch is found later than in a full run, so it can force changes in the modules
built after it; the cap bounds that blast radius. The queue's staleness rule is only as good as its path
rules: a bookkeeping path the profile does not declare re-opens proven phases (safe, slow), and a code path
wrongly declared as bookkeeping would keep a stale proof (unsafe) — declare `ledgers` narrowly.
