# stock-levels — build plan

## 0. Track

ADDITIVE

## 1. Context

Adds reorder alerts to the inventory service.

## 2. Interfaces

| Method | Path | Access key | Handler |
|---|---|---|---|
| GET | /stock/{sku} | `stock.read` | app/stock.py |
| POST | /stock/{sku}/reorder | `stock.reorder` | app/stock.py |

## 3. Tasks

| # | Task | Cites | Test-seed |
|---|---|---|---|
| T1 | reorder level per item | D-1 | tests/test_stock.py::test_reorder_level |

## 4. BLOCKERS

### DECIDED-FROM-DOCS

none

### NEEDS-RULING

none

### BLOCKING

none
