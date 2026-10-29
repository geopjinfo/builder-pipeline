---
name: scaffold-module
description: Use when adding or scaffolding a new module/feature slice — the golden-path replication recipe. Copy the project's template module, wire its layers and cross-cutting contracts per PIPELINE_PROFILE.md, and verify against the boundary rules. Trigger on "add a module", "scaffold <X>", "build the <X> module".
---

# Scaffold a module (golden-path replication)

> **Template skill — extend per project.** This file carries the project-independent recipe
> skeleton. During unpacking (or on first use), append the project's concrete idioms from
> `PIPELINE_PROFILE.md` §5–§7 as a "Project idioms" section: the exact layering calls, the DI
> style, the named reference files to copy. A scaffold skill earns its keep through specifics —
> the profile holds them; this recipe orders them.

The architecture is designed once; every module **replicates the template's shape exactly** —
do not invent a new shape (a weak pattern gets replicated N times). Protected paths (profile §4)
are never edited to add a module.

## 0. Ground the module in the decided scope (read first, don't guess)

- **Backlog / requirements:** pull this module's requirement cluster, interfaces, and catalogue
  keys from the requirements oracle (profile §3).
- **Catalogues:** every authorization key, error code, and workflow state you use must already
  exist in its oracle. **Never invent an entry** — stop and flag if one is missing.
- **Specs:** the boundary/architecture docs the profile cites. Locate via indexes; verify against
  source.

## 1. Scaffold

1. Copy the template module (profile §5) to the new module's location (follow the naming
   convention).
2. Implement the module's registration contract completely — every hook the template defines
   (permissions, routes, migrations, events, settings…), even if empty.
3. The platform/host discovers it by convention — **no edit to protected core paths**.
4. **In the same scaffold commit, update every check that counts modules.** A new module folder
   on its own can turn a gate red before any behaviour exists: an oracle that lists every module's
   namespace (audit actions, permission prefixes, rosters it feeds), or a fingerprint/baseline that
   records the module count. Add the new entry to each such oracle and re-baseline each such
   fingerprint here, not in a later row — and say in the commit and the board row's Notes that the
   **count** moved, not a behaviour, so a reviewer does not read the re-baseline as an unexplained
   drift. List the project's module-counting checks in the "Project idioms" section.

## 2. Build the layering (profile §5 — treat as enforced, not advisory)

Follow the profile's layering rule exactly. The generic invariants:

- Each layer does only its job; the presentation layer never touches the data layer directly.
- Business rules live in their designated pure, unit-testable home — never inline in
  services/controllers.
- One business operation = one transaction, opened only where the profile allows.
- Time, randomness, and other ambient effects are injected, never called inline in business code.
- Public API of the module goes through its published facade only; internals stay private.

## 3. Apply the cross-cutting contracts (profile §6 — byte-identical in every module)

Errors · validation (unknown-field rejection) · pagination envelope + caps · idempotency on the
critical set · concurrency guards on aggregates · versioned events with the prescribed async
side-effect mechanism · audit entries · authZ per interface (exactly one key, from the oracle,
scope semantics per profile) · data conventions (money, timestamps, localized text, naming).

For each profile §7 invariant, **copy the named reference implementation.**

## 4. Data

The module's own schema/tables per the boundary rules (no forbidden cross-module references);
migrations backward-compatible; seeds idempotent.

## 5. Tests

Tests arrive through the TDD loop (seed → red → green per board row), never as a test-after
phase. Cumulatively the suite must cover the profile §9 tiers: unit on business rules,
integration on real infrastructure, the access matrix, resource bounds, and the forced-failure
rollback case.

## 6. Verify

Run the profile §2 gate + integration commands. Then run the `module-readiness-check` skill and
resolve every failure before calling the scaffold done.
