# Changelog — builder kit

All notable changes to the kit. Format: [Keep a Changelog](https://keepachangelog.com); the kit
versions independently of any project it is pasted into.

## [Unreleased]

### Added

- **Per-harness renderers in `adapters/lib/`.** Pure modules (text in, `{ path, content }` out) for Claude Code (a
  move-compatible copy of the install transform, byte-identical for every persona), Codex (`.codex/agents/*.toml`,
  `.agents/skills/`, `.codex/hooks.json`) and Antigravity (`.agents/agents/*.md`, `.agents/skills/`), each checked
  against the harness's official docs, which the module cites. What a harness cannot enforce is listed in the module's
  `unconfirmed` export, and a capability typo stays read-only everywhere. `cli.js` does not use them yet. Docs:
  `adapters/codex.md`, `adapters/antigravity.md`. Tests: `tests/adapters.test.mjs`.
- **The kit is an installable package.** `package.json` is no longer private: name `@geopjinfo/builder-pipeline`, a
  `builder` command (`cli.js`), `files` (every folder and document the CLI reads; the kit's own `tests/` stay out),
  `engines.node >=18` (the floor `cli.js` enforces), `license` (UNLICENSED until one is chosen) and `repository`.
  Install from a tag: `npm i -D github:geopjinfo/builder-pipeline#<tag>`; `npx builder --version`. Tests:
  `tests/package.test.mjs`.
- **`builder run <name> [args]`** runs a kit script from the package with the project as its working directory
  (`BUILDER_PROJECT_ROOT` names it); no name lists them, a path-shaped or unknown name is refused. Installed as a
  package, `unpack` copies no scripts or oracle adapters into the project, the installed prose says
  `npx builder run <name>` instead of `node scripts/<name>.mjs`, and `verify` looks for the scripts in the package.
  A kit copied in as `builder/` is unchanged. Tests: `tests/run-from-package.test.mjs`.
- **`builder.lock.json`** records the sha256 of every kit-owned file the kit writes. `upgrade` keeps a kit-owned file
  changed since then and reports it `kept (local edit)`; `--force` overwrites it after the usual backup. Project-owned
  files are not locked; an install with no lock upgrades as before. Tests: `tests/lock.test.mjs`.
- **The kit names itself where it is installed:** as a package, installed Markdown, the pointer block and CLI output
  say `npx builder …` and `node_modules/<package>/<file>`; a `builder/` copy is byte-identical to before. Tests:
  `tests/kit-location.test.mjs`.

### Security

- **`protected-paths.cjs` finds a link maker anywhere in a statement.** The statement-lead list is a list of
  prefixes, and a prefix not on it hid the maker: `find … -exec|-execdir|-ok ln -s <protected> …`, `flock`, `busybox`,
  `doas`, `ionice -c3` leads and a PowerShell `ForEach-Object { New-Item -ItemType Junction … }` block were allowed.
  A token-bounded maker word now starts a statement of its own and its operands are judged as at a head; read-only
  pipelines and data heredoc bodies are left out unless the command could run what it wrote.
- **Any CR in a shell command is not understood** by the heredoc lexer (fails closed): bash ends a line on `\n` only
  and compares a heredoc end line with its CR, so a lone or trailing `\r` moved the body boundary.
- **Read-only verbs:** `-O` inside a flag cluster (`git grep -nO'cmd'`, also spelled with quotes or a backslash) and
  git's `--open…`/`--ou…` prefixes are writing options, so such a pipeline is no longer read-only.

### Fixed

- **A data heredoc is judged by its target, not its body.** `cat > notes.md <<'EOF'`, `tee [-a] f <<'EOF'` (stdout
  may go to `/dev/null`) and a lone `git commit -F - <<'EOF'` whose body quoted a redirect or a link into a
  protected folder were refused as a write or link they never make. The write-shape, link and `cd` stages now read
  the command without its data heredoc bodies — only when the command is made of data statements alone and runs no
  shell or interpreter; `git commit -F -` counts as inert only as the whole command (it runs config-driven hooks).
  Tests: `tests/fence-heredoc-links.test.mjs` (46 cases).

## [0.16.0] — 2026-11-12

### Security

- **The optional index hooks start committed code only.** `tooling/optional/session-sync-hook.js` used to start the
  interpreter named in a file inside the git-ignored index directory, on `autosync.py`, with no check; the post-merge
  block `sync-hook.sh` installs did the same. An agent that wrote either could have its code run on the next session
  or merge, outside the permission prompt. Now:
  - the hook starts Python only when every entry of the folder holding `autosync.py` is a plain file equal to its
    blob at HEAD (`hook-trust.cjs`, installed beside it) and no committed file is missing;
  - the interpreter is `INDEX_PYTHON`, else the tool venv (`INDEX_TOOL_VENV`, default `graphifyy`) that `uv tool dir`
    or pipx reports, found outside the project, never a recorded path;
  - Python runs `-I -B` with an unused pycache prefix, no inherited `PYTHON*` and `NoDefaultCurrentDirectoryInExePath`;
  - the merge block checks the hook and `hook-trust.cjs` against HEAD and runs the hook with `--trigger merge`, so
    both triggers share one implementation; `sync.py` runs `-m graphify` with `-P`.

  Three new tests (an untracked module, an edited script, a recorded interpreter) fail on 0.15.5 and pass now; the
  positive control runs the sync for both triggers.

### Added

- **Worktree sweep lists orphan folders** (with `prefix` set): folders beside the primary that `git worktree list`
  does not know and that hold no `.git`, with their size. Listed only, never removed — that is a recursive delete.
- **Briefs carry a context budget.** `templates/module-brief.md` and `templates/orchestrator-worker-brief.md`: the
  thread dispatches and decides only, heavy steps go to one sub-agent that returns at most 10 lines, long runs go
  detached, and `state.md` is updated after every step. Every tier output goes under the worktree's gitignored logs
  dir, never `../` or the worktree root. The worker brief checks the deferral registry on entry.
- **A provider-token wiring kind**, documented in `examples/wiring/README.md`: the `provider` kind skips
  `{ provide: TOKEN, use* }` bindings by design, so it was blind to them.
- **A tracked git-hooks folder is an instruction file** in the `instruction-trailer.cjs` example.

### Fixed

- **Worktree sweep:** a `git worktree remove` whose folder survives is `FAIL … at rmdir`, never `SWEPT`.
- **`wiring-check`** drains stdout/stderr before it exits; a bare exit after many lines could cut a piped `--list`.
- **`orch`:** a stray file under `runs/` is no longer read as a run by `pause`, `resume` or `status`.
- **page-keeper** reads the page collection first and pins every overwrite and delete to the version it saw,
  through the page data tool; the Claude Code install grants it `ArtifactData`.
- **standards- and invariant-auditor** may run the graph-query commands when the graph trial is on; their read-only
  command list had forbidden the step the reference asks for.
- **Tiers are never run bare** by the repo-audit gate agent or the e2e harness skill: they go through
  `commands.tier`.
- **Seven project ids** in the instruction-lint, outbound-guard and reanchor examples are now neutral.

## [0.15.5] — 2026-10-30

### Security

- **`hook-trust.cjs` never starts a `git` from the current folder on Windows.** It started `git` by bare name, and
  Windows looks in the current folder before PATH unless `NoDefaultCurrentDirectoryInExePath` is set. A `git.exe`
  planted in the project would then run outside the permission prompt and answer the check itself. The check now sets
  that variable in its own process before starting git. The new test plants a stand-in `git.exe` with the variable
  unset: it fails on 0.15.4 and passes now. It skips off Windows, where a bare name is looked up in PATH only.

## [0.15.4] — 2026-10-30

### Security

- **`hook-trust.cjs` resolves a local require the way Node does.** 0.15.3 treated `require('./b')` as a path that does
  not exist and left it out of the check, while Node loaded `b.js`. The same went for a folder (`./pkg` →
  `pkg/index.js`), and `require('..')` was not recognised at all. A hook could therefore load a rewritten file behind
  such a require. No checked script in the pack uses these forms today. Specifiers now go through `require.resolve`,
  which executes nothing, so a rewritten target is refused and so is a planted `b.js` that would win over a committed
  `b.json`. Both new tests fail on 0.15.3 and pass now.

## [0.15.3] — 2026-10-30

### Security

- **`hook-trust.cjs` judges files by their real path, as Node loads them.** Node resolves a module, and the requires
  inside it, from its realpath. 0.15.2 hashed through a symlink but resolved requires from the link's own location.
  So a symlinked file holding an exact copy of a committed file passed the check, while its requires loaded from
  beside the copy, outside the repository. The same went for a folder symlink or junction holding byte-identical
  copies. The closure and the repository are now both realpath'd, and a file whose real path leaves the repository
  is refused. The new folder-junction test fails on 0.15.2 and passes now. The file-symlink test skips on hosts that
  cannot create file symlinks.

## [0.15.2] — 2026-10-30

### Security

- **`hook-trust.cjs` compares bytes with HEAD instead of asking `git status`.** 0.15.1 trusted `git status`, and
  that left two gaps. First, `status` runs `core.fsmonitor` from the repository's config, which an agent can write.
  Second, it reads the index, where `assume-unchanged` or `skip-worktree` hides a change. The check now hashes each
  file the way git hashes a blob and compares the result with `git rev-parse HEAD:<path>`. It runs git with fsmonitor
  and hooks off, replace objects ignored and no inherited `GIT_*` environment. A project file must belong to the
  project root's repository: a file inside a `.git` planted under `scripts/` is refused. A CRLF checkout still
  matches its LF blob. What it does not cover is now stated in the file: an agent that may commit, or rewrite
  `.git`, can still put code at HEAD.

## [0.15.1] — 2026-10-30

### Security

- **Hooks run only committed code (`hooks/claude-code/hook-trust.cjs`).** Every Claude Code hook used to load
  `scripts/lib/*.cjs`, or spawn `scripts/*.mjs`, straight from the agent-writable tree, and a hook runs outside the
  permission prompt. An agent that rewrote one of those files had its code run by the next matching tool call. Now a
  hook loads or spawns a project file only when that file and every local file it requires are tracked and clean
  against HEAD. Otherwise:
  - `instruction-lint-on-edit` sends a "not run" note on an instruction-file edit and never blocks;
  - `bash-output-cap` leaves the output as it is;
  - `reviewer-write-guard` keeps its default runs folder and still enforces, and `registry-read-guard` allows;
  - `reanchor-after-compact` gives the fixed re-read order without the run paths;
  - `board-render` skips the render, with a stderr line.

  `instruction-lint-on-edit` also checks that the feature is on and the edited file matches
  `features.instructionLint.files` before it starts anything; before, it spawned the lint on every edit.
  **Arming:** copy `hook-trust.cjs` into `.claude/hooks/` next to the hooks (`cli.js unpack` does). A hook that
  cannot find it loads nothing, and the guards then keep their defaults.

### Added

- **Re-anchor after compaction (`features.reanchor`, `hooks/claude-code/reanchor-after-compact.cjs`).** A
  `SessionStart` · `compact` hook hands the compacted session each run in flight: its `state.md` with the `Now:`
  line, the board and its first open phase, and the open `FIX-n` rows copied verbatim. It reads files only, with
  no model call, so a summary cannot lose where the run is. The orchestrator still re-reads the files.
- **Outbound guard (`features.outboundGuard`, `scripts/lib/outbound-guard.cjs`, `scripts/outbound-check.mjs`).**
  The one door for any step that sends an excerpt to a model. It refuses (never redacts) a denied file, a
  secret-shaped string, a value from the project's env files, or a payload over the excerpt limit. A refusal, a
  failed call and a timeout all come back as "no advice", so the pipeline never waits on it. The reasons name the
  file, the line and the kind of match, never the matched text. With the feature off, the CLI refuses everything.
- **EXPERIMENTS §12–15:** ranked plain search when the index is stale (`rankedSearch`), a raise-only review-level
  hint (`riskHint`), model-chosen order for the seeded walk with a replayable trace (`walkPriority`), and advisory
  notes on prose rules (`ruleNotes`). These are protocols only, each needs `outboundGuard` on, and none may block or
  lower a level. They came from a review of hosted decision-model use cases against the pipeline: the ideas carried
  over, the hosted service did not.

## [0.15.0] — 2026-10-29

### Added

- **Instruction lint (`features.instructionLint`, `scripts/instruction-lint.mjs`).** The instruction files
  (CLAUDE.md, AGENTS.md, `.claude/**`) are held to the repo:
  - every inline-code path resolves;
  - no bare `:N` line reference;
  - every registered figure matches its source command;
  - every enumerated set is complete;
  - count claims and incident-history phrases may not grow past a baseline (`--refresh`).

  It runs as a P7 record gate. `hooks/claude-code/instruction-lint-on-edit.cjs` blocks an agent's failing
  edit in the same turn; in that `--files` mode no figure command runs. DESIGN §17 gains two writing rules:
  never type a repo count, and a rule cites a decision id while its history stays in the decision record.
  One adopting project's audit found every high-confidence drift of this kind, and the lint now catches all
  of them.
- **Plan-gap checks.** The planner gives every Tasks row a `Files` column and leaves no placement decision
  to the builder: which file, which specs pin it, no conditional steps, no timing-dependent asserts. Files
  outside the batch row's list become a `NEEDS-RULING · scope` entry. The reviewer's new step 4 holds the
  build to `plan.md` and the diff to the row's files: an unrecorded divergence or an out-of-scope edit is a
  blocker. `output-check` requires `Files` when `features.planSchema.taskColumns` lists it. These came from
  a fresh-context plan review that caught gaps no seat had recorded.
- **The orchestrator owns the index, once per batch.** Before the split approval it runs the index check in
  the primary and asks the human, once, about docs above the embed limit. Each lane worktree gets a copy
  of the index, and lane briefs never stop to ask. Lanes in fresh worktrees had been planning with no index.
- **`orchestrator.primaryLaunch: "app-session"`** (opt-in). The orchestrator starts a primary-seat pipeline
  lane as its own app session. The adapter lists the limits that were observed, and the lane brief's first
  step refuses to run without its skills.
- **Experiments 9–11:** `tokenEconomizer`, `planReview`, and `primaryLaunch`, each with a baseline, a
  keep/remove rule and its risk.
- **A citations `dir` source may name several directories.** `source.dir` accepts one path or a
  non-empty list; every directory is read and the ids are merged into one set. Observed in an adopting
  project whose decision records live in two folders: a board citing a real record from the second
  folder failed as an invented id. Each listed directory must exist (a missing one exits 2, never
  skipped); an empty list is an invalid profile. Test: "a dir source may be an array — ids from every
  directory are merged into one set", red before the change.
- **Scaffold step: update every module-counting check in the scaffold commit.**
  `skills/scaffold-module.md` §1 step 4 — a new module folder alone can turn an oracle that lists
  module namespaces, or a fingerprint that records the module count, red; both are fixed in the
  scaffold commit and the re-baseline is labelled a count move, not a behaviour change.

### Fixed

- **The cost meter priced nothing on the current models and lost seat names.** It now has rates for
  `claude-opus-5-5` and `claude-sonnet-5-5` (table version 2026-10-29). A resumed session's copy of a
  subagent transcript no longer erases the seat type its original recorded. In one adopting project, 93
  of 97 dispatches had read as `unknown` and every one as unpriced.
- **`orchestrator-check` reported "unmeasured" (exit 0) from a worktree.** The transcript folder is
  derived from the working directory, but a run working in a separate worktree keeps its session
  transcript under the folder the session started from. A session named by `--session` or
  `CLAUDE_CODE_SESSION_ID` is now looked up in this checkout's folder first, then in every project
  folder; the newest-file fallback stays local. Test with a negative control (an unknown id stays
  unmeasured).

- **The pack's prose tests read nested worktrees as pack prose.** A worktree of this repo under `.claude/worktrees/` was walked like any other folder, so its files failed the retracted-premise and script-name checks; an adopting project's arch gate, which runs this suite, went red while a worktree existed. `.claude/` (local state only) is now skipped, with a planted-file test that fails without the skip.

### Changed

- **DESIGN.md** gains a terms block, a "costs and when this is overkill" block, the phase order in one
  line, and a "does not vary" list keyed to principle numbers.

## [0.14.0] — 2026-10-22

### Added

- **`upgrade` — taking a newer release over an older install.** `node builder/cli.js upgrade --tool <t> [--dry-run]`
  walks unpack's own source→destination mapping, so the two sets cannot drift. A kit-owned file (personas, skills and
  references, playbooks, hooks, scripts and scripts/lib, oracle adapters, experimental tooling, utility skills) whose
  content differs from the pack is overwritten after a copy to `.builder/backup-<UTC stamp>/<same path>`; a missing
  one is added. Project-owned files — `PIPELINE_PROFILE.md`, the boards and their rules, the registry, the decision
  log, the brief templates, `.gitignore` — are never touched once they exist. The pointer block now closes with
  `<!-- /builder-kit:pipeline -->` and is re-wired only between its markers; a block from an older release is
  recognised by its fixed shape and anything else is reported `kept (by hand)`. One line per file (updated / added /
  unchanged / kept-project-owned) and a summary; `--dry-run` writes nothing. Re-running `unpack` stays copy-if-absent.
  UNPACK.md § Upgrading an existing install; the `setup-builder` skill's upgrade mode runs it.
- **`node builder/cli.js --version`.** `package.json` `version` is the kit's one version source; a pack test holds it
  equal to the newest released heading here.
- **Orchestrator hardening from a second orchestrated batch.**
  - **Credit queue.** `--queue <worktree>` on credit-prep, credit-audit, credit-run and credit-review (a worktree of
    this repo only — its spend must be visible to the cap guard); the printed launcher names the queue a job is
    really in. A queue lists every refusal with its reason and no longer counts a refused job as run. Read-only kinds
    run before writing kinds, and a dirty-tree refusal names the credit job whose verdict left the files. One runner
    per queue (`runner.lock`) and one job per target worktree (a lock in the orch store), both by exclusive create
    with dead holders taken over under a guard lock.
  - **Hard caps across runners.** A running credit job reserves its budget (`running.json`); the cap check and the
    reservation are one step under a machine-wide lock, re-run before every 429 retry. A skipped retry moves the
    rate-limited verdict aside, so the job really stays queued. A negative cost counts as unreported, never as
    negative spend. `runTask` validates `task.json` again at run time, and every path checks the task id rule.
  - **Re-runs keep the meter.** `credit-run <run> <task> --rerun [--queue-only] [--cleared-by <who>]` moves the
    finished verdict aside (`verdict.prev-<stamp>.json`); the meter, the review hold and `credit-review --verdict`
    read every verdict file. Running a finished job without `--rerun` is refused. After FAILED-INTEGRITY or
    FAILED-SCOPE, a re-run needs `--cleared-by`.
  - **Review hold fails closed.** `orch merge` reads every queue of the repo for jobs that target the lane, and
    refuses a lane whose worktree folder is gone or a run that records no repo.
  - **`features.orchestrator.mechanical`** (off by default): `orch merge` resolves the hot ledger files itself from
    the three blobs, in the new `scripts/lib/orch-merge-resolve.cjs`. Version manifests take the lane's bump on top of
    the target, a changelog is merged as a union of sections (the lane's re-versioned with a note), JSON is merged by
    key, and append-only ledgers by line. This holds even when git merged two same-version bumps "cleanly". Any other
    conflict still stops, and the heads-up names both sets. Every merge git call runs git from an absolute PATH
    entry.
  - **`features.orchestrator.capacity`** (off by default): a standing lane policy. `next` prints `ADD-LANES` while
    the capacity seat is freshly measured under its percentage, and `split --measured <file>` sizes the split from
    the file's last reading. `BUILDER_ORCH_LANE_CAP` overrides the cap. `--max-lanes` must be a whole number and
    warns above the cap. The run keeps its plan file.
  - **`SELF-AUDIT <lane>`.** A WAIT-P4 lane is told to run its own seats while the credit lane is busy with other
    work and holds no seat job of the lane's own (`creditBusy`). `gate-launch --resume` accepts it only where `next`
    offers it and a lane slot is free (429 hold and the halved cap included).
  - **`CREDIT-FILL`** replaces `CREDIT-UNDERUSED`. It says how far behind pace the spend is and names light jobs to
    queue, including the gate queue's keys whose P5 docs are owed.
  - **`orch link-guard <folder> [--brief <file>]`**, also run by `gate-launch`. When a `linkDirs` entry of a lane
    worktree is a link, a brief that names any reinstall step is refused. That covers every npm install alias, yarn
    and pnpm, a recursive delete of the dir, and `git clean -x`. A reinstall there would delete through the link into
    the shared install, and no brief wording exempts it. The scan is linear on long lines.
  - **`orch launch-id <log>`** (Claude Code adapter): the session id a background launch logs, taking the copy id when
    a resume with flags started one. `usage` and `usage-read` take a seat name in any case and refuse an unknown seat
    before reading anything.
  - **`gate-queue retip <key> --tip <sha>`** re-records a key's range after a FIX. The new tip must descend from the
    base and from the recorded tip, and a GATED key is refused. Refs that start with `-` are refused, and git runs from
    an absolute PATH entry.
- **`features.claims.jestBatch`** (off by default): claims-check runs each jest config once per sha and rebuilds
  each claim's summary from the files its own patterns select. It reuses a passing result logged at the same sha on
  a clean tree. Failures are never logged; a malformed or other-sha log is refused; a busy lock falls back to the
  claim's own command.
- **Findings and review checks.** A findings location may carry any extension or be a dotfile, and a `..` segment is
  refused. A blocker under `PASS-WITH-RULINGS` is refused like one under `PASS`.
- **The live board names its uncounted rows.** `board-parse` returns the Status-table rows that sit under a
  non-counted `##` heading (the rule `board-progress` already reported on stderr), and the rendered page names them,
  so a board whose figures are a lower bound says so.
- **Merge vocabulary.** A merged row is In review in every record; Reviewed is the human's sign-off only (task-board
  template, orchestrator skill).

- **Batch orchestrator gaps, found in a first real orchestrated batch.**
  - **`orch credit-audit <run> --key K --worktree W [--tester] [--dry]`** (behind `credit.enabled`). It turns the
    P4 auditor seats of one gate-queue key, and with `--tester` the P3 tester, into credit jobs. Each job is built
    from the queue's own base..tip and changed files. Ledger paths, from the gate queue's own ledger rules, are left
    out of the auditors' scope. Seat models come from `models.strong` (standards, security, invariant, tester) and
    `models.mid` (vuln). A credit worker cannot run `git diff <range>`, so each brief lists the files to read.
  - **A WAIT-P4 protocol.** The worker-brief template, the gate-batch skill and the orchestrator skill carry it: a
    lane stops with `RESULT: PASS WAIT-P4 <key> @ <sha>`, and the orchestrator runs the seats, checks the findings,
    marks P4 and resumes the lane.
  - **`orch release-stale [--apply]`.** It lists the claims held by a paused run, a MERGED or FAILED lane, or a
    missing run, which block new claims on the same files. It releases them only with `--apply`. A live run's claim
    is never stale.
  - **Version at merge.** The skill and the brief template give the orchestrator the re-version rule for two
    parallel lanes that claimed the same version.
  - **Test slot.** The orchestrator skill now states plainly that it owns the machine's test slot and the merge
    order.
  - **`digest --check <plan>`** is tested in both argument orders.

- **The fence fences its own definition.** `hooks/protected-paths.cjs` holds the protected list and the rules that
  read it. If it were unfenced, one write could empty the list, and every later call would be judged against the
  emptied set. So whenever anything is protected, the hook's own file is protected too. It is judged by where a
  write lands (its real path) across every route: file tools, shell writes, code naming it, and a link to it or to
  the folder holding it. `BUILDER_UNLOCK=fence` opens it, as a human grant. The CI half,
  `examples/jest-tier-runner/instruction-trailer.cjs`, now counts its own installed path
  (`scripts/lib/instruction-trailer.cjs`) as an instruction file. An undeclared change to the definition fails the
  trailer check like any other instruction change.

- **`hooks/protected-paths.cjs` guards the shell route and closes the link bypasses.** The hook used to judge
  only the file tools, so a shell redirect, a `cd` into a folder before a relative write, or a link made with
  any shell command walked past it. It now also judges Bash and PowerShell calls: the accidental write shapes
  (`>`/`>>`, `tee`, `mv`/`cp`, `sed -i`), each by spelling and by where it lands; creating a link whose operand
  is protected, lies in a protected folder or contains one (the project root, a parent folder). Link makers are
  recognised after a statement lead (`X=1 ln`, `{ ln …; }`, `if`/`then`, `time`/`nohup`/`xargs`/`eval`, `$( )`,
  backticks, `cmd /c`, `bash -c`, PowerShell assignment, cast, module-qualified `New-Item`,
  `Start-Process cmd -ArgumentList '/c mklink …'`), and so are the link-shaped `subst`, `New-PSDrive`, `ndr` and
  `mount`. An operand that cannot be placed fails closed. A relative write, link operand or interpreter operand
  after `cd`/`pushd`/`Set-Location` is judged where the `cd` went, and changing into a protected folder before a
  write, a link or code is refused (reading after it is not). Code naming a protected path, through a link or
  in a nested string, is refused. A write to an existing file with more than one hard link fails closed on every
  route, and `NotebookEdit` (`notebook_path`) is judged like `Write`. The settings snippet's matcher names every
  route; `BUILDER_PROTECTED` can add prefixes and never remove one. The fence is still the profile's `PROTECTED`
  list; nothing is hard-coded. Tests run against a fake project in a temp lab and remove each link without
  recursing through it.

- **The batch orchestrator — `node scripts/orch.mjs` + `skills/orchestrator.md` (`features.orchestrator`, off by
  default).** A layer above the pipeline that turns a multi-row plan into a batch: `digest` reads a plan artifact in
  any shape (table, bullets, HTML) and marks every cell it inferred `⚠ CONFIRM` and every unused line Unmapped;
  `split` refuses while a CONFIRM is open, then gives each row a risk class, a level, a track and a dispatch by rule
  (Full → the full pipeline, Micro → one SOLO agent, Standard → `standardPipeline`, full or lite; a hint raises,
  never lowers) and groups rows that share no owned file into lanes, hot files left to the merge queue. Nothing
  launches before the human approves the split. Each lane is placed on a seat — a terminal worker on a secondary
  account, or the primary account — by fresh usage readings under per-seat `limits` (the first lane may start
  unmeasured; both full is `USAGE-HOLD`). Claims keep lanes of different runs apart; a run lease keeps two
  orchestrating sessions apart; `orch watch` / `orch wait` replace polling; a finish without a result file, or with a
  changed git config or hook, is a stall, and a stalled or failed lane is pinned by snapshot refs before anything
  else touches it. `orch merge` merges one lane at a time: built on `orch/integration` from the target's current
  tip, gated there with hooks disabled, the target moved by compare-and-swap only on green (an ff-only command
  handed back when the target is checked out). Preflight runs the project's own checks — none configured, or one
  red, is one lane. A 429 halves the lane count globally and backs off with bounded jitter. With
  `credit.enabled`, bounded jobs (code reading, record fixes, docs, sweeps, the tester and auditor seats) run on a
  headless API-credit worker under mechanical guards: building, planning and reviewing seats refused; a model floor
  from `models.strong` / `models.mid`; an exact allow list; the key source checked before any model call; tracked,
  untracked and gitignored changes held to the job's scope; git integrity hashed around the run; a `RESULT: PASS`
  line required; per-day and per-period caps; a fallback down `credit.fallback` for account faults only; and a
  review hold that `orch merge` honours. Every seat action is a project command template, so the core is
  harness-neutral; the Claude Code values and the credit worker adapter are in `adapters/claude-code.md` and
  `scripts/lib/orch-worker-claude-code.cjs`. Plan and worker-brief templates install under `specs/`; the pipeline,
  lite and gate-batch skills say when a lane worker runs them. `orchestrator: not configured` → one run per module,
  by hand.

- **`node scripts/worktree-sweep.mjs` (`features.worktreeSweep`, off by default).** Runs isolate concurrent writers
  in their own git worktrees, and nothing removed them after the merge, so dead checkouts piled up, each holding
  gitignored evidence a hand-typed recursive delete would destroy (and a delete through a `node_modules` junction
  empties the primary's). The sweep removes a worktree only when it is merged into `target`, clean including
  untracked files, unlocked, not `reserved`, inside the optional name `prefix`, idle for `idleHours`, named by no
  running process and held by no `holdCommand` (the project's own "something still needs it" check; a failing
  check holds, as does a process check that cannot run). It copies `backupDirs` out to
  `<logs>/backups/worktrees-<date>/` first, unlinks a `node_modules` link without entering it, runs plain
  `git worktree remove` (never `--force`), prunes, and keeps the branch. Dry run unless `--apply`. The full
  playbook's *Finish* gains item 8 and the gate batch's *Finish* a cleanup paragraph: whoever merges runs it;
  the run never removes its own worktree. `worktreeSweep: not configured` names the manual fallback.

- **Split module pipeline (`liteSplit`, experimental).** `build-module-lite` builds one module through the
  playbook's steps 0–3 and queues it; `build-module-lite-gate-batch` runs every later phase over up to `cap`
  queued modules, each audited against its own diff. `node scripts/gate-queue.mjs` stamps every finished phase
  with the sha it was proven at and re-opens it when that module's code moves; bookkeeping and docs-only paths
  come from the profile. Off by default (EXPERIMENTS.md §8).

### Fixed

- **Naming a protected path is not writing it.** The hook's code rule read the whole command, so read-only work
  was refused when it merely named a protected path next to a heredoc or an interpreter. Two examples are notes
  appended with `cat >> notes.md <<'EOF'`, and a commit message on stdin (`git commit -F - <<'EOF'`). The rule now
  leaves out two things, and only these:
  - the body of a DATA heredoc: its delimiter is quoted or nothing in it expands, and it is consumed by
    `cat >[>] FILE` or `git commit|tag -F -`, alone in its pipeline;
  - a pipeline made only of read-only verbs, with no redirect and no option that writes.
  A `cat` body is still read whenever anything in the command could run the file it wrote: an interpreter, a
  shell, `source`, `.`, `xargs`, `eval`, `iex`, `Start-Process`, or a PowerShell `&` call. Write targets are still
  judged, by spelling and by where they land. Link creation and the cd-into rule still read the whole command.
  The PowerShell tool keeps the whole-text reading. Anything the lexer does not understand also falls back to the
  whole text, so it fails closed. The code rule now also refuses a protected spelling anywhere in the code's text,
  for example an assignment `P=src/core/x`, not only as a separate operand.

- **Claims check: a bare-number `expect` must be a whole output line.** Unanchored, `"1"` matched any digit in
  the output, including a date inside a "No such file or directory" error for a vanished evidence log, or the
  "1" in "10", so a dead claim passed. A number-only `expect` is now anchored to a full line; any other `expect`
  is unchanged.
- **Tier runner warns when the running Node is not the one `.nvmrc` declares** (exact `x.y.z` only), since CI runs
  that one and a local result on another Node may not reproduce there. Warning only; exit unchanged.

- **Parallel seats clobbering the board.** The playbook makes `<boards>/<key>.md` the one progress
  surface but gave no rule for two seats writing it at once. A row flip is a read-modify-write of
  the whole file, so concurrently dispatched seats overwrite each other — observed in an adopting
  project, where two parallel FIX lanes welded three stray status cells onto line 1 of the board and
  both lanes noticed and repaired it independently. Added *One writer at a time* to
  `skills/build-module-pipeline.md` and `adapters/claude-code.md`, and cross-referenced it from the
  narrow-FIX-lane step: when more than one seat is dispatched at once, the orchestrator becomes the
  board's only writer and seats report row outcomes instead. Sequential dispatches are unaffected —
  the rule is about concurrency, not trust.

## [0.13.2] — 2026-09-13

### Added

- **`verify` fails on a ledger left at a default path that §16 moved.** Fixing the writer does not find
  what the writer already wrote: a repo that ran the buggy upgrade still holds the blank twin, and every
  checker reads §16, so all of them pass over it in silence — which is the entire failure. The check names
  each surviving file, the §16 key that moved it, and what to do (move any content into the §16 copy, then
  delete). It looks only for the kit's own filenames, and only for a ledger §16 actually moved, so a
  project with an unrelated `tasks/` directory and a default install are both untouched — a test asserts
  the default install is not accused.

### Fixed

- **The installer honours §16 `paths` — it was the last reader that did not.** An adopter who keeps
  project history elsewhere moves the ledgers and records the move in §16; `verify`, `check-ledgers`
  and the board tooling all followed, but `unpack` kept copying to its own defaults. Because
  copy-if-absent asks the DEFAULT destination whether it exists, and at a §16 install it never does,
  the documented upgrade path — re-run the CLI — re-created a blank board directory, a blank
  `DEFERRED_TASKS.md` and a blank `DECISIONS.md` at the repo root beside the real ones. Nothing
  mechanical objected: the checkers read §16 and stayed green while a person, a search or a later
  script reaching for the root file found an empty ledger wearing the kit's own header, which reads
  as "nothing decided" with the authority of a real file. The board rules, the session-board
  template, the registry and the decision log now install at `paths.boards` / `paths.registry` /
  `paths.decisions`; with no profile the defaults are unchanged. The brief template is not a ledger
  and stays at `specs/`. Dogfood tests assert both the first install and the re-run; their red twin
  reverts the installer and shows all three files back at the root.
- **The pointer block no longer names ledger paths it cannot know.** The agent-instruction block the
  installer writes told every agent that boards live in `tasks/` and deferrals in
  `DEFERRED_TASKS.md`, and it is written once and never rewritten — so at a §16 install it named the
  wrong homes for the life of the repo. It now points at §16 `paths` instead, which cannot go stale.
- **Profile §11 no longer contradicts §16.** The template's human-readable ledger list hardcoded the
  same two defaults next to the settings block that makes them configurable; it now asks for the §16
  values, with a line saying the two must match.
- **The no-Node fallbacks install the CLI's ledger set, and cannot plant a twin.** `scripts/unpack.sh`
  and `unpack.ps1` had no test in the suite and had drifted: neither ever learned to install
  `DECISIONS.md` or the session-board template, so a no-Node adopter received a smaller kit than a Node
  one and nothing said so. They also cannot read §16 — `/bin/sh` has no guaranteed JSON parser — so at a
  moved install a re-run copied blank ledgers to the defaults. Rather than pretend to parse the profile,
  they now treat the ledgers as first-install-only: a profile already present means the ledgers already
  exist, so copying again could only duplicate. They skip the ledgers there, name the CLI, and still
  install everything else, so a re-run remains a valid repair. Tested both ways, skipped where there is
  no POSIX sh.

### Verified, not changed

- Every other §16 path consumer was already correct — `board-check-all`, `board-render`, `board-watch`,
  the render hook, `fix-rate`, `ledger-row`, `claims-check`, `handoff-pack`, `handoff-check`,
  `mutation-step` and `line-citations-check` resolve `boards`, `registry`, `decisions`, `handoffs` and
  `logs` from the profile. The installer was the last blind reader; a sweep confirmed it rather than
  assuming it.

## [0.13.1] — 2026-09-12

Two upstream fixes (released there as 0.12.2 and 0.12.3) merged into this line, which branched at
0.12.1 and never carried them. Renumbered rather than back-inserted: in this line they follow
0.13.0, and a changelog that says otherwise is a changelog nobody can date a bug against.

### Fixed

- **The kit runs under a host whose `package.json` says `"type": "module"`.** Node decides how to load a
  `.js` file from the nearest `package.json`, so in such a host `cli.js` and every hook were loaded as ES
  modules and threw on their first `require()`. For a `PreToolUse` guard that is a guard that crashes and
  lets the tool call through — the failure this kit exists to prevent, and one its own suite could not see
  because it ran in a CommonJS host. `builder/package.json` now pins the kit to CommonJS, and the five hooks
  ship as `.cjs` so the copies installed into the host stay CommonJS wherever they land. A dogfood test
  unpacks into an ESM host and runs every installed hook; its red twin deletes the package.json and shows the
  `require is not defined` failure. The settings snippets in `adapters/claude-code.md` name the `.cjs` files,
  and so does every other live pointer — including `hooks/protected-paths-precommit.sh`, which the upstream
  sweep missed. The one `.js` name left standing is in this file's own history, where it was true.
- **`verify` and `check-ledgers` read the ledger paths from §16.** Both looked at the installer's defaults
  (`tasks/`, `DEFERRED_TASKS.md`) whatever `paths.boards` and `paths.registry` said, so an adopter who moved
  the ledgers as the profile allows failed `verify` — and `check-ledgers` looped over a directory that was no
  longer there and printed PASS over nothing. Each now reads §16 (defaults unchanged with no profile), and
  `check-ledgers` fails with `LG-0` when the boards directory is missing or holds no board, naming the path it
  looked in: an empty input set is not a pass. Its `LG-3` message names the configured registry too. The report
  prints forward-slash paths on every host, since the path is what a person cites. Note the ordering this
  imposes: wire `check-ledgers` into CI once the first board exists, not before.
- **Ledger columns are resolved by header name, and a row that does not match its header is refused (LG-6).**
  Every rule read a fixed position — status at index 3, evidence at index 4 — so a ledger whose rows carry one
  column fewer than their header did not fail that read: it passed it, against the wrong cell. On a real board
  whose `FIX-*` rows omitted the `Cites` cell the gate reported hundreds of "status not in vocabulary"
  violations quoting the evidence prose, while the statuses themselves were never examined. `parseTables()`
  keeps each header with its rows and `columnsOf()` finds id, status and evidence by name, so a column inserted
  before Status moves nothing; a table with no id-and-status header pair is not a ledger table and is skipped,
  as the old id-shaped row filter skipped a board’s phase table. LG-6 names both cell counts and the header,
  and the row is not read — a missing cell or an unescaped `|` in prose is a board defect, not a status.
- **A status cell is read for the term it claims, not for its typography.**
  People write ledgers in markdown, for people: `**DONE**`, `DONE 2026-09-03`, `**DONE (2026-08-26)** — CP3 B4`.
  All three claim DONE and an exact-match gate failed all three. On one repo’s ledgers that was 146 findings of
  which 127 were emphasis and annotation — and a gate that fails on bold teaches its readers to skip it, so the
  nineteen that were REAL (`OPEN`, `BUILT`, `CLOSED — by observation`, `needs-ruling`) went unread with the rest.
  Emphasis is now stripped wherever it appears and the cell must BEGIN with a vocabulary term, the remainder
  starting at a separator; the longest term wins, so `IN-PROGRESS` and `NOW UNBLOCKED` survive. `DONEISH` and
  `CLOSED — by observation` still fail. The evidence rule follows the claim, which is the half that bites: a row
  whose markup used to fail LG-2 now resolves to DONE and its missing evidence becomes the finding.
- **An escaped pipe is a literal, not a cell boundary.**
  Markdown spells a literal `|` inside a table as `|`, which is how a row quoting a command
  (`grep -iE "clock|date"`) is written. The parser split on every pipe, turning one cell into three and
  reporting the row as ragged — 62 of one repo’s 80 LG-6 findings were this, and the rows were fine. The
  split now honours the escape and the cell text has it removed, so a rule reads what a person sees.
- **The board tooling reads `paths.boards` from §16, and a nested boards directory keeps its root.**
  The same assumption was in four more readers. `board-check-all` walked `tasks/` and crashed with `ENOENT`
  once the boards had moved; `board-render <key>` resolved a bare key against `tasks/`; `board-watch` and the
  `board-render.cjs` hook swept `tasks/`. Deeper than the path: `board-render` and `board-freshness` took a
  board's **grandparent** as the repo root — true only in the installer's default layout — so a board nested
  two levels down looked for its run log and its profile in the wrong place, found neither, and the freshness
  gate reported *not applicable*: a stale page passed. One `profile.rootOf(dir)` now walks up to the nearest
  ancestor holding `PIPELINE_PROFILE.md` or `.pipeline/` (the grandparent stands in when nothing marks a root,
  so a fixture in a bare temp directory behaves as before), and every board reader uses it. `board-check-all`
  fails with the path it looked in when the directory is missing. Dogfood tests move the boards two levels
  down and drive all four.

## [0.13.0] — 2026-09-11

### Every rule the pack stated without a command now has one

The pack wrote down rules it shipped nothing to hold: the board's `Cites` column with no resolver, a
"seam with no motor" invariant class asking for "the mechanical check + its allowlist" with none
shipped, a line-count gate on the instruction file named in `tooling/PORTING.md` with no gate, a
"never re-baseline to green" rule beside a `--write-baseline` that absorbed every new finding in one
motion, and two experiments whose measurement was prose. This release ships the command for each —
every one ported as a mechanism from the source project, with everything project-specific moved into
§16, and every one `off` (or experimental) until an adopter says what their project has.

### Added

- **`citations-check`** (`features.citations`) — every board `Cites` id in a declared scheme must
  resolve to its source (`{ csv, column }` · `{ dir, filePattern }` · `{ files, idPattern }`); prose
  is not-evaluable, never failed. A scheme whose source yields zero ids fails (the positive control),
  and so do boards with no `Cites` column at all. Playbook: P1, right after the board is created.
- **`line-citations-check`** (`features.lineCitations`) — a catalogue cited by line number instead of
  by key. Positive control first; an optional shrink-only roster for a backlog being swept (a dead
  entry fails, and so does a `total` above the count); `--stale` measures cited vs actual lines.
  Playbook: end of P2 and P5.
- **`wiring-check`** (`features.wiring`) — declared seams with nothing on the other end, inventoried by
  per-kind `declare` / `join` patterns; an allow file for seams a person rules latent (reason and
  citation required, dead waivers fail); zero inventory or a mandatory kind with no seams fails.
  `examples/wiring/` holds the kinds for a TypeScript dependency-injection service. Playbook: end of P2.
- **`instruction-budget`** (`features.instructionBudget`) — the agent instruction files stay under
  `maxLines`; a missing listed file fails. Playbook: close-out.
- **`decision-index`** (`features.decisionIndex`) — the index of decision ids derived from their
  anchors (headings, decision-log rows); `--check` fails on a stale index, an id cited but never
  anchored, or one anchored twice. Playbook: close-out.
- **`ratchet-refresh`** (`features.ratchets`) — shrink-only gap lists moved by measurement only: a
  newly measured item is refused, a covered one drained, and the list and its ceiling live in one
  file and move together. Playbook: after the behavioural run.
- **`examples/jest-tier-runner/instruction-trailer-check.mjs`** — the CI entry for the shipped
  `instruction-trailer.cjs`.
- **Experimental instruments ship** — `tooling/experimental/graph-trial-report.mjs` (the graph-trial
  measurement from the harness's transcripts, claimed vs counted side by side, the control group
  flagged) and `tooling/experimental/persona-gen.mjs` (role profiles generated from a permission
  catalogue; `--check` holds the generated half to the catalogue and every drafted bullet to
  `citationPattern`). `features.graphTrial` gains `seats` + `callPattern`; `features.personas` gains
  the catalogue keys.
- **The knowledge-index example meets the whole contract** — `tooling/optional/sync.py --check`
  (facts line, exits `0/3/4/10/11/12`), `autosync.py` (one entry for every trigger: lock with
  stale-holder reclaim, embed only within `INDEX_AUTO_LIMIT_KB` and only through `INDEX_EMBED_COMMAND`
  — no model CLI assumed — status file, exit `20` on a held lock), and `session-sync-hook.js` (the
  Claude Code session-start trigger, copied never armed). `sync-hook.sh` now runs `autosync.py` on
  the branches in `BASE_BRANCHES`. New env vars: `INDEX_ROOT`, `INDEX_OUT_DIR`, `INDEX_AUTO_LIMIT_KB`,
  `INDEX_EMBED_COMMAND`, `INDEX_PENDING_FILE`, `INDEX_SYNC_SKIP`, `INDEX_STALE_LOCK_SECONDS`,
  `INDEX_PYTHON`, `INDEX_AUTOSYNC_SCRIPT`.
- **`repo-audit` ships its synthesis seat and its Claude Code fan-out** —
  `skills-extra/repo-audit/agents/repo-auditor.md` and `audit-workflow.js` (launched only on explicit
  opt-in; every project value in `args`). The sweep gains the invariant lens.

### Changed

- **`contract-oracle` baselines are shrink-only.** A plain `--write-baseline` prunes resolved entries
  and refuses while any new finding exists; `--accept "<key>"` carries one by name; `--initial`
  records everything only when no baseline exists yet. **Upgrading:** a script or CI step that called
  `--write-baseline` to absorb new drift now exits 1 — name the keys, or use `--initial` on a first
  baseline.
- **`unpack` installs personas that ship inside an extra** (`skills-extra/<name>/agents/*.md`) the way
  it installs `agents/*.md`; `--no-extras` skips them.
- **Settings validation** checks the new list shapes at load (schemes, kinds, lists; unique names; the
  wiring kind's `scope`, `optional` and `detail`), so `features.mjs` never reports a profile valid
  that a script would reject mid-run.
- **Playbook** gains the `not configured` branch for each new check; `DISCOVERY.md` gains a row per
  feature; `EXPERIMENTS.md` §2 and §4 describe the instruments that now ship; the claude-code, codex
  and generic adapters describe the session-start trigger.

## [0.12.1] — 2026-09-11

### Fixed

- **A spend total with unmeasured seats now says it is a floor.** The live board summed only the seats it
  could measure and printed that sum as the run's spend, beneath rows showing an em-dash — an incomplete
  figure that read as complete. The run summary, the agents footer and the `--json` run document now print
  `≥ $x · n seats unmeasured`, and the footer's wall-clock and token sums carry `≥` too. A fully measured
  run is unchanged.
- **A section too large before its first row is refused with the true reason.** `page-docs` blamed the
  first row when a section's title, subtitle and columns alone exceeded the per-document cap; it now names
  the envelope, with or without rows, and still never drops the section.

## [0.12.0] — 2026-09-11

### The pipeline gains its instruments and its script checks — and every one of them is optional and says so

This release ports a round of improvements proven in the source project, as **mechanisms**, with everything project-
or stack-specific moved into `PIPELINE_PROFILE.md` or an adapter. Five further ideas ship as **experiments** and two
as **unmeasured defaults** — `EXPERIMENTS.md` names the measurement that promotes or removes each. Nothing in this
release assumes a language, a contract format, a permission catalogue, a knowledge index or a mutation tool: a
project without one gets a working pipeline, and the missing feature prints `<feature>: not configured` instead of
crashing or passing.

**The pack now lives in its own repository** and is released as an archive (`git -C builder archive …`, see
`UNPACK.md`). Receive releases as archives; a working copy with a `.git` inside belongs to the pack's maintainers.

### Added

- **Settings — `PIPELINE_PROFILE.md` §16.** One ` ```json pipeline-settings ` block: commands (with `{tier}`), paths,
  models, protected globs, and 21 features each in a declared state (`on` · `off` · `unmeasured` · `experimental-off`
  · `experimental-on`). `scripts/lib/profile.cjs` validates it — a feature switched on without its required keys is an
  error, never a silent skip, and a misspelt feature name is an error. `node scripts/features.mjs` and
  `node builder/cli.js features` print every state; `cli.js verify` refuses an invalid block.
- **Checks that catch record-class defects before review.** `claims-check` (re-runs counts, anchors `file:line`
  citations, refuses retracted phrases and ownerless "owed" notes) at the end of P2 and P5; `output-check` for the plan
  (sections and table headers from the profile, optional catalogue oracle), the auditors' findings JSON and the
  reviewer's review file (`skills/references/review-template.md`); `handoff-pack` + `handoff-check` — P7 cannot close
  without one handoff file per run, sections §A–§F, each with a `RESPONSE REQUIRED` line.
- **Instruments.** Per-seat cost read from each seat's own transcript, background dispatches included, with the
  orchestrator's own turns scoped to the run (Claude Code; other harnesses render em-dashes); a versioned rate table
  with both cache-write TTLs; `orchestrator-check` (warns when a session is not on the declared orchestrator model);
  `cost-window`, `seat-peaks`, `fix-rate`.
- **Optional checks behind interfaces.** `contract-oracle` with an OpenAPI 3 adapter (`oracles/openapi3.cjs`) judging
  served status codes, query parameters and error-code families against a baseline; `rules-module`, a structural-rules
  runner interface keyed without line numbers (ast-grep TypeScript rules under `examples/`, not a default set);
  `mutation-step`, non-blocking, reading the mutation-testing-report schema (Stryker named as one example);
  `index-check`, the knowledge-index freshness exit-code contract behind the P1 gate.
- **Row readers.** `ledger-row` prints one registry or board row with its section and real header, so seats never read
  a whole ledger.
- **Board tooling.** `## Todo`, `## Definition of Done` and `## Modules & endpoints` sections; a `decision` run-log
  event; `board-render --json` writes one document per section, split and never truncated; the declared orchestrator
  model is read from the profile.
- **Claude Code hooks** (`hooks/claude-code/`, copied by the installer and never armed): an output cap for the
  orchestrator's shell results that never drops an error line, a registry read guard, and a reviewer guard that holds
  the reviewer to its one review file.
- **The pack tests itself.** `node builder/tests/run.mjs` — node:test over synthetic fixtures, no project needed —
  including an adopter dogfood that unpacks the pack into a throwaway Python project with every optional feature off,
  and a prose self-test that holds the playbook, seats and adapters to the scripts the pack actually ships.
- **Experimental, opt-in with `unpack --experimental`:** the read-only live page and its keeper seat
  (`tooling/experimental/page-shell.*`, `agents/experimental/page-keeper.md`), script-driven runs, the graph-seat
  trial, role persona profiles, a builder on a mid-tier model with a strong advisor, and a blocking mutation threshold.

### Changed

- **Playbook.** Orchestrator model check before step 0; the index freshness gate at step 0 refuses the planner on an
  unrecorded non-zero exit; builder dispatched in batches of `features.builderBatch.rows` (default five — unmeasured)
  reading rows through `ledger-row`; the narrow FIX lane in the loop-back (unmeasured, judged by `fix-rate`); rule hits
  handed to the vuln-auditor, who must account for every line; **stop at `run.end`, one run per session**; the board
  file is the one progress surface — no harness to-do mirror; the handoff is a file, never a table in a chat report.
- **The "subagents cannot spawn subagents" premise is retracted.** Harnesses may nest; the pipeline caps it where it
  can (Claude Code: spawn depth 1), and the no-nested-run rule rests on run ↔ branch ↔ board ↔ version bump.
- **Seats.** The reviewer writes its own review file (neutral `writes:` field; Claude Code maps it to one guarded
  write); the four auditors return a findings JSON block; the tester moves to the strong tier; the docs seat carries
  `effort: low`; the planner holds to the fixed plan shape.
- **DESIGN.md** gains the principles behind this release — instruments before savings, scripts before reviewers, a
  figure in an instruction file is read from its source by a test, an instruction with no runnable command is
  decoration, every optional check is declared, one run per session, decide harness settings by replay, ship unproven
  ideas as experiments — and loses the source project's exact figures.
- **Adapters.** `claude-code.md` holds every Claude-Code-only step (hooks, spawn depth, cache TTL guidance, effort,
  transcript accounting, the live page, Workflow runs, the advisor); `codex.md` and `generic.md` say what each becomes
  without that harness, or that it is unavailable.
- **Run-economy scripts moved** from `tooling/` to `examples/jest-tier-runner/`: they are one jest implementation of
  the tier-runner interface, not the pack's runner for every stack.
- **Installer.** Installs every script and lib by walking `scripts/`, the oracle adapters, the playbook references and
  the Claude Code hooks; maps comma-listed capabilities and `writes:`; passes `effort:` through. **Node 18 or newer.**
- `board-progress.mjs` requires a board path (it used to fall back to a board file of the source project).

### Fixed

- `cli.js check-ledgers` read the **Cites** column as the status on the pack's own board format, so valid boards
  failed; it now reads Status, accepts `DONE <date>`, counts `IC-n` rows and skips `_*.md` templates.
- The no-Node unpack fallbacks missed libraries the renderer now needs.
- House references removed from templates, optional tooling and extra skills.

### Upgrading from 0.11

The installer is copy-if-absent, so it never overwrites an installed file. Unpack 0.12.0 into a clean directory with
the same `--tool`, diff it against your installed `.claude/` or `.builder/` and `scripts/`, and take what you want;
then add §16 to your `PIPELINE_PROFILE.md` (start from `PIPELINE_PROFILE.template.md`, switch on only what your project
has) and run `node builder/cli.js verify`.

## 2026-08-28 — status-and-next (generic port from the source repo)

- **`skills-extra/status-and-next/`** — the session-start planning pass: re-verify repo + tracker +
  deferred-registry state from scratch (trust nothing cached — the near-issued dead brief lesson),
  report deltas and owed status flips with ownership, then emit the single next unblocked item as a
  full module brief. Read-only except the report; flags-never-acts on irreversible items. Count
  tracker status columns by header index, chase every cited blocker to its current authority, and
  never sweep another party's dirty files into a commit.

## 2026-08-28 — the live run board (generic port from the source repo)

- **`scripts/board-render.mjs`** — renders a task board to one self-contained `tasks/<key>.html`:
  run header, ceiling, gates, findings, phases, rows, deferred, step timeline, files produced,
  per-seat accounting, and the raw markdown. No external asset of any kind, so it opens from
  `file://` offline; it reloads itself every 20 s and shows its own age.
- **`scripts/board-watch.mjs`** — watches `tasks/` and `.pipeline/`, re-renders only what the
  freshness check calls stale, sweeps on a timer as a backstop, and never fails a run. Started once
  per run by the orchestrator; **a coder flipping a row to `IN-PROGRESS` moves the page by itself**,
  which is the point — no new event, no new instruction for a seat to forget.
- **`scripts/lib/*.cjs`** — the six readers: board parser (reusing the one row vocabulary),
  append-only run log, transcript usage, pricing, freshness, row ids.
- **`board-check-all.mjs`** gains a second check: a rendered board older than its own run log fails
  the gate, exactly as a stale progress bar does. `--fix` re-renders. Both opt-ins are independent.
- Playbook + `tasks/README.md` template: the run-log event table, the one-writer rule, and the
  `ceiling` event — how a run says out loud that it will not reach what it set out to.
- **Accounting is not self-reported.** Model, wall clock and tokens per seat come from the harness's
  own dispatch records; an agent reporting its own cost is reporting a number nobody checked. A
  harness that keeps no such record yields em-dashes, and everything else still works. Absence
  renders as absence throughout — never `0`, never `$0.00`.

## 2026-08-26 — run economy + hardening (generic port from the source repo)

- Orchestrator playbook gains "Context & run discipline": digest-wrapped suite runs (never bare),
  selective-is-inner-loop-only, free-memory worker sizing note, `state.md` + compact-safe phase
  gates, the six-field dispatch header, findings-field validation, knowledge-index entry refresh.
- Profile: the test seat moves to the top model tier (first full verification; adversarial work).
- Tester brief: full-suite + digest-not-raw run discipline.
- **tooling/** added: the six generic run-economy scripts (run-tier, capacity, tier-lock, digest, affected, instruction-trailer) + PORTING.md naming the four localization knobs per file.
- **tooling/optional/** added: caveman token-saver hook (needs the user-level skill too) and the graphify auto-sync pair (needs the graphify tool) — shipped un-wired, with install notes.
- Deliberately NOT ported (source-repo-specific): graphify mechanics, the jest capacity governor
  and tier-lock scripts (adapters may copy them), the instruction fence hook, `DALIL_*` unlocks.

## [0.11.0] — 2026-08-25

### Added — phases 0.5, 3b, 4d and 6.5: the pipeline stops asking only one question

**Read this first, because it changes what the badge means.** Everything in 0.10.0 and earlier was
exported *after* it had survived real module builds. This release is not: the mechanisms below are
proven **in design** — each one is the direct answer to a measured failure in the source project —
but the four new phases have not yet run end to end there. Exported at the maintainer's explicit
call. Treat the shapes as sound and the ergonomics as version 1.

**The measurement they answer.** An estate with well over a thousand passing behavioural
assertions, a full operation × role permission matrix, dozens of integration suites and hundreds of
end-to-end tests — fully green — was hunted for one question none of those tiers asks, and returned
**dozens of findings, most confirmed live**. Every existing tier asked *"may actor X call operation Y, and does it return the
right code?"* **None asked whether the system was still coherent afterwards.** Two of the four worst
findings were not in the domain code at all.

- **Phase 4d — `invariant-auditor`** (9th persona, read-only, joins the existing parallel fan-out as
  a 4th dispatch in the same message). Walks a coherence taxonomy per aggregate. Ten seed classes:
  four tagged **universal** (reflexive · last-of-kind · seam-with-no-motor · absence-proof), six
  tagged **domain** and expected to resolve `N/A` outside a workflow-and-approvals system — profile
  §15 is where a project writes its own, because a class earns its place by having been paid for.
  Governing clause, worth copying into anything similar you build: **observe, do not rule.** A
  finding only where a ratified source *states* the control; everything else is `NEEDS-RULING` with
  observed behaviour and **no expectation attached**, because an auditor that supplies the missing
  expectation has become the author of the requirement it audits.
- **Phase 6.5 — behavioural gate.** The only phase that runs the **real application**; phases 1–6
  all read statically or test in-process, which is a second ceiling underneath the declaration one.
  Delta-scoped so it blocks on new failures without being hostage to estate-wide reds; disposable
  targets only; a recorded skip is CHANGES-REQUIRED, never an invisible pass.
- **Phase 3b — contract & effect drift.** Deterministic, seconds, zero model tokens. Catches the
  transition that silently stopped auditing. Re-baselining an oracle to green needs a registry row,
  never a silent hash bump.
- **Phase 0.5 — track selection.** FULL · ADDITIVE · PLATFORM · RULINGS · FIX · SOLO, so five
  natures of work stop sharing one shape. Any diff touching production source is FULL or ADDITIVE;
  a track escalates **up** mid-run and never down. Out-of-scope work becomes a `SPLIT` finding — a
  registry row plus a *proposed* separate run. **The pipeline never starts another pipeline**:
  subagents cannot spawn subagents, and a nested run has no answer to *whose board, whose registry
  rows, whose version bump* (a premise retracted in 0.12.0: harnesses may nest; the rule rests on
  run ↔ branch ↔ board).
- **Digest-first planning.** The planner authors the invariant candidates, the coder consumes them
  as `IC-n` board rows and never writes them, the tester covers them as adversarial stories,
  MERGE-READY requires each one covered-and-named or deferred. Three seats, so the author of the
  code is never the author of the questions about the code. In the source project many module digests existed
  while exactly **one** story pack did — that is what "optional" produces.
- **Triaged blockers** — `DECIDED-FROM-DOCS` (decide, record, continue) · `NEEDS-RULING` (proceed on
  a stated assumption) · `BLOCKING` (stop). Only the third halts a run. Most escalations in
  the source project were already answered by its own requirement register.
- **`DESIGN.md` §14 — the declaration ceiling**, the principle under all of it: every tier derived
  from a declaration inherits that declaration's blind spots, and no amount of extra assertions
  moves the ceiling. Buy a second question instead.
- **Persona and profile updates:** planner (digest, track confirmation, triage), coder (`IC-n`
  consume-never-author), tester (story coverage, observer-must-throw, per-run fixture salting),
  reviewer (four auditors, candidate coverage, behavioural-gate result). Profile **§14 is now
  required** where the app can be containerised — it is read by three phases — and **§15** is the
  project's own taxonomy.

### Added — board mechanics (proven, no evidence debt)

- **`scripts/board-progress.mjs` + `scripts/board-check-all.mjs` + `templates/session-board.md`** —
  a task board whose progress bar is *computed from the Status column*, never typed, plus a
  repo-wide freshness gate. It found a board reading **0% while sitting at 8 of 12 done** the first
  time it ran. A bar looks like an output even when it is an input.
- **`cli.js unpack` installs the board scripts and the session-board template**, and `verify` checks
  for them. Shipping the board *rules* without the scripts that enforce them leaves the rule resting
  on discipline, which is the thing this kit exists not to do.
- **`templates/task-board.md` aligned** with the mechanism: phase-status block, `progress:auto`
  markers, counted sections (`## P<n> —` phases / `## B<n> —` batches), a `Cites` column,
  IN-PROGRESS-before-work, opt-in/convert-on-touch, and the `_*.md` / `README.md` skip — without
  that last one the checker writes a fabricated bar into your documentation, which it did on its
  first run.
- **`DESIGN.md` §8** gains *a status summary is computed, never typed*, with the `Cites` corollary:
  an unchecked citation is just a more confident-looking invention.

## [0.10.0] — 2026-08-19

### Added — qa-audit Phase C: the layer a declaration-derived suite structurally cannot reach

Phases A1–A7 all derive their scenarios from a **declaration** — a requirement row, a permission
matrix, a state machine, an effect inventory. That is a ceiling, not an oversight: no derivation
reaches a case no declaration mentions. Two escapes proved it in production — an administrator
deactivated **his own account** (permission held, target existed, transition legal: a correct `200`
by every declared measure), and a duplicate unique field returned **500** while the pack asserted
`!is2xx`, which a 500 satisfies. Phase C is for that class.

- **Global transcript invariants** — a post-pass over EVERY call the run made, not the calls a test
  aimed at: nothing 5xx's, every 4xx carries the house error shape, no body leaks a hash, stack
  frame or session token. Deterministic, free, works on read-only targets, and it closes the
  duplicate-field-500 *class* rather than one field at a time.
- **`templates/invariant-registry.md`** — reflexive (caller == target) and system-safety (the last
  of something that cannot be recreated) cases, plus the discipline that keeps them honest: the
  auditor **observes**; an `unruled` entry is reported `NEEDS-RULING` and routed to a human, never
  asserted. Inventing the expectation makes the audit the author of the requirement it audits.
- **Hostile-input battery** — generated from the API schema, asserting only *shaped refusal, never
  crash*. No business outcome, so it stays pure generator code and covers every future module free.
- **`templates/module-digest.md`** — the semantic model of a bounded context, split by volatility:
  authored judgement frozen above a marker, derivable facts regenerated below it so they cannot rot.
  `covered` must name what covers it; staleness is a gate.
- **`templates/story-pack.md`** — the 7-axis adversarial taxonomy (wrong-actor · wrong-time ·
  reflexive · lifecycle · interleaving · cross-module · identity-abuse) as a completeness guard, and
  a mechanical ban on assert-by-absence-of-success in story files.
- **Seeded monkey walk** — random, stateful, replayable from one integer, asserting only the
  universal invariants because it has no model of any endpoint.
- **Profile §14** gains two seams that make the otherwise-generic Phase-C code portable:
  **Conventions** (API prefix, error shape and code pattern, statuses exempt from the shape rule,
  concurrency/idempotency headers, pagination contract) and **Disposable actors** (how to mint an
  actor a probe may destroy, and which capability can undo each destructive verb — if only the actor
  being destroyed holds it, that verb is terminal and belongs in the registry).

### Added — rules earned the hard way
- **An observer that cannot observe must THROW, not return empty.** A store probe that swallowed its
  connection error and returned "not found" made every negated assertion over it pass while
  observing nothing — hiding a critical session-revocation defect behind well over a thousand green assertions.
  *A negated assertion over an unobservable value is not a test.*
- **When a probe asserts absence, prove it could have observed presence.** Twice this pattern
  produced a *phantom guard*: a refusal that looked exactly like the protection under test but came
  from an unrelated gate, or from the probe's own malformed request. Positive controls, and
  "inconclusive" as a first-class outcome.
- **A pack must not assume an empty database.** Ephemeral targets make the assumption true and hide
  every violation of it.
- **Shift EVERY published port** in the disposable stack — one unshifted port takes down the whole
  bring-up.
- **The honesty boundary.** A green run means *"every declared behaviour held"*, never *"the system
  is sound"*. An invariant hunt on the source project found dozens of findings, most confirmed live, against
  a fully green suite; business invariants and infrastructure posture are not reachable from a route
  inventory, and the skill now says so.

### Rationale
The 0.9.0 kit could tell you what your suite did not *exercise*. It could not tell you what your
suite could not *express*. Phase C is that second gap, and its cheapest layer — global invariants —
is a few hundred lines that would have caught both production escapes on their first run.

## [0.9.0] — 2026-08-04

### Added — qa-audit: the real app, real infra, requirements as the oracle
- **`skills-extra/qa-audit/`** — pattern skill for an audit tier that runs the REAL application on
  real infrastructure with nothing stubbed, asserting what the business asked AND what it forbade,
  plus every declared side effect. Complements `e2e-harness` (contract oracle); build it second,
  since it reuses those scenarios through a second transport.
- **Profile §14** — the project-specific surface the skill reads: requirement source, what counts
  as a side effect in this stack, environments, redaction fields, artifacts and commands.
- **`templates/qa-targets.md`** — environment config shape, carrying the safety rule inline.
- **`templates/requirement-pack.md`** — the four-verb pack vocabulary (`assert` · `by-design` ·
  `gap` · `skipped`). Its absence is what makes a documented deferral surface as a false defect.
- **`cli.js check-targets`** — mechanical gate: a target whose DATASTORE is shared may not be
  destructive; an attached target must declare `shared` explicitly; credentials may not be
  embedded. Also fails when the skill is installed but no config exists — a silent pass there
  would leave the only rule that can take down a team environment unguarded.
- **Setup step 6b** fills §14 and writes the target config; **DISCOVERY** now marks environment
  rows `⚠ CONFIRM` and defaults to `shared: true` when unsure.
- **Adapter notes** for claude-code / codex / generic: probes and pack authoring fan out, the RUN
  never does — two runners against one environment corrupt each other's fixtures.

### Rationale
Proven on a production modular backend: hundreds of assertions over real HTTP surfaced that **a majority of
the declared audit actions fired in no scenario at all**. A green suite was implying coverage that did
not exist — which no contract-level oracle can detect, because a transition that silently stops
auditing changes no route, no schema and no permission key.

## [0.8.0] — 2026-08-03

### Added — harness-aware model & settings selection at setup
- **`cli.js unpack --models strong=<x>,mid=<y>`** — per-install tier→model override for
  native-format targets (baked into installed agent frontmatter); validated; defaults unchanged.
- **Profile §12 upgraded** from a static tier table to the per-harness record: tier→model per
  confirmed harness + "how a phase is launched at that model" + four harness settings (parallel
  audit dispatch · reasoning effort · permission/autonomy mode · tool-scoping enforcement).
  Tier→phase assignments stay fixed by the kit; only the model names are per-project.
- **Setup Phase 1 expanded (1a/1b/1c):** after target detection, the setup agent proposes the
  tier→model mapping by inspecting the USER'S harness config/subscription (never from the kit's
  memory — model line-ups go stale), plus the §12 settings; one batched confirmation; unpack
  runs with `--models`; non-native harnesses get their mapping written into §12 at discovery.

## [0.7.0] — 2026-08-03

### Changed — agent-agnostic pass (no harness is privileged)
- **Personas de-flavored:** all 8 agents now carry harness-neutral frontmatter —
  `capabilities: read-only|code|test-only|docs` + `tier: strong|mid` — instead of any specific
  harness's `tools`/`model` fields. Every harness consumes the same files as prompt text.
- **Adapter-side transform:** the CLI's claude-code target converts neutral frontmatter into
  Claude Code's native fields at install time (read-only → no edit tools; strong→opus,
  mid→sonnet). The kit source stays neutral; adapters adapt. (Script fallback copies untransformed
  — harness defaults apply.)
- Docs reframed: quick starts use `--tool <your-agent>`; Claude Code described as "one adapter
  among ten"; hardening steps in setup lead with the universal layer; new agent-agnostic badge.

### Added
- **`hooks/protected-paths-precommit.sh`** — universal, agent-agnostic protected-path guard
  (git pre-commit): rejects commits touching profile §4 paths regardless of which agent (or
  human) made the change; `BUILDER_UNLOCK=<tag>` grant supported. The backstop layer;
  harness-specific hooks merely intercept earlier. `hooks/README.md` rewritten as a two-layer
  enforcement matrix.

## [0.6.0] — 2026-08-03

### Added
- **`SETUP_PROMPT.md`** — single paste-into-agent bootstrap: drives the entire setup end-to-end
  (preflight → harness detection + one confirm question → CLI unpack → discovery → batched
  `⚠ CONFIRM` rulings → optional hardening offer → verify → planner dry-run → report). Solves the
  first-run chicken-and-egg: the prompt installs the skill.
- **`skills/setup-builder.md`** — the same procedure as an installed skill (4th core skill, all
  install paths updated): re-verify and **upgrade mode** (kit `CHANGELOG.md` diff, copy-if-absent
  re-run) for repos already onboarded.

- **`templates/developer-guide.md`** — generation template for a project-specific
  `DEVELOPER_GUIDE.md` (repo root): the team's 10-minute onboarding page, filled from the
  completed profile + setup state by setup Phase 7 (no-surviving-placeholder rule; diff-and-ask
  on regeneration in upgrade mode).

### Changed
- README quick start leads with the zero-thought path; CLI/scripts install the 4th skill;
  setup gains the guide-generation phase (old report phase is now Phase 8).

## [0.5.0] — 2026-08-03

### Added
- **`skills-extra/e2e-harness/`** — OpenAPI-driven full-API e2e pattern: contract-as-oracle
  scenario packs, per-operation drift gate (model regenerates only the delta), real-infra runs,
  deterministic-first cost model. Build playbook (Phase A) + operate loop (Phase B).
- **`skills-extra/repo-audit/`** — repo-wide read-only audit: gate baseline → per-module fan-out
  through the kit's three auditor personas → verify-before-accept → cross-module dedup +
  systemic-pattern extraction → one ranked report under `audits/`.
- **`skills-extra/adr/`** — house-format Architecture Decision Records: template, sequential
  numbering, Accepted-is-immutable + supersede flow, index + `DECISIONS.md` cross-linking,
  handoff-table integration for protected doc dirs.
- **`hooks/graphify-post-merge.sh`** — git post-merge hook: background incremental graphify
  re-extraction + `.needs_semantic_sync.json` marker for deferred semantic work; silent no-op
  until graphify is adopted. Manual enable (copy into `.git/hooks/`).
- **`CHANGELOG.md`** — this file.

### Changed
- `skills-extra/README.md` — table now covers all six utility skills + wiring notes.
- `hooks/README.md` — documents both hooks and the ledger-gate CLI command.

## [0.4.0] — 2026-08-03

### Added
- **`hooks/protected-paths.js`** — PreToolUse guardrail (Claude Code): blocks Edit/Write to
  `PIPELINE_PROFILE.md` §4 protected paths; `BUILDER_UNLOCK=<tag>` env grant for sanctioned
  platform work. CLI copies it; arming `settings.json` stays a deliberate human act.
- **`cli.js check-ledgers`** — five mechanical ledger gates, CI-ready exit codes:
  LG-1 unique registry ids · LG-2 in-vocabulary statuses · LG-3 `DEFERRED→id` must exist in the
  registry · LG-4 no unresolved `⚠ VERIFY` · LG-5 `DONE` requires named test evidence.
- **`templates/decision-log.md`** → installed as `DECISIONS.md`: append-only ADR-lite rulings
  index; pipeline close-out and USAGE stop-point C wired to it; planners cite `D-n` ids.

## [0.3.0] — 2026-08-03

### Added
- **`USAGE.md`** — human operator's runbook: the three stop points, phase-by-phase expectations,
  interruption/resumption, sub-module usage, troubleshooting table, cost pacing.

### Changed
- Docs modernized: shields badges + 10 Mermaid diagrams across `README` (pipeline map,
  quick-start strip), `DESIGN` (failure→mechanism map, firewall sequence, loop-back state,
  earn-DONE decision flow), `USAGE` (stop-point flow, board-row lifecycle), `UNPACK` (install
  flow), `DISCOVERY` (discovery loop). Personas and the profile template deliberately kept
  diagram-free (they load into agent context).

## [0.2.0] — 2026-08-03

### Added
- **`cli.js`** — zero-dependency Node unpacker: `unpack --tool <list|all>` across 10 harness
  targets (claude-code native; codex/opencode/generic → `AGENTS.md`; gemini → `GEMINI.md`;
  cursor → `.cursor/rules/*.mdc`; copilot; windsurf; cline; aider), marker-guarded pointer
  blocks, copy-if-absent safety, `--dry-run`, `targets`, `verify`.
- **`DISCOVERY.md`** — agent prompt that fills `PIPELINE_PROFILE.md` from the **target**
  project's own docs; undetectable decisions marked `⚠ CONFIRM` for one batched human answer.
- **`skills-extra/`** — bundled utilities: `caveman` (token-saver reply mode), `graphify`
  (repo → queryable knowledge graph; needs its Python package), `ledger-audit` (unearned-status
  audit, genericized). Installed by default; `--no-extras` to skip.

## [0.1.0] — 2026-08-03

### Added
- Initial extraction of the build-module-pipeline mechanism into a portable, project-agnostic
  kit: 8 generic persona agents (planner · builder · tester · standards/security/vuln auditors ·
  docs maintainer · reviewer), 3 workflow skills (pipeline orchestrator · scaffold ·
  readiness-check), ledger templates (module brief · task board · deferred registry),
  `PIPELINE_PROFILE.template.md` as the single per-project grounding file, `DESIGN.md`
  (12 principles + war stories), `UNPACK.md`, adapters (claude-code · codex · generic), and
  sh/ps1 fallback unpack scripts.
