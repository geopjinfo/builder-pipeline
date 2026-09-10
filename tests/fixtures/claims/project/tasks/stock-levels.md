# stock-levels — build board

_Plan: runs/stock-levels/plan.md_

## P2 — Code

| # | Task | Cites | Status | Test-seed / evidence | Notes |
|---|---|---|---|---|---|
| T1 | reorder level per item | D-1 | DONE | `app/stock.py:2 «def reorder_level»` | |
| T2 | supplier lead time | — | DEFERRED→STK-D1 | — | the lead-time source is owed: STK-D1 |

## Notes

- The stale "stock counts are cached" note is gone; counts are read live.
- The unit count is re-run from the claims file.
- The alert wording is owed to the decision workspace — see DECISIONS.md.
