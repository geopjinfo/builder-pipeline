---
name: ledger-audit
description: Use to audit the project's claim ledgers — task boards, the deferred registry, trackers, and README/status prose — for status claims not earned by their cited evidence (a DONE whose proof asserts something adjacent), vacuous assertions, partial acceptance-criteria coverage, cross-ledger drift, and stranded handoffs. Read-only. Trigger on "ledger audit", "are our DONEs real", "find unearned status", or at module close-out.
---

# Ledger audit — hunt unearned status

Read-only audit of the project's **claim ledgers**: task boards (`tasks/*.md`), the deferred
registry (`DEFERRED_TASKS.md`), any tracker files the profile cites, and status prose in READMEs
and changelogs. You are not reviewing code quality — you are checking that every **status claim**
is entailed by its cited evidence. Load `PIPELINE_PROFILE.md` first if present (§11 names the
ledgers).

Scope: a single module (`ledger-audit <moduleKey>` — cheap; run at every close-out) or the whole
repo (batch by ledger; accumulate findings into `audits/ledger-audit.md`).

## What to check, per claim

1. **Entailment.** Open the cited evidence (test file, commit, doc). Does the assertion prove
   *the claim itself* — not something adjacent? The three named failure shapes:
   - **Absence proof for a presence claim** — evidence proves the module *doesn't* do a related
     forbidden thing; the row claims it *does* do the feature.
   - **Gate compliance standing in for delivered behaviour** — "lint/arch gate passes" ≠ "the
     feature works".
   - **Unit tested but never wired** — direct coverage on a component no real entry point reaches.
2. **Positive controls.** Any evidence that is a negative assertion (`[]`, `not.toContain`,
   `toBeNull`) must carry a positive control on the same fixture — otherwise it proves nothing.
3. **Full acceptance coverage.** Re-read the row's acceptance text. Multi-clause criteria joined
   by `;`/`and` are where partial delivery hides — one clause of three met is not DONE.
4. **Cross-ledger consistency.** Every `DEFERRED→<id>` has a live registry row and vice versa;
   statuses use each ledger's exact vocabulary (an out-of-vocabulary value is silently dropped by
   whatever counts rows); no stranded handoff (a "human will apply X" note with no owner or
   tracker row).
5. **Vacuous or self-referential proof.** Evidence that merely restates the claim, cites a file
   that doesn't exist, or cites a test that could not fail.

## Rules

- Read-only — report, never fix. Every finding: `{ ledger row, claim, cited evidence,
  why it fails (which shape), minimal correction }`.
- Verify before you accuse: open the evidence; a finding without an opened citation is itself
  unearned status.
- A failing DONE's correction is `DEFERRED→<new registry id>` (with a real registry row) or
  reopening the row — never "DONE with a caveat in prose".

## Output

Ranked findings (claims that mislead > drift > hygiene), counts per ledger, and the exact row
edits to make. If everything holds, say so plainly — a clean audit is a valid result.
