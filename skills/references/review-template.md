# <moduleKey> — review pass <n>

<!-- The ONE review shape. The reviewer writes this file itself as `<runs>/<moduleKey>/review-pass<n>.md` — the
     only file it may write — and the orchestrator runs
     `node scripts/output-check.mjs review <runs>/<moduleKey>/review-pass<n>.md` before acting on it.

     What the checker enforces, and nothing more:
       - the title line `# <moduleKey> — review pass <n>`;
       - these seven `##` sections, all present, in this order;
       - `## Verdict` opens with **MERGE-READY** or **CHANGES-REQUIRED**;
       - every `###` heading under `## Findings (ranked)` names a severity (BLOCKER | WARNING | NIT) and a
         `file:line`;
       - no **MERGE-READY** verdict over a BLOCKER finding.

     Section names and order are fixed because reviews that vary in shape make every consumer re-derive where the
     verdict and the loop-back list are — and records go missing in the variation. Keep every section; write
     "none" under one that is empty. -->

## Verdict

**MERGE-READY** | **CHANGES-REQUIRED** — one sentence: why.

## Readiness

Readiness checklist: <n> items — <passed> passed · <failed> failed · <n/a> N/A (each cited).

## Requirement traceability

| Requirement | Where implemented (`file:line`) | Where tested (`file:line`) | Aligned? |
|---|---|---|---|

## Invariant candidates

| Candidate | Status | Covered by / registry id |
|---|---|---|

## Findings (ranked)

### B-1 · BLOCKER · `path/to/file.ext:NN` — one-line claim

Evidence you verified (what you opened, what it says). Cite the rule, decision or requirement it answers to.

### W-1 · WARNING · `path/to/file.ext:NN` — one-line claim

### N-1 · NIT · `path/to/file.ext:NN` — one-line claim

## Loop-back list

Ordered `FIX-n` items for the coder — `file:line` · the rule or requirement · the minimal fix. "none" when
MERGE-READY.

## Merge conditions

Items still required before the merge that are not code, each with its registry id, its decision-workspace
file, or its handoff § line. "none" if none.
