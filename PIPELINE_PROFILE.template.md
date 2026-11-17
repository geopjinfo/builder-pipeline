# PIPELINE_PROFILE — project grounding for the builder pipeline

> **This is the one file that makes the generic pipeline concrete.** Every persona agent loads it
> first and treats it as authoritative. Fill every section; where a section truly doesn't apply,
> write `N/A — <why>` (an explicit N/A is a decision; a blank is a bug). Keep it under ~330 lines —
> it is loaded into every agent's context. Link out to longer specs instead of pasting them.
>
> Install location: repo root, named `PIPELINE_PROFILE.md`. Delete this note block after filling.

## 1. Project identity

- **Project:** `<name>` — `<one-line description>`
- **Stack:** `<language / framework / ORM / DB / cache / runtime constraints (e.g. air-gapped, serverless)>`
- **Repo layout:** `<where modules live, e.g. src/modules/<key>/; where shared/core code lives>`
- **Architecture stance:** `<e.g. "modular monolith, architecture settled — execution not redesign"
  or "evolving — planner may propose shape changes as BLOCKERS for human ruling">`
- **Unit of work:** `<what one pipeline run builds — a bounded-context module, a feature slice,
  a service, a screen…>` referred to below as a **module**, keyed by `<moduleKey convention>`.
- **Visibility:** `private` (default) or `public`. Machine-read as `"visibility"` in §16. An account whose
  `content` is `public` or `scratch` launches only on a `public` project; an account with path roots sees only
  those roots. The kit never guesses: an unset value is `private`.

## 2. Commands (the agent runs these verbatim)

| Purpose | Command |
|---|---|
| Install | `<npm install / poetry install / …>` |
| Build / typecheck | `<…>` |
| Unit tests | `<…>` |
| Integration tests | `<…>` (note if excluded from the default gate run — then it must be run explicitly before merge) |
| Lint | `<…>` |
| Full gate suite | `<…>` |
| Coverage | `<…>` |

## 3. Oracles — closed catalogues; consult, never extend

> An oracle is a human-decided catalogue. Agents must use entries **verbatim**; a missing entry is
> a BLOCKER ("stop and flag an amendment"), never an invention.

| Oracle | File / source | Governs |
|---|---|---|
| `<e.g. permission catalogue>` | `<path>` | `<every route's authorization key>` |
| `<e.g. error-code registry>` | `<path>` | `<every error response code>` |
| `<e.g. workflow state machines>` | `<path>` | `<state names + legal transitions>` |
| `<e.g. requirements tracker>` | `<path>` | `<requirement ids, module scope, acceptance criteria>` |

> **No requirements tracker yet?** Switch on `features.specAuthoring` (§16): the `spec-author` skill writes one
> ratified `<specs>/<key>.spec.md` per module — requirement rows, acceptance criteria, API contract — before
> Phase 1, and that file is the module's row source here (`npx builder-pipeline run spec-check <key> --rows` prints the rows).

## 4. Protected paths — agents must never edit

| Path | Why | What to do instead |
|---|---|---|
| `<e.g. src/platform/**>` | `<stable core>` | stop and ask the human (a "boundary event") |
| `<e.g. docs/**>` | `<read-only mirror>` | an item in the handoff pack's §E |
| `<generated files>` | `<regenerated>` | edit the generator input |

## 5. Golden path — the template to replicate

- **Template module:** `<path to the reference/template module to copy>` — replicate its shape
  exactly; never invent a new module shape.
- **Scaffold recipe:** `<skill/doc name, e.g. the installed scaffold-module skill>`
- **Layering rule:** `<e.g. routes → controllers → validators → services → policies → repositories;
  controllers never touch the data layer; business rules live in pure policy functions; DB access
  only in repositories; one business op = one transaction>`
- **Boundary rules:** `<e.g. one module = one schema; no cross-module table reads; cross-module
  calls only via published facades; cross-module reactions via events; no cross-domain FKs>`

## 6. Cross-cutting contracts (byte-identical in every module)

