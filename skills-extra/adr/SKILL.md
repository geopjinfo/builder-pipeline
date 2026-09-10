---
name: adr
description: Use to write an Architecture Decision Record in a consistent house format, or to promote a DECISIONS.md ruling into a full ADR. Trigger on "write an ADR", "record this decision", "we decided X over Y, document it", "supersede ADR-NNN", or when a settled technical choice (framework, datastore, boundary rule, locking strategy) needs a permanent record with trade-offs. NOT for open design discussion — only for decisions that are actually settled.
---

# ADR — architecture decision records (house format)

`DECISIONS.md` is the one-line **index** of rulings; an ADR is the **essay** — written when a
decision has real trade-offs, rejected alternatives, and consequences someone will question in a
year. Promote a `D-n` row to an ADR when any of: it changes a boundary/contract every module
inherits · it rejects an obvious alternative · it will be re-litigated without a written why.

## Where they live

`<adr dir>` — use the project's existing ADR directory if one exists (check profile §3/§5 docs
and `docs/**/adr*`); otherwise create `docs/adr/` (or `adr/` in doc-less repos) plus an
`index.md`. If the project's ADR dir is a **protected path** (profile §4), write the ADR body in
the run's handoff pack (§E docs) and hand it off — never edit the mirror.

## Format (one file: `ADR-NNN-<kebab-title>.md`)

```markdown
# ADR-NNN: <imperative title — the decision, not the topic>

- **Status:** Proposed | Accepted | Superseded by ADR-MMM
- **Date:** <yyyy-mm-dd>
- **Decision ref:** D-n (DECISIONS.md) · <requirement/spec ids if any>

## Context
What forces this decision — the problem, constraints, and why now. 3–8 sentences, cited.

## Decision
The choice, stated actively ("We will …"). Include the exact mechanism (config, pattern,
gate) so a reader can verify the codebase still complies.

## Consequences
What becomes easier, what becomes harder, what is now forbidden. Include the enforcement
(hook/gate/review rule) if any — an unenforced ADR is a wish.

## Alternatives considered
One short paragraph per rejected option: what it was, why rejected. This section is why the
decision won't be re-litigated.
```

## Rules (the workflow half — format is taste, these are not)

1. **Number sequentially**, never reuse. Check the index for the next free `NNN` (and for a
   concurrent branch that claimed it — bump past).
2. **Accepted ADRs are immutable.** To change one: new ADR that supersedes it; flip the old
   `Status:` to `Superseded by ADR-MMM` — that status line is the only edit ever allowed.
3. **Update the index** (`index.md`: number · title · status · date) and add/annotate the
   `DECISIONS.md` row's "Full ADR" column with the ADR id — the two stay cross-linked.
4. **One decision per ADR.** Two decisions that always travel together are still two ADRs with
   cross-references.
5. Pipeline integration: the run's handoff pack (§E docs) is where a build's "warranted
   ADR" surfaces; write it with this skill before merge, so the merge commit and the record land
   together.
