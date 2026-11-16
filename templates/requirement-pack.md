# Template — requirement pack

One pack per module. Authored **REQ-first, never endpoint-first**: start from what the business
asked, not from what the API happens to expose. The refusals are the point — a passing create
proves routing; a refused one proves a rule.

## Before writing a line, read four things

| Source | For |
|---|---|
| The module's requirement rows | the rules to assert, verbatim (with `features.specAuthoring` on: its ratified spec; `spec-check <module> --pack` prints this pack's skeleton from it) |
| Its section in the spec/BRD | intent behind the rule |
| Its state machine | which transitions are legal — the rest must be refused |
| **The deferral registry** | what is knowingly NOT built |

Skipping the fourth produces **false defects**, which is worse than no pack: it trains people to
ignore the report.

## The four verbs

| Verb | Use when | Behaviour |
|---|---|---|
| `assert` | the requirement holds as written | fails if not |
| `by-design` | requirement text and intended behaviour diverge, and the divergence is **documented** | asserts the INTENDED behaviour; **carries the citation in the step name** |
| `gap` | genuinely unenforced, and that is known | records the observed behaviour, never fails |
| `skipped` | could not run (fixture missing, throttled, needs another module) | records the reason |

A step name should read as a sentence a non-engineer can judge:

```
REQ-005: a second user with the same email is refused
REQ-013 [by-design <ruling ref>]: the seeded set is per-wave, not the range the requirement names
REQ-008 [known-gap]: the "no history attached" clause is unenforced
REQ-004 [skipped]: lockout — rate limit reached; throttled, not refused
```

## Shape

```
pack <module>:
  journey "<business flow, named as a person would say it>":
    ── happy path ────────────────────────────────
    assert  REQ-…  the thing the business asked for succeeds
    ── refusals (the point) ──────────────────────
    assert  REQ-…  the same actor lacking the permission is refused
    assert  REQ-…  a value outside the allowed set is refused
    assert  REQ-…  an illegal transition from this state is refused
    assert  REQ-…  an unproven cross-context reference is refused
    ── effects (a 2xx proves routing, not behaviour) ──
    assert  REQ-…  the transition wrote its audit entry
    assert  REQ-…  the event fired / the version advanced
    assert  REQ-…  history survives the revert
```

## Rules

- **Never poison a shared fixture.** An admin password reset can make a seeded persona
  permanently unloginable, and every later scenario then looks broken. Snapshot and restore in a
  `finally`, or use a throwaway.
- **Assert the refusal reason, not just the refusal.** "Refused" and "refused with the wrong
  error" are different facts; so are "refused" and "throttled".
- **Every claim names its evidence.** A pack that passes without asserting an effect has proved
  the route exists, nothing more.
- **Prove the precondition.** Before asserting history survives a delete, assert there WAS history
  — otherwise the check passes on an empty set.
- Packs run on every transport tier unmodified. A result that differs between tiers is a finding.
