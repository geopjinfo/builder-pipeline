---
name: module-readiness-check
description: Use before opening any module PR or when asked to verify a module is "ready", "done", or "meets the bar". Runs the project's Definition-of-Done as a tracked checklist, reporting pass/fail per item with file evidence. Trigger on "is this module ready", "run the readiness check", "DoD check", before merge.
---

# Module readiness check

> **Template skill — extend per project.** The checklist below is the project-independent core.
> During unpacking, add the project's own checklist items from `PIPELINE_PROFILE.md` §5–§10 (and
> any Definition-of-Done doc the profile cites) so this file becomes the single binding bar.
> Checks must be concrete enough to verify with grep/read/run — a check nobody can falsify is
> decoration.

Create one tracked todo per check; mark each pass/fail with concrete file evidence
(path + line). **Do not claim ready until every item passes** — report failures honestly with
the offending location.

## Boundary & shape

- [ ] Module replicates the template shape (profile §5); registration contract fully implemented.
- [ ] No edits to protected paths (§4); no reach-ins past other modules' published facades;
      boundary rules (§5) hold (no forbidden cross-module data access).
- [ ] Public facade exports only the intended API — no internals/entities leaked.
- [ ] File/module headers state the module's **actual live posture** — no stale copied claims.

## Interfaces & authorization

- [ ] Every interface declares exactly the prescribed authorization (one key, per §6), and every
      key exists **verbatim** in its oracle (§3) — no invented keys.
- [ ] Scope semantics per §6 (order of checks; out-of-scope behaviour; no existence leak).
- [ ] API documentation carries the required annotations (§10 invariants).

## Reliability contracts (§6)

- [ ] Idempotency on mutating interfaces; the critical set enforces it as required.
- [ ] Concurrency guard on aggregate writes (stale write → the prescribed rejection), including
      destructive writes (delete/soft-delete are version-guarded too).
- [ ] Workflow transitions are explicit named operations (never a generic status patch),
      double-gated, using exact oracle state names.
- [ ] Events versioned; no external I/O inside transactions; side effects via the prescribed
      async mechanism; one audit entry per transition.

## Data, validation, security

- [ ] Data conventions (§6): money/decimal, timestamps, state columns, localized text, naming.
- [ ] Boundary validation everywhere, unknown fields rejected; every path/query param validated;
      no banned raw-query APIs; output DTO-mapped.
- [ ] No secrets/PII in logs beyond the §6 allowance; §7 credential/session invariants hold.
- [ ] Migrations backward-compatible; seeds idempotent.

## Tests (§9)

- [ ] Full suite green: typecheck + unit + **integration on real infrastructure** + coverage
      thresholds (run integration explicitly if the default gate excludes it).
- [ ] Access matrix (interface × role) asserted; resource bounds (N+1 / page caps) asserted;
      forced-failure rollback test exists and passes.
- [ ] Absence assertions carry positive controls (the tester's positive-control rule).
- [ ] **Spec trace** — every requirement id the module declares has a test or a requirement-pack step
      (`assert` · `by-design <cite>` · `gap` · `skipped`): run `npx --no-install builder-pipeline run spec-trace-check <requirements>`;
      an `UNTRACED` id fails this item. Feature off → record `specTrace: not configured` (not a pass).

## Repo hygiene

- [ ] No hard hygiene finding since base: `npx --no-install builder-pipeline run hygiene --since <base> --json` has no `hard`
      check (no secret, no assistant or scratch file, no attribution trailer or identity). Feature off → record
      `hygiene: not configured` (not a pass).
- [ ] Completion gate: `npx --no-install builder-pipeline run hygiene --gate --since <base>` — record `completion gate: PASS`,
      `FAIL` (one FIX row per failing gate; not ready) or `not configured` (no gate check is on; not a pass).

## Ledgers (§11)

- [ ] Task board rows all closed (`DONE` with test evidence / `DROPPED` reasoned /
      `DEFERRED→<id>` with a live registry row).
- [ ] Deferred registry updated (entries added; unblocked rows flagged; review date bumped).
- [ ] Version bump + changelog entry present per §11.
- [ ] Module README documents boundary, aggregates, published API, events.

## Output

Report: total / passed / failed, with `file:line` evidence per failure. Any failed item ⇒ the
module is **not** ready; list the minimal fixes.
