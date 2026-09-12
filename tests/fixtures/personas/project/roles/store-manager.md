# Store Manager — role profile

_Drafted around the generated blocks; the blocks themselves are stale on purpose (the catalogue gained a key)._

## Seeded login

<!-- generated:login start -->
- `manager@example.test` · scope `Store` — seeded at `test/seed.ts:12`
<!-- generated:login end -->

## Keys held (3)

<!-- generated:keys start -->
- `stock.read` — Read stock levels
- `stock.adjust` — Adjust stock, with a reason
- `report.export` — Export the stock report
<!-- generated:keys end -->

## Scope rules

- Holds every store in the region, never another region — RULE-4

## Separation-of-duties limits

1. May not approve an adjustment they raised — `docs/rules.md:31`

## Abuse goals — hunting prompts, never rulings

- Raise an adjustment as clerk, approve it as manager in the same session — RULE-7
