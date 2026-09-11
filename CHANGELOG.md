# Changelog — builder kit

All notable changes to the kit. Format: [Keep a Changelog](https://keepachangelog.com); the kit
versions independently of any project it is pasted into.

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
