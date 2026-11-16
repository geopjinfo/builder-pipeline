pack orders:
  journey "a customer places an order":
    ── happy path ────────────────────────────────
    REQ-003: the order total is the sum of its lines
    ── refusals (the point) ──────────────────────
    assert  REQ-002  a second order with the same reference is refused
    REQ-004 [by-design rulings/R-2.md]: a cancelled order is archived, not refused
    REQ-005 [known-gap]: the "no history attached" clause is unenforced
    REQ-006 [skipped]: lockout — rate limit reached; throttled, not refused

Note: REQ-001 is covered by the unit tests, so this pack has no step for it.
