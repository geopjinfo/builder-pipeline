# Optional modules — port only if the target wants them

## caveman-context.js (token-saver output mode)
SessionStart hook that puts every session in compressed "caveman" prose (~75% output-token cut;
code/CLI/API names/error strings stay verbatim; safety warnings drop to normal prose).
**Two-part install:** (1) this hook wired in `.claude/settings.json` under `SessionStart`;
(2) the `caveman` SKILL itself, vendored repo-level at `.claude/skills/caveman/` (copy it from the
kit's `skills-extra/caveman/`) — the hook's instruction points there, and a repo-level copy travels
with every clone and account, where a user-level `~/.claude/skills/caveman/` copy does not. Without
the skill the hook's instruction has nothing to point at. Env opt-out and level knob are inside the hook file.
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

`npx builder run index-check` (folder layout: `node scripts/index-check.mjs`) runs it and prints the verdict. At P1 the orchestrator branches on
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

### The graphify example: `sync.py` + `autosync.py` + `session-sync-hook.cjs` + `sync-hook.sh`

These keep a graphify graph current and meet the whole contract:

- **`sync.py --check`** reports without syncing. It prints one JSON facts line (`index`, `tooling`,
  `changedCode`, `deleted`, `pendingDocs`, `pruned`, `builtAtCommit`, `head`) and exits
  `0` / `3` / `4` / `10` / `11` / `12`. Use it as `features.graph.check`. Plain `sync.py` does the
  free code sync and exits `10` whenever docs are pending, including an earlier run's backlog.
- **`autosync.py --trigger merge|session|p1|p4|manual [--no-embed]`** is the one entry for every
  trigger.
  - **Lock:** `<index dir>/.sync.lock`, holding pid and start time; reclaimed once past
    `INDEX_STALE_LOCK_SECONDS` (default 7200).
  - **Decision:** after the code sync it decides `none`, `not-requested`, `over-limit`,
    `no-embedder` or `embed`.
  - **Embed:** only when the pending docs total at most `INDEX_AUTO_LIMIT_KB` (default 300; keep it
    equal to `features.graph.autoLimitKb`) **and** `INDEX_EMBED_COMMAND` names your embed step. The
    pack assumes no model CLI.
  - **No re-trigger:** the embed runs with `INDEX_SYNC_SKIP=1` and `INDEX_PENDING_FILE` set, and
    rewrites that file to whatever it did not embed.
  - **Records:** output is appended to `.sync.log`, and the decision is written to
    `.autosync-status.json`.
  - **Exit codes:** `0` fresh · `10` pending · `20` lock held · `3` no index · `1` error.
    `--no-embed` is the free `features.graph.syncFree` step before the phase-4 auditors.
- **`session-sync-hook.cjs`** is the session-start trigger for Claude Code. It starts
  `autosync.py --trigger session` detached, exits 0 at once, and speaks only when the previous run's
  decision was `over-limit`. Its header gives the `settings.json` snippet. With `--trigger merge` it is
  also the merge trigger's runner, and then it prints nothing.
- **`sync-hook.sh`** installs the guarded post-merge block. The block runs
  `node <HOOKS_JS_DIR>/session-sync-hook.cjs --trigger merge` on the branches in `BASE_BRANCHES`
  (default `main`). List every base branch your feature work merges into.

**These run outside the permission prompt, so they start committed code only.** A git hook and a session
hook both run unattended; a script or interpreter an agent can rewrite would otherwise run on the next
merge or session with no approval.
- The merge block starts node only when `session-sync-hook.cjs` and `hook-trust.cjs` (from
  `hooks/claude-code/`, installed beside the hook) are plain files equal to their blobs at HEAD.
- The hook starts Python only when **every** entry of the folder holding `autosync.py` is a plain file
  equal to its blob at HEAD, and no committed file is missing. A package folder, an extension module,
  a sourceless `.pyc` or a link would each change what `import sync` loads.
- The interpreter comes from `INDEX_PYTHON`, else the tool venv (`INDEX_TOOL_VENV`, default `graphifyy`)
  that `uv tool dir` or pipx reports, found outside the project. It is **never** read from a path
  recorded inside the index directory: that folder is git-ignored, and an agent can write it.
- Python runs as `-I -B` with an unused pycache prefix, no inherited `PYTHON*` variables, and
  `NoDefaultCurrentDirectoryInExePath` set, so no repository bytecode is read and no child on Windows
  takes a program from the current folder. `sync.py` runs `-m graphify` with `-P` for the same reason.

Anything untrusted means no sync, silently; the session and the merge carry on.

**Requires graphify installed** (as a `uv tool` or pipx venv, or named by `INDEX_PYTHON`). Without it
these are inert. Place the Python files two levels below the repo root (for example
`scripts/graphify/`), or set `INDEX_ROOT`. Keep that folder holding only the committed scripts. Localize
the branch list, the embed command, and a `.graphifyignore` that excludes human-facing publishes and
derived artifacts.
`hooks/graphify-post-merge.sh` is the simpler standalone merge trigger; it has no lock.

All of these ship un-wired; UNPACK never arms them. They are choices.
