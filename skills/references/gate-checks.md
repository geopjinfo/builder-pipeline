# Gate checks P1–P4 — what each free check does

Part of the `build-module-pipeline` skill. The skill names each check, its command, where a failure
goes and its `not configured` line; this file says what each check holds the output to, and why.

## P0 — index freshness: branch on the exit code

- `0` fresh → proceed.
- `11` code behind → run the command in `features.graph.syncFree` (free), then re-check.
- `10` / `12` docs pending → run the command in `features.graph.sync` (it embeds docs up to
  `features.graph.autoLimitKb`), then re-check. Still `10` because the pending docs are **above**
  the limit → a person's call: state the count and size and ask. A declined embed is recorded,
  not skipped.
- `3` absent or not configured → record `graph: not configured` (or the absent verdict) and
  proceed; seats locate with plain search.
- `4` unmeasurable on this machine → record it and proceed, as for `3`.
- `1` the check itself failed → fix it, or record the failure with its message.

A planner reading a stale index is
how a brief goes wrong while the coder, reading the source file, is right.

## P1 — the experimental graph trial

*Experimental:* when `features.graphTrial` is `experimental-on`, tell the planner the trial is on;
it then follows `builder/skills/references/graph-query.md` and ends with a `graph:` line. See
`EXPERIMENTS.md`.

## P1 — plan shape (`output-check.mjs plan`)

It holds the plan to the section names in `features.planSchema.sections`, the fixed table
headers in `features.planSchema.tables`, the Tasks columns in `features.planSchema.taskColumns`
(add `Files` to require each row's edited files), and — when `features.planSchema.oracle` is set — every
catalogue key in those tables against the oracle. A fixed shape is what lets the board, the builder and
the reviewer read the plan without interpreting it.

## P1 — board citations (`citations-check.mjs`)

Every `Cites` id in a scheme the profile declares (`features.citations.schemes`) must resolve to
its source; prose citations are reported not-evaluable, never failed. An unchecked citation is a
more confident-looking invention, and one id reads exactly like its neighbour that exists.

## P2 — how the builder reads its rows, and why batches

The builder reads its rows with
`node scripts/ledger-row.mjs board <key> <ROW…>` and any registry row with
`node scripts/ledger-row.mjs registry <ID…>` — one row with its section and real header, never
the whole ledger.

Why batches: every turn of a dispatch re-reads its whole context window, so the
long tail of a dispatch that has built many rows costs far more per turn than a fresh dispatch's
startup. **UNMEASURED** in this pack: its benefit is judged by per-dispatch peak context and
builder cost per row, before and after —
`node scripts/seat-peaks.mjs --since <iso> --until <iso> --seat module-builder` (see
`EXPERIMENTS.md`).

## P2 — the claims check (`claims-check.mjs --extended`)

It re-runs each count, holds every `file:line` citation (and `file:line «anchor»`) under
`paths.citationRoots` to the file, refuses phrases listed in `features.claims.retracted`, and
refuses any `NEEDS-RULING` or "owed" note that names no decision-workspace file, registry id or
handoff §. In one adopting project 44% of loop-back fixes were false records (stale counts,
drifted citations, ownerless notes), and they drove most review re-loops. `--extended` adds two checks on
`DONE` rows: **UNANCHORED** (a count in the evidence cell with no file, script, command or log path
that could have produced it) and **NAMED** (a cited test name that occurs in none of the spec files
the same cell cites). The bare CLI keeps them off unless asked.

## P2 — line citations and wiring

- **Line citations** (`features.lineCitations`) — a catalogue cited by line number instead of by
  key. A line number rots the moment a row is inserted above it and launders a guess as
  verification: in one adopting project every one of 120 such citations pointed at the wrong row.
  The scan runs a positive control first, so a zero from a scan that found nothing fails. Feature
  off → `lineCitations: not configured`.
- **Wiring** (`features.wiring`) — a declared seam with nothing on the other end: a queue whose
  dispatcher has no production caller, a subscription to an event nothing emits, a registered
  provider nothing references. Every artifact is individually correct, so no test fails; only the
  join is missing. The builder joins it, deletes it, or — when a person rules it deliberately
  latent — adds an allow row with a reason and a citation. A waiver matching no unjoined seam is
  dead and fails. Feature off → `wiring: not configured`.

## P3 — the mutation step (`mutation-step.mjs`)

Every **logic** survivor becomes
a tester row naming the assertion that kills it; the **payload** survivors (those matching
`features.mutation.payloadPattern` — error bodies, detail fields) become ONE row. A green suite
that lets a mutant live asserts less than it looks: in one adopting project the first baseline
scored far below what an all-green suite suggested, and most survivors were error-payload
assertions. The step never blocks; a blocking threshold is experimental (`features.mutationGate`,
`EXPERIMENTS.md`) and is set only from measured scores.

## P3 — why the full tiers run here

The builder's selective loop sees only what its
selection reaches; this run sees the rest.

## P3b — reading a red drift oracle

A red effect oracle means a **declared side effect
changed**: read the REMOVED lines first — a transition that silently stopped auditing, an event
that stopped firing, a dropped revocation. A red contract oracle means the API moved.

## P4 — the three audit preparations

*Re-sync the index (optional, free).* When `features.graph.syncFree` is set, run it: an auditor
querying the index otherwise queries one that does not contain the diff under audit. Graph off →
nothing to run; step 0 already recorded `graph: not configured`.

*Rule hits for the vuln-auditor (optional).*

```
node scripts/rules-module.mjs <module> > <runs>/<key>/rules.txt
```

Give **`vuln-auditor`** that path: the structural rule hits in this module, each `NEW` or
`BASELINED` with its recorded reason. The seat must **account for every line**. Feature off → the
file holds `rules: not configured`, and the seat says so in its output.

*Experimental:* when `features.personas` is `experimental-on`, attach the role profiles for the
roles this module touches to the `security-auditor` and `invariant-auditor` dispatches
(`EXPERIMENTS.md`). A profile locates; it never rules.

## P4 — the findings schema (`output-check.mjs findings`)

It refuses a finding missing any of `id` · `severity` · `location` · `cite` · `claim` ·
`evidence`, a `location` that is not a real `file:line`, a PASS over a blocker, and a
`filesTouched` path outside the git diff. The
reviewer's job is verifying evidence; that is mechanical only when the fields are guaranteed
present.

## P6 — the spec trace (`spec-trace-check.mjs`)

Every requirement id in `features.specTrace.requirements` must have a test (any whole-token mention
in a file under `features.specTrace.tests` matching `testPattern`) or a requirement-pack step under
`features.specTrace.packs` — one of the four verbs in `templates/requirement-pack.md`: `assert`,
`by-design <cite>`, `gap`, `skipped`. A plain mention in a pack is a note, not a step, and traces
nothing; a `by-design` step with no citation fails, because the citation is what makes the
divergence documented rather than quietly accepted. An `UNTRACED` id fails the readiness item: a
requirement nobody traced has no outcome, however green the suite. Two positive controls: requirement
files that declare zero ids fail, and a run that read no test or pack file fails. Feature off →
`specTrace: not configured`.

## P6 — the review file's sections

The reviewer writes `<runs>/<key>/review-pass<n>.md` in the shape of `builder/skills/references/review-template.md`:
Verdict · Readiness · Requirement traceability · Invariant candidates · Findings (ranked) · Loop-back list · Merge
conditions.
