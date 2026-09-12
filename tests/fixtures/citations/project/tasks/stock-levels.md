# stock-levels — task board

| Row | Task | Cites | Test-seed | Status |
|---|---|:--|---|---|
| T1 | On-hand per location | `STK-001` | levels.test.py::on_hand | DONE |
| T2 | Reorder point per location | STK-002 · REG-001 | levels.test.py::reorder | DONE |
| T3 | Refuse a negative adjustment | **REG-002**, `stock.adjust` | adjust.test.py::negative | DONE |
| T4 | Transfer in one transaction | stk-004 + INV-2 + stock.transfer | transfer.test.py::atomic | IN-PROGRESS |
| T5 | Movement sum holds `a \| b` | INV-1; spec §2.3 | levels.test.py::sum | PLANNED |
| T6 | Board housekeeping | — | — | PLANNED |
| T7 | Read the notes file | stock.md | — | PLANNED |

## Notes

A second table with no Cites column: its third cell is not a citation.

| Item | Owner | Detail |
|---|---|---|
| handover | stock team | STK-999 is not a citation here |
