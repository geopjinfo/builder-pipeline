# DECISIONS — rulings log (ADR-lite)

> **Installed as `DECISIONS.md` at the target repo root.** Every pipeline stop point that ends in
> a human ruling gets a row here — boundary events, catalogue amendments, deferred fold-in vs
> defer-again calls, spec-gap resolutions, two-strike escalations. The next module's brief
> inherits these instead of re-litigating them; the planner cites them like any other doc.
>
> One line per ruling. If a decision has real trade-offs and alternatives, promote it to a full
> ADR in your architecture docs and link it from here — this log is the index, not the essay.

| Id | Date | Module/scope | Decision | Why (one line) | Full ADR |
|----|------|--------------|----------|----------------|----------|
| D-1 | <yyyy-mm-dd> | <moduleKey or "platform"> | <what was ruled> | <the reason that made it non-obvious> | — |

## Rules

- **Append-only.** A reversed decision gets a new row that supersedes the old id ("D-7 reverses
  D-3 because …") — never edit history.
- **Cite or it didn't happen.** Pipeline agents may cite `D-n` ids as authority the same way they
  cite specs; a ruling that never lands here will be re-asked (and maybe re-answered
  differently) next module.
- **Close the loop at close-out.** The pipeline's Finish step reminds you: any ruling made during
  the run gets its row before the merge.
