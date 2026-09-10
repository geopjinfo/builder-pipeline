<!-- Copy to <runs>/<moduleKey>/state.md at Phase 1 (`paths.runs`, default `.pipeline`).
     The orchestrator's OWN cursor. The board tracks the seats; this tracks the RUN.
     Rewrite AT EVERY PHASE GATE. After any context compaction, re-read this file plus the
     board's status block BEFORE deciding anything — never reconstruct a run from scrollback.
     It is the first thing you read back, so it must be the last thing you wrote.

     Never leave a check line blank: a feature that is off is written as its
     "<feature>: not configured" line. A blank reads as a pass. -->

# <moduleKey> — orchestrator state

_Updated: <iso> · Loop: <0 = first pass> · Track: <track> · Branch: `<branch>`_

**Now:** P<n> <phase> — <dispatched | awaiting | verdict received>
**Next:** P<n+1> <phase>
**Orchestrator model:** `<last line of node scripts/orchestrator-check.mjs — or "orchestratorModel: not configured">` <· proceeding on <model>, by <who> — only if exit 5 was accepted>
**Graph:** `<the verdict: line of node scripts/index-check.mjs at step 0 — or "graph: not configured">` <· declined embed: <n> KB, by <who> — only if one was declined>

## Open FIX rows (the loop-back list — the single thing the coder gets)
| # | file:line | Rule / requirement id | Minimal fix | Status |
|---|-----------|-----------------------|-------------|--------|
| FIX-1 | | | | PLANNED |

## Phases to re-run after the current fix
- [ ] Test (always)
- [ ] Drift/contract checks (always — a fix is exactly when a declared effect silently disappears)
- [ ] Claims check (always)
- [ ] <only the auditor whose domain was touched>
- [ ] Behavioural/QA gate (only if runtime behaviour changed; always if a transition changed)

## Last suite results (digests only — never paste a log)
| Suite | When | Result | Log |
|---|---|---|---|

## Optional checks — last result (one line each)
| Check | Phase · loop | Result — or "<feature>: not configured" |
|---|---|---|
| plan shape (`output-check plan`) | P1 | |
| builder batches (`builderBatch`, unmeasured) | P2 | <rows per batch · dispatches> |
| claims (`claims-check --run`) | end P2 · end P5 | |
| mutation step | P3 | <score · logic survivors · payload survivors — or NOT RUN — reason> |
| index re-sync (`graph.syncFree`) | P4 | |
| rules → vuln-auditor (`rules.txt`) | P4 | <hits · NEW> |
| findings shape, per seat (`output-check findings`) | P4 | |
| review shape (`output-check review`) | P6 | |
| contract oracle | P6.5 | |
| narrow FIX lane (`fixLane`, unmeasured) | loop-back | <groups dispatched> |
| handoff pack (`handoff-check`) | P7 | |

## Decisions taken this run
| id | What | Citation | How to reverse |
|---|---|---|---|
