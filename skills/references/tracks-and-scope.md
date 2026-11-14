# Tracks and scope — the reasoning

Part of the `build-module-pipeline` skill. The skill keeps the track table and the rules; this file
keeps why each rule is shaped the way it is.

## Why tracks at all

Forcing five natures of work through one shape is
how the wrong rigour gets applied to each.

## Why the drift, invariant and behavioural phases exist

The tester, the permission matrix and every tier of the test suite ask *"may actor X call operation Y,
and does it return the right code?"* None asks whether the system is still coherent afterwards,
and no phase before 6.5 ever runs the application. Those two blind spots are where one adopting
project's invariant hunt found dozens of live defects behind a fully green suite.

## Rule 1 — a production-source diff may never go SOLO

In the source project a remediation task went
the solo route and shipped with the gate chain red; this is that lesson stated mechanically
rather than left to judgement.

This rule was first written as *"any diff touching production source is FULL or ADDITIVE, no
exceptions"*, and that wording made **FIX** unusable — remediation almost always lands in
production source, so every FIX run had to re-interpret the rule before it could start, and a
rule each run re-interprets is not a rule. **SOLO is the target.** FIX runs coder, tester, drift,
every auditor, the reviewer and the behavioural gate; it skips only the planner, because its
entry condition is a *verified* blocker list that has already done the planner's work.

## The pipeline never starts another pipeline — why

The cap on nested dispatch does
not rest on what the harness allows; it rests on the run. The harness might allow a nested run; the rule was
never about the harness. A nested run means either you nesting — reintroducing exactly the context
pollution the firewall exists to prevent — or a persona gaining dispatch power, which breaks
clause 5 of the operating contract. It also breaks the 1:1 mapping *run ↔ branch ↔ board ↔ version
bump ↔ PR* that makes review possible: a nested run has no answer to *whose board, whose registry
rows, whose version bump*.

## Blocker triage

**Blockers are triaged, not uniform** — three outcomes, and only the third stops the run:
- **`DECIDED-FROM-DOCS`** — a ratified source settles it, including by clear implication.
  Decide, **record it** in `<decisions>` (what, the citation, why, and how to reverse it —
  profile §11) and as a `decision` event, and keep going. Say plainly that it was decided from
  the docs, not ruled by a human.
- **`NEEDS-RULING` (non-blocking)** — genuinely undefined, or two ratified sources conflict.
  Raise it through §13 and **proceed on a stated assumption** while you wait.
- **`BLOCKING`** — proceeding under any assumption would be unsafe or make the work useless if
  wrong (money movement, who may approve what, retention, a **new oracle entry**). Stop and
  surface it. Never invent an oracle entry, ever.

## Search first, decide second, escalate last

A gap is not automatically a question for a human: in one adopting project **most
escalations were already answered by the requirement register**. Search first, decide second,
escalate last.

## Why the planner authors the digest

The digest is a
*planning* deliverable because its whole value is asking the coherence questions **before the
code exists**; the coder never authors them, since the author of the code cannot be the author of
the questions about the code.
