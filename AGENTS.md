# Working on the builder kit — for AI agents

This file is for an agent **changing this repository** (the kit itself). It does not ship in the package (it is kept
out of `package.json` `"files"`, and `tests/package.test.mjs` fails if it is added). An agent in a project that
*installs* the kit reads that project's own `AGENTS.md` / `CLAUDE.md` and the kit's shipped
[`llms.txt`](llms.txt) instead.

## What this repository is

`builder-pipeline`: an npm package, installed from a git tag, that gives any software project a
multi-agent build pipeline for Claude Code, Codex and Antigravity (and prompt files for other agents). A zero-dependency
Node CLI (`cli.js`, command `builder-pipeline`) installs neutral personas, skills, templates and hooks into a project, and runs
the kit's checker scripts there (`npx builder-pipeline run <name>`). Every project fact lives in the project's own
`PIPELINE_PROFILE.md`; the kit carries none.

## Layout

| Path | What it holds |
|---|---|
| `cli.js`, `cli/` | the CLI: bootstrap, inventory, choices, unpack, upgrade, verify, features, doctor, check-ledgers, check-targets, personas-check, run, targets |
| `adapters/lib/` | per-tool renderers (`neutral.cjs` reads the neutral format; `claude-code.cjs`, `codex.cjs`, `antigravity.cjs` render it); `index.cjs` |
| `adapters/*.md` | per-tool notes; the source for doctor's partial/unsupported reasons |
| `agents/` | the nine neutral personas (+ `experimental/`) |
| `skills/` | the pipeline, lite split, gate batch, orchestrator, builder-init, persona-detect, scaffold, readiness, setup skills (+ `references/`) |
| `skills-extra/` | optional utility skills (`--no-extras` skips them) |
| `templates/` | ledger formats installed once as project-owned files |
| `scripts/`, `scripts/lib/` | checker and board scripts (`.mjs` entry, `.cjs` logic); `scripts/lib/profile.cjs` holds the `FEATURES` table (every §16 feature and its default) |
| `hooks/` | guard hooks: universal + `claude-code/` |
| `oracles/`, `examples/`, `tooling/` | contract-oracle adapters; examples (never defaults); optional and experimental tooling |
| `tests/` | the suite (`run.mjs` + `*.test.mjs`, fixtures under `tests/fixtures/`); not shipped |
| `README.md`, `GUIDE.md`, `FEATURES.md`, `USAGE.md`, `DESIGN.md`, `EXPERIMENTS.md`, `llms.txt` | the shipped docs (short entry · deep dive · one-page feature table · runbook · why · experiments · agent map) |
| `RELEASING.md`, `AGENTS.md`, `CLAUDE.md` | maintainer-only; not shipped |

## The rules

1. **Branch only.** Work on a branch; never commit to, merge into or push `main`. Never create a tag unless the
   maintainer asks: releasing is [`RELEASING.md`](RELEASING.md), and `main` moves only by fast-forward to a green commit.
2. **The suite stays green.** From the repo root: `node tests/run.mjs` (all tests), or
   `node tests/run.mjs <name-fragment>…` for the files you touched while iterating. Every commit has the full suite at
   `fail 0`. A test that flakes under load is re-run alone and noted, never skipped.
3. **Red test first.** Every behaviour change starts with a test that fails for the right reason (name it
   `red: …`), then the change, then green. A doc-only change needs no new test, but must keep the prose tests green.
4. **Zero dependencies.** No `npm install`, no `dependencies` or `devDependencies`. Node built-ins only.
5. **Node 18 floor.** `engines.node` is `>=18` and `cli.js` enforces it; use nothing newer.
6. **CommonJS.** `package.json` says `"type": "commonjs"`; runtime code is `.js` / `.cjs` with `require`. Tests are
   `.mjs` (`node:test`, `node:assert/strict`). Scripts are `.mjs` entry points over `.cjs` logic in `scripts/lib/`.
7. **No project-specific ids.** Nothing shipped may name a project, product, person, private host, drive path or a
   project's ticket/decision/ruling ids. `tests/genericity.test.mjs` scans every shipped file; its allowlist is exact
   text only, for the kit's own neutral ids.
8. **Install-neutral commands.** Shipped text says `npx builder-pipeline <cmd>` / `npx builder-pipeline run <name>`. A folder-layout form
   (`node builder/cli.js`, `node scripts/<x>.mjs`) appears only on a line that says "folder layout", in a
   `> **Commands.**` note, or in Markdown the CLI installs (it rewrites them). Scripts and hooks print run hints through
   `scripts/lib/run-hint.cjs` only. Guarded by `tests/invocation.test.mjs` and `tests/kit-location.test.mjs`.
9. **Neutral personas.** `agents/*.md` frontmatter is neutral (`name`, `description`, `capabilities`, `tier`, optional
   `effort`, `writes`). Never write tool-specific fields there: `adapters/lib/` renders each tool's form.
10. **Hooks are copied, never armed.** The CLI copies hook files and prints the settings block; it never writes a
    tool's live hook configuration. Enabling a hook is the human's act.
11. **Every check declared.** A new optional feature goes into the `FEATURES` table in `scripts/lib/profile.cjs` with
    a default of `off` (or `experimental-off` with an `EXPERIMENTS.md` entry and its measurement), and a step that
    cannot run prints `<feature>: not configured`, never a pass. Prose may name only `features.<x>` the loader knows
    (`tests/pack-prose.test.mjs`).
12. **Project-owned files are never rewritten** by `unpack` or `upgrade`; kit-owned files are recorded in
    `builder.lock.json` and backed up before an upgrade overwrites them.
13. **CHANGELOG.** Every change adds an entry under `## [Unreleased]` in `CHANGELOG.md`, with its tests. Do not bump
    `package.json` `version` outside a release (`tests/version.test.mjs` ties it to the newest released heading).
14. **Shipped files are listed.** A new top-level file or folder is either added to `package.json` `"files"` or to the
    skip list in `tests/package.test.mjs`; the test fails on anything in neither.
15. **Commits.** Small, each green. No AI attribution or co-author trailers.

## Where to look

| To change… | Start at | Tests |
|---|---|---|
| a CLI command | `cli.js`, `cli/*.cjs` | `cli-commands`, `setup-flow`, `upgrade`, `lock`, `choices`, `inventory`, `doctor` |
| what a tool receives | `adapters/lib/<tool>.cjs`, `adapters/<tool>.md` | `adapters`, `native-tools`, `doctor` |
| a §16 feature or its default | `scripts/lib/profile.cjs`, `PIPELINE_PROFILE.template.md` | `profile`, `features`, `pack-prose` |
| a checker script | `scripts/<name>.mjs` + `scripts/lib/<name>.cjs` | `<name>.test.mjs` |
| a hook | `hooks/`, `hooks/claude-code/`, `hooks/README.md` | `hooks`, `protected-paths*`, `hook-trust`, `bash-cap`, `package-hooks` |
| the orchestrator | `scripts/orch.mjs`, `scripts/lib/orch-*.cjs`, `skills/orchestrator.md` | `orch-*` |
| a persona or skill text | `agents/`, `skills/` | `pack-prose`, `persona`, `instruction-*` |
| the docs | `README.md` (short entry), `GUIDE.md`, `FEATURES.md`, `llms.txt` | `cli-commands` (README command list), `kit-location`, `invocation`, `genericity` |
| a release | [`RELEASING.md`](RELEASING.md) | `version`, `package` |

Why a rule exists: [`DESIGN.md`](DESIGN.md). What an unproven feature must prove: [`EXPERIMENTS.md`](EXPERIMENTS.md).