- **Errors:** `<format, e.g. RFC 9457 ProblemDetails; where codes come from (oracle §3)>`
- **Validation:** `<e.g. schema validation at the boundary only; unknown fields rejected>`
- **Pagination / collections:** `<envelope shape; page-size cap>`
- **Idempotency / concurrency:** `<e.g. Idempotency-Key on mutators; optimistic locking via
  row_version + If-Match; which mutations are the "critical set">`
- **Async / side effects:** `<e.g. versioned events; no external I/O inside transactions; outbox>`
- **Audit / logging:** `<e.g. one append-only audit entry per transition; action naming rule;
  no secrets/PII in logs>`
- **AuthZ:** `<e.g. exactly one permission key per route, from oracle; scope check after
  permission; out-of-scope reads return not-found (no existence leak)>`
- **Data conventions:** `<money/decimal handling; timestamps; localized text; naming (files,
  resources, transitions)>`

## 7. Hard invariants + reference implementations

> Each row: an invariant that has bitten before, and the ONE in-repo reference the coder copies.
> "Copy these, don't reinvent."

| Id | Invariant | Reference implementation | Enforced by |
|---|---|---|---|
| I-1 | `<…>` | `<path>` | `<gate/hook/review>` |
| I-2 | `<…>` | `<path>` | `<…>` |

## 8. Gates — named, so findings can cite them

| Gate | Asserts | Runs in |
|---|---|---|
| `<G-1>` | `<…>` | `<CI / hook / arch-test>` |

(If the project has no named gates yet, name the checks the reviewer performs anyway — findings
must cite *something* stable.)

## 9. Test tiers (what "green" means)

- **Unit:** `<scope, e.g. pure policy functions directly>`
- **Integration:** `<scope + infrastructure, e.g. real DB via containers — never mocked storage>`
- **Mandatory adversarial tiers:** `<e.g. permission matrix route × roles; N+1 bound on lists;
  forced-failure rollback (fail a mid-transaction write, assert no partial rows); idempotency
  replay; stale-version write>`
- **Positive-control rule:** every absence assertion needs a presence control on the same fixture
  (see DESIGN.md §11 — this rule is project-independent; restated here so testers can cite it).
- **Coverage thresholds:** `<numbers / command>`

## 10. Docs write-scope (Phase 5)

- **Allowed:** `<e.g. OpenAPI source, module README, product-docs/**>`
- **Forbidden:** `<e.g. docs/** mirror — goes in the handoff pack>`
- **Required doc invariants:** `<e.g. every API operation documents its permission key>`

## 11. Ledgers

These three must repeat §16 `paths` exactly — §16 is what every script and the installer read, this
section is what a person reads, and two homes for one ledger is the failure the registry template names.

- **Task board:** `<§16 paths.boards, e.g. tasks>/<moduleKey>.md` (format: `templates/task-board.md`
  from the kit — its rules install as `README.md` in that same directory) — the one progress surface
- **Deferred registry:** `<§16 paths.registry, e.g. DEFERRED_TASKS.md>`
- **Decision log:** `<§16 paths.decisions, e.g. DECISIONS.md>` — every decision a run takes: what, citation, why, how to reverse
- **Handoff packs:** `<e.g. handoffs/<date>-<moduleKey>-handoff.md>` — one per run, §A–§F
- **Run artifacts:** `.pipeline/<moduleKey>/{plan,state,review-pass<n>}.md` + `run.jsonl` (gitignore `.pipeline/`)
- **Versioning:** `<e.g. semver in package.json + CHANGELOG.md entry per module; who tags>`

## 12. Phase → model mapping & harness settings (filled at setup, per chosen harness)

> Personas declare only a **tier** (`strong` | `mid`). This section maps tiers to the concrete
> models of THIS project's harness(es) — chosen at setup by inspecting the harness's own
> config/subscription, not hardcoded in the kit. Harnesses with a native model field
> (e.g. Claude Code) get the mapping baked in at install (`cli.js --models`); all others read it
> from here at dispatch time.

