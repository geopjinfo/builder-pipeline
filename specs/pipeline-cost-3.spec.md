# Spec — pipeline-cost-3: seat model parity

Module: pipeline-cost-3
Status: ratified
Ratified-by: George ("proceed as recommended", 20 November 2026, on the kit improvement plan; the text is ratified under the autonomy mandate of 16 November 2026 and the item was pulled forward from the third round to unblock the third benchmark bed; see Decision log)

> The third round of cost work, started early. Source: the kit improvement plan of 20 November 2026 and the bed
> thread's finding that the benchmark's arm E profile declared claude-sonnet-5-5 for both tiers since `full-01` while
> every seat ran Opus. It extends `specs/pipeline-cost-2.spec.md` (REQ-2022 to REQ-2024, REQ-2027). Maintainer-only;
> it does not ship. REQ-2025 and REQ-2026 of the plan stay reserved for a later spec.

## Intent

> "Kit seats run on claude-opus-5-5: the install maps `tier: strong` to opus. Opus share of kit cost: full-01 76
> percent, hard-01 83 percent, g12 71 percent. Bare arms Sonnet only. So E versus A is also Opus versus Sonnet, and
> still no accuracy gain." — kit improvement plan, 20 November 2026. "arms/E-profile/PIPELINE_PROFILE.md has pinned
> models.strong and models.mid to claude-sonnet-5-5 since full-01, and the seats still ran Opus." — bed thread, 20
> November 2026, decision D158 of the benchmark.

## Scope

- In: the Claude Code install reads profile §16 `models.strong` / `models.mid` for the agents' `model:` lines
  (REQ-2021) · a free check that reads the installed agents back against §16 and can rewrite them (REQ-2031) · the
  run discipline names the check before step 0 · EXPERIMENTS §27.
- Out: Codex and Antigravity agents (no kit defaults; §12 at dispatch time) · a change to the tier defaults
  themselves (opus, sonnet, haiku), which is a benchmark decision after PT9 · REQ-2025 and REQ-2026.

### INVARIANTS

- Zero dependencies and Node 18. CommonJS logic in `scripts/lib/seat-models.cjs`; the install rule lives in `cli.js`.
- `--models` on the command wins over the profile, tier by tier. The lock records the flag, never the profile.
- `builder/agents/*.md` stay neutral: only installed files under `.claude/agents/` carry a `model:` line.
- The check is free: no §16 feature, no off state. A tier the profile does not declare is in step by definition.
- The check never edits without `--write`, and `--write` changes only the `model:` line and the lock hash.

## Actors

| Actor | Source |
|---|---|
| the person installing the kit | cli.js `unpack`, `upgrade` |
| the orchestrator | skills/build-module-pipeline.md, before step 0 |
| the benchmark harness | arms/E-kit.sh (benchmark repository) |

## Requirements

| Id | Requirement | Actor | Kind | Source |
|---|---|---|---|---|
| REQ-2021 | At `unpack` and `upgrade` for Claude Code, a string `models.strong`, `models.mid` or `models.low` in PIPELINE_PROFILE.md §16 that is not an unfilled placeholder is the model written into every agent of that tier. Precedence: `--models` on the command, then §16, then the lock's recorded overrides, then the defaults. The install prints the mapping it took from the profile. §16 is read each time and never recorded in the lock. | the person installing the kit | behaviour | intent, D150 |
| REQ-2031 | `npx builder-pipeline run seat-models [--write] [--json]` compares the `model:` line of every kit agent under `.claude/agents/` (core, experimental and extras personas; a `builder-` prefix stripped) with §16 by the persona's tier. In step: one line, exit 0. Drift: one `DRIFT:` line per agent that names the file, the model it runs, the tier and the declared model, exit 1. `--write` rewrites the drifted lines and the agents' builder.lock.json hashes, then exits 0. A project-owned agent, a tier the profile leaves null, and a profile without models are in step. Exit 2 on an unknown argument or an invalid profile. | the orchestrator | behaviour | intent, D151 |
| REQ-2032 | `seat-models` refuses an unknown argument and an invalid profile (exit 2) and writes nothing on either; without `--write` it never changes a file, whatever it finds. | the orchestrator | refusal | D151 |

## Acceptance criteria

