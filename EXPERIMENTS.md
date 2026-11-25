# EXPERIMENTS — shipped, not proven

> **Commands.** Written for the npm-package install: a kit script runs as `npx --no-install builder-pipeline run <name>`. With the
> kit copied in as a `builder/` folder ([`UNPACK.md`](UNPACK.md)), run it from the project's `scripts/` copy with Node.

Every item here is in the pack because it has a reasoned case and a way to measure it — and none has
been measured on enough runs to earn a place in the default pipeline. Each entry says what ships,
how to switch it on, the **exact measurement** that promotes or removes it, and what it risks.

**Two kinds.**

- **Experimental** (`experimental-off` by default). Off until you opt in. Any experimental *files*
  (persona, tooling) are installed only by `unpack --experimental` (see `UNPACK.md`); then set the
  feature to `experimental-on` in `PIPELINE_PROFILE.md` §16. While it is on, its measurement is owed.
- **Unmeasured** (`off` by default since 2.0.0, REQ-1403). The mechanism is cheap and the reasoning
  sound, but the §19 recorded run did not measure it. Set the feature to `unmeasured` to switch it on;
  every report then says the benefit is unmeasured.

**The rule for every entry.** A keep/stop call made on zero runs is the impression the entry exists
to replace. Record the call — keep, stop, or change a parameter — as a decision in `paths.decisions`,
with the numbers and the runs they came from, and update this file.

`npx --no-install builder-pipeline run features` prints the current state of each, with its decision beside it. `npx --no-install builder-pipeline run experiments`
prints every section's decision, `--check` refuses a blank or an unsupported keep, `--matrix` prints the trial matrix,
and `--record <n> --row "| … |"` is how a scheduled run appends its measurement.

---

## 1. Script-driven run and a live page — `livePage` (experimental)

