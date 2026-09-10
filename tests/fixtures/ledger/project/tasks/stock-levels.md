# stock-levels — build board

## P2 — Code

| # | Task | Cites | Status | Test-seed / evidence | Notes |
|---|---|---|---|---|---|
| T1 | reorder level per item | D-1 | DONE | tests/test_stock.py | |
| FIX-1 | the quantity check is missing on the reorder route | — | DONE | tests/test_api.py | |
| FIX-2 | FIX-1 was incomplete — the bulk route still skips the check | — | DONE | tests/test_api.py | |
| FIX-3 | same shape as FIX-1, on the export route | — | DONE | tests/test_export.py | |
| FIX-3a | follow-on to FIX-3 itself | — | DONE | tests/test_export.py | |
| FIX-4 | re-opens FIX-2: the export route never got the bulk check | — | DONE | tests/test_export.py | |