| Id | Req | Verb | Given | When | Then |
|---|---|---|---|---|---|
| AC-2021a | REQ-2021 | assert | a profile with `strong: claude-sonnet-5-5`, `mid: claude-haiku-4-5` | `unpack --tool claude-code` | the strong agents carry `model: claude-sonnet-5-5`, the mid agents `model: claude-haiku-4-5`; the lock's `install.models` is empty; the output names the mapping |
| AC-2021b | REQ-2021 | assert | the same profile | `unpack … --models strong=big-model` | strong agents `big-model`, mid agents `claude-haiku-4-5` |
| AC-2021c | REQ-2021 | assert | the template's unfilled `strong` placeholder | `unpack` | the defaults `opus` and `sonnet`; no profile line printed |
| AC-2021d | REQ-2021 | assert | an installed project whose §16 `strong` changes | `upgrade` | the strong agents carry the new model |
| AC-2031a | REQ-2031 | assert | an install in step | `seat-models` | `seat models: in step — n agent(s) on the declared models (…)`, exit 0; `--json` lists the entries with tier and model |
| AC-2031b | REQ-2031 | assert | two strong agents edited to `model: opus` under a Sonnet profile | `seat-models` | two `DRIFT:` lines naming file, model, tier and declared model, sorted by file, exit 1 |
| AC-2031c | REQ-2031 | assert | one drifted agent | `seat-models --write` | a `written:` line naming the file, then in step, exit 0; the next `upgrade` reports no local edit on it |
| AC-2032 | REQ-2032 | assert | an unknown argument | `seat-models --bogus` | exit 2, no file changed |
| AC-2031d | REQ-2031 | assert | a project-owned agent, a null `mid`, a profile without models | `seat-models` | exit 0 each; the project-owned agent is not listed |

## Expected effect and measurement

Written before the run. Benchmark `third-01`, stage PT9 (benchmark decision D158): arm E at this spec's commit with
§16 models at the bare arm's model (parity) against arm E at the earlier commit (Opus seats), same tasks and seeds,
one subscription lane. Before any run `seat-models` exits 0 in the arm's checkout.

| Change | Expected | Keep rule |
|---|---|---|
| REQ-2021 | every seat message of the parity arm carries the declared model | 100 percent of seat messages on the declared model |
| REQ-2031 | the check exits 0 before every run; a deliberate drift in a dry run is reported | exit 0 on every run; the dry-run drift reported |

The cost and accuracy of the parity arm against the Opus arm answer whether the seats need the stronger model; that
is PT9's question and the benchmark's decision, carried back here as a tier default change only with run ids.

## API contract

No API contract — the module is one install rule, one script and one library of the kit's own CLI.

## Oracle amendments

| Oracle | Entry | Why | Decision |
|---|---|---|---|
| ORACLE.md | none | the module adds no decision rule an oracle must apply | dropped — no oracle entry is needed |

## Amendments to earlier specs

| Id | Clause | Change | Decision |
|---|---|---|---|
| AM-6 | adapters/claude-code.md § Post-copy wiring 1, "To change later, edit the installed `.claude/agents/` files" | edit §16 and run `seat-models --write`; the installed files are rewritten, not edited by hand | D151 |
| AM-7 | this spec, REQ-2029 and REQ-2030 (20 Nov) | renumbered REQ-2031 and REQ-2032, with their AC rows, on 25 Nov: `specs/package-pinning.spec.md` (PR 45, merged first) holds REQ-2029 and REQ-2030; LG-1 keeps registry ids unique | D150 stands; ids only |

## Open questions

| Id | Question | Blocks | Answer |
|---|---|---|---|
| Q-1 | Should the profile win over `--models` typed on the command? | REQ-2021 | No. The flag is typed for one install on purpose (the setup skill chooses it from the subscription); the profile is the standing declaration. The flag wins, the profile wins over the lock's memory of an earlier flag, because the lock remembers and the profile declares. Answered 20 November 2026 under the autonomy mandate. |
| Q-2 | Should the benchmark arm install the kit after copying the profile, so REQ-2021 applies at `unpack`? | PT9 | Either order works: `unpack` reads the profile when it is there, and `seat-models --write` puts the agents in step when the profile lands later. The arm script's order is the bed thread's choice (D158). Answered 20 November 2026 under the autonomy mandate. |

## Decision log

Kit decision ids continue the kit's own sequence (D149 was the last). The benchmark repository keeps its own sequence (its D158 is the bed's wait on this spec).

| Id | Decision | Why |
|---|---|---|
| D150 | The Claude Code install reads §16 `models` for the agents' `model:` lines; flag over profile over lock over defaults; the profile is never recorded in the lock. | The kit told projects to fill §16 and then ignored it at the one place the model is written: every benchmark run so far had Opus seats under a Sonnet profile. |
| D151 | `seat-models`, a free check with `--write`, named before step 0 beside `orchestrator-check`. | An install rule is silent afterwards; a check that reads the installed files against the declaration keeps drift visible and fixes it in one command, with the lock hash kept in step so the next upgrade does not read the fix as a local edit. |
