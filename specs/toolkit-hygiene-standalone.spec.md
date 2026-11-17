# Spec — toolkit-hygiene-standalone: the hygiene checks without the full pipeline

Module: toolkit-hygiene-standalone
Status: ratified
Ratified-by: George (autonomy mandate of 16 November 2026, applied by the build thread; see Decision log)

> The kit's own spec for the standalone form of the three hygiene checks, part of release 2.0.0. It follows the installed
> spec template and the shape of `specs/toolkit-standalone.spec.md`. Check it with
> `npx builder-pipeline run spec-check specs/toolkit-hygiene-standalone.spec.md` (folder layout: `node scripts/spec-check.mjs specs/toolkit-hygiene-standalone.spec.md`).
> It is maintainer-only and does not ship in the package.

## Intent

> "we should have clear areas of expertise like a swiss tool, if somebody already uses some level of orchestration we
> should be able to handle audit or review it - can we go this split direction and they can use a specific tool or the
> complete tool set?" — George, project chat, 16 November 2026. The 2.0.0 plan names the three hygiene checks
> (`instruction-lint`, `instruction-budget`, `worktree-sweep`) as the next tools to run on named targets with the default
> settings while their feature is off, in the shape `spec-check` and `spec-trace-check` already have (REQ-401 to REQ-405 of
> `specs/toolkit-standalone.spec.md`).

## Scope

- In: `instruction-lint FILE…` and `instruction-budget FILE… [--max-lines N]` on named files with the feature defaults ·
  `worktree-sweep --target BRANCH [--idle-hours N] [--apply]` with the feature defaults, dry run unless `--apply` ·
  usage errors for a flag without its value, an unknown flag and a named path that does not exist · the pipeline's own
  "not configured" lines unchanged when nothing is named · the skills `status-and-next` and `repo-audit` name the
  standalone commands.
- Out: a default integration branch for the sweep (the person names it) · running a `holdCommand` from a config file
  while the feature is off (never) · a baseline or ratchet for the lint without a profile (it has none: reported, not
  enforced) · the lint-on-edit hook, which keeps its `--files` form and its "not configured" answer.

## Actors

| Actor | Source |
|---|---|
| a team that runs another orchestrator | intent |
| a CI job | intent |
| the lint-on-edit hook and the pipeline's gates | hooks/claude-code/instruction-lint-on-edit.cjs |
| a person who merges and cleans up | scripts/lib/worktree-sweep.cjs |

