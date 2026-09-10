<!-- Copy to <pipeline-workdir>/<moduleKey>/state.md at Phase 1.
     The orchestrator's OWN cursor. The board tracks the seats; this tracks the RUN.
     Rewrite AT EVERY PHASE GATE. After any context compaction, re-read this file plus the
     board's status block BEFORE deciding anything — never reconstruct a run from scrollback. -->

# <moduleKey> — orchestrator state

_Updated: <iso> · Loop: <0 = first pass> · Track: <track> · Branch: `<branch>`_

**Now:** P<n> <phase> — <dispatched | awaiting | verdict received>
**Next:** P<n+1> <phase>

## Open FIX rows (the loop-back list — the single thing the coder gets)
| # | file:line | Rule / requirement id | Minimal fix | Status |
|---|-----------|-----------------------|-------------|--------|
| FIX-1 | | | | PLANNED |

## Phases to re-run after the current fix
- [ ] Test (always)
- [ ] Drift/contract checks (always — a fix is exactly when a declared effect silently disappears)
- [ ] <only the auditor whose domain was touched>
- [ ] Behavioural/QA gate (only if runtime behaviour changed; always if a transition changed)

## Last suite results (digests only — never paste a log)
| Suite | When | Result | Log |
|---|---|---|---|

## Decisions taken this run
| id | What | Citation | How to reverse |
|---|---|---|---|
