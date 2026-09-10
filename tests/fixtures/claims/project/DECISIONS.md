# DECISIONS — rulings log

| Id | Date | Module/scope | Decision | Why (one line) | Full ADR |
|----|------|--------------|----------|----------------|----------|
| D-1 | 2026-01-20 | stock-levels | reorder levels are per item, not per warehouse | items move between warehouses | — |
| D-2 | 2026-01-28 | stock-levels | stock counts are read live on every request | a stale count caused a double reorder | — |
