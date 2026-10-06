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

## Run scope — what a close-out audit reads

A pipeline run is audited **once, at close-out, before the final reviewer**. Read only what the run
touched — the registry, trackers and accumulated audit file grow with every run, and reading them
whole on every close-out is where this skill's cost goes:

- **Board:** `tasks/<key>.md` — every row.
- **Registry and trackers:** only the rows the board names (deferral ids, requirement ids), found
  with `grep -n`. Never read either file whole.
- **Prose:** only files in the run's `git diff --name-only <base>..HEAD`. Untouched prose is a
  whole-repo audit's job.
- **Accumulated findings:** never read `audits/ledger-audit.md` whole — grep for an earlier section
  on this key and read only that.

Record the audited commit in the section header (`audited-at <short-sha>`). On a re-run before
merge, audit only rows changed in `git diff <audited-at>..HEAD -- tasks/<key>.md`, rows added since,
and earlier findings still open. **After merge, do not re-run** unless that diff is non-empty. At run
scope use one agent, not one per ledger or per check.

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
