# stock-levels — decisions taken from the docs

## D-1 — reorder levels are per item

Items move between warehouses, so a per-warehouse level would reorder twice.

## D-2 — counts are read live

A cached count caused a double reorder.
