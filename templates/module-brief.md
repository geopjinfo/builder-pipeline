# Module build-brief template (`build-module-pipeline`)

The canonical brief for building **one** module through the pipeline. Fill the `<…>` placeholders
from the project's sources, delete any inapplicable line, and pass the result to the pipeline.

**Why this template exists:** every module needs the same decisions made up front — boundary fork,
exact catalogue keys, access-scope shape, dependency fallbacks — and the same close-out (tests
green, auditors clean, handoff table). Every historical escaped defect in the source project traced
to a skipped line of this brief.

**Golden rules baked in (never negotiate):** never edit a protected path (profile §4) without the
human's explicit grant; never invent an oracle entry (§3); replicate the template shape (§5);
run the full integration tier before merge if the default gates exclude it; agents never edit
forbidden doc paths — changes there ride the handoff table.

---

## The template

> **Prompt — `build-module-pipeline`: `<MODULE_KEY> — <Title>`**
>
> Build `<MODULE_KEY>` through the full pipeline (planner → coder → tester → standards+security+vuln
> auditors → docs → reviewer, gate-fail loop). **Wave/priority:** `<…>`. **Why now / unblocks:** `<one line>`.
>
> **1. Scope (planner grounds):** requirements `<ids / spec §s>`, tracker row(s) `<id>`.
> Data: `<schema/tables/collections>`. Confirm fields against `<ERD / data spec>`.
>
> **2. Boundary decision (settle FIRST):** clean domain module, or does it need an edit to a
> protected path (new port / core hook / shared seam)? If yes → planner **flags the unlock decision
> for the human; revert the unlock after merge.** If no → state "domain-only, no unlock."
>
> **3. Interfaces:** `<routes/endpoints/handlers>` — per API conventions (profile §6); state
> transitions are explicit named operations, never a generic status patch.
>
> **4. Catalogue keys (verbatim from the oracles, profile §3 — NEVER invent; if a needed key is
> missing, STOP and flag an amendment):** `<keys>` → map each interface to its exact key.
>
> **5. Access scope:** scope-bearing? If yes → derive the per-role rule from the grants +
> requirements; wire the project's scope mechanism + its manifest/matrix entries; out-of-scope
> reads behave per profile §6 (no existence leak); client-supplied scope filters are overridden
> server-side. If unscoped (admin-global) → say so explicitly.
>
> **6. Dependency / deferred fallbacks:** depends on an unbuilt module or capability? Build what
> this module owns; gate the dependent transition with `<the project's "not yet available"
> rejection or a documented fallback>`. **Document, don't fake.** Register deferrals in the
> deferred registry.
>
> **7. Workflow:** `<states/transitions from the workflow oracle>` — double-gated (permission +
> legal-transition check). Or "none."
>
> **8. Contracts checklist:** the profile §6 cross-cutting contracts apply in full — enumerate any
> module-specific notes here (money handling, localized fields, special envelopes…).
>
> **9. Security-audit focus:** `<this module's sensitive surface — scope/IDOR, PII, exports,
> money, credentials, file handling>`.
>
> **10. Tests (TDD):** the coder writes each task's seeded failing test FIRST (red → green; seeds
> from the plan's Test-seed column), the tester then verifies + extends adversarially. Tiers per
> profile §9, plus module-specific cases: `<list>`.
>
> **11. Definition of done:** gates + integration green; `module-readiness-check` clean; all three
> auditors + `module-reviewer` **MERGE-READY**; task board fully closed (DONE / DROPPED /
> DEFERRED→registry-id); version bump + changelog entry on the branch. Commit on
> `<branch convention>`; **do NOT merge** — the human reviews, merges, tags, reverts any unlock.
>
> **12. FINAL — handoff table (REQUIRED in the report):** agents cannot edit `<protected doc
> paths>`. Output a table — every human-only change this module implies. Columns: **File · Where
> (row/section) · What → to-what · Why · Context (exact values to fill)**. Must cover at minimum:
> - tracker/status flips for this module's rows;
> - any architecture-decision record the design warrants (a boundary/scope/fallback decision that
>   diverges from a spec);
> - any catalogue amendment — only if a required key was missing (the module must have STOPPED
>   rather than invented it); list the exact rows to add.

---

## Close-out (human-owned, after MERGE-READY)

1. Run gates + the full integration tier on the merged result.
2. Merge per project convention; tag the version; regenerate clients if the schema changed.
3. Revert any protected-path unlock (re-arm the guardrail).
4. Apply the module's handoff table in the doc workspace/tracker.
5. Record notable rulings somewhere durable (decision log / memory) so the next brief inherits them.
