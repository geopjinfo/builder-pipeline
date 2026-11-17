# Spec — toolkit-unpack-groups: install one tool group of the kit

Module: toolkit-unpack-groups
Status: ratified
Ratified-by: George (autonomy mandate of 16 November 2026, applied by the build thread; see Decision log)

> The kit's own spec for lane E of release 2.0.0: `npx builder-pipeline unpack --tools GROUP[,GROUP]`. It follows the
> installed spec template. Check it with `npx builder-pipeline run spec-check specs/toolkit-unpack-groups.spec.md` (folder
> layout: `node scripts/spec-check.mjs specs/toolkit-unpack-groups.spec.md`). It is maintainer-only and does not ship
> in the package.

## Intent

> "we should have clear areas of expertise like a swiss tool, if somebody already uses some level of orchestration we
> should be able to handle audit or review it - can we go this split direction and they can use a specific tool or the
> complete tool set?" — George, project chat, 16 November 2026. The Builder Toolkit Brief names six tool groups. A team
> installs the groups it wants and nothing else, and `upgrade` repeats that choice.

## Scope

- In: the group table (`scripts/lib/tool-groups.cjs`: every installed file in exactly one group, plus the `core` set
  every install carries) · `unpack --tools` and the filtered copy list · `install.toolGroups` in `builder.lock.json` ·
  `upgrade` repeating the recorded groups · `verify` naming the groups · the dry-run count per group · the docs.
- Out: a per-file `--only` flag (the group is the unit) · removing a group from an existing install (`uninstall` and
  `upgrade --prune` keep their current meaning) · the settings-without-a-profile work (`toolkit-standalone.spec.md`).

## Actors

| Actor | Source |
|---|---|
| a team that runs another orchestrator | intent |
| a CI job | intent |
| a maintainer of the kit | brief, tool groups |
| the `upgrade` command | UNPACK.md, Upgrading an existing install |

