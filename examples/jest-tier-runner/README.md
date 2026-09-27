# Example — a tier runner for a JavaScript project on jest

These six files are **one example** of the run-economy interface below, written for a JavaScript
project that tests with jest (with prisma migrations and npm scripts in the example patterns). They
are not installed by the pack and nothing in the pipeline depends on them. Point `commands.tier` and
`commands.affected` in `PIPELINE_PROFILE.md` §16 at **your own** equivalent — this port, a Makefile
target, a pytest or `go test` wrapper — as long as it honours the interface. The porting knobs for
this example are listed in [`../../tooling/PORTING.md`](../../tooling/PORTING.md).

## The interface

**1. A tier runner writes the full log and prints a bounded digest.**

- `commands.tier` is one command containing `{tier}`; `commands.tiers` lists the names it accepts.
- Every run writes the complete output to a file under the logs directory (`paths.logs`).
- What reaches the caller is a **digest** of a bounded number of lines: the counts (suites / tests
  passed and failed), each failure with **one** line saying why, and the path of the full log.
- The exit code is the test runner's own, so the command composes in a chain like a bare call. A run
  that did not run (lock busy, harness died before producing a result) says so in one line and must
  never print a previous run's result.
- **The suite total is checked, not trusted.** The runner counts the tier independently (jest:
  `--listTests --json`, with the run's own selecting arguments) and compares it with the reported suite
  total. A shortfall is a FAIL with a non-zero exit even when the test runner exited 0 — a worker that
  dies can take a whole suite with it and leave every reported figure green. A count that could not be
  taken is said ("corpus NOT measured"), never presented as measured. Measure the rule on your project
  first: equality held exactly in the reference project, skipped suites included.
- Why: a raw multi-megabyte suite log read into an orchestrator's context costs tokens on every later
  turn, and pushes the loop-back list into the middle of the window, where it is least likely to be
  acted on. The log is kept; only the digest is spoken.

**2. Selective ("affected") runs are inner-loop only.**

- `commands.affected` runs only what the changeset can reach. It is a convenience for the builder's
  red → green loop and is **never** merge evidence: a board row cites a full run, and full tiers stay
  mandatory at the phases that verify.
- It **escalates to a full run** when the change touches something an import graph cannot see
  through: shared configuration, migrations and schema, seeds, the shared kernel, the test harness or
  its support files, the test-runner configs, the manifests. A false "full" costs minutes; a false
  "related" costs a missed regression, so anything not obviously safe belongs on the escalation list.

**3. Worker pools are sized from free memory.**

- The worker count is the minimum of (cores minus a small reserve), (free memory ÷ memory per
  worker) and a per-tier ceiling. The governor only ever **lowers** the count: raising it makes runs
  slow, flaky and non-comparable across machines. CI pins an explicit override so it stays
  deterministic — and the pin is still bounded by the tier's ceiling (an override above it is clamped
  and reported), or a single-worker tier ends up running many.
- A wrapper that wants a smaller pool (a shared remote host, say) passes a **lower-only cap** into the
  governor (`TEST_WORKER_CAP` in this example), never a test-runner CLI worker flag: the CLI flag
  replaces the governed answer, so a host with memory for two workers runs the cap's six.
- Why memory and not load average: load average is not reported on every platform, and an
  oversubscribed tier fails on timeouts, which reads as a regression and is not one.

**4. One suite at a time when suites share an external resource.**

- When two tiers share a database container, a template database or a daemon, a **machine-wide**
  lock serialises them. Scope the lock to the resource, not the repository: a lock keyed by
  checkout or worktree is an absent lock, because worktrees on one machine share the resource.
- A lock whose holder is gone is reclaimable, and a holder older than a plausible run ceiling is
  treated as stale even if its process id now resolves — process ids are reused.

## What is in this directory

| File | Implements | Installed as (if you copy it) |
|---|---|---|
| `run-tier.mjs` | 1 — runs a jest tier with `--json --outputFile`, writes `logs/<tier>-<stamp>.log`, prints the digest; `gates` runs the gate chain the same way | `scripts/run-tier.mjs` |
| `digest.cjs` | 1 — the ≤25-line digest from jest's JSON result | `scripts/lib/digest.cjs` |
| `affected.cjs` | 2 — jest `--findRelatedTests` plus the escalation list | `scripts/lib/affected.cjs` |
| `capacity.cjs` | 3 — `maxWorkers()` for your jest configs | `scripts/lib/capacity.cjs` |
| `tier-lock.cjs` | 4 — the machine-wide lock with a stale-holder ceiling | `scripts/lib/tier-lock.cjs` |
| `instruction-trailer.cjs` | not part of the interface — a CI check that a change to the agent instruction files is declared by a commit trailer | `scripts/lib/instruction-trailer.cjs` |
| `instruction-trailer-check.mjs` | not part of the interface — the CI entry for `instruction-trailer.cjs`: `node scripts/instruction-trailer-check.mjs [<base-ref>]` (default `origin/main`); exit 0 pass · 1 undeclared change · 2 git could not answer. Requires `./lib/instruction-trailer.cjs` when installed, else the helper beside it | `scripts/instruction-trailer-check.mjs` |

`run-tier.mjs` requires its helpers from `./lib/`, so keep that layout or change the three requires.
Requires Node 18 or newer; no dependencies beyond the test runner itself.

```
node scripts/run-tier.mjs unit
node scripts/run-tier.mjs integration --affected --since origin/main
```

In §16 that becomes, for example, `"tier": "node scripts/run-tier.mjs {tier}"` and
`"affected": "node scripts/run-tier.mjs unit --affected"`.
