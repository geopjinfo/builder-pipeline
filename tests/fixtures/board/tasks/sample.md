# Sample module — build board

_Started: 2026-01-05 · Track: **FULL** · Branch: `feat/sample` · Plan: .pipeline/sample/plan.md_
**Scope:** stock adjustments · **Unlock:** none

<!-- phase:status start -->
| Phase | Seat | Status | Artifact | Verdict |
|---|---|---|---|---|
| P1 Plan | module-planner | DONE | .pipeline/sample/plan.md | 0 blocking |
| P2 Code | module-builder | **DONE** | — | — |
| P4 Audit | security-auditor | IN-PROGRESS | — | — |
<!-- phase:status end -->

<!-- progress:auto start -->
| Batch | Progress | Done | Doing | Total |
|---|---|---|---|---|
| P2 — Code | `▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░` 67% | 4 | 1 | 6 |
| P4 — Audit | `▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░` 50% | 1 | 0 | 2 |
| **TOTAL** | `▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░` **63%** | **5** | **1** | **8** |
<!-- progress:auto end -->

## P2 — Code

| # | Task | Cites | Status | Test-seed / evidence | Notes |
|---|------|-------|--------|----------------------|-------|
| T1 | Add the adjustment endpoint | spec §2 | DONE | tests/unit/test_adjust.py | |
| T2a *(split from T2)* | Validate the quantity | spec §3 | **DONE** | tests/unit/test_qty.py | |
| T2b | Reject negative stock | spec §3 | IN-PROGRESS | — | |
| C1 | Carried candidate | — | DROPPED | — | deferred again |
| D3-a | First half of a deferral | — | DEFERRED→REG-D3 | tests/unit/test_half.py | |
| D3-b | Second half of a deferral | — | PLANNED | — | |

## P4 — Audit

| # | Task | Status | Notes |
|---|---|---|---|
| FIX-1 | Escape the \| in reason text | DONE | from the review |
| IC-1 | Stock is never negative | PLANNED | invariant candidate |

## Todo

- [x] Open the run log
- [ ] Render the page

## Definition of Done

| Batch | Done when |
|---|---|
| P2 | every row settled and its test named |

## Modules & endpoints

| Module | Endpoints |
|---|---|
| inventory | POST /adjustments |

## Deferred this cycle
- REG-D3 — the second half waits on the stock service — mirrored in DEFERRED_TASKS.md