Decision log (the plan's rule: each decision taken without George is logged with its reasoning so he can change it):

| Id | Decision | Reasoning | Date |
|---|---|---|---|
| DL-1 | This spec is ratified by the build thread, not by George in person. | George's mandate of 16 November 2026: fill open decisions with the recommended option and complete the work. Each acceptance criterion has a passing test. | 2026-11-17 |
| DL-2 | `core` is a set, not a group a user names. It holds the pointer block, `PIPELINE_PROFILE.md`, the ledger seeds, `features`, `choices`, and each `scripts/lib` file that the scripts of two or more groups require. | A file two groups need cannot belong to one of them: a `spec` install would then lack `profile.cjs`. The assignment is computed from the real `require` closure and checked by a test. | 2026-11-17 |
| DL-3 | `skills/state-template.md` is in `pipeline`, not `orchestrator`. | The brief lists the state template under the orchestrator, but the file is the build-module-pipeline skill's own run cursor and `cli.js` installs it under that skill's `references/`. In `orchestrator` it would land in a folder that group does not install. | 2026-11-17 |
| DL-4 | The reviewer persona, the four auditor personas and `repo-auditor` are in `audit`; the planner, builder, tester, docs-maintainer and `page-keeper` are in `pipeline`. | The brief puts review and audit together. A team with its own orchestrator wants the reviewers; the build seats are the pipeline's. | 2026-11-17 |
| DL-5 | The citation, contract-oracle, index, outbound, wiring, rules-module, mutation, ratchet, decision-index and personas checkers are in `audit`. | Each judges a claim or an artifact and fails a gate; none drives a phase. The brief's `audit` list is open ("review and audit gates"). | 2026-11-17 |
| DL-6 | `worktree-sweep` is in `orchestrator`; `gate-queue` is in `pipeline`; `cost-window`, `seat-peaks` and `scripts/experimental/` are in `evals`. | The sweep removes the orchestrator's lanes. The gate queue is the lite split's, which the pipeline owns; `orch` also requires its lib, so the lib is core. The cost and experiment scripts measure and change no install. | 2026-11-17 |
| DL-7 | In the folder layout the `hooks` group also installs the scripts the hooks load (`board-render.mjs`, `instruction-lint.mjs` and their libs). | A hook runs only committed project code (hook-trust). A `hooks` install without those files would arm a hook that points at nothing. The list is checked against the real closure. | 2026-11-17 |
| DL-8 | `upgrade --tools` narrows an install: a locked file outside the selected groups is reported `kept (outside the tool groups)` and is removed only with `--prune`. | Narrowing is a deletion; the kit never deletes without `--prune`, and a stale-file line would name the wrong cause. | 2026-11-17 |
| DL-9 | `verify` prints `SKIP` for a check whose files are outside the installed groups, and keeps the check for the core files. | A `spec`-only install has no personas by design; a FAIL there would say the install is broken when it is what was asked. | 2026-11-17 |

## Requirements

Kind: `behaviour` (what succeeds) · `refusal` (what is refused, and why) · `effect` (what a success leaves behind) ·
`constraint` (always true).

| Id | Requirement | Actor | Kind | Source |
|---|---|---|---|---|
| REQ-801 | Every file `unpack` installs, in the package layout and in the folder layout, for every tool, with and without extras and experimental files, belongs to exactly one of `spec`, `audit`, `orchestrator`, `hooks`, `evals`, `pipeline` or the `core` set | a maintainer of the kit | constraint | brief, tool groups |
| REQ-802 | A `scripts/lib` file that the scripts of two or more groups require is `core`; one that one group's scripts require alone is in that group | a maintainer of the kit | constraint | DL-2 |
| REQ-803 | `npx builder-pipeline unpack --tool HARNESS --tools GROUP[,GROUP]` installs the files of the named groups and the `core` set, and no file of another group | a team that runs another orchestrator | behaviour | brief, tool groups |
| REQ-804 | With `hooks` selected in the folder layout, the scripts the hooks load are installed with it | a team that runs another orchestrator | constraint | DL-7 |
| REQ-805 | An unknown group name is refused with exit 1 and the list of valid groups, and nothing is written | a CI job | refusal | brief, tool groups |
| REQ-806 | `--tools all`, or no `--tools`, installs every group, and the install list is the one `unpack` produced before this change | a team that runs another orchestrator | constraint | brief, tool groups |
| REQ-807 | `builder.lock.json` records `install.toolGroups` as the sorted group list, and records no `toolGroups` when every group installs | the `upgrade` command | effect | UNPACK.md, lock |
| REQ-808 | `upgrade` repeats the recorded groups when `--tools` is absent, and `--tools` given again replaces them in the lock | the `upgrade` command | behaviour | UNPACK.md, lock |
| REQ-809 | `upgrade --tools` over a wider install reports each locked file outside the selected groups as `kept (outside the tool groups)`; `--prune` backs it up and removes it | the `upgrade` command | behaviour | DL-8 |
| REQ-810 | `verify` names the installed groups (`all` or the list) and prints `SKIP` for a check whose files are outside them | a CI job | effect | DL-9 |
| REQ-811 | `unpack --dry-run` prints the selected groups and the count of files per group, and writes nothing | a team that runs another orchestrator | behaviour | brief, tool groups |

## Acceptance criteria

Verb: `assert` (holds as written) · `by-design` (cite a decision) · `gap` (cite a deferred-registry row).

| Id | Req | Verb | Given | When | Then |
|---|---|---|---|---|---|
| AC-801 | REQ-801 | assert | the real `unpack --tool all --experimental --dry-run` list in the folder layout and in the package layout | each path is passed to `groupOf()` | no path returns null, and every group it returns is one of the six or `core` |
| AC-802 | REQ-802 | assert | the `require` closure of every `scripts/*.mjs` and `tooling/experimental/*.mjs` | each `scripts/lib` file's users are grouped | a lib used by two or more groups is `core`; a lib used by one group is in that group, or in `hooks` when only a hook loads it |
| AC-803 | REQ-803 | assert | a fresh project, folder layout | `unpack --tool claude-code --tools spec` | exit 0; `.claude/skills/spec-author/SKILL.md`, `scripts/spec-check.mjs`, `specs/spec.template.md`, `PIPELINE_PROFILE.md` and `CLAUDE.md` exist; `.claude/agents/module-builder.md`, `scripts/orch.mjs` and `.claude/hooks/protected-paths.cjs` do not |
| AC-804 | REQ-803 | assert | a fresh project, folder layout | `unpack --tool claude-code --tools audit,orchestrator` | exit 0; `.claude/agents/module-reviewer.md`, `scripts/claims-check.mjs`, `scripts/orch.mjs` and `specs/orchestrator-plan.template.md` exist; `.claude/agents/module-builder.md` and `scripts/spec-check.mjs` do not |
| AC-805 | REQ-804 | assert | a fresh project, folder layout | `unpack --tool claude-code --tools hooks` | exit 0; `.claude/hooks/protected-paths.cjs`, `scripts/board-render.mjs`, `scripts/instruction-lint.mjs` and `scripts/lib/bash-cap.cjs` exist; `scripts/claims-check.mjs` does not |
| AC-806 | REQ-805 | assert | a fresh project | `unpack --tool claude-code --tools spec,trello` | exit 1; stderr names `trello` and lists `spec, audit, orchestrator, hooks, evals, pipeline`; no `CLAUDE.md` and no lock were written |
| AC-807 | REQ-806 | assert | two fresh projects | `unpack --tool all --experimental` in one and `unpack --tool all --experimental --tools all` in the other | the sorted file lists outside `builder/` are identical, and neither lock has `install.toolGroups` |
| AC-808 | REQ-807 | assert | the project of AC-804 | the lock is read | `install.toolGroups` equals `["audit","orchestrator"]` |
| AC-809 | REQ-808 | assert | the project of AC-804, with the kit's `agents/module-reviewer.md` changed | `upgrade` with no `--tools` | exit 0; `.claude/agents/module-reviewer.md` carries the change; `.claude/agents/module-builder.md` still does not exist; the lock still says `["audit","orchestrator"]` |
| AC-810 | REQ-808 | assert | the project of AC-809 | `upgrade --tools audit,orchestrator,spec` | exit 0; `scripts/spec-check.mjs` now exists; the lock says `["audit","orchestrator","spec"]` |
| AC-811 | REQ-809 | assert | a full `unpack --tool claude-code` install | `upgrade --tools spec` | exit 0; a line `kept (outside the tool groups)` names `.claude/agents/module-builder.md`, which still exists |
| AC-812 | REQ-809 | assert | the project of AC-811 | `upgrade --tools spec --prune` | exit 0; `.claude/agents/module-builder.md` is gone and a copy is under `.builder/backup-*/`; the lock no longer lists it |
| AC-813 | REQ-810 | assert | the project of AC-803 | `verify` | the output has `tool groups: spec (builder.lock.json)` and a `SKIP` line for the personas check; the full install's `verify` prints `tool groups: all` |
| AC-814 | REQ-811 | assert | a fresh project | `unpack --tool claude-code --tools spec --dry-run` | exit 0; a line `tool groups: spec` and a line with `spec:` followed by a count and `core:` followed by a count; no file was written |

## API contract

No API contract — the module is a command-line installer with exit codes and printed lines; it serves no HTTP interface.

## Oracle amendments

| Oracle | Entry | Why | Decision |
|---|---|---|---|

## Open questions

| Id | Question | Blocks | Answer |
|---|---|---|---|
