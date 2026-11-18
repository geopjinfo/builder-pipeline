# Close-out (P7) — the detailed procedures

Part of the `build-module-pipeline` skill, *Finish*. The skill keeps the step order and the stop
rules; this file keeps how each step is done.

## The one exception — a late grant on the same branch

A grant that arrives in the reply to the run's
OWN handoff is applied on that run's branch, without a new key, only when ALL FIVE hold: (1) the branch
is not yet merged; (2) the grant is comment/prose-only, names the file and line range, and is given in
words; (3) the human says so in session, recorded as a decision with its reversal; (4) one commit per
grant, a registry row it closes moves with its asserting spec in the same commit, currency stamp last,
gates re-run and quoted with sha; (5) a reviewer delta pass over exactly the new commits returns
MERGE-READY, boundary checks first (only granted files, zero non-comment lines, no unlock file left).
Fail any one and it is a new run. This relaxes neither the rule that a no-pipeline change never touches
source, nor the fenced-area track for a behavioural change. Without it, the fix-in-run rule (which
exempts fenced sites) plus grants that only arrive after `run.end` guarantee one tail run per run.

## Step 2 — earn each DONE: the three failure shapes

Hunt three failure shapes by name:
- **absence proof for a presence claim** (evidence proves a different, adjacent property);
- **gate compliance standing in for delivered behaviour**;
- **the unit tested but the wired path never reached** (direct coverage no real entry point
  exercises).

Re-read each row's acceptance text: multi-clause criteria joined by `;`/`and` are where partial
delivery hides — meeting one clause of three is **not** DONE. (If the
optional `ledger-audit` extra skill is installed, run it scoped to this module in P7a, before the
reviewer is dispatched — see *Fix in-run*.)

## Step 3 — the three free record gates

- **Decision index** (`features.decisionIndex`) — the index of decision ids is derived from their
  anchors, never typed, so an id this run cited but never anchored is visibly absent instead of
  invisible. `--check` fails on a stale index, an unanchored id, or an id anchored twice; run it
  without `--check` to regenerate. Feature off → `decisionIndex: not configured`.
- **Instruction budget** (`features.instructionBudget`) — the agent instruction files stay under
  their line budget. Over budget → move a section into a path-scoped rule file (moved, not
  copied). Without a gate the root file grows back one working agreement at a time. Feature off →
  `instructionBudget: not configured`.
- **Instruction lint** (`features.instructionLint`) — what the instruction files state about the
  repo is still true: every path resolves, no bare `:N` line reference, every registered figure
  matches its source, every enumerated set is complete, and count claims and history phrases do
  not grow past the baseline. A module that renamed or moved a file fixes the instructions that
  cite it here, in the same run. Feature off → `instructionLint: not configured`.

## Step 3 — the hygiene report and the completion gate

`node scripts/hygiene.mjs --since <base> --json` runs every hygiene-class check whose §16 feature is on
(`branchSweep`, `runSweep`, `worktreeSweep`, `ignoreCheck`, `sizeCheck`, `secretScan`, `depsCheck`, `docsCheck`,
`deadCode`, `instructionLint`, `instructionBudget`, `attributionCheck`, `artifactCheck`) through its own script and
prints one report; a check that is off prints its `not configured` line. `--since` narrows the checks that read
files to the files changed since the ref; the sweeps and the tree checks judge the whole tree and say so. A **hard**
finding (exit 1 from `secretScan`, `attributionCheck`, `artifactCheck`, `depsCheck`, `deadCode`) opens a `FIX-n`
row; a soft finding goes to the handoff pack's gaps, with the `repo-steward` persona's keep / fix / allow and the
§16 row that would record it. `--apply` reaches only the three sweeps and is never part of the close-out.

`node scripts/hygiene.mjs --gate --since <base> --json` prints the seven rows of the completion gate — **file scope**,
**ignore rules**, **secrets**, **staging**, **commit**, **delivery**, **separation** — each `PASS`, `FAIL` or
`NOT CONFIGURED`, with the findings behind a `FAIL`. A `FAIL` row opens one `FIX-n` row per failing gate and the
module stays open. `NOT CONFIGURED` is never a pass: record it as `hygiene: not configured` for that row. No gate
check on at all → exit 3 and the same line for the module. The gate reads; it removes nothing, rewrites no history
and erases no file of the person's.

**Staging and commit rules.** Stage files by name, never `git add .` or `git add -A`; inspect
`git diff --cached --name-status` before the commit; a plain commit message and a plain PR title and body with no
attribution trailer and no generated-content footer; remove scratch output before the close-out; run the completion
gate (`hygiene --gate --since <base>`) before the push. A FAIL row is a FIX row, never a line to delete.

## Step 5 — the handoff pack's sections

Fill every `<fill …>` — §E (docs and contract changes) is written by hand. Sections: **§A progress** (commit, version, verdict,
rows done / deferred / dropped, tier results, behavioural-gate result) · **§B tracker flips**,
split pre-merge / post-merge (`features.handoffPack.tracker`; `tracker: not configured` when the
project keeps none) · **§C decisions** (every decision recorded this run, in-session rulings to
declare, `NEEDS-RULING` items) · **§D registry** rows added / closed / moved · **§E docs**
(protected-path doc changes, any warranted architecture-decision record, any catalogue amendment,
the contract diff) · **§F merge conditions** and the tag. Each item carries a `RESPONSE REQUIRED`
line. The check refuses a missing section, a missing `RESPONSE REQUIRED` line, a tracker value
outside the tracker's own vocabulary, and a decision or registry id that does not exist.

## Step 6 — what the report carries

A concise summary: module key; files added/changed; oracle keys used (all
verified); contracts exercised; tests green; docs updated; readiness + audit verdicts; the
requirements-traceability result; the behavioural-gate result (or the recorded skip and its
reason); and the invariant-candidate line — how many covered, how many `DEFERRED→<id>`, how many
`NEEDS-RULING` routed. Point to `<runs>/<key>/{plan,review-pass<n>}.md` as the audit trail.

## Step 3 — updating the deferred registry

(a) add a row for every item this module deferred (blocking
dependency + how-to-resume); (b) close or flag any row whose dependency this module just
resolved; (c) bump the registry's `Last reviewed` date.

## Step 3 — the registry gate and the decisions, why

Run `node builder/cli.js check-ledgers` because an out-of-vocabulary status or dangling `DEFERRED→id` rots silently
otherwise. The decisions to record include boundary events, catalogue amendments, fold-in calls and escalation
outcomes — future planners cite these ids instead of re-asking.

## Step 8 — the worktree sweep

Whoever merges it runs, from the primary checkout,

```
node scripts/worktree-sweep.mjs            # dry run: KEEP / SWEEP per worktree, with every reason
node scripts/worktree-sweep.mjs --apply
```

It removes a worktree only once it is merged into `features.worktreeSweep.target`, clean (untracked
files included), idle, unlocked, not reserved, named by no running process and held by no
`holdCommand`; it copies the worktree's gitignored evidence (`backupDirs`) out first, unlinks a
`node_modules` junction without entering it, removes with plain `git worktree remove` (never
`--force`) and keeps the branch. `worktreeSweep: not configured` → remove finished
worktrees with `git worktree remove <path>` (no `--force`) after unlinking any `node_modules`
link, and copy out the run folder and logs first.
