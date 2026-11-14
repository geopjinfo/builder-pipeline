# Template — session board (cross-run delivery board)

The kit's `templates/task-board.md` covers **one pipeline run**. This one covers a **delivery**: a
client preview, a release, a remediation programme — several runs that have to be tracked together
while they are in flight.

**Why the bar is computed.** A hand-maintained progress bar is a claim nobody re-derives: the rows
move and the bar does not, and the board then reports last week's number with this week's authority.
The `board-progress` script makes it a *projection of the Status column* and rewrites only the block
between the markers. `board-check-all` fails the gate on any stale board. The first time
that pair ran in the source project it found a board reading **0% while sitting at 8 of 12 done**.

Wire both into the gate chain (profile §8):

```
node scripts/board-progress.mjs <board>            # rewrite the block
node scripts/board-progress.mjs <board> --check    # exit 1 if stale
node scripts/board-check-all.mjs                   # every marked board, CI-friendly
node scripts/board-check-all.mjs --fix             # rewrite instead of failing
```

**Counted sections** are `## B<n> — <title>` (a delivery board's batch, one branch per batch) or
`## P<n> — <title>` (a build board's phase). Everything else is prose and is not counted. Boards
named `_*.md` and `README.md` are skipped, so a template can carry the markers without being
counted — otherwise the checker writes a fabricated bar into your documentation.

---

```markdown
# <DELIVERY> — <what this board delivers>

_Source: <the request/spec this answers> · Target date: <date>_
_**Binding authority: <the ruling/spec document>** · <the requirement rows this traces to>_

**Scope:** <modules / areas in play>

**How this board is run.** Every batch is one branch cut off `<base>`, built through the pipeline,
ending MERGE-READY. Bars are recomputed by the command below — never hand-edit the block between
the `progress:auto` markers.

<!-- progress:auto start -->
<!-- progress:auto end -->

**Statuses:** `PLANNED` · `IN-PROGRESS` · `DONE` · `DEFERRED→<registry-ID>` · `DROPPED` (reason in
Notes). A `DONE` row without named evidence is **invalid**. `IN-PROGRESS` is flipped **before** the
work, not after — a status written afterwards is a log, not a signal.

---

## Plan on a page

| Order | Batch | Branch | Starts when | Unblocks |
|---|---|---|---|---|
| 1 | **B1** <title> | `<branch>` | <gate> | <what it lets start> |

## B1 — <title>

| # | Task | Cites | Status | Test-seed / evidence | Notes |
|---|------|-------|--------|----------------------|-------|
| T1 | <task> | <REQ / ADR / gate id> | PLANNED | <failing test first> | |

## Deferred this cycle
- <REGISTRY-ID> — <task> — mirrored in the deferred registry
```

## The `Cites` column earns its width

Failure mode 3 of this kit is **invented facts**. A citation is the defence against it — and an
*unchecked* citation is just a more confident-looking invention, since `REQ-014` reads exactly
like `REQ-004` and only one of them exists. Pair this template with a checker that resolves
every id in a recognised scheme against your oracles, and reports prose citations as
**not-evaluable** rather than pretending it read a PDF.

The other half of the case is retrieval: in one adopting project, **most escalations to a
human were already answered by the requirement register.** Making every row name its source is how
that gets noticed before the escalation instead of after it.
