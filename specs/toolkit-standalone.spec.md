# Spec — toolkit-standalone: use one kit tool without the full pipeline

Module: toolkit-standalone
Status: ratified
Ratified-by: George (autonomy mandate of 16 November 2026, applied by the build thread; see Decision log)

> The kit's own spec for the toolkit split, part of release 2.0.0. It follows the installed spec template. Check it with
> `npx builder run spec-check specs/toolkit-standalone.spec.md` (folder layout: `node scripts/spec-check.mjs specs/toolkit-standalone.spec.md`).
> It is maintainer-only and does not ship in the package.

## Intent

> "we should have clear areas of expertise like a swiss tool, if somebody already uses some level of orchestration we
> should be able to handle audit or review it - can we go this split direction and they can use a specific tool or the
> complete tool set?" — George, project chat, 16 November 2026. Decisions Q1 to Q4 of the Builder Toolkit Brief were
> approved the same day ("proceed with recommendations").

## Scope

- In: settings without a profile (Q1, option c) · the ledger gate with explicit paths · a board importer for two
  foreign formats (ralph `prd.json`, Spec Kit `tasks.md`) · the spec checker and the spec-trace checker on named files
  with defaults (Q3, options a then b).
- Out: the licence and the npm registry listing (Q2; a maintainer decision, raised in the PR) · the version bump to
  2.0.0 (Q4; the release PR) · importers for pull requests and for Codex or Antigravity transcripts (brief, audit
  section; a later spec) · the accounts tool (the 2.0.0 plan).

## Actors

| Actor | Source |
|---|---|
| a team that runs another orchestrator | intent |
| a CI job | intent |
| the pipeline at step 0.7 and the readiness gate | brief, tool 1 |
| a maintainer of the kit | brief, Q2 and Q4 |

