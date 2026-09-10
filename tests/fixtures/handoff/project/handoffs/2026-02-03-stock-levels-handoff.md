# stock-levels — handoff pack

**From:** `3f9a1c2` · v0.4.0 · base `main` · generated 2026-02-03 by `node scripts/handoff-pack.mjs`

## §A progress

RESPONSE REQUIRED: none needed

- Commit `3f9a1c2`, version v0.4.0, reviewer verdict **MERGE-READY**.
- Board rows: 3 DONE · 1 DEFERRED · 0 DROPPED · 0 still open.
- Tiers (last result per gate from the run log): unit pass (41/41) · integration pass (12/12).

## §B tracker flips

RESPONSE REQUIRED: none needed

No tracker flips — tracker: not configured

## §C decisions

RESPONSE REQUIRED: non-blocking

- `D-1` — reorder levels are per item, not per warehouse.
- In-session rulings to record: none.

## §D registry

RESPONSE REQUIRED: none needed

- added `STK-D1` — supplier lead times wait on the purchasing module.

## §E docs

RESPONSE REQUIRED: non-blocking

- Interface / contract change: `POST /stock/{sku}/reorder` added.

## §F merge conditions

RESPONSE REQUIRED: none needed

- Merge conditions: none.
- Tag: v0.4.0.
