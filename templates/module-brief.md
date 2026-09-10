# Module build-brief template (`build-module-pipeline`)

The canonical brief for building **one** module through the pipeline. Fill the `<…>` placeholders
from the project's sources, delete any inapplicable line, and pass the result to the pipeline.

**Why this template exists:** every module needs the same decisions made up front — boundary fork,
exact catalogue keys, access-scope shape, dependency fallbacks — and the same close-out (tests
green, auditors clean, handoff pack). Every historical escaped defect in the source project traced
to a skipped line of this brief.

**Golden rules baked in (never negotiate):** never edit a protected path (profile §4) without the
human's explicit grant; never invent an oracle entry (§3); replicate the template shape (§5);
run the full integration tier before merge if the default gates exclude it; agents never edit
forbidden doc paths — changes there ride the handoff pack.

---

## The template

> **Prompt — `build-module-pipeline`: `<MODULE_KEY> — <Title>`**
>
> Build `<MODULE_KEY>` through the full pipeline (planner → coder → tester → standards+security+vuln+
> invariant auditors → docs → reviewer → behavioural gate, gate-fail loop). **Wave/priority:** `<…>`.
> **Why now / unblocks:** `<one line>`.
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
> **11. Definition of done:** gates + integration green; `module-readiness-check` clean; all four
> auditors + `module-reviewer` **MERGE-READY**; the behavioural-gate result recorded; task board
> fully closed (DONE / DROPPED / DEFERRED→registry-id); version bump + changelog entry on the
> branch; the handoff pack written and passing its check. Commit on `<branch convention>`; **do NOT
> merge** — the human reviews, merges, tags, reverts any unlock.
>
> **12. FINAL — the handoff pack (REQUIRED, a FILE — not a table in the report):** agents cannot
> edit `<protected doc paths>`. At close-out the orchestrator generates and fills ONE file,
> `<handoffs>/<date>-<MODULE_KEY>-handoff.md` (`paths.handoffs`):
> `node scripts/handoff-pack.mjs <MODULE_KEY> --base <ref>`, then
> `node scripts/handoff-check.mjs <handoffs>/<date>-<MODULE_KEY>-handoff.md`. Every item carries a
> `RESPONSE REQUIRED` line. Sections:
> - **§A progress** — commit, version, verdict, board rows done / deferred / dropped, tier results,
>   behavioural-gate result.
> - **§B tracker flips**, split **pre-merge / post-merge** — exact row ids and values, every value
>   from the tracker's own vocabulary (`features.handoffPack.tracker`; write
>   `tracker: not configured` when the project keeps none).
> - **§C decisions** — every decision recorded this run, in-session human rulings to declare,
>   `NEEDS-RULING` items.
> - **§D registry** — deferred-registry rows added / closed / moved.
> - **§E docs** — every change to a protected doc path; any architecture-decision record the design
>   warrants (a boundary/scope/fallback decision that diverges from a spec); any catalogue amendment
>   — only if a required key was missing (the module must have STOPPED rather than invented it),
>   with the exact rows to add; the contract diff.
> - **§F merge conditions** and the tag.
>
> The report may summarise the pack; it never replaces it.

---

## Close-out (human-owned, after MERGE-READY)

1. Run gates + the full integration tier on the merged result.
2. Merge per project convention; tag the version; regenerate clients if the schema changed.
3. Revert any protected-path unlock (re-arm the guardrail).
4. Apply the module's handoff pack (§A–§F) in the doc workspace/tracker, answering each
   `RESPONSE REQUIRED` line — tracker flips, decision records, catalogue amendments.
5. Record notable rulings in the decision workspace (`paths.decisions`) so the next brief inherits
   them.