**Tier assignments (fixed by the kit — don't change without reading DESIGN.md §2):**
strong = plan · code · **test** · standards-audit · security-audit · **invariant-audit** · review;
mid = vuln-audit · docs. Test is strong because it is the first full verification and its work is
adversarial, not mechanical — green-suite misses (authorization-scope loops, money defects) proved
the class. Phases 0.5, 3b and 6.5 are orchestrator-run and spend no seat model. **The orchestrator
has no persona file**, so no tier routes it: declare its model in §16 `models.orchestrator` and turn
on `features.orchestratorModel` to be warned when a session runs on another.

| Harness in use | strong = | mid = | How a phase is launched at that model |
|---|---|---|---|
| `<e.g. claude-code>` | `<e.g. opus>` | `<e.g. sonnet>` | `<baked into .claude/agents/ frontmatter at install>` |
| `<e.g. codex>` | `<model id from ~/.codex config / subscription>` | `<model id>` | `<e.g. codex exec -m <model> "...persona + inputs...">` |
| `<other>` | `<…>` | `<…>` | `<per-session model picker / flag / config profile>` |

**Other harness settings decided at setup** (one line each; `N/A` where the harness lacks it):

- **Parallel audit dispatch:** `<supported (one message, 4 dispatches) | sequential fresh sessions>`
- **Reasoning effort / thinking budget:** `<e.g. high for strong phases, default for mid — or N/A>`
  (a persona's neutral `effort:` hint — docs carries `low` — is applied where the harness has one)
- **Nested dispatch:** `<the harness's spawn-depth setting, capped so seats cannot dispatch — or N/A>`
- **Permission / autonomy mode:** `<what the harness needs so read-only seats can run inspection
  commands but the pipeline still stops at the human seam>`
- **Tool-scoping enforcement:** `<native (frontmatter/policy) | verify-by-git-status per adapters/generic.md>`

## 13. Human seam

- **Who rules boundary events / catalogue amendments:** `<name/role>`
- **Merge policy:** `<pipeline never merges; human reviews MERGE-READY verdict, merges, tags>`
- **Commit conventions:** `<branch naming; message format; attribution rules>`

## 14. Behavioural gate / QA audit — **required if the application can be containerised**

> The pattern lives in `skills-extra/qa-audit/SKILL.md`; this section is the part that is **yours**.
> Phase **6.5** is the only phase that runs the real application, phase **3b** reads the drift
> oracles named here, and phase **1** writes the module digest to the path below. Leave this section
> unfilled and each degrades to a **recorded skip** — CHANGES-REQUIRED until a human waives it,
> because absent evidence is never a pass. If the app genuinely cannot be containerised, say so here
> in one line; that sentence is the waiver, and it beats silence.

**Requirement source** — where executable requirements come from, and how to read one:

| | |
|---|---|
| Source | `<e.g. tracker CSV / requirements/*.yaml / Jira export>` |
| Id shape | `<e.g. <MOD>-R-NNN>` |
| Acceptance text | `<which column/field carries the rule the pack must assert>` |
| Deferral registry | `<path>` — **read before authoring**; a documented deferral asserted as a requirement is a false defect |

**Effect sources** — what counts as a declared side effect in THIS stack, and how to find each
in code (the inventory extractor reads these; the fingerprint of them is the second drift oracle):

| Effect | How it appears in code | How it is observed at run time |
|---|---|---|
| Audit entry | `<e.g. audit.record({ action: '…' })>` | `<e.g. SELECT on audit table by aggregate id>` |
| Domain event | `<e.g. outbox.enqueue(type)>` | `<e.g. outbox/event table grew with type>` |
| Session revocation | `<e.g. sessions.destroyAllForUser()>` | `<e.g. token rejected + store key gone>` |
| Concurrency guard | `<e.g. updateWithVersion()>` | `<e.g. version column incremented>` |
| Storage ownership | `<e.g. which schema/collection a module may write>` | `<e.g. no writes outside its own>` |

**Environments** — see `templates/qa-targets.md`. One row per target; `shared: true` forces
read-only and `cli.js check-targets` fails the build if a shared target is marked destructive.

| Target | App host | **Data host** | Shared? | Mode |
|---|---|---|---|---|
| `<local>` | `<ephemeral>` | `<its own>` | no | FULL |
| `<…>` | `<…>` | `<…>` | `<yes/no>` | `<FULL / READ-ONLY>` |

**Redaction** — secret headers/body fields in this stack, redacted to a short correlating prefix
in the call transcript: `<e.g. cookie, authorization, x-csrf-token; password, token, secret>`

**Conventions** — the seams the Phase-C layers (global invariants, hostile input, monkey) read: the
ONLY project-specific things in otherwise fully generic code, so getting them right makes those layers portable:

| | |
|---|---|
| API path prefix | `<e.g. /api/v1/>` — scopes the invariants to your domain surface, so infra routes cannot mask or fake a finding |
| Error shape | `<e.g. RFC 9457 ProblemDetails with a `code` field>` |
| Error code pattern | `<e.g. /^APP-\d{4}$/>` — a 4xx without one is an UNSHAPED refusal and a finding |
| Statuses exempt from the shape rule | `<e.g. 429 — a throttle is a transport control, not a domain refusal>` |
| Concurrency header | `<e.g. If-Match + a row-version integer>` |
| Idempotency header | `<e.g. Idempotency-Key>` |
| Pagination contract | `<e.g. ?page=&pageSize= capped at 100; envelope { items, page, pageSize, totalItems, totalPages }>` |

**Disposable actors** — how a probe mints an actor it may safely destroy. Self-destruction tests
damage whoever performs them, so they must never self-target a seeded persona:

| | |
|---|---|
| Create an actor | `<e.g. POST /users, then write the credential hash directly — fixture setup, not stubbing>` |
| Make it loginable | `<e.g. seed the hash + clear any must-change-password flag; every assertion still crosses the real login>` |
| Positive control | `<e.g. the new actor completes an ordinary read before any refusal from it is trusted>` |
| Recovery capability | `<which permission can undo each destructive verb, and WHO holds it — if only the actor being destroyed holds it, that verb is terminal and belongs in the invariant registry>` |

**Phase-C artifacts + commands**

| | |
|---|---|
| Module digests | `<e.g. digests/<module>.digest.md>` — see `templates/module-digest.md` |
| Digest regen + validate | `<digest regen command>`; `<its --check form>` wired into the gate chain (§8) |
| Invariant registry | `<e.g. invariants.json>` — see `templates/invariant-registry.md` |
| Ruling requests | `<where generated NEEDS-RULING requests are written for a human>` |
| Stories | `<e.g. scenarios/stories/<module>.stories.pack.ts>` — see `templates/story-pack.md` |
| Story lint | `<the banned assert-by-absence idiom, and the check that enforces it>` |
| Monkey walk | `<monkey-walk command, taking a seed and a step count>` |

**Artifacts + commands**

| | |
|---|---|
| Report | `<e.g. audits/<date>-qa-audit.md>` (dated, never overwritten) |
| Transcript | `<e.g. reports/transcript.{md,jsonl}>` — the JSONL is what §16 `features.contractOracle.transcript` reads |
| Run | `<QA run command, taking a target name>` |
| Worklist | `<worklist command>` — declared effects nothing exercises |
| Effect drift | `<effect-drift command>` — wire into the gate chain (§8) |

## 15. Invariant taxonomy — the coherence questions THIS project has paid for

The pipeline's fourth auditor seat (`invariant-auditor`) asks **"is the system still coherent after
the call succeeded?"** — the one question every other seat and every test tier structurally cannot
reach, because they all ask *may actor X call operation Y, and does it return the right code?*

The persona ships with ten seed classes. **Four are universal** (reflexive · last-of-kind ·
seam-with-no-motor · absence-proof); the other six came from a workflow-and-approvals domain and may
resolve `N/A` on every aggregate in yours — which is a correct result, not a wasted row.

**This section governs when filled.** A class earns its place by having been paid for: something
shipped, something broke, and the class is the shape of the break. Write yours here as you find
them; delete seed rows that do not apply to your domain and say so, so the deletion reads as a
decision rather than an oversight.

| # | Class | Scope | The question, in your domain | Reference implementation (the guard that holds) |
|---|---|---|---|---|
| 1 | Reflexive | universal | `<can the actor be the target — which operations?>` | `<file:line of the comparison>` |
| 2 | Last-of-kind | universal | `<what must never reach zero?>` | `<file:line of the count consulted on the write>` |
| 7 | Seam with no motor | universal | `<which queues/schedulers/registries must have a live caller?>` | `<the mechanical check + its allowlist>` |
| 10 | Absence-proof | universal | `<which claims are provable only by presence?>` | `<the close-out audit rule>` |
| … | `<your class>` | domain | `<the question>` | `<the guard, or "none — NEEDS-RULING">` |

**Unruled cases go to a human, not into the code.** Name the channel in §13. An auditor that invents
the expectation becomes the author of the requirement it audits, and the audit stops being evidence.

| | |
|---|---|
| Invariant registry (machine-readable, if any) | `<e.g. invariants.json>` — see `templates/invariant-registry.md` |
| Where `NEEDS-RULING` requests are written | `<path/channel>` (§13) |
| Ruled entries gain | `<expect + citation, after which they are asserted like any requirement>` |

## 16. Pipeline settings (machine-read)

The one block the pack's scripts read — exactly one. It holds the tier runner (full log to a file,
≤25-line digest), the ledger paths (keep them equal to §11), the model ids (§12), the protected globs
(mirror §4; the protected-paths hook reads them and only ADDS them to its own list — while any is set, this
file is protected too, so a person edits it) and the optional features. Replace every `<…>`: an unfilled placeholder fails validation.
Check it with `npx builder-pipeline features` (folder layout: `node scripts/features.mjs`). `visibility` is the §1 fact
(`private` or `public`) that the account content policy reads before a launch. **States:** `on` runs, and its required keys must be filled
or the profile is invalid — never a silent skip · `off` prints `<feature>: not configured` and does
nothing (it means *not told*, never *unimportant*) · `unmeasured` runs and every report says its
benefit is unmeasured · `experimental-off` / `experimental-on` are opt-in; the second needs
`unpack --experimental` and owes the measurement in `EXPERIMENTS.md`. An unknown feature name is an
error, because a typo would otherwise switch a check off in silence.

```json pipeline-settings
{
  "schema": 2,
  "visibility": "private",
  "commands": {
    "tier": "<command with {tier}, e.g. make test-{tier}>",
    "tiers": ["unit", "integration", "gates"],
    "affected": null,
    "typecheck": null
  },
  "paths": {
    "boards": "tasks",
    "registry": "DEFERRED_TASKS.md",
    "runs": ".pipeline",
    "decisions": "DECISIONS.md",
    "handoffs": "handoffs",
    "logs": "logs",
    "citationRoots": ["src", "tests", "docs", "tasks"]
  },
  "models": { "orchestrator": null, "strong": "<id>", "mid": "<id>" },
  "protected": ["<glob>"],
  "features": {
    "graph":            { "state": "off", "check": null, "sync": null, "syncFree": null, "autoLimitKb": 300 },
    "claims":           { "state": "on", "retracted": null, "registryIdPattern": "[A-Z][A-Z0-9]{1,8}-D\\d+[a-z]?", "jestBatch": null },
    "planSchema":       { "state": "on", "sections": ["Track", "Context", "Tasks", "BLOCKERS"], "tables": {}, "taskColumns": ["Task", "Cites", "Test-seed"], "oracle": null },
    "findingsSchema":   { "state": "on" },
    "reviewTemplate":   { "state": "on" },
    "handoffPack":      { "state": "on", "tracker": null },
    "specAuthoring":    { "state": "off", "dir": "specs", "idPattern": "REQ-\\d+" },
    "rowReader":        { "state": "on" },
    "contractOracle":   { "state": "off", "adapter": "openapi3", "spec": null, "transcript": null, "baseline": null, "codeField": "code", "statusFamilies": {} },
    "rules":            { "state": "off", "runner": "ast-grep", "scan": null, "baseline": null, "ratcheted": [] },
    "mutation":         { "state": "off", "tool": null, "command": null, "report": null, "payloadPattern": null },
    "orchestratorModel":{ "state": "off" },
    "costAccounting":   { "state": "off", "reader": "claude-code" },
    "bashCap":          { "state": "off", "limitBytes": 4096 },
    "registryGuard":    { "state": "off", "seats": [] },
    "reanchor":         { "state": "off", "maxRuns": 2 },
    "outboundGuard":    { "state": "off", "maxBytes": 8000, "denyPaths": [".env", ".env.*", "*.pem", "*.key", "*.p12", "*.pfx", "id_rsa*", "id_ed25519*", "*.keystore", "credentials*.json"], "envFiles": [".env", ".env.local", ".env.development", ".env.test"], "extraPatterns": [], "timeoutMs": 20000 },
    "citations":        { "state": "off", "schemes": [] },
    "lineCitations":    { "state": "off", "catalogues": [], "roots": [], "extensions": [".md"], "roster": null, "control": null, "minFiles": 1, "keyColumn": 0 },
    "wiring":           { "state": "off", "roots": [], "extensions": [], "testPattern": null, "allow": null, "kinds": [] },
    "specTrace":        { "state": "off", "idPattern": "REQ-\\d+", "requirements": [], "tests": [], "testPattern": null, "packs": [] },
    "instructionBudget":{ "state": "off", "files": [], "maxLines": 200 },
    "instructionLint":  { "state": "off", "files": ["CLAUDE.md", "AGENTS.md", ".claude/**/*.md"], "ignorePaths": [], "figures": [], "sets": [], "baseline": null },
    "decisionIndex":    { "state": "off", "roots": [], "idPattern": "D-\\d+", "out": null },
    "ratchets":         { "state": "off", "lists": [] },
    "builderBatch":     { "state": "off", "rows": 5 },
    "fixLane":          { "state": "off" },
    "livePage":         { "state": "experimental-off" },
    "graphTrial":       { "state": "experimental-off", "seats": ["orchestrator", "module-planner", "standards-auditor", "invariant-auditor"], "callPattern": null },
    "personas":         { "state": "experimental-off", "catalogue": null, "keyColumn": 0, "labelColumn": 1, "roleColumns": null, "grant": "1", "out": null, "logins": null, "citationPattern": null },
    "advisorBuilder":   { "state": "experimental-off" },
    "tokenEconomizer":  { "state": "experimental-off" },
    "planReview":       { "state": "experimental-off" },
    "rankedSearch":     { "state": "experimental-off" },
    "riskHint":         { "state": "experimental-off" },
    "walkPriority":     { "state": "experimental-off" },
    "ruleNotes":        { "state": "experimental-off" },
    "mutationGate":     { "state": "experimental-off" },
    "familyReview":     { "state": "experimental-off" },
    "routerHint":       { "state": "experimental-off" },
    "liteSplit":        { "state": "experimental-off", "cap": 4, "trigger": 3, "ledgers": ["(^|/)CHANGELOG\\.md$"], "docsOnly": ["(^|/)README\\.md$"] },
    "remoteLanes":      { "state": "experimental-off", "remotePollSeconds": 30 },
    "boardLoop":        { "state": "experimental-off", "promptFile": "LOOP_PROMPT.md", "gate": null, "maxPasses": null, "passTimeoutMinutes": 60, "maxTurnsPerPass": 20, "stallMinutes": 5, "maxRetriesPerRow": 2, "maxConsecutiveFailures": 3, "maxConsecutiveNoProgress": 3, "testRoots": ["test/", "tests/"] },
    "worktreeSweep":    { "state": "off", "target": null, "idleHours": 6, "prefix": null, "reserved": [], "backupDirs": ["logs", ".pipeline"], "holdCommand": null },
    "branchSweep":      { "state": "off", "target": null, "staleDays": 30, "keep": ["main", "release/*"], "remote": "list" },
    "runSweep":         { "state": "off", "keepDays": 30, "roots": [".pipeline", "logs/backups"] },
    "capacity":         { "state": "off", "perLaneMb": null, "reserveCores": 2, "maxLoadPerCore": 1.0, "minFreeMb": 1024, "minDiskMb": 2048, "intervalSeconds": 60, "ttlSeconds": 180, "riseAfterTicks": 3, "holdMaxMinutes": 60, "explainAfterTicks": 10 },
    "orchestrator":     { "state": "off", "target": null, "primaryLaunch": "manual", "sourceRoots": ["src/"], "riskPaths": { "migration": [], "platform": [], "permission": [] }, "preflight": [], "mechanical": null, "capacity": null },
    "accounts":         { "state": "off", "softLimitPct": 80, "usageStaleMinutes": 30, "accounts": {} }
  }
}
```
