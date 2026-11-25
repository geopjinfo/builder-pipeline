# Spec — package-pinning: the kit runs only the copy a project installed, never a package fetched by name

Module: package-pinning
Status: ratified
Ratified-by: George ("proceed as recommended" on the kit improvement plan, 20 November 2026, REQ-2028; the spec text is ratified under the autonomy mandate of 16 November 2026; see Decision log)

> The kit's own spec for one finding of the skill-file review of 20 November 2026 (PR #45). It follows the installed
> spec template and the shape of `specs/pipeline-sizing.spec.md`. It is maintainer-only and does not ship in the package.

## Intent

> "Pinned package name. Every `npx builder-pipeline` in skills and docs becomes `npx --no-install builder-pipeline` or
> carries the version. builder-init fails when the lock file has no entry. — PR #45: the npm name `builder-pipeline` is
> unregistered and 29 skill lines call it without a version. A stranger who publishes the name would be run by every
> project. — Measurement: `node tests/run.mjs` and a grep gate in `hygiene --gate`: 0 unpinned calls." — Kit improvement
> plan from benchmark results, row REQ-2028, approved by George on 20 November 2026.

## Scope

- In: the command form the shipped text uses · the lock-entry check in `builder-init` step 0 · the `pin-check` script and
  its `features.pinCheck` key · the delivery row of the completion gate · the install line of the README · the form
  `unpack` writes when it rewrites a folder-layout command for a package install.
- Out: the run hints the CLI and the scripts print at run time (`scripts/lib/run-hint.cjs` and `cli.js`), which stay
  `npx builder-pipeline …` until a decision changes them (deferred, registry row `DEF-PIN-1`) · the history in
  `CHANGELOG.md`, the decision log and the specs, which quote commands as they were run · reserving the npm name,
  which is George's call (publish was deferred on 18 November 2026).

### INVARIANTS

The checker treats these as non-negotiable (D45). Every requirement below holds inside them.

- Zero dependencies and Node 18. CommonJS logic in `scripts/lib/pin-check.cjs`, an `.mjs` entry. `git` and Node
  built-ins only.
- The kit never fetches itself by name. A command the shipped text gives runs the installed copy or stops.
- A new check defaults to off (project rule). Off prints `pinCheck: not configured` and exits 3; it is never a pass.
- The gate keeps its seven rows (REQ-1844). The new finding joins the delivery row.

## Actors

| Actor | Source |
|---|---|
| a project that installed the kit | intent |
| the builder-init skill | intent |
| the build-module-pipeline at Phase 7 | REQ-1845 |

## Requirements

| Id | Requirement | Actor | Kind | Source |
|---|---|---|---|---|
| REQ-2028 | Every kit command the shipped skills, agents, templates, adapters, hooks and docs give is `npx --no-install builder-pipeline CMD` or `npx --no-install builder-pipeline run NAME`, or carries a version (`builder-pipeline@VERSION`). The Markdown `unpack` rewrites for a package install uses the same form. | a project that installed the kit | constraint | intent, D155 |
| REQ-2029 | `builder-init` step 0 stops when `package.json` does not list the kit, when the lock file has no entry for it, or when `npx --no-install builder-pipeline --version` does not print the installed version. It tells the human to re-run the setup prompt and never guesses another install route. | the builder-init skill | refusal | intent, D155 |
| REQ-2030 | The kit lists `features.pinCheck` with the default off. When `pin-check` runs, every line of a tracked file that matches `files` and calls `npx builder-pipeline` or `npm exec builder-pipeline` with no `--no-install`, `--no` or version is UNPINNED with its path and line, exit 1; `allow` suppresses by path. `hygiene --gate` reads UNPINNED into the delivery row. | the build-module-pipeline at Phase 7 | behaviour | intent, D155 |

## Acceptance criteria

| Id | Req | Verb | Given | When | Then |
|---|---|---|---|---|---|
| AC-2028a | REQ-2028 | assert | the kit's shipped text (every tracked `.md`, `.mdc`, `.txt`, `.toml`, `.sh` and `.ps1` file except `CHANGELOG.md`, `DECISIONS.md`, `specs/` and `tests/`) | `pin-check` scans it | 0 UNPINNED (tests/pin-check.test.mjs) |
| AC-2028b | REQ-2028 | assert | a kit file with `node scripts/features.mjs` installed as a package | `unpack` rewrites it | the line reads `npx --no-install builder-pipeline run features` (tests/pin-check.test.mjs) |
| AC-2029 | REQ-2029 | assert | the `builder-init` skill text | step 0 is read | it names the lock entry (`node_modules/builder-pipeline` in `package-lock.json` or the equivalent) as a stop condition and gives `npx --no-install builder-pipeline --version` as the check (tests/pin-check.test.mjs) |
| AC-2030a | REQ-2030 | assert | a temp repo whose README has one `npx builder-pipeline verify` line, one `npx --no-install builder-pipeline verify` line and one `npx builder-pipeline@2.1.0 verify` line, `pinCheck` on | `pin-check` | one UNPINNED naming `README.md:LINE`, exit 1 (tests/pin-check.test.mjs) |
| AC-2030b | REQ-2030 | assert | the same repo, `allow: ["README.md"]` | `pin-check` | no finding, exit 0 |
| AC-2030c | REQ-2030 | assert | `pinCheck` off | `pin-check` | `pinCheck: not configured`, exit 3; with `--defaults` the check runs and the first line says so |
| AC-2030d | REQ-2030 | assert | `pinCheck` on and one UNPINNED line, every other gate check off | `hygiene --gate --json` | the delivery row is FAIL with the finding, the other six rows NOT CONFIGURED, exit 1 (tests/pin-check.test.mjs) |

## API contract

No API contract — the module is a text rule, a skill step and one command-line script.

## Oracle amendments

| Oracle | Entry | Why | Decision |
|---|---|---|---|
| ORACLE.md | none | the module adds no decision rule that an oracle must apply | dropped — no oracle entry is needed |

## Open questions

| Id | Question | Blocks | Answer |
|---|---|---|---|
| Q-1 | Should the run hints the CLI prints (`scripts/lib/run-hint.cjs`) move to the pinned form too? | — | Deferred (`DEF-PIN-1`): the plan names skills and docs; the printed hint is typed in the project that has the kit installed, where `npx` runs the local copy. Decide with the npm-name reservation. |
| Q-2 | Should the npm name `builder-pipeline` be reserved by a publish? | — | George's call; publish was deferred on 18 November 2026. Until then the README gives the GitHub tag install only. |

## Decision log

| Id | Decision | Why |
|---|---|---|
| D155 | The shipped text uses `npx --no-install builder-pipeline`; `pin-check` (default off) finds the bare form and the delivery gate row reads it; `builder-init` stops without a lock entry. | Measured on npm 10.9: `npx --no-install builder-pipeline` with no installed copy ends in "npx canceled due to missing packages" (exit 1) and runs nothing; a bare `npx builder-pipeline` resolves the registry name, which nobody has registered. The 29 skill lines and 276 doc lines that gave the bare form are the finding of the SkillSpector scan (PR #45, 20 November 2026). |
