# tasks/ — per-module pipeline build boards

> **Install this file as `tasks/README.md`** in the target repo (the unpack step does this).
> The unpack step also installs `scripts/board-progress.mjs` + `scripts/board-check-all.mjs`,
> and `tasks/_session-board.template.md` for cross-run delivery boards.

One git-tracked board per `build-module-pipeline` run: `tasks/<moduleKey>.md` (`paths.boards`). The
board is the **durable truth** for what a module build planned, finished, dropped, and deferred, and
it is the **one progress surface** — there is no harness task-list mirror. Every extra progress
surface is one more place for status to disagree; in one adopting project the mirror instructions
went unfollowed while the board stayed current, so the mirror was retired rather than enforced. The
board rides the module PR — open the file to see progress at any time.
(`.pipeline/<moduleKey>/{plan,state,review-pass<n>}.md` stay gitignored/ephemeral.)

## Format

```markdown
# <MODULE_KEY> — build board

_Started: <date> · Track: <track> · Brief: <one line> · Plan: .pipeline/<moduleKey>/plan.md · State: .pipeline/<moduleKey>/state.md_

<!-- phase:status start -->
| Phase | Seat | Status | Artifact | Verdict |
|---|---|---|---|---|
| P1 Plan | module-planner | DONE | .pipeline/<k>/plan.md | 0 blocking |
| P2 Code | module-builder | IN-PROGRESS | — | — |
<!-- phase:status end -->

<!-- progress:auto start -->
(computed by scripts/board-progress.mjs — never hand-edited)
<!-- progress:auto end -->

## P2 — Code

| # | Task | Cites | Status | Test-seed / evidence | Notes |
|---|------|-------|--------|----------------------|-------|
| T1 | <planned task> | <requirement / decision / gate id> | DONE | <test file path(s)> | |
| T2 | <planned task> | <id> | DEFERRED→<REG-ID> | — | why + registry id |
| C1 | <candidate from the deferred registry> | — | DROPPED | — | human ruled defer-again |
| IC-1 | <invariant candidate from the module digest> | <digest candidate id> | DONE | <story / test file> | covered by: <named> |
| FIX-1 | <loop-back fix> | <gate id> | DONE | <test file path> | from reviewer blocker list |

## Deferred this cycle
- <REG-ID> — <task> — mirrored in DEFERRED_TASKS.md

## Todo
- [x] <a to-do that is not a board row — e.g. open the run log, start the watcher>
- [ ] <still open>

## Definition of Done

| Phase | Done when |
|---|---|
| P2 | every row DONE or DEFERRED→<id> · the row's tests green on a full tier run |

## Modules & endpoints

| Module | Method | Path | Permission key |
|---|---|---|---|
| <module> | <verb> | <path> | <key, verbatim from the oracle> |
```

**Three optional sections, never counted.** `## Todo`, `## Definition of Done` and
`## Modules & endpoints` are optional. The renderer shows each one, and says **"none declared"** in
words when a section is absent, so a missing section reads as missing rather than as nothing to do.
They are never counted into the progress bar (only `## P<n>` and `## B<n>` sections are), and
`node scripts/board-render.mjs <key> --json` emits each as its own page document. Keep the table
headers as shown. A project whose interfaces are not HTTP endpoints fills the columns with its own
equivalents (handler, message, command), or leaves the section out.

**Decisions are not typed on the board.** Each decision the run takes is a `decision` event in the
run log; the rendered page reads it from there, and the decision workspace (`paths.decisions`) stays
the record.

## The progress block is computed, never typed

A hand-maintained bar is a claim nobody re-derives: the rows move and the bar does not, and the
board then reports last week's number with this week's authority. `board-progress.mjs` counts the
Status column of every counted section and rewrites **only** the block between the markers.

