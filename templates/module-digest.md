# Template — module digest

One per bounded context. Copy to wherever your audit reads them from (`digests/<module>.digest.md`
is the shape proven in production; the format matters more than the path).

## What a digest is for

The structural sweeps — global invariants, reflexivity, hostile input — know that a route *exists*
and that a caller can be its own target. They do **not** know what a *payment* means, that one
module routes directly while every sibling routes through an engine, or that removing a user
strands the approval task they own. Those questions need a model of the module, and that model is
what a human QA tester carries in their head when they invent good adversarial scenarios.

A digest writes it down so it can be reviewed, reused, and turned into stories.

## The rule that shapes the file: split by volatility

```
┌─ AUTHORED (frozen judgement) ──────────────────────┐
│  front matter: aggregates, actor-relative           │
│  semantics, cross-module assumptions, candidates    │
├─ MARKER ───────────────────────────────────────────┤
│  GENERATED (rewritten from the repo every run):     │
│  transitions, illegal pairs, routes, requirements,  │
│  declared effects                                   │
└────────────────────────────────────────────────────┘
```

Everything below the marker is derivable, so **derive it**. A hand-copied transition table is wrong
the first time someone adds a transition, and a digest that is trusted and wrong is worse than no
digest. Make staleness a gate (`<digest command> --check` in your gate chain), exactly as you do
for contract and effect drift.

## Template

```yaml
---
module: <module key>
trackerKeys: [<REQ prefixes this module owns>]
purpose: <one line — what this bounded context is for>
scope: <how scope/tenancy narrows reads and writes here, or why it does not>
aggregates:
  - name: <Aggregate>
    states: [<state>, <state>]
    softDelete: <true|false>
    hardDelete: <true|false>
    notes: <what a tester must know — e.g. which states are reachable only by the system>
selfTargetable:
  - route: <METHOD /path/{id}/verb>
    why: <why the path id can be the caller's own>
    invariant: <registry id, if one exists>
crossModule:
  - <what this module assumes of, or publishes to, a neighbour — especially by-key references
     with no foreign key, because nothing tells this module when the target disappears>
invariantCandidates:
  - id: <MOD>-IC-1
    statement: <written as an assertion, so it reads as a test name>
    axis: <reflexive|system-safety|wrong-actor|wrong-time|lifecycle|interleaving|cross-module|identity-abuse>
    status: <OPEN|covered|needs-ruling>
    coveredBy: <REQUIRED when covered — name the pack/probe/story>
    rationale: <why it might NOT hold; cite file:line, ADR, or requirement id>
---

# <MODULE> — <Name>

<2–4 paragraphs: what makes this module unusual to test, where its neighbours can hurt it, and
which of its properties a declaration-derived suite structurally cannot reach.>
```

## Rules

- **`covered` MUST name what covers it.** An uncited `covered` is an unfalsifiable claim — the
  exact shape of unearned status. Validate it mechanically.
- **`rationale` must add information.** Restating the statement in other words is worthless; cite
  the line of code, the ADR, or the requirement that makes the candidate plausible.
- **Aim for 8–14 candidates**, spread across several axes. A digest whose semantic pass produced no
  candidates is almost certainly unfinished, not clean.
- **`OPEN` is the valuable output**, not a failure. It is the story-authoring worklist.
- **Never invent a rule here.** If the correct behaviour is genuinely undecided, the status is
  `needs-ruling` and it goes to a human — not `OPEN` with a guessed expectation.

## Generating it

Model cost belongs to the authored half only, and only when the module drifts. Everything below the
marker is a deterministic render of what your repo already knows. That is the same
generate → freeze → reuse economics the requirement packs use: pay once per module, replay free.
