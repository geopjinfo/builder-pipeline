# Fix loop — the narrow FIX lane and the in-run edge cases

Part of the `build-module-pipeline` skill (*Fix in-run* and *Loop-back*, step 2).

## The narrow FIX lane (`features.fixLane`, UNMEASURED)

Group the `FIX-n` rows by the file
area they name, and dispatch one builder per group carrying ONLY: the `file:line` list, the rule
each cites, the minimal fix, and the tests to run (`commands.affected`, or the relevant tier) —
no plan, no board history. Localize → repair → validate. Groups run one after another unless
their files are disjoint — and when they **are** disjoint and run concurrently, the lanes must be
told not to write the board at all (see *One writer at a time* in the skill): their source files may be
disjoint, but the board they both flip rows in is one file and is not. Why: loop-backs are a material share of run cost, and a fixer that
re-reads the whole plan pays for context the fix does not need. The lane is kept only if the
fix-of-fix rate does not rise over two runs that used it — record the baseline before the first
use and judge with `node scripts/fix-rate.mjs <boards>/<key>.md …` (`EXPERIMENTS.md`). Feature
off → one builder dispatch with the plan path, the board path and the whole list, and record
`fixLane: not configured`.

## The hand-back check — the detail

Run it from the run's worktree, plus the project's ledger-integrity specs by file, if it has any — no
tier lock, no database, never a full tier. A ledger-spec red that names nothing the run touched (another
lane's work in progress) does not block: log it and go on. Record each hand-back as ONE `gate`
event (`gate: handback`, the result, `retry <n>/2`). The P2 claims check (in the skill) is then the last
hand-back's claims result.

## The hand-back check in a FIX lane

**Every FIX-lane builder return runs the *Hand-back check* (P2) first.** A failure goes straight
back to the SAME FIX lane as new `FIX-n` rows, before step 3 dispatches anything; 2 retries, then
escalate; a foreign ledger red is logged, not blocking. This includes the FIX lanes opened by the
ledger audit — the lane that writes record rows is the one most likely to leave a record defect behind.

## A comment-only fix at a fenced, already-ruled site

**A comment-only fix at a fenced, already-ruled site is ASKED, not deferred:** the brief's entry section
lists it as `GRANT-ASK: <file>:<line range> — <change>`; a grant given in words in the rulings reply is
applied in-run as its own commit with the comment-only proof quoted; not granted in words = not granted.

## Every brief inherits the module's open registry rows

The step-0b sweep lists them; each one that
rule (1)–(3) does not protect is a `C-n` fold-in by default, not a candidate for a human to re-sort.
The cost this rule removes: one extra pipeline run per small item.
