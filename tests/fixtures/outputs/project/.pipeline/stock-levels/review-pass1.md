# stock-levels — review pass 1

## Verdict

**CHANGES-REQUIRED** — one blocker: a negative minimum yields a negative reorder level.

## Readiness

Readiness checklist: 12 items — 11 passed · 1 failed · 0 N/A.

## Requirement traceability

| Requirement | Where implemented (`file:line`) | Where tested (`file:line`) | Aligned? |
|---|---|---|---|
| reorder level per item | `app/stock.py:2` | `tests/test_stock.py:4` | yes |

## Invariant candidates

none

## Findings (ranked)

### B-1 · BLOCKER · `app/stock.py:3` — a negative minimum yields a negative reorder level

Opened app/stock.py:3 — `item.minimum * 2` with no lower bound.

### N-1 · NIT · `app/stock.py:6` — name the reserved-stock rule

## Loop-back list

1. FIX-1 — `app/stock.py:3` · clamp the minimum at zero.

## Merge conditions

none