**What ships.** `npx --no-install builder-pipeline run board-render <key> --json` (one JSON document per board section,
split never truncated); `tooling/experimental/page-shell.cjs` (a read-only live page that reads those
documents; `npx --no-install builder-pipeline run experimental/page-shell <key>` writes it); `agents/experimental/page-keeper.md` (a read + shell + publish seat that refreshes the
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
run: cost (`npx --no-install builder-pipeline run cost-window --since <iso> --until <iso>` over each run's window), `FIX-n`
rows raised, and the verdict. **Promote** if FIX rows and verdict are no worse and cost is not higher.
**Remove** otherwise.

**Risk.** A page someone can edit is a second truth — the page must stay a projection, never written
back. Per-seat cost on a shared page is sensitive: show it only on an organisation-internal page,
labelled as derived at a named rate version. A script-driven run hides the orchestrator's judgement
between phases, which is exactly where loop-back decisions are made.

**Decision (2026-11-17).** not yet measured — no measurement: no ADDITIVE run has been made with the page on.

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
run: `npx --no-install builder-pipeline run experimental/graph-trial-report <sessionId>…`.

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

**Decision (2026-11-17).** not yet measured — no measurement: no run with the trial on and a control group.

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
(`npx --no-install builder-pipeline run cost-window`). **Promote** only if loop-backs do not grow and cost falls.
**Remove** otherwise.

**Risk.** Quality lost in P2 surfaces as extra loop-backs in P3–P6, where it costs more than it
saved. A replay of one run is a small sample; say so in the decision.

**Decision (2026-11-17).** not yet measured — no measurement: no replay A/B has been run.

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

Set `state` to `"experimental-on"` and run `npx --no-install builder-pipeline run experimental/persona-gen`. Draft profiles
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

**Decision (2026-11-17).** not yet measured — no measurement: no run with generated profiles attached.

## 5. Blocking mutation threshold — `mutationGate` (experimental)

**What ships.** The mutation **step** (`features.mutation`, P3, non-blocking — its score is a `gate`
event, logic survivors become tester rows, payload survivors become one row). No threshold ships, and
**the flag enforces nothing**: `features.mutationGate.state` is a recorded intent that `npx --no-install builder-pipeline run
features` reports, not a branch in `mutation-step.mjs`. Switching it on does not make the step block.

**Opt in.** Configure `features.mutation` and run the step. Switch
`features.mutationGate.state` to `"experimental-on"` only once the measurement below has produced a
threshold — and then a blocking branch still has to be written, with its own red test, before the
flag gates anything.

**Measurement.** After **two runs that logged a `mutation` gate event**, set a blocking threshold
from those measured scores, with **payload survivors counted apart from logic survivors** (the
threshold applies to the logic-only score: detected over detected plus logic survivors). If both runs
score high (roughly 85% or above), close this entry: the gate would not be needed.

**Sample run (2026-11, kit-internal, two small modules, not an adopting project).** Baseline scores
87.8% and 75.6%; after the step's own `LOGIC` and `PAYLOAD` rows were written as tests, 97.6% and 94.4%.
The lowest logic-only score at any point was 91.9%: 16 of the 22 survivors on the 75.6% run were
error-payload lines. A threshold on the overall score would have blocked that run over one assertion
type; a threshold on the logic-only score at 85% would never have fired. The remaining logic survivors
at the end were equivalent mutants (a regex anchor already guarded by `Number()`, a string literal
whose two values take the same branch), so the suite's ceiling was 94–98%, not 100%. Call recorded:
**keep off**. The non-blocking step produced the whole gain on its own. A second kit-internal sample (three freshly built
modules, 303 to 177 mutants each) scored 71.8%, 76.8% and 81.9% overall and 84.7%, 85.1% and 86.7% logic-only on
their first run: right at the 85% line, so a gate there would have blocked one of three first runs over 23 logic
survivors that the step had already turned into tester rows. An adopting project's two runs are still owed before
the entry is closed.

**Risk.** A threshold chosen before a measurement is a number nobody measured. In one adopting
project most surviving mutants were error-payload assertions, so a naive threshold would mostly fail
runs over one assertion type rather than over weak logic tests. The sample run above reproduced that
shape exactly.

**Decision (2026-11-17).** not yet measured — kit-internal samples only: logic-only scores 84.7% to 91.9% over five modules, two adopting-project runs still owed; the step stays non-blocking.

## 6. Builder batches — `builderBatch` (unmeasured, off by default since 2.0.0)

**What ships.** P2 dispatches the builder in batches of at most `features.builderBatch.rows` board
rows (default 5), a fresh dispatch each, the builder reading its rows through
`npx --no-install builder-pipeline run ledger-row board <key> <ROW…>`.

**Why it is on.** Every turn re-reads the whole context window, so the long tail of a dispatch that
has built many rows costs more per turn than a fresh dispatch's startup.

**Measurement.** *Before:* over a window of runs without batching,
`npx --no-install builder-pipeline run seat-peaks --since <iso> --until <iso> --seat module-builder` — median, p90 and max
peak context per builder dispatch, turns per dispatch — and builder cost per row from
`npx --no-install builder-pipeline run cost-window` over the same window. *After:* the next run whose P2 has more rows
than one batch, same commands over its window. **Keep** if the p90 peak **and** builder cost per row
both fall. Otherwise raise `rows` and say why, or set the feature `off`.

**Risk.** A batch boundary drops context the next batch must re-read. Rows that share a file split
across batches can conflict. Keep coupled rows in one batch.

**Decision (2026-11-17).** not yet measured — no measurement: no before/after window of `seat-peaks` and `cost-window` recorded; the §19 dry run did not exercise batches, so the feature is off by default (REQ-1403).

## 7. Narrow FIX lane — `fixLane` (unmeasured, off by default since 2.0.0)

**What ships.** In the loop-back, `FIX-n` rows are grouped by file area. Each group goes to its own
builder dispatch carrying only the `file:line` list, cites, minimal fixes and the tests to run — no
plan, no board history. `npx --no-install builder-pipeline run fix-rate [boards…]` measures the fix-of-fix rate: the share
of `FIX-n` rows that repair another `FIX-n` row of the same board. Its rule counts a row only when a
repair cue sits near the reference — a mere mention of another FIX row is not a repair.

**Why it is on.** Loop-backs are a material share of run cost, and a fixer that re-reads the whole
plan pays for context a localized fix does not need.

**Measurement.** Before the first use, record the baseline:
`npx --no-install builder-pipeline run fix-rate <boards>/<recent-run>.md …` over your recent run boards. After **two runs
that looped back through the lane**, run `npx --no-install builder-pipeline run fix-rate <boards>/<key1>.md <boards>/<key2>.md`.
**Keep** if the rate is at or below the baseline **and** loop-back cost did not rise
(`npx --no-install builder-pipeline run cost-window` over the loop-back phases). Otherwise set the feature `off` and
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

**Decision (2026-11-17).** not yet measured — no measurement: no baseline `fix-rate` recorded and no two loop-back runs; the §19 dry run had no FIX row (`fixLane: unmeasured`), so the feature is off by default (REQ-1403).

## 8. Split module pipeline — `liteSplit` (experimental)

**What ships.** Two skills and one script: `build-module-lite` (the playbook's steps 0–3 at full strength,
plus the free checks, then the module is queued `BUILT-UNGATED` and the run stops), `build-module-lite-gate-batch`
(every later phase — drift, the four auditors on each module's own diff, docs, ledger audit, review, the
behavioural gate, the release commit, close-out — over up to `cap` queued modules), and
`npx --no-install builder-pipeline run gate-queue`, which records each finished phase with the sha it was proven at and re-opens it
when that module's code moves afterwards. The bar does not move: nothing merges until the batch closes it `GATED`.

**Opt in.** Set `features.liteSplit.state` to `"experimental-on"`; tune `cap` (hard limit of open modules),
`trigger` (when to run the batch), and `ledgers` / `docsOnly` (extra path patterns the queue treats as
bookkeeping, or as docs that re-open no module phase). Off, `gate-queue` refuses and the lite skills do not run.

**Measurement.** Over **one full batch of at least `trigger` modules**, compare against the same number of full
runs: total orchestrator + seat wall clock (`npx --no-install builder-pipeline run cost-window`), fix rows per module
(`npx --no-install builder-pipeline run fix-rate`), and how many checks `gate-queue status` re-opened after a fix. **Keep** if wall
clock fell and fix rows per module did not rise; **stop** if late findings forced rework in modules built on top
of the flawed one more than once per batch. One real module has been through both halves so far — not a batch.

**Risk.** A defect found at the batch is found later than in a full run, so it can force changes in the modules
built after it; the cap bounds that blast radius. The queue's staleness rule is only as good as its path
rules: a bookkeeping path the profile does not declare re-opens proven phases (safe, slow), and a code path
wrongly declared as bookkeeping would keep a stale proof (unsafe) — declare `ledgers` narrowly.

**Decision (2026-11-17).** not yet measured — one module through both halves, not a batch; no wall-clock or fix-row comparison.

**Known gaps (deferred on purpose, each with a trigger).**
- *No live page for lite runs or batches.* A full run can project its board to a live page; a lite run and a
  gate batch have only the markdown board and `gate-queue status`. Build one only when a parallel lane reports
  it lost track of a lite run — before that, the need is a guess.
- *The batch is started by hand.* `gate-queue status` says when `trigger` is reached, but nothing starts the
  batch. Automate only after two hand-run batches have closed cleanly, and give the automatic start the same
  entry checks as a manual one.
- *The claims check re-runs every distinct test command a board cites.* On a multi-module batch that can cost
  most of an hour. The fix is to run each test config at most once per sha, or to accept a tier log already
  produced at the same sha — with a red test proving a stale log is refused. Do not change the checker while
  lanes are mid-run on it: that changes the rules under them.

## 9. Learned cost control on trial lanes — `tokenEconomizer` (experimental)

**What ships.** Nothing but this protocol. The plugin is third-party (microsoft/TokenEconomizer, Apache-2.0): it
prunes tools a repo's sessions never use, sends one redirect note when a turn is stuck in a failure loop, and can
inject repo facts confirmed over three sessions. It supports a fixed range of harness versions; check yours first.

**Opt in.** `features.tokenEconomizer.state: "experimental-on"`, then install the plugin at local scope **in the
trial lane worktrees only**, with micro-skills off. It is a dev-time tool: nothing of it ships to an air-gapped
host.

**Measurement.** First check the meter: `npx --no-install builder-pipeline run cost-window` over a recent week must price every
dispatch and name every seat. An `unpriced` count or an `unknown` seat means the rate table or the transcript
reader is behind, and no comparison is valid until it is fixed. Then take the baseline over two comparable lanes
without the plugin (`cost-window`, `seat-peaks`, `fix-rate`) and repeat over two lanes with it. **Keep** if cost
per lane fell and the fix-of-fix rate did not rise; check that pruning removed no tool a seat's `capabilities`
need. **Remove** otherwise.

**Risk.** A pruned tool a seat needs shows up as a seat that cannot finish, not as an error; the plugin's
one-command restore undoes it. A harness upgrade past the supported range leaves the plugin inert without saying
so, so pin the harness version for the trial.

**Decision (2026-11-17).** not yet measured — no measurement: the meter check and the two-lane baseline have not run.

## 10. Fresh-context plan review — `planReview` (experimental)

**What ships.** Nothing but this protocol. Between P1 and P2, a reviewer with **no project instruction files and
no conversation history** reads `plan.md` and the code it cites, and reports placement decisions left to the
builder, timing-dependent assertions, specs the plan changes without listing, and edits outside the lane's files.
On Claude Code the Elephant-Goldfish Model plugin's stage 9 (`implementation_readiness` + `codebase_details` +
`style`) does this; run it from the CLI, because an app-started session may not load a local-scope plugin.

**Opt in.** `features.planReview.state: "experimental-on"`. The review is read-only, so it may run on the credit
lane.

**Measurement.** One adopting project's trial on one finished plan, blind to its later records: 0 blockers and
10 majors, about 80 seconds and $7. It missed 4 of the 6 code and test fixes the auditors later raised, and caught
two gaps no seat recorded: a race asserted as one fixed code, and edits outside the batch row's files. The planner
and reviewer personas now check both, so the question this trial must answer is narrower: **does the review still
find gaps those checks miss?** Run it on the next three FULL-track plans, blind, from a directory holding only the
plan and every file it cites (code, specs, profile, ledgers, test tree, sibling plans). The builder marks every
decision the plan left open, as it is made, with a `GUESS:` comment in the code; at close-out, match the review's
findings against that list, the lane's `FIX-n` rows and the planner's unrecorded contract changes. **Keep** if,
across the three plans, the review named at least two-thirds of the `GUESS:` decisions, or at least one contract
drift per plan that the planner did not record, or prevented a FIX row the persona checks did not; **remove**
otherwise. (The earlier criterion, FIX rows alone, was retired after the sample run below: three well-formed plans
built green first and left nothing to prevent.)

**Sample run (2026-11, kit-internal: a four-module test service, not an adopting project).** Three FULL-track plans
written by `module-planner` (7, 8 and 10 rows; $1.27–$1.90 and 4–7 minutes each), each reviewed blind from a bare
directory holding only the plan, the code and the specs it cites, then built as written. The review cost $0.44–$0.69
and 87–120 seconds per plan (about a third of the planner's cost) and returned 17–26 findings. Every build was green
on its first run, so there was **no FIX row for the review to prevent** and the keep criterion above could not be
met; what the review did instead was name 22 of the 28 decisions the builder settled silently (helper exports for a
test seed, a clock that must move, detail strings, intra-operation ordering, fixture order for a permission matrix)
and four contract drifts the planner had made without recording them (a factory signature widened against the
"byte-identical" convention, an interface changed against the brief, a settable clock against "a fixed clock in
every test"). Two cautions from the run: the review context must include every file the plan cites (the profile,
the ledgers, the test tree, sibling plans) or a fifth of its findings are "the cited file is missing"; and a plan
whose close-out steps write ledgers outside the lane draws three findings per plan that are not defects. Call
recorded: **keep off**; the criterion as written measures FIX rows, and three green-first builds produced none, so
the next trial should also count the builder's silently settled decisions (mark each in the code as it is made, then
match the list against the findings).

**Risk.** A reviewer graded against a feature-spec standard over-corrects: on a rationale document, about half of
one trial's findings were dropped as the wrong standard. Give it the implementation-readiness standard only.

**Decision (2026-11-17).** not yet measured — kit-internal sample only: 22 of 28 silent decisions named and 4 unrecorded contract drifts over three plans, 0 FIX rows to prevent; three adopting-project plans owed.

## 11. Primary-seat lanes started by the orchestrator — `orchestrator.primaryLaunch` (unmeasured, off by default)

**What ships.** `features.orchestrator.primaryLaunch: "app-session"` lets the orchestrator start a primary-seat
pipeline lane as its own app session instead of asking the human to (`skills/orchestrator.md` §3,
`adapters/claude-code.md`). The brief's first step refuses to run without its skills.

**Measurement.** One batch with at least one primary-seat pipeline lane, against the last batch where those lanes
were started by hand: human interventions per lane (starts, unblocks), stalls, and the time from `LAUNCH` to
`LAUNCHED`. **Keep** if interventions fell and stalls did not rise; **remove** otherwise.

**Risk.** A session that silently lacks a plugin or hook runs the pipeline without its guards. The first-step
check exists for that; a lane that fails it is a stall, never a degraded run.

**Decision (2026-11-17).** not yet measured — no measurement: no batch with an orchestrator-started primary lane.

---

**§12–15 share one door.** Each sends a short excerpt to a cheap model (a Haiku-class subagent on the session's own
provider). Every payload goes through `scripts/lib/outbound-guard.cjs` (`npx --no-install builder-pipeline run outbound-check` from a
shell), so `features.outboundGuard` must be `on` before any of them is switched on. The guard refuses, and never
redacts: a denied file, a secret-shaped string, a value from `envFiles`, or a payload over `maxBytes` means NOT
SENT, and the step goes on without advice. A failed or timed-out call is also "no advice". None of the four may block
a phase, lower a review level, or stand in for a gate. A sending step to a provider other than the session's own is
a new data recipient, and that is the project owner's decision, recorded before the trial.

## 12. Ranked plain search when the index is stale — `rankedSearch` (experimental)

**What ships.** Nothing but this protocol. When the graph index check reports stale or missing (`graph` off, or
`index-check` not fresh), a locating seat's plain-search hits are ranked before it opens any: BM25 over the hit lines
first, and a cheap-model rank of the top 30 only when BM25 ties. The seat still locates first, then verifies by
reading; a rank is never a citation.

**Measurement.** Replay five locate questions from past runs whose answer file is known, with the index withheld.
Count reads until the answer file is opened, unranked against ranked. **Keep** if the median falls by at least a
third with no question missed. **Remove** otherwise.

**Risk.** A confident rank can hide the right file below the fold. The seat reads at least the top five before
concluding "not found".

**Decision (2026-11-17).** not yet measured — no measurement: no replay of the five locate questions.

## 13. Raise-only review-level hint — `riskHint` (experimental)

**What ships.** Nothing but this protocol. Before review dispatch, a cheap model reads the diff summary (paths and
hunk headers, not the diff body) and may answer `raise to FULL: <reason>`. Any other answer is ignored. It can never
lower a level the rules chose, and it is not a gate.

**Measurement.** Replay the last ten lanes, blind to their review records. Count the review findings a raised level
would have caught that the chosen level missed, against raises that found nothing. **Keep** if it would have caught at
least one finding for every three false raises. **Remove** otherwise.

**Risk.** Over-raising turns into cost. The ratio above is the stopping rule.

**Decision (2026-11-17).** not yet measured — no measurement: no replay of the last ten lanes.

## 14. Model-chosen order for the seeded walk — `walkPriority` (experimental)

**What ships.** Nothing but this protocol. In a seeded random walk across roles and routes (an HTTP behavioural
tier), a cheap model picks the order of the next ten candidate steps from their names only (role, route, last
status). The seed and every choice are written to a trace file beside the run, so the walk replays exactly without
the model. A finding that cannot be replayed from its trace is not a finding.

**Measurement.** Equal step budgets, three seeds each. Count distinct failures per 100 steps, random order against
model order. **Keep** if model order finds more distinct failures on at least two of the three seeds. **Remove**
otherwise.

**Risk.** The model may steer toward routes that already fail and away from new ones. Count distinct failures, not
total failures.

**Decision (2026-11-17).** not yet measured — no measurement: no three-seed comparison.

## 15. Advisory notes on prose rules — `ruleNotes` (experimental)

**What ships.** Nothing but this protocol. After an edit, a cheap model checks the changed hunk against the
project's written rules that no deterministic gate covers yet. It may append a one-line note to the rules backlog
(`features.rules`' scan list or the project's equivalent): rule id, file and line, one sentence. It never blocks and
never edits code.

**Measurement.** Over two lanes, a person marks each note true or false. **Keep** if at least two in three are true.
A rule whose true notes keep recurring is a candidate for a deterministic rule, and the note stops once that rule
exists. **Remove** otherwise.

**Risk.** A note that reads like a ruling may be acted on as one. The note says "advisory" in its text, and the
reviewer weighs it like any other unverified claim.


**Decision (2026-11-17).** not yet measured — no measurement: no two lanes with marked notes.

## 16. Review by auditor family — `familyReview` (experimental)

**What ships.** `features.familyReview`, default `experimental-off`. On, the plan split (`orch split`) assigns a
second reader to each lane. The second reader is a registry account (`features.accounts.accounts.<name>`) whose
worker `family` is not the writer's family and whose `tier` is at or above the writer's tier. The tiers are
`free < mid < strong`. An account with no `tier` is unknown and never qualifies. If no such account exists, the lane
has no second reader and the plan carries the reason line `familyReview: no second reader — no other-family account
at or above tier <x>`. The second reader reads the P4 findings as one list and writes its own review file. It never
replaces the reviewer seat (D14). The pipeline, the seats and the FIX loop are unchanged. Off, nothing of it runs:
the plan split is byte-identical with the key absent. Family diversity is not assumed to be the mechanism; the
measurement decides.

**Opt in.** Set `features.familyReview` to `experimental-on` in `PIPELINE_PROFILE.md` §16. Give each account a
`tier` and a `family`. Off, the reviewer reads the findings in dispatch order, as today.

**Measurement.** Three modules with the feature on and three comparable modules with it off. For each module
record: accepted findings per auditor family, reviewer loop-backs (`FIX-n` rows raised by the review pass), and cost
per task (`npx --no-install builder-pipeline run cost-window` over the review window). **Keep** if accepted findings rise, loop-backs do
not rise, and cost per task stays inside the module budget. **Drop** otherwise.

**routerHint (M8b, advisory).** `features.routerHint`, default `experimental-off`. On, the kit prints three lines for
a lane: an account suggestion (the pays order, the content class against the project visibility), a risk flag (a
content class the visibility refuses, a Full lane) and whether a second opinion is advised (the §16 second-reader
rule). It never changes a placement: a probability is not an exit code (D15). A call to a decisions-style API goes
through `features.outboundGuard`; a call that would send task text to an account whose data-recipient decision is
not in the decision log is refused with `E_DATA_RECIPIENT` first. Off, nothing of it runs. **What it must prove.**
Over ten lanes, record the suggested account against the account the rulebook placed, and the risk flag against the
lane's outcome (a `FIX-n` row or a merge revert). **Keep** if the suggestion matches the placement in eight of ten
lanes and every flagged lane had a finding. **Drop** otherwise. No measurement yet.

**Risk.** A second reader doubles the review cost of a lane. A family view can hide a cross-family defect: a security
finding that is also an invariant break is read once, in one list. The reviewer still reads every finding.

**Decision (2026-11-17).** not yet measured — no measurement: the second reader is built; no module has run with it.

## 17. Board loop on a throwaway project — `boardLoop` (planned, experimental)

**What ships.** `features.boardLoop` (M9): `npx --no-install builder-pipeline run board-loop` and `orch loop`. The orchestrator loops one brief through Stage 0 to Stage 5 on a
throwaway project without a person between the stages. The board stays the one progress surface.

**Opt in.** Set `features.boardLoop.state` to `experimental-on` in `PIPELINE_PROFILE.md` §16, on a throwaway project only,
with `features.boardLoop.promptFile`, `gate` and `maxPasses` filled.
The test bed is a small project of four to six aider polyglot exercises, each with its unit tests as the gate.

**Measurement.** Over one loop of every exercise, record: pass rate (exercises whose unit tests pass), cost per
exercise (`npx --no-install builder-pipeline run cost-window`, or `unmeasured` when the harness keeps no record), turns per stage,
timeouts, and silent failures (a stage that ended without a verdict and without an error). Write the numbers in
this section with the project commit sha. Promotion is the maintainer's call, made on these numbers.

**Measurements.**

| Date | Kit commit | Test bed commits | Account | Passes | Rows done | Pass rate | Cost (USD) | Turns | Timeouts | Silent failures | Stop | Note |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-11-17 | 24ae3cd | 3e97890 → 606d88f | stub worker | 3 | 0/6 | 0% | unmeasured | 3 | 0 | 0 | no-progress | dry run of the machinery, no model |
| 2026-11-17 | accae92 | 5e4f866 → 500cfc8 | gateway lane (Sonnet-class through the local gateway) | 5 | 1/6 | 17% | 0.29 | 43 | 0 | 0 | consecutive-failures | 4 passes INCOMPLETE: the worker ran `cd … && cat …` and the exact allow list denied it; the prompt did not name the Read tools |
| 2026-11-17 | b5ba4e8 (prompt names the tools) | b5ba4e8 → 1fa2470 | gateway lane (same) | 6 | 6/6 | 100% | 0.33 | 48 | 0 | 0 | all-pass | one row per pass; 82 s wall time; six commits with the two trailers; `./gate.sh` passes all six afterwards |
| 2026-11-17 | 3bb2343 (integration branch, #28) | 7472eb9 → a5d7834 | gateway lane via `orch loop` (placement over the accounts registry) | 5 | 1/6 | 17% | 0.63 | 49 | 0 | 0 | consecutive-failures | orchestrator-driven (Run 3); 4 passes INCOMPLETE: the worker ran `cd <worktree> && ./gate-row.sh …` and a heredoc write through the shell, which the exact allow list denies; same prompt as the 6/6 run |
| 2026-11-17 | 57c55f2 (D69 hook) | 7472eb9 → c85b58e | gateway lane via `orch loop` | 6 | 5/6 | 83% | 0.37 | 56 | 0 | 0 | max-passes | orchestrator-driven (Run 4, D69): one pass INCOMPLETE on `cd ../.. && … 2>&1 \| tail -15; git rev-parse HEAD` (a `..`, a redirection and a second command: refused by design); then five rows in five passes; the cap of 6 stopped the loop with one row open |

**Risk.** A loop with no person between the stages can run on past a wrong plan. The timeout and the silent-failure
counts exist to show that.

**Decision (2026-11-17).** not yet measured — four model runs on one project: 1/6, 6/6 ($0.33), 1/6 ($0.63, orchestrator-driven, exact allow list) and 5/6 ($0.37, orchestrator-driven after D69, stopped by the pass cap); no wrong solution in any run. Promotion stays a person's call; a second project and a second account are owed before keep.

## 18. Remote lanes — `remoteLanes` (planned, experimental)

**What ships.** `features.remoteLanes` (M12): `orch remote add | preflight | place | launch | poll | cancel`. A lane runs on another machine over ssh, with the same brief,
board and worker adapter as a local lane.

**Opt in.** Set `features.remoteLanes.state` to `experimental-on` in `PIPELINE_PROFILE.md` §16, then add one machine with
`npx --no-install builder-pipeline run orch remote add` and run its preflight.

**Measurement.** One local lane and one remote lane on the same project and the same exercises. For each lane
record: pass rate, wall time from `LAUNCH` to the verdict, ssh failures (a connection that dropped or was refused),
orphaned workers (a worker process alive after the lane ended), and cost (or `unmeasured`). **Keep** if the remote
lane's pass rate is equal and it left no orphaned worker. **Drop** if ssh failures or orphans appear in more than
one run in three.

**Risk.** A worker that outlives its lane spends an account with nobody reading the result. The orphan count is the
stopping rule.

**Decision (2026-11-17).** not yet measured — no measurement: the feature is not built.

## 19. Recorded runs — the loop runner dry run and the 2.0.0 build (REQ-1402, REQ-1406)

**What this section is.** The record of every end-to-end run the kit made on a throwaway project, and of the build of
the kit itself. Each run names its id, its files, its cost (or `unmeasured`), its fix-rate line and its silent failures.
A number here comes from a file in the project Library, never from memory.

### Run 1 — the loop runner on the polyglot test bed (2026-11-17, dry run)

- Run id: `polyglot-testbed` (the board key; run log `.pipeline/loop/polyglot-testbed.jsonl`).
- Project: the throwaway polyglot test bed (six aider Python exercises, pytest gate), commit `3e97890` before the run,
  `606d88f` after it (one commit by the runner: `loop: T1 blocked after 2 failed passes`). Kit commit `24ae3cd`.
- Worker: the stub worker of the kit's own tests (`tests/fixtures/loop/stub-loop-worker.cjs`), so no model ran. This is
  a dry run of the machinery, not a measurement of a model. A run with a model on a ready account is owed and is a
  follow-up.
- Result: 3 passes, 0 of 6 rows done, stop `no-progress` (an identical diff hash three times: the stub wrote nothing).
  Row T1 was marked BLOCKED after its 2 failed passes; pass 3 moved to T2.
- Cost: `unmeasured` (the stub reports no `total_cost_usd`). Turns: 1 per pass, 3 in all. Timeouts: 0. Silent
  failures: 0 (every pass ended with a verdict and one run-log row).
- Fix-rate: `fixLane: unmeasured — no FIX row in 1 board(s); the fix-of-fix rate was not measured` (exit 3).
  `builderBatch` was not exercised.
- Library files (uploaded flat; the evidence set `evidence/polyglot-loop-dryrun-2026-11-17/` names them): `board.md`
  (the board after the run), `run.jsonl` (three pass rows), `progress.md` (the notes fed forward), `state.json`.

### Run 1b — the loop runner with a model on the polyglot test bed (2026-11-17)

- Run id: `polyglot-testbed`, two runs on the same board, both through the gateway lane (API credits through the local
  gateway, a Sonnet-class model; the account `gw` of the test bed profile, `pays: gateway`). Kit commits `accae92` and
  `b5ba4e8` (branch of #23).
- Run 1b-i: 5 passes, 1 of 6 rows, stop `consecutive-failures`, cost $0.29, 43 turns, 0 timeouts, 0 silent failures.
  Four passes ended INCOMPLETE: the worker ran a shell command (`cd … && cat …`) that the exact allow list denies, and
  REQ-604 makes a denied tool INCOMPLETE. The prompt had not named the Read tools. Test bed `5e4f866 → 500cfc8`.
- Run 1b-ii, after the prompt template named the Read, Grep and Glob tools and the one allowed shell command: 6 passes,
  6 of 6 rows, stop `all-pass`, cost $0.33, 48 turns, 0 timeouts, 0 silent failures, 82 s wall time. Six commits, each
  with `Builder-Account: gw` and `Builder-Requirement:`; `./gate.sh` passes all six exercises afterwards. Test bed
  `b5ba4e8 → 1fa2470`.
- Fix-rate: `fixLane: unmeasured — no FIX row in 1 board(s)` (a loop board carries no FIX rows). `builderBatch` was not
  exercised.
- Library files: `polyglot-loop-model-run1-2026-11-17-{board.md,run.jsonl,progress.md,state.json}` and
  `polyglot-loop-model-run2-2026-11-17-{board.md,run.jsonl,progress.md,state.json}`.

### Run 3 — the loop driven by the orchestrator on the polyglot test bed (2026-11-17, REQ-1406)

- Command: `npx --no-install builder-pipeline run orch loop tasks/polyglot-testbed.md` from the integration branch (`3bb2343`, #28), with
  `features.orchestrator` on. The orchestrator placed the loop through the accounts registry (`placeLoop`: the first
  account whose readiness assessment reads ready — the M3 placement fills that seam later), recorded the job in
  `loops.json` (kind loop, account `gw`, cap 6) and ran the same runner as Run 1b. Writer: the gateway lane (API
  credits through the local gateway). A loop board has no reader roles, so no second account took part; the Codex and
  Gemini lanes were ready but idle.
- Readiness: the account read ready through the key-file route (`accounts install` wrote its wrapper; the key file in
  the measurement's accounts home is a placeholder that nothing reads, because the gateway lane's real token lives in
  the devbox wrapper the worker shim starts). The run's `accounts-readiness.json` is in the Library.
- Result: 5 passes, 1 of 6 rows, stop `consecutive-failures`, cost $0.63, 49 turns, 0 timeouts, 0 silent failures,
  89 s wall time. Four passes ended INCOMPLETE on a denied shell command: the worker ran
  `cd <worktree> && ./gate-row.sh T<n> …` and, once, wrote a file through a shell heredoc; the exact allow list permits
  only the gate command as written. Same prompt as Run 1b-ii, which solved 6 of 6: the model's choice of shell prefix
  varies between runs, and the exact allow list turns that variance into failed passes. Test bed `7472eb9 → a5d7834`.
- Fix-rate: `fixLane: unmeasured — no FIX row in 1 board(s)`. `builderBatch` not exercised.
- Observation for the loop's next change (a person decides): the allow list could accept the gate command with a
  `cd <worktree> &&` prefix and pipes to `tail`/`head`, or the prompt could forbid `cd`; until then the pass rate of
  the loop depends on the model's shell habits, not on its solutions.
- Library files: `polyglot-loop-orch-run3-2026-11-17-{board.md,run.jsonl,progress.md,loops.json,accounts-readiness.json}`.
  The orchestrator writes `loops.json` for a loop job; there is no `events.jsonl` for a loop (that file belongs to a
  lane run), so `loops.json` plus the run log are the event record of this run.

### Run 4 — the orchestrator-driven loop after D69 (2026-11-17)

- Same command, board, account and prompt as Run 3; kit commit `57c55f2` (#23 with D69: the loop's pin carries the
  `lane-shell-allow.cjs` PreToolUse hook, which accepts the gate command with a `cd <own worktree> &&` prefix or one
  `| head/tail -n N`, nothing wider). Test bed `7472eb9 → c85b58e`.
- Result: 6 passes, 5 of 6 rows, stop `max-passes`, cost $0.37, 56 turns, 0 timeouts, 0 silent failures, 90 s wall
  time. Pass 1 ended INCOMPLETE on `cd ../.. && ./gate-row.sh T1 2>&1 | tail -15; git rev-parse HEAD`: a `..` segment,
  a redirection and a second command, each refused by design. Passes 2 to 6 solved one row each; the cap of 6 stopped
  the loop with one row (T6) open, so a cap of rows plus one would have closed the board.
- Against Run 3 (1/6, $0.63) on the same prompt: D69 turned the shell-prefix failures into passes without widening the
  shell; the one remaining refusal was a command the rule is meant to refuse.
- Fix-rate: `fixLane: unmeasured — no FIX row in 1 board(s)`. `builderBatch` not exercised.
- Library files: `polyglot-loop-orch-run4-2026-11-17-{board.md,run.jsonl,progress.md,loops.json,accounts-readiness.json}`.

### Run 2 — the 2.0.0 build itself (November 2026)

The 2.0.0 modules were built as device and cloud lanes of the project (one Claude session per module, on George's
accounts through the project threads), not through the kit's orchestrator. So there is no orchestrator run log and no
`events.jsonl` for the build; REQ-1406 is met honestly by this record, and an orchestrator-driven build run is a
follow-up once an account is ready on the device. The module pull requests, all drafts against the stacked bases at the
time of writing:

| Module | PR | What it adds |
|---|---|---|
| M0 | #6 | the accounts spec and decisions |
| M1 | #14 | the account registry |
| M2a | #15 | the readiness assessment |
| M3 | #22 | account placement |
| M6 | #16 | worker adapters |
| M9 | #23 | the loop runner above a board |
| M10 | #18 | the accounts command |
| M11 | #21 | wrappers, gateway and free accounts |
| M12 | #19 | remote lanes |
| A | #7 | EXPERIMENTS §16 to §20 and the decision rows |
| B | #8 | time to first value |
| C | #9 | false-positive rates |
| M14 | this PR | the evidence programme |

**Decision (2026-11-17).** not yet measured — one stub dry run, two model runs (1/6 then 6/6, $0.33) and two
orchestrator-driven runs (1/6 before D69, 5/6 after it, $0.37); the orchestrator-driven run of a build with lanes is owed.

## 20. Kit measurements — time to first value and false-positive rates (skeleton)

**What ships.** The default-on checks and the install path. These are not features to promote. This section records
how fast a new project gets its first result from the kit, and how often the default-on checks are wrong.

**Time to first value.** `scripts/first-value.mjs` creates an empty git repository in a temporary folder, installs
the kit from an npm pack of the checkout, runs `npx --no-install builder-pipeline inventory` and `npx --no-install builder-pipeline run claims-check --files`
there, and prints the wall time. The test fails above 300 s.

| Date | Commit | Node | Wall time (s) |
|---|---|---|---|
| 2026-11-17 | bf64f70 (branch of 36bfdc0, release 1.1.0) | v22.23.4 | 1.1 (pack 0.4, install 0.3, inventory 0.2, claims-check 0.2) on a Linux developer machine, npm cache warm |

**False-positive rates.** Each default-on check (`check-ledgers`, `claims-check`, `output-check`, `fix-rate`,
`inventory`) runs on three public repositories. A person classifies every finding as true or false. A check above
20% false positives is reported as a defect.

Run of 2026-11-17, kit at 36bfdc0 (release 1.1.0), Node v22.23.4, no `PIPELINE_PROFILE.md` in the repositories (default
settings). Repositories, shallow clones: `expressjs/express` 43fca52d, `fastify/fastify` 46797238, `pallets/flask`
49943b5a (three well-known, active projects in two languages, with no agent harness folders) and `ruvnet/claude-flow`
8cb2fbc7 (added because it has `.claude/agents`, `.claude/skills` and `.agents/skills`, so `inventory` has input).
Each check ran from the repository root with the kit's scripts. A finding is one printed violation, problem, item,
overlap or clash. One person classified every finding by hand against the file it names.

| Check | Input | Findings | False | Rate |
|---|---|---|---|---|
| `check-ledgers` | the 4 repository roots | 8 (LG-0 ×2 per repository: no registry file, no boards directory) | 0 | 0% |
| `claims-check --files --no-run-counts` | every `*.md` outside `node_modules`, 97 documents | 0 (no citation, retracted-phrase or owed-note problem; count claims come from a claims file, and none was given) | 0 | no finding to rate |
| `output-check plan` and `review` | each repository's README as the document | 68 (17 per repository: missing sections, missing tables, wrong title) | 0 | 0%, negative control only |
| `fix-rate <files>` | the same 97 documents | 0 (no `FIX-n` row) | 0 | no finding to rate |
| `inventory` | the 4 repository roots | 187 (4 mode calls, 181 items, 1 overlap, 1 clash) | 2 | 1.1% |

The two false `inventory` findings are both on `claude-flow`: `.claude/skills/dual-mode/README.md` listed as a skill
(the folder has no `SKILL.md`), and `.claude/agents/MIGRATION_SUMMARY.md` listed as an agent named "Migration
Summary" (the file is a note, not a persona). The one overlap (`security-auditor`, same name, wording score 0.079) and
the clash it raises are true. No check is above 20%. `claims-check` and `fix-rate` found nothing on these
repositories: their inputs are seat outputs and boards, which a project without a pipeline run does not have. A rate
for them needs a run on an adopting project's boards and claims file.

**Risk.** A rate taken on three repositories is a small sample. Name the repositories and the shas so the run can
be repeated.

**Decision (2026-11-17).** not yet measured — time to first value 1.1 s on one machine (limit 300 s); false-positive rates 0% to 1.1% over four public repositories (no check above 20%).

## 21. Capacity governor — `capacity` (opt-in, 2.1.0)

**What ships.** `features.capacity` (M15, spec `specs/capacity-reporter.spec.md` REQ-1501 to REQ-1516, D70 to D74,
D83): `npx --no-install builder-pipeline run capacity --once | --watch` writes `<orch root>/capacity.json`; `orch next`,
`gate-launch --resume` and the loop runner read it as one more min() term in the lane cap. It lowers only, never
stops a lane, and an unmeasured signal never binds. While the feature is off, nothing of it runs and the script
prints `capacity: not configured`.

**Opt in.** Set `features.capacity.state` to `on` and `perLaneMb` to this project's measured per-lane peak RSS. To
measure it, run one board loop with the feature on: the runner writes `passPeakRssMb` into each pass row of
`.pipeline/loop/<board>.jsonl`.

**Measurement.** Three figures from the loop runner's test project (the polyglot test bed: six aider exercises,
pytest gate, one gateway lane on an 8-core, 15 GB Linux host): the per-lane peak RSS, a recorded tick log where the
governor bound, and the count of false binds. A false bind is a tick where the record lowers the lane count while
every signal is inside its limit. **Keep** if the recorded run has no false bind and the bind releases when the
signal clears. **Drop** if a false bind appears or a hold does not release.

**Per-lane peak RSS.** 347 MB per lane. The template's `perLaneMb` note carries the same figure.

| Date | Kit commit | Sampler | Passes | `passPeakRssMb` per pass (MB) | Peak (MB) | Cost (USD) |
|---|---|---|---|---|---|---|
| 2026-11-17 | 9424344 (#31) | `ps -o rss= -p <pid>`, one process | 6 | 44, 44, 44, 44, 44, 44 | 44 — the gateway wrapper, not the worker (before-evidence) | 0.458 |
| 2026-11-17 | ec7ee78 (#39) | the pid's process tree, `ps -eo pid=,ppid=,rss=` | 6 | 276, 347, 303, 346, 347, 345 | 347 | 0.462 |

The first row is the wrapper caveat. A lane started through a gateway wrapper exposes the wrapper's pid, so a
single-process sample reads the wrapper (44 MB) and not the model worker. The tree sampler sums the pid and every
descendant. In each run, four of the six passes completed. Two passes exited because the lane-shell hook (D69)
refused a gate command with a pipe (`cd … && gate | tail`) or a second `cd`, and the retry passed. These exits are
the hook's correct refusals; the governor took no part in them. A narrower rule for a pipe to `tail` after the gate
is a follow-up candidate (D106), not a change in this release.

**Recorded tick log.** Trial T2, 2026-11-17: `capacity --watch` at `intervalSeconds` 15, `minFreeMb` 20000 on the
15 GB host (a limit the host cannot meet, set to force one bind), `maxLanes` 2, one board loop running.

| Tick | Time (UTC) | Record | Binding signal |
|---|---|---|---|
| 1 to 2 | before 16:35:33 | 1 of 2 lanes | accounts (one account ready) |
| 3 | 16:35:33 | 0 of 2 lanes | memory (free memory under `minFreeMb`) |
| 4 to 64 | 16:35:48 to 16:50:48 | 0 of 2 lanes, held | memory; the rise waits for `riseAfterTicks` |

The loop runner held before pass 3 (`capacity: 0 lanes (memory) — holding up to 60 min, reading again every 15 s`),
read the record 63 times over 931 s, and ran the pass when the record rose to one lane (`1 lane(s) — the pass runs
after 63 read(s)`). Its run log carries one row:
`{"kind":"capacity.hold","reads":63,"seconds":931,"binding":"rise-damping","ended":"pass"}`. The row named
`rise-damping` and not the signal that held. The fix in this release carries `heldBinding` through the damped ticks,
so the row now reads `"binding":"memory"`. False binds: 0. The bind at tick 3 followed a limit the host could not
meet, and ticks 1 and 2 bound on a true account count.

**Risk.** A reading that binds on a signal the host does not measure. The governor never binds on an unmeasured
signal (D72), and every line names the signal with its figure and unit. A dead watcher: a record older than
`ttlSeconds` is ignored, and the reader says so.

**Decision (2026-11-17).** keep — 347 MB per lane on the 8-core, 15 GB host; one forced bind at tick 3, held 62 ticks and released; 0 false binds in the recorded run.

## 22. Model summary of the progress report — `reporterSummary` (experimental)

**What ships.** `features.reporterSummary` (M16, D79) and `agents/experimental/progress-reporter.md`, installed with
`--experimental` only. While the flag is `experimental-on`, the orchestrator dispatches the persona once per report
interval; the reporter includes `summary.md` under `## SUMMARY (model)` only while the file is younger than one interval.
The report itself is built by code and is sent with or without the summary.

**Opt in.** `unpack --experimental`, then set `features.reporterSummary.state` to `experimental-on` with
`features.reporter` on.

**Measurement.** Over two weeks of reports on one project: the bytes of the SUMMARY section against the bytes of the
sections it summarises (the bytes row), the share of reports where the reader opened nothing else after the summary
(the suppression ratio row), and a person marks each summary true or false against the report (the summary criterion).
**Keep** if at least nine in ten summaries are true and the suppression ratio is above one half. **Drop** otherwise.

| Date | Kit commit | Reports | Summary bytes / summarised bytes | Suppression ratio | True summaries | Note |
|---|---|---|---|---|---|---|

**Recorded run, the reporter without a summary (REQ-1702).** Trial T3, 2026-11-17: `features.reporter` on,
`intervalMinutes` 1, `heartbeatEvery` 4, a loopback webhook, one board loop running, 47 minutes. The figures below
are the reporter's own bytes per report and its only-on-change suppression ratio. The summary criterion stays
unmeasured until a report carries a summary.

| Ticks | Sent | Full reports | Heartbeats | Alerts | Silent ticks | Bytes sent | Bytes per report | Bytes per heartbeat | Suppression ratio |
|---|---|---|---|---|---|---|---|---|---|
| 48 | 14 | 4 | 10 | 0 | 34 | 6089 | 435 | 150 | 34 of 48 ticks silent (71%) |


**Risk.** A summary read as the report. The section is labelled as a model's words, it is dropped when stale, and it
never carries a figure the report does not.

**Decision (2026-11-17).** not yet measured — 435 bytes per report and 34 of 48 ticks silent (71%) in one recorded run without a summary; no report has carried a summary yet, so the summary criterion has no measurement.

## 23. Dead code — `deadCode` (planned, experimental)

**What ships.** `features.deadCode` (M20, spec `specs/repo-hygiene.spec.md` REQ-1823 to REQ-1825, D91):
`npx --no-install builder-pipeline run dead-code`. ORPHAN for a source file under `roots` with an extension in `extensions` that no
other file imports and that is not an entry (package.json `main`, `bin`, `exports`, the test pattern, the `entries`
globs). The `baseline` is a ratchet bank (`scripts/lib/ratchet.cjs`): a new ORPHAN is REFUSED (exit 1), a removed one
shrinks the bank. STALE-TODO for a `TODO`, `FIXME`, `HACK` or `XXX` marker whose line is older than `todoDays` by
`git blame`, with the age in days and no author; reported, never failed. While the feature is off, nothing of it runs
and the script prints `deadCode: not configured`.

**Why it is an experiment.** Dynamic imports, framework conventions (a file loaded by a path the framework builds),
generated files and scripts a package.json `scripts` line runs by path are all imports the reader cannot see. Each one
is a false ORPHAN. The rate decides whether the check can ever gate.

**Opt in.** Set `features.deadCode.state` to `experimental-on` in `PIPELINE_PROFILE.md` §16 with `roots`,
`extensions` and `baseline` filled. Run `npx --no-install builder-pipeline run dead-code`. The first run with an empty bank REFUSES
every orphan; a person classifies each one and the true orphans are deleted, the false ones become `entries` globs.

**Measurement (written before the code, REQ-1825).** Run `dead-code` with an empty bank on two repositories:

1. the kit's own repository (`roots: ["scripts", "cli", "hooks"]`, `extensions: [".mjs", ".cjs"]`, the test pattern
   `\.test\.mjs$`), and
2. the loop runner's test project (the polyglot test bed of EXPERIMENTS §17, `roots: ["."]`, its own extensions).

A person classifies every ORPHAN as true (the file is dead) or false (something the reader cannot see loads it). The
ORPHAN false-positive rate is false ÷ findings. Record the kit commit, the project commit, the findings, the false
count and the rate per repository in the table below. STALE-TODO is reported only and is not rated.

| Date | Kit commit | Repository | Commit | Findings | False | Rate |
|---|---|---|---|---|---|---|
| 2026-11-17 | dc0079e | the kit itself, roots as written above, empty bank, no `entries` | dc0079e | 73 | 73 | 100 percent |
| 2026-11-17 | dc0079e | the kit itself, `entries` the layout implies (`scripts/*.mjs`, `scripts/*.cjs`, `cli/*.cjs`, `hooks/**`) | dc0079e | 5 | 5 | 100 percent |

**Classification of the kit run (2026-11-17).** Every ORPHAN is a file loaded by a path the reader cannot see: 58
command entries `cli.js` runs by a built path (`scripts/<name>.mjs`, `scripts/account-key.cjs`,
`scripts/readme-badges.cjs`), 4 `cli/*.cjs` modules `cli.js` (outside `roots`) requires, 11 hook programs Claude Code
and git run from settings, and 5 libraries loaded by `path.join` (`bash-cap`, `reanchor` from the hooks and `cli.js`;
`tool-groups` from `cli.js`; `router-hint`, `srt-check` from `profile.cjs` and `account-wrappers.cjs`). Zero true
orphans. STALE-TODO: none. The second repository is owed, and the polyglot test bed cannot serve it: the bed is Python
and the import reader (`specifiers` in `scripts/lib/deps-check.cjs`) reads `require` and `import` only, so every `.py`
file would be an ORPHAN by construction, not by measurement. The second repository is a JavaScript project other than
the kit (spec amendment DL-4).

**Keep rule.** Keep (promote to `off`, a feature a project may switch on) when the rate is under 10 percent on both
repositories. Drop when it is 10 percent or more on either. A rate on one repository alone is not a decision.

**Risk.** Two repositories are a small sample, and both are JavaScript. A project in another language gets its own
measurement before `experimental-on`.

**Decision (2026-11-17).** not yet measured — one of two repositories measured: on the kit 73 findings, 73 false (100 percent), and still 5 of 5 false after the entry globs; the keep rule needs both repositories and the second (a JavaScript project, DL-4) is owed. The kit's number already says the reader cannot gate a repository whose entries are dispatched by a built path; the recommended course when the second number is in is drop, or a reader that takes `package.json` `bin` dispatch and hook settings as entries before the experiment is run again.

## 24. Pipeline sizing — `track-check` (free check, unmeasured)

**What ships.** The `SMALL` track of the `build-module-pipeline` skill (`specs/pipeline-sizing.spec.md` REQ-2001 to
REQ-2010, D134 to D138): one builder dispatch for a change of at most 4 production source files in one module, the
orchestrator running typecheck and the tiers itself, the foreground dispatch rule, the unattended mode (`Human: none`)
and the `Track:` / `Phases:` report header. `npx --no-install builder-pipeline run track-check --since <base>` measures the limits
from git. None of it is a §16 feature: the limits are fixed numbers in the skill (D135), so there is nothing to switch
on and the measurement decides whether the numbers change, not whether the track exists.

**Why it is here.** The numbers 4 files and 1 module come from one benchmark pilot, not from a sweep. Too low, and a
small change takes the full pipeline for nothing; too high, and a change that needed an auditor goes without one.

**Measurement (written before the second run).** The kit benchmark runs the same five tasks (two to six files each,
hidden tests, three seeds) with the kit before this change (version 2.1.0) and after it, on the same model and lane.
Record, per arm: solved cells of 15, cost per run, wall minutes per run, tool calls per run, seats dispatched per run,
runs that ended in a wait for a person, and the track each run reported. Then the full batch (40 tasks, three arms).

| Date | Kit commit | Bed | Solved | Cost per run (USD) | Wall (min) | Seats per run | Waits | Note |
|---|---|---|---|---|---|---|---|---|
| 2026-11-18 | 2.1.0 (before) | pilot-01, 5 tasks × 3 seeds | 14 of 15 | 1.64 (0.17 to 8.03) | 4.9 | 0 in 8 runs, 1 to 2 in 5, 8 and 14 in 2 | 2 | no SMALL track; two runs waited on a waiver nobody could give |
| 2026-11-18 | 18677ff3 (after) | pilot-02-E, the same 5 tasks × 3 seeds, one subscription lane | 14 of 15 | 0.65 (0.14 to 1.10) | 3.7 | 0 in 4 runs, 1 in 10, 2 in 1 | 0 | tool calls 24 per run (was 48); 9 of 15 reports open with `Track: SMALL`, 6 with prose; 1 run blocked by the harness permission pin (E-T3-s3), 53 denied commands across 15 runs; one run wrote `Needs a human` and ended |

**Keep rule.** Keep the numbers when, after the change, no run waits for a person, the cost per run on the pilot
tasks falls below 1.00 USD with solved cells not below 14 of 15, and every report carries its `Track:` line. Raise the
file limit only if a run that escalated would have been solved as SMALL with the same evidence; lower it only if a
SMALL run ships a defect the hidden tests catch. A change to the numbers is a new decision row, with the run ids.

**Risk.** Five tasks of one shape (small backend changes in one TypeScript project) decide the first numbers. A project
with large files or deep module trees gets its own reading before the numbers are called general.

**Decision (2026-11-18).** not yet measured — two of the three keep conditions hold after the change (no run waited for a person; 0.65 USD per run against 1.64, solved 14 of 15 both times) and the third does not: 9 of 15 reports carried the `Track:` header and 4 runs dispatched no seat, so the header and the one-seat rule moved into the skill's run discipline and the full batch measures them again. The numbers 4 files and 1 module stay as written until that batch.

**Measured again (2026-11-19, full batch `full-01`, 15 tasks × 5 seeds, kit at 00f0a12, one subscription lane).** Arm E
on the five pilot tasks: 25 of 25 solved, 1.15 USD per run (median 0.65; 19 runs SMALL at 0.21 to 1.01, 4 runs
escalated to ADDITIVE at 3.71 to 4.64, 2 reports without a `Track:` line), no run waited for a person. Across all 15
tasks: 71 of 75 solved under the registered grading rule (75 of 75 under the D141 sensitivity rule of the benchmark),
1.42 USD per run, 72 of 75 reports with a `Track:` line, 56 SMALL runs at 0.45 USD mean and 16 ADDITIVE runs at 4.94
USD mean. Records: Library `benchmark/full-01/` (comparison.md, gaps.md, stats.json).

**Decision (2026-11-19).** keep — the SMALL track stays as written: it removed the waits, and a SMALL run costs 0.45 USD against
1.64 for the 2.1.0 pipeline on the same tasks. The keep rule's cost condition failed (1.15 USD on the pilot tasks against
the 1.00 limit) for one reason that is not the limits: 4 of 25 pilot-task runs escalated to ADDITIVE, and an ADDITIVE run
costs ten times a SMALL run. That is gap §25, which has its own measurement. The header rule reached 72 of 75 reports,
not all; §25 G3 carries the fix. The numbers 4 files and 1 module are not changed by this batch (D140).

## 25. Escalation cost — `mediumTrack`, `soloTrack` and the report template (experimental-off, measured first)

**What was measured (2026-11-19, benchmark `full-01`, 600 cells, arms A to J, Library `benchmark/full-01/`).** The kit
(arm E, 00f0a12) solved 71 of 75 cells against 74 of 75 for a bare agent and 75 of 75 for a plain `CLAUDE.md`; the
paired difference is no evidence either way (-0.040 [-0.160, 0.040] and -0.053 [-0.160, 0.000]). Cost per run was 1.42
USD against 0.12 and 0.13. On the three trivial tasks the kit cost 4.75 times the plain agent against a registered
claim of at most 2 times. Every arm, kit or not, solved 93 to 100 percent, so the bed did not separate the arms on
accuracy; it separated them on cost. The kit's cost has two parts, read from the `Track:` line of each report:

| Part | Runs | Cost per run (USD) | Tool calls | Wall (min) | What the bare agent paid on the same tasks |
|---|---|---|---|---|---|
| SMALL track | 56 of 75 | 0.45 (0.21 to 1.01) | 13 | 1.7 | 0.04 to 0.23 |
| Escalated to ADDITIVE | 16 of 75 | 4.94 (3.71 to 6.57) | 136 | 17.5 | 0.09 to 0.23 |
| No `Track:` line | 3 of 75 | 0.64 | 18 | 8.6 | |

The escalations were: a new migration (T8, 2 of 5 seeds), a new table (T9, 5 of 5), a new CLI report kind (T14, 2 of
5), a new field across the job queue (T11, 3 of 5), a five-file split (T5, 3 of 5), a new query parameter (T3, 1 of 5).
The same task escalated on some seeds and not on others, so the limits, not the task, decide the cost. Arms A and B
solved every one of these cells.

**The gap.** G1: a change that stays in one module leaves SMALL because it adds a migration, a table, a CLI kind or a
fifth file, and the ADDITIVE pipeline (four auditors, a board, a pack, a planner) costs ten times as much for the same
result on this bed. G2: the SMALL track itself costs 3 to 5 times a bare run on a one-line change; the seat is the cost.
G3: 3 of 75 reports had no `Track:` line although the rule is in the skill's run discipline.

**Proposed change (not in this release; experimental, default off until measured).** G1: a `MEDIUM` step between SMALL
and ADDITIVE, or wider SMALL limits that treat a migration, a table or a CLI kind inside one module as a reading in
the report rather than an escalation; one builder seat plus one auditor, no board, no pack. G2: a `SOLO` path for a
change the orchestrator can make itself (one or two files, no new behaviour), tiers run once. G3: the `Track:` and
`Phases:` lines move into the report template the orchestrator fills, so the rule cannot be skipped.

**Measurement (written before any change).** The benchmark runs arm E before and after on T3, T5, T8, T9, T11, T14
(G1) and on T1, T6, T7 (G2), same model, same seeds, one lane. Keep G1 when E's cost per run on the six tasks falls
below 1.00 USD with solved cells not below this batch and no new hidden-test failure; keep G2 when the E over B cost
ratio on the trivial tasks is at most 2 (the PT3 claim) with solved unchanged; keep G3 when 75 of 75 reports carry the
line. A bed where the bare agent fails some seeds is needed before any accuracy claim; that is a benchmark decision,
not a kit change.

**Risk.** Lowering the escalation makes a migration or a new table run without the auditors that exist for exactly
those changes. The measurement must include the security and migration auditors' findings on the escalated runs of
this batch before the step is widened; if those auditors found nothing on the 16 runs, the risk is small on this bed
and unknown elsewhere.

**What ships (2026-11-19, `specs/pipeline-cost.spec.md` REQ-2011 to REQ-2020, D142 to D145).** G1: `features.mediumTrack`
(`experimental-off`, `maxFiles` 6), a `MEDIUM` track between `SMALL` and `ADDITIVE`: at most 6 production source files
in one module with one addition (a migration, a table or a public operation); one builder dispatch, the orchestrator's
typecheck and tiers, one auditor dispatch chosen by the addition (`security-auditor` for a public operation,
`invariant-auditor` for a migration, a table or a plain change), one re-dispatch at most, no board, no pack. A
dependency, a permission key or a protected path still escalates. G2: `features.soloTrack` (`experimental-off`,
`maxFiles` 2), a `SOLO` path for a production-source change of at most 2 files with no new behaviour: the orchestrator
edits with a red test first, dispatches no seat, runs the tiers once; with the key off, rule 1 stands. G3:
`templates/module-report.md`, installed once as `specs/module-report.template.md`, opens with the `Track:` and
`Phases:` lines; it has no §16 key because the header rule is already in force (REQ-2007) and a template has no off
state. `track-check` gains `--medium [N]` (exit 3 on a `MEDIUM` line) and `--solo [N]`; without the flags nothing
changes, and the orchestrator passes a flag only when its key is on.

| Date | Kit commit | Gap | Keys | Bed | Solved | Cost per run (USD) | Tool calls | Note |
|---|---|---|---|---|---|---|---|---|
| 2026-11-19 | 00f0a12 (before) | G1 | off | full-01, arm E, T3 T5 T8 T9 T11 T14 × 5 seeds | 28 of 30 | 2.85 (16 ADDITIVE escalations at 4.94, 14 SMALL at 0.45) | 136 per escalated run | arms A and B solved every one of these cells |
| 2026-11-19 | 00f0a12 (before) | G2 | off | full-01, arm E, T1 T6 T7 × 5 seeds | 15 of 15 | 0.45 SMALL mean; E over B on the trivial tasks 4.75 [4.38, 5.36] | 13 | the registered claim was at most 2 |
| 2026-11-19 | 00f0a12 (before) | G3 | — | full-01, arm E, 75 reports | — | — | — | 72 of 75 reports carry the `Track:` line |
| | (after) | G1 | `mediumTrack: experimental-on` | the same six tasks and seeds | | | | owed: the auditor's findings on each MEDIUM run, and the escalations left |
| | (after) | G2 | `soloTrack: experimental-on` | the same three tasks and seeds | | | | owed: the E over B ratio, seats per run (expected 0) |
| | (after) | G3 | — | every arm E report of the batch | | | | owed: reports with the line, of all |

**Decision (2026-11-19).** not yet measured — the before rows are full-01 (600 cells, D140); the code ships with both keys
`experimental-off` and the template installed. The after measurement decides each of G1, G2 and G3 on its own: keep G1 at
under 1.00 USD per run on the six tasks with solved not below 28 of 30 and no new hidden-test failure; keep G2 at an E
over B ratio of at most 2 on the trivial tasks with solved unchanged; keep G3 at 75 of 75 reports with the line.