Decision log (the plan's rule: each decision taken without George is logged with its reasoning so he can change it):

| Id | Decision | Reasoning | Date |
|---|---|---|---|
| DL-1 | This spec is ratified by the build thread, not by George in person. | George's mandate of 16 November 2026: fill open decisions with the recommended option and complete the work. The spec is the recommended option written down; each acceptance criterion has a passing test. | 2026-11-17 |
| DL-2 | `worktree-sweep` with the feature off runs only when `--target BRANCH` is given; it never guesses an integration branch. | The target decides what "merged" means. A guessed branch (the current one, or `main`) can mark an unmerged lane as finished. The flag already exists and is the one required setting of the feature. | 2026-11-17 |
| DL-3 | `worktree-sweep` with the feature off is a dry run unless `--apply` is given, and the first line says which. | A sweep removes folders. The same rule the feature has when on; the first line states it because a person without a profile has not read §16. | 2026-11-17 |
| DL-4 | With the feature off, `worktree-sweep` runs no `holdCommand`, even one written in a config file beside the project. | The hold command is a shell command. With the feature off the person has not turned the check on, so no command of theirs runs through it; `prefix` and `reserved` also come from the defaults. | 2026-11-17 |
| DL-5 | A named file that does not exist exits 2 (usage), not 1 (FAIL), for the lint and the budget in standalone form. | A check that cannot read its input asserts nothing; exit 2 is the kit's code for bad arguments. With the feature on, a listed file that is missing stays FAIL (exit 1), because the profile claims the file exists. | 2026-11-17 |
| DL-6 | Named files replace the feature's `files` list in both modes of the lint and the budget. | `spec-trace-check` already treats named requirement files as "exactly these". One rule for both modes is simpler to document and to test than a filter in one mode and a list in the other. | 2026-11-17 |

## Requirements

Kind: `behaviour` (what succeeds) · `refusal` (what is refused, and why) · `effect` (what a success leaves behind) ·
`constraint` (always true).

| Id | Requirement | Actor | Kind | Source |
|---|---|---|---|---|
| REQ-701 | `instruction-lint FILE…` with `features.instructionLint` off lints the named files with the default settings, with no baseline (the ratchet is reported, not enforced), prints that it did so on its first line and uses the script's normal exit codes | a team that runs another orchestrator | behaviour | 2.0.0 plan |
| REQ-702 | `instruction-lint` with the feature off and no named file, or with `--files` (the edit hook's form), still prints `instructionLint: not configured` and exits 0 | the lint-on-edit hook and the pipeline's gates | constraint | hook contract |
| REQ-703 | `instruction-lint` refuses a named path that does not exist, and an unknown flag, with exit 2 and a usage line | a CI job | refusal | 2.0.0 plan |
| REQ-704 | `instruction-budget FILE… [--max-lines N]` with `features.instructionBudget` off judges the named files against `N` lines, or the feature default of 200, prints that it did so on its first line and uses the script's normal exit codes | a team that runs another orchestrator | behaviour | 2.0.0 plan |
| REQ-705 | `instruction-budget` with the feature off and no named file still prints `instructionBudget: not configured` and exits 0 | the lint-on-edit hook and the pipeline's gates | constraint | 2.0.0 plan |
| REQ-706 | `instruction-budget` refuses a named path that does not exist, a `--max-lines` flag with no value or with a value that is not a positive integer, and an unknown flag, with exit 2 and a usage line | a CI job | refusal | 2.0.0 plan |
| REQ-707 | `worktree-sweep --target BRANCH [--idle-hours N]` with `features.worktreeSweep` off judges every worktree against the branch with the default settings (`idleHours` 6 unless the flag says otherwise, no prefix, nothing reserved), as a dry run, and says so on its first line | a person who merges and cleans up | behaviour | 2.0.0 plan |
| REQ-708 | `worktree-sweep --target BRANCH --apply` with the feature off removes each SWEEP worktree the same way the feature does when on, and its first line says that `--apply` removes | a person who merges and cleans up | effect | 2.0.0 plan |
| REQ-709 | `worktree-sweep` with the feature off and no `--target` still prints `worktreeSweep: not configured` and exits 0 | the lint-on-edit hook and the pipeline's gates | constraint | 2.0.0 plan |
| REQ-710 | With the feature off, `worktree-sweep` never runs a `holdCommand`, not even one written in a config file | a CI job | constraint | DL-4 |
| REQ-711 | `worktree-sweep` refuses to run outside a git repository, and refuses a `--target` or `--idle-hours` flag with no value, with exit 2 and a usage line | a CI job | refusal | 2.0.0 plan |

## Acceptance criteria

Verb: `assert` (holds as written) · `by-design` (cite a decision) · `gap` (cite a deferred-registry row).

| Id | Req | Verb | Given | When | Then |
|---|---|---|---|---|---|
| AC-701 | REQ-701 | assert | a project with no profile and an `AGENTS.md` that cites a path that exists | `run instruction-lint AGENTS.md` | exit 0; the first line is `instructionLint: not configured — checking AGENTS.md with defaults`; the verdict line says `PASS` and `no baseline: reported, not enforced` |
| AC-702 | REQ-701 | assert | the same project and a `CLAUDE.md` that cites a path that does not exist | `run instruction-lint AGENTS.md CLAUDE.md` | exit 1; the first line names both files; a problem line names `CLAUDE.md` and says the cited path does not exist; the verdict line says `FAIL` |
| AC-703 | REQ-702 | assert | a project with no profile | `run instruction-lint`, and `run instruction-lint --files CLAUDE.md` | exit 0 both times, and the output is exactly `instructionLint: not configured` |
| AC-704 | REQ-703 | assert | a project with no profile | `run instruction-lint missing.md`, and `run instruction-lint AGENTS.md --bogus` | exit 2 both times; the first names `missing.md` as not found; the second prints a usage line naming `--bogus` |
| AC-705 | REQ-704 | assert | a project with no profile and an `AGENTS.md` of 150 lines | `run instruction-budget AGENTS.md` | exit 0; the first line is `instructionBudget: not configured — checking AGENTS.md with defaults`; a row reads `AGENTS.md  150/200`; the verdict line says `PASS` |
| AC-706 | REQ-704 | assert | the same project | `run instruction-budget AGENTS.md --max-lines 100` | exit 1; a row reads `AGENTS.md  150/100  OVER`; the verdict line says `FAIL` |
| AC-707 | REQ-705 | assert | a project with no profile | `run instruction-budget` | exit 0, and the output is exactly `instructionBudget: not configured` |
| AC-708 | REQ-706 | assert | a project with no profile | `run instruction-budget missing.md` · `run instruction-budget AGENTS.md --max-lines` · `run instruction-budget AGENTS.md --max-lines zero` · `run instruction-budget AGENTS.md --bogus` | exit 2 each time; the first names `missing.md`; the second and third name `--max-lines N`; the fourth names `--bogus` |
| AC-709 | REQ-707 | assert | a repository on `main` with no profile and one worktree whose branch is merged, clean and idle | `run worktree-sweep --target main --idle-hours 0` | exit 0; the first line is `worktreeSweep: not configured — checking worktrees against main with defaults (dry run: nothing is removed; add --apply to remove)`; a `SWEEP` line names the worktree; its folder still exists |
| AC-710 | REQ-708 | assert | the same repository | `run worktree-sweep --target main --idle-hours 0 --apply` | exit 0; the first line is `worktreeSweep: not configured — checking worktrees against main with defaults (--apply: merged, clean, idle worktrees are removed)`; a `SWEPT` line names the worktree; its folder is gone and its branch remains |
| AC-711 | REQ-709 | assert | the same repository | `run worktree-sweep`, and `run worktree-sweep --idle-hours 0` | exit 0 both times, and the output is exactly `worktreeSweep: not configured` |
| AC-712 | REQ-710 | assert | the same repository and a `builder.config.json` that keeps `worktreeSweep` off but names a `holdCommand` that writes a marker file | `run worktree-sweep --target main --idle-hours 0` | exit 0, and the marker file does not exist |
| AC-713 | REQ-711 | assert | a folder that is not a git repository, and the repository from AC-709 | `run worktree-sweep --target main` in the folder · `run worktree-sweep --target` · `run worktree-sweep --idle-hours --target main` in the repository | exit 2 each time; the first says `not a git repository`; the second and third print a usage line naming the flag |

## API contract

No API contract — the module is a set of command-line tools with exit codes and printed lines; it serves no HTTP interface.

## Oracle amendments

| Oracle | Entry | Why | Decision |
|---|---|---|---|

## Open questions

| Id | Question | Blocks | Answer |
|---|---|---|---|