A **counted section** is `## P<n> — <title>` (a build board's phase) or `## B<n> — <title>` (a
delivery board's batch, one branch per batch). Everything else is prose.

```
node scripts/board-progress.mjs tasks/<board>.md            # rewrite
node scripts/board-progress.mjs tasks/<board>.md --check    # exit 1 if stale
node scripts/board-check-all.mjs                            # every marked board — wire into CI
node scripts/board-check-all.mjs --fix                      # rewrite instead of failing
```

**Opt-in by design.** Only boards carrying the markers are checked, so existing flat boards neither
fail nor need converting — a closed board's bar signals nothing to anyone. **Convert on touch:** a
board gains the block when it reopens (a `FIX-n` row lands). Files named `_*.md` and `README.md` are
skipped: a template quoting the markers is not a board, and counting it writes a fabricated bar into
your documentation.

## The rendered run board — `tasks/<key>.html`

A markdown board says what the rows **are**. It cannot say what the run **did** — the order things
happened in, the files each step produced, which seat spent what — and that used to live only in a
transcript, which is exactly what a context compaction discards. So a run keeps an append-only log
beside its board (`.pipeline/<key>/run.jsonl`, written by the orchestrator alone) and publishes a
rendered page from the two:

```
node scripts/board-render.mjs <key>          # write tasks/<key>.html
node scripts/board-render.mjs <key> --json   # one JSON document per section (for a hosted page)
node scripts/board-watch.mjs                 # keep every board current while a run happens
```

One self-contained file — no stylesheet, script, font or image fetched from anywhere, so it opens
from `file://` offline. It reloads itself every 20 s and shows its own age, because a page that only
says *when* it was rendered lets a dead watcher pass for a quiet run.

**Start the watcher once, at the beginning of a run,** as a separate long-running process. A page
that is fresh only when somebody remembers to render it is a page that is usually stale. The watcher
re-renders on any write to a board or a run log — which means **a coder flipping a row to
`IN-PROGRESS` moves the page by itself**, with no extra event and no new instruction for a seat to
forget.

**The markdown wins.** The HTML is a projection; where they disagree the markdown is the truth and
the renderer is the defect. **Absence renders as absence** — an unmeasured cell is an em-dash, never
`0` and never `$0.00`, because a zero is a measurement nobody took. Per-seat model / wall-clock /
token figures come from the harness's own dispatch records, not from the seats: an agent reporting
its own cost is reporting a number nobody checked. A harness that keeps no such record yields
em-dashes and the rest of the board still works (`features.costAccounting`). Cost is derived from a
local rate table whose version is printed next to the total.

`board-check-all.mjs` carries a second check for these pages — a rendered board older than its own
run log fails, exactly as a stale progress bar does. `--fix` re-renders. The two opt-ins are
independent: a board may carry a run log, a progress block, either or neither.

### What the run log records

| Event | When | Carries |
|---|---|---|
| `run.start` | run opens | module, track, branch, base, scope |
| `step` | every dispatch | id, seat, title, detail, status, the harness's agent id, `files[]` |
| `gate` | every tier, gate or optional check run | gate, result, figure, detail, log path |
| `finding` / `finding.close` | an escalation or auditor finding, and its closure | id, severity, finding, mechanism, closed-by |
| `ceiling` | whenever the reachable total drops | item, claim, reality, disposition, owner |
| `decision` | every decision the run takes | id, what, why, by, reversal |
| `run.end` | close-out | verdict, rows done / total |

A `ceiling` event is not optional bookkeeping. It is how a run says out loud that it will not reach
what it set out to, instead of arriving at close-out with a quiet shortfall — and the page renders
"no ceiling declared" in words when there is none, so silence cannot read as *nothing was out of
reach*.

A `decision` event mirrors a decision recorded in the decision workspace; it does not replace the
record. A later event with the same id amends the earlier one on the page.

## Rules

- **Statuses:** `PLANNED` · `IN-PROGRESS` · `DONE` · `DEFERRED→<registry-id>` · `DROPPED`
  (reason in Notes).
- **Row kinds:** `T-n` from the plan's `## Tasks` · `C-n` candidates copied from the deferred
  registry at pipeline entry · `IC-n` invariant candidates carried from the module digest · `FIX-n`
  appended from verified loop-back blocker lists. **Rows have exactly these four authors** — nobody
  free-writes a row, or the board becomes the work.
- **`Cites`:** the ratified source the row answers to — a requirement id, a decision record, a gate
  id. The planner fills it; the reviewer confirms each one resolves. A row citing nothing is a row
  nobody can check. Pair this with a checker that resolves every id in a recognised scheme against
  your oracles and reports prose citations as *not-evaluable* rather than pretending it read a PDF:
  an unchecked citation is just a more confident-looking invention, and failure mode 3 of this kit
  is invented facts.
- **Test-seed / evidence:** before work — the failing test(s) to write first (from the plan);
  after — the test file path(s) proving the row. A `DONE` row without named tests is invalid. An
  `IC-n` row closes only with what covers it named.
- **Read rows, not the board.** Seats read their rows with
  `node scripts/ledger-row.mjs board <key> <ROW…>`, which prints each row with its section and real
  header — a row read without its header is a row read without its meaning.
- **`IN-PROGRESS` is flipped before the work, not after.** The board is a live signal or it is a
  log; only one of those is worth reading mid-session. Keep the `phase:status` block current at
  every gate.
- **Finish gate:** every row ends `DONE`, `DROPPED` (reasoned), or `DEFERRED→<id>` with a matching
  row in the deferred registry. The module reviewer treats any divergence as a blocker.
- Deferral details live in the registry (`DEFERRED_TASKS.md`) — the board only cross-links by id.
- **Earned DONE:** at close-out the orchestrator re-opens each DONE row's evidence and confirms
  the assertion entails the claim (see the pipeline skill's Finish section). Failing rows become
  `DEFERRED→<id>` — never a DONE with a caveat in prose.
