# Optional modules — port only if the target wants them

## caveman-context.js (token-saver output mode)
SessionStart hook that puts every session in compressed "caveman" prose (~75% output-token cut;
code/CLI/API names/error strings stay verbatim; safety warnings drop to normal prose).
**Two-part install:** (1) this hook wired in `.claude/settings.json` under `SessionStart`;
(2) the `caveman` SKILL itself, which lives at USER level (`~/.claude/skills/caveman/`) — copy it
from the source machine or drop it repo-level under `.claude/skills/`. Without the skill the hook's
instruction has nothing to point at. Env opt-out and level knob are inside the hook file.
Use it for the main session only: a seat's output is a small share of what it costs, because seats
mostly pay for what they read.

## Knowledge index — the contract any index tool meets

An index helps seats *locate* things — which file defines a concept, what a change touches. It is
only useful while fresh: a stale index answers confidently about code that has moved or no longer
exists. The pack does not ship an index. It ships the contract below, and the graphify scripts in
this folder as **one example**.

### The exit-code contract

`features.graph.check` in profile §16 names a command that **reports without syncing** and exits:

| Exit | Verdict |
|---|---|
| `0` | fresh — code and docs both current |
| `3` | absent — no index built (with the feature `off`, the pipeline prints `graph: not configured`) |
| `4` | unmeasurable — the check could not run |
| `10` | docs pending re-embed |
| `11` | code behind |
| `12` | both |

`node scripts/index-check.mjs` runs it and prints the verdict. At P1 the orchestrator branches on
it: with the feature on, a non-zero exit refuses the planner until the index is refreshed or the
verdict is recorded in the run's state file (`Graph:` line). A refusal whose reason is written down
is a decision; a planner grounded on a stale index without anyone saying so is not.

Two details make the verdict honest:

- **Code freshness is measured by content**, not only by comparing the commit the index was built
  at with `HEAD`. Uncommitted edits count, and a commit that touched nothing indexable does not.
- **A sync must exit `10` whenever anything is still pending**, including a run that found nothing
  new to do. A sync that says "nothing changed" with a backlog of unembedded docs hides the backlog.

### Two refreshes, two prices

- **Code refresh** re-extracts changed source files structurally, by parsing, with no model. It is
  free, so run it whenever it is useful: `features.graph.sync` on the triggers below, and
  `features.graph.syncFree` before the phase-4 auditors so they query an index that includes the
  diff under audit.
- **Doc embedding** uses a model to extract meaning from changed docs, and **spends tokens**. It runs
  automatically only while the pending docs total at most `features.graph.autoLimitKb`. Above that,
  a person decides: an unattended trigger that embeds an unbounded backlog is an unbudgeted spend.
  Prune what should never be embedded first (generated reports, data files, ledgers addressed by
  path): index what must be *found*, and let a plain search serve what is already addressed by name.

### Three triggers, one lock

1. **Merge** — a post-merge git hook catches code arriving by merge. It must fire on **your base
   branch(es)**, not only `main`. Guarding for the wrong branch left one project's index silently
   stale for weeks.
2. **Session start** — a harness hook, where the harness has one. It runs detached and never blocks
   the session, and speaks only when the previous run left docs above the limit. It catches docs
   dropped into the tree with no commit or merge.
3. **P1** — the gate above. It is the catch that exists in every harness.

No watcher: triggers at known moments cost nothing between them, and each one leaves a status
record someone can read. **One lock** is held by whichever trigger is syncing. A second trigger that
finds the lock held exits at once with its own distinct "lock held" code and does nothing, because
two concurrent embeds double the spend and can corrupt the index. Store the holder's pid and start
time in the lock, so a lock left by a dead process can be reclaimed once it is older than the longest
plausible sync.

### The graphify example: `sync.py` + `sync-hook.sh`

These keep a graphify graph current: a free structural re-sync on every merge to the base branch(es)
via a guarded post-merge block, and deferred doc embeds tracked in a visible pending file.
`hooks/graphify-post-merge.sh` is the simpler standalone merge trigger.

How far they meet the contract: `sync.py` exits `0` (synced or nothing to do), `10` (docs pending),
`3` (no graph yet) and `1` (error). That covers `0` / `3` / `10`. It **syncs rather than reports**,
so it has no code-behind verdict (`11` / `12`), and it has **no lock and no size limit**. To use it
as `features.graph.check`, add a report-only mode or a wrapper that compares the index with the
working tree without syncing. Add the lock and the limit before wiring a second trigger.

**Requires the graphify tool installed** (`graphify-out/.graphify_python` written by a full run) —
without it these are inert. Localize: the branch list in `sync-hook.sh`'s guard, and a
`.graphifyignore` excluding human-facing publishes and derived artifacts.

All of these ship un-wired; UNPACK never arms them. They are choices.