Decision log (the plan's rule: each decision taken without George is logged with its reasoning so he can change it):

| Id | Decision | Reasoning | Date |
|---|---|---|---|
| DL-1 | This spec is ratified by the build thread, not by George in person. | George's mandate of 16 November 2026: fill open decisions with the recommended option and complete the work. The spec is the recommended option written down; its 25 acceptance criteria each have a passing test. | 2026-11-16 |
| DL-2 | The toolkit split ships in 2.0.0, not in a separate 1.2.0. | George, 16 November 2026: "everything should be in 2.0 version". The strategy study orders it after M13 (distribution) inside 2.0.0. | 2026-11-16 |

## Requirements

Kind: `behaviour` (what succeeds) · `refusal` (what is refused, and why) · `effect` (what a success leaves behind) ·
`constraint` (always true).

| Id | Requirement | Actor | Kind | Source |
|---|---|---|---|---|
| REQ-101 | With no `PIPELINE_PROFILE.md`, a script reads its settings from the file named by `BUILDER_CONFIG`, or else from `builder.config.json` in the project root | a team that runs another orchestrator | behaviour | brief Q1 |
| REQ-102 | A config file is validated with the same rules as the profile's §16 block and an invalid one is refused with the same messages | a CI job | refusal | brief Q1 |
| REQ-103 | When `PIPELINE_PROFILE.md` exists, the profile is the only source of settings and a config file beside it is ignored and reported | a maintainer of the kit | constraint | brief Q1 |
| REQ-104 | `npx builder run NAME --config PATH` hands the path to the script as `BUILDER_CONFIG` and removes the flag from the script's arguments | a team that runs another orchestrator | behaviour | brief Q1 |
| REQ-105 | `npx builder run features` names the source of the settings in use: the profile, a config file, or defaults | a CI job | effect | brief Q1 |
| REQ-201 | `npx builder check-ledgers --boards DIR --registry FILE` checks those paths in place of §16 `paths` and the defaults | a team that runs another orchestrator | behaviour | brief C2 |
| REQ-202 | A `--boards` or `--registry` flag with no value is refused as a usage error | a CI job | refusal | brief C2 |
| REQ-301 | `npx builder run board-import --format ralph PRD.json --out BOARD.md` writes one board row per user story, numbered `T1`… in file order, with the title as the task, the story id in Cites, `passes` as the status (DONE or PLANNED) and the acceptance criteria as the notes | a team that runs another orchestrator | behaviour | brief, audit section |
| REQ-302 | `npx builder run board-import --format spec-kit TASKS.md --out BOARD.md` writes one row per task line, with the task id as stated, the checkbox as the status, and the `[P]` and `[USn]` markers in the Cites cell | a team that runs another orchestrator | behaviour | brief, audit section |
| REQ-303 | The importer keeps what the source states and marks every inferred cell `⚠ CONFIRM`; every source line it did not map is listed under `## Unmapped` with its line number; every inference is listed under `## Inferred` | a team that runs another orchestrator | constraint | orch-digest rule |
| REQ-304 | An imported DONE row with no test named by the source keeps an empty evidence cell, so the ledger gate reports it under LG-5 | the pipeline at step 0.7 and the readiness gate | constraint | brief, earned status |
| REQ-305 | The importer refuses an unknown format, a missing or unreadable source, invalid JSON, and an existing output file without `--force`; it writes nothing when it refuses | a CI job | refusal | brief, audit section |
| REQ-306 | The written board is read by `check-ledgers` and by `board-progress` as a build board | the pipeline at step 0.7 and the readiness gate | effect | brief, audit section |
| REQ-401 | `spec-check FILE.md` with `features.specAuthoring` off checks the file with the default settings and prints that it did so | a team that runs another orchestrator | behaviour | brief Q3 |
| REQ-402 | `spec-check KEY` with the feature off still prints `specAuthoring: not configured` and exits 0, so step 0.7 is unchanged | the pipeline at step 0.7 and the readiness gate | constraint | brief Q3 |
| REQ-403 | `spec-trace-check FILE… --tests PATH [--packs PATH]` with `features.specTrace` off checks the named files with the default id pattern and prints that it did so | a team that runs another orchestrator | behaviour | brief Q3 |
| REQ-404 | `spec-trace-check` with the feature off and no named requirement file still prints `specTrace: not configured` and exits 0 | the pipeline at step 0.7 and the readiness gate | constraint | brief Q3 |
| REQ-405 | A `--tests` or `--packs` flag with no value, or a named path that does not exist, is refused with exit 2 | a CI job | refusal | brief Q3 |

## Acceptance criteria

Verb: `assert` (holds as written) · `by-design` (cite a decision) · `gap` (cite a deferred-registry row).

| Id | Req | Verb | Given | When | Then |
|---|---|---|---|---|---|
| AC-101 | REQ-101 | assert | a project with no profile and `BUILDER_CONFIG` naming a file that turns `specTrace` on | `run features` | exit 0, and the line `specTrace: on` is printed |
| AC-102 | REQ-101 | assert | a project with no profile and a `builder.config.json` that turns `bashCap` on | `run features` | exit 0, and the line `bashCap: on` is printed |
| AC-103 | REQ-101 | assert | a project with no profile, no `BUILDER_CONFIG` and no `builder.config.json` | `run features` | exit 0, and the line `no PIPELINE_PROFILE.md — defaults in use` is printed |
| AC-104 | REQ-102 | assert | a config file that names an unknown feature `claimz` | `run features` | exit 1, and the output names `claimz` as an unknown feature |
| AC-105 | REQ-102 | assert | a config file that is not valid JSON | `run features` | exit 1, and the output contains `not valid JSON` |
| AC-106 | REQ-103 | assert | a profile that turns `claims` off, and a config file beside it that turns `claims` on | `run features` | exit 0, `claims: not configured` is printed, and a line says the config file is ignored because the profile exists |
| AC-107 | REQ-104 | assert | a config file that turns `specTrace` on, passed as `run features --config PATH` | the script runs | exit 0, `specTrace: on` is printed, and the script's arguments do not contain `--config` |
| AC-108 | REQ-105 | assert | a project with a config file in use | `run features` | the first line names the config file's path |
| AC-201 | REQ-201 | assert | a project whose boards live in `work/boards` and whose registry is `work/REGISTRY.md`, no profile | `check-ledgers --boards work/boards --registry work/REGISTRY.md` | exit 0 and `check-ledgers: PASS` when the rows are clean |
| AC-202 | REQ-201 | assert | the same project | `check-ledgers` with no flags | exit 1 with two LG-0 lines naming `DEFERRED_TASKS.md` and `tasks` |
| AC-203 | REQ-202 | assert | any project | `check-ledgers --boards` | exit 1 and an error line naming `--boards DIR` |
| AC-301 | REQ-301 | assert | the ralph example `prd.json` with four stories, two with `passes: true` | `run board-import --format ralph prd.json --out tasks/imported.md` | exit 0; the board has four rows under `## P0`; row `T1` cites `US-001` and has status `DONE`; row `T3` cites `US-003` and has status `PLANNED` |
| AC-302 | REQ-301 | assert | the same source | the board is read | each row's Notes cell holds the story's acceptance criteria joined by `;` |
| AC-303 | REQ-302 | assert | a Spec Kit `tasks.md` with `- [x] T001 Setup…`, `- [ ] T012 [P] [US1] Create model in src/models/a.py` and a prose line | `run board-import --format spec-kit tasks.md --out tasks/imported.md` | exit 0; row `T001` is `DONE`; row `T012` is `PLANNED` with Cites `[P] [US1]` |
| AC-304 | REQ-303 | assert | the same Spec Kit source | the board is read | the prose line is listed under `## Unmapped` with its line number; every inferred value is listed under `## Inferred` and marked `⚠ CONFIRM` |
| AC-305 | REQ-304 | assert | the ralph board from AC-301 | `check-ledgers --boards tasks --registry EMPTY.md` where EMPTY.md is a registry with the kit header and no rows | exit 1, and an LG-5 line names row `T1` of the board |
| AC-306 | REQ-305 | assert | any project | `run board-import --format trello x.json --out b.md` | exit 2, the message names `ralph` and `spec-kit`, and `b.md` does not exist |
| AC-307 | REQ-305 | assert | an existing `tasks/imported.md` | `run board-import --format ralph prd.json --out tasks/imported.md` | exit 2, the message names `--force`, and the file is unchanged |
| AC-308 | REQ-305 | assert | a `prd.json` that is not valid JSON | `run board-import --format ralph prd.json --out b.md` | exit 2, the message says `not valid JSON`, and `b.md` does not exist |
| AC-309 | REQ-306 | assert | the ralph board from AC-301 | `run board-progress tasks/imported.md` | exit 0 and the progress block counts four rows |
| AC-401 | REQ-401 | assert | a project with no profile and a well-formed draft spec at `specs/a.spec.md` | `run spec-check specs/a.spec.md` | exit 0, and the first line is `specAuthoring: not configured — checking specs/a.spec.md with defaults` |
| AC-402 | REQ-401 | assert | the same project and a spec missing its `## Requirements` section | `run spec-check specs/a.spec.md` | exit 1 and a `spec-check: FAIL` line |
| AC-403 | REQ-402 | assert | a project with no profile | `run spec-check stock-levels` | exit 0, and the output is exactly `specAuthoring: not configured` |
| AC-404 | REQ-403 | assert | a project with no profile, `docs/requirements.md` declaring `REQ-001` and `REQ-002`, and `tests/a.test.ts` naming `REQ-001` | `run spec-trace-check docs/requirements.md --tests tests` | exit 1; the first line says the check runs with defaults; `REQ-002` is reported `UNTRACED` |
| AC-405 | REQ-404 | assert | a project with no profile | `run spec-trace-check` | exit 0, and the output is exactly `specTrace: not configured` |
| AC-406 | REQ-405 | assert | a project with no profile | `run spec-trace-check docs/requirements.md --tests` | exit 2 and a usage line naming `--tests PATH` |
| AC-407 | REQ-405 | assert | a project with no profile | `run spec-trace-check docs/missing.md --tests tests` | exit 2 and a line saying the source is missing |

## API contract

No API contract — the module is a set of command-line tools with exit codes and printed lines; it serves no HTTP interface.

## Oracle amendments

| Oracle | Entry | Why | Decision |
|---|---|---|---|

## Open questions

| Id | Question | Blocks | Answer |
|---|---|---|---|
