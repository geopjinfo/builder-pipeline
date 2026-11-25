# Spec — toolkit-distribution: licence, package name, verifiable README, registry release

Module: toolkit-distribution
Status: ratified
Ratified-by: George (autonomy mandate of 16 November 2026, applied by the build thread; see Decision log)

> The kit's own spec for lane M13 (distribution) of release 2.0.0. It follows the installed spec template. Check it with
> `npx builder-pipeline run spec-check specs/toolkit-distribution.spec.md` (folder layout: `node scripts/spec-check.mjs specs/toolkit-distribution.spec.md`).
> It is maintainer-only and does not ship in the package.

## Intent

> "fill with recommended (do not trim based on dev effort - should be based on ROI and feature - be sensible,
> reasonable and grounded evidence driven)" — George, project chat, 16 November 2026. Decisions S3 (package name and
> registry listing) and S4 (verifiable proof statement) of the product strategy study were decided the same day.

## Scope

- In: an MIT licence file and the matching `license` field · the package name `builder-pipeline` with a second bin of
  the same name · README badges computed from source, with a check that stops drift · a proof statement a reader can
  verify · the npm publish steps in `RELEASING.md`.
- Out: the removal of the `builder` bin and the rename of every old `npx` line (done in the 2.0.0 release-prep lane; see DL-2) · the
  version bump to 2.0.0 (the release PR) · the first `npm publish` itself (the maintainer's act, with the maintainer's
  npm login) · measurements for `EXPERIMENTS.md` (lane M12).

## Actors

| Actor | Source |
|---|---|
| a project that installs the kit | strategy study S3 |
| a maintainer of the kit | strategy study S3 |
| a reader of the README | strategy study S4 |
| the kit's test suite | AGENTS.md rule 3 |

Decision log (the plan's rule: each decision taken without George is logged with its reasoning so he can change it):

| Id | Decision | Reasoning | Date |
|---|---|---|---|
| DL-1 | This spec is ratified by the build thread, not by George in person. | George's mandate of 16 November 2026: fill open decisions with the recommended option and complete the work. The spec is the recommended option written down; each acceptance criterion has a passing test. | 2026-11-16 |
| DL-2 | The `builder` bin stays, and the old `npx` prose is not renamed in this lane. The 2.0.0 release-prep PR drops the bin and renames the prose. **Done:** the release-prep lane removed the bin and renamed every shipped line to `npx builder-pipeline` (REQ-503 updated; `tests/bin-rename.test.mjs` guards it). | Four lanes edit prose in parallel. A rename now conflicts with all of them. The end state of decision S3 (bin `builder-pipeline` only) is unchanged. | 2026-11-16 |
| DL-3 | The licence holder is written as `geopjinfo`, the GitHub login. | No legal name is on record in the repository. George can change the holder line in `LICENSE` at any time; the test checks only the heading and the field. | 2026-11-16 |
| DL-4 | The licence is MIT. | Decision S3 names a permissive licence. MIT is the most common choice for a CLI kit and needs no notice file. | 2026-11-16 |
| DL-5 | The phases badge counts the numbered rows of the phase table in `skills/build-module-pipeline.md`, including the half-step rows (0.5, 0.7, 3b, 6.5). The orchestration row (`—`) is not a phase. | The table is the one source of the phase list. The old badge said 10 while the table had 13 numbered rows. A count from the source cannot drift. | 2026-11-16 |
| DL-6 | The personas badge counts `agents/*.md` and excludes `agents/experimental/`. | An experimental persona is installed only with `--experimental`; the badge describes the default install. | 2026-11-16 |
| DL-7 | The tool-targets badge counts the keys of `TOOLS` in `cli.js`. | `npx builder-pipeline targets` prints that table; the badge and the command then agree. | 2026-11-16 |
| DL-8 | The badge script ships in `scripts/` because that folder is in `files`. It is a maintainer tool and is not a `run` target (`.cjs`, not `.mjs`). | Putting it in `tests/` would hide a tool the release routine runs. The shipped copy is inert. | 2026-11-16 |
| DL-9 | The proof statement names no project and no module count. | The source project's data cannot ship (AGENTS.md rule 7). A count nobody can check is not evidence. Published measurements start with 2.0.0. | 2026-11-16 |
| DL-10 | The tests that build a fixture install at `node_modules/@geopjinfo/builder-pipeline` now build it at `node_modules/builder-pipeline`. | The tests describe the package shape. The shape changed with the name. `cli.js` detects a package install by the `node_modules` segment alone, so no code path changed. | 2026-11-16 |
| DL-11 | The README gives the git-tag install only; the registry form (`npm i -D builder-pipeline`) is removed until the npm name is reserved by a publish. | The name `builder-pipeline` is not registered (20 November 2026); a registry install line invites a project to fetch whatever a stranger publishes under it. George approved the change in the kit improvement plan (REQ-2028); the publish stays his call. |

## Requirements

Kind: `behaviour` (what succeeds) · `refusal` (what is refused, and why) · `effect` (what a success leaves behind) ·
`constraint` (always true).

| Id | Requirement | Actor | Kind | Source |
|---|---|---|---|---|
| REQ-501 | The repository root holds a `LICENSE` file whose first line is `MIT License` and whose copyright line names a year and a holder | a project that installs the kit | constraint | strategy study S3 |
| REQ-502 | `package.json` declares `license` as `MIT`, the same licence the `LICENSE` heading names, and lists `LICENSE` in `files` | a project that installs the kit | constraint | strategy study S3 |
| REQ-503 | `package.json` names the package `builder-pipeline` and declares one bin, `builder-pipeline`, running `cli.js`; the `builder` bin of 1.x is gone | a project that installs the kit | constraint | strategy study S3, DL-2 |
| REQ-504 | No shipped document or shipped script names the old scoped package; the README gives the git-tag install form and the pinned command `npx --no-install builder-pipeline`, and no registry install form while the npm name is unregistered (DL-11, `specs/package-pinning.spec.md`) | a reader of the README | constraint | strategy study S3, DL-11 |
| REQ-505 | `scripts/readme-badges.cjs` exports `badges()`, which returns the README badge block computed from source: phases from the phase table, personas from `agents/`, tool targets from `cli.js`, the Node floor from `engines`, zero dependencies from `package.json`, and install `npm` | a maintainer of the kit | behaviour | strategy study S4, DL-5 to DL-7 |
| REQ-506 | `check(TEXT)` returns one mismatch per badge whose line in TEXT differs from the generated one, and an empty list when the block matches | the kit's test suite | behaviour | strategy study S4 |
| REQ-507 | `node scripts/readme-badges.cjs --write [FILE]` rewrites the badge block (the lines between the centred paragraph's opening tag and its closing tag) in FILE (default `README.md`) and leaves every other line unchanged; without `--write` it prints the mismatches and exits 1 when there are any | a maintainer of the kit | effect | strategy study S4 |
| REQ-508 | The README badge block equals `badges()` | the kit's test suite | constraint | strategy study S4 |
| REQ-509 | The README holds the proof statement `Built and used by its author on one production backend.` with its two follow-up sentences, and no shipped document says `proven on`, `15+` or `shipped modules` | a reader of the README | constraint | strategy study S4, DL-9 |
| REQ-510 | `RELEASING.md` names the badge command, `npm pack --dry-run`, `npm publish --access public`, says the tag and the registry version must match, and says the first registry release is 2.0.0 | a maintainer of the kit | constraint | strategy study S3 |
| REQ-511 | `scripts/readme-badges.cjs` requires Node built-ins only and loads on Node 18 | a maintainer of the kit | constraint | AGENTS.md rules 4 and 5 |
| REQ-512 | `--write FILE` on a file with no badge block, or on a file that does not exist, is refused with exit 2 and writes nothing, because a rewrite needs the two markers to know where the block is | a maintainer of the kit | refusal | strategy study S4 |

## Acceptance criteria

Verb: `assert` (holds as written) · `by-design` (cite a decision) · `gap` (cite a deferred-registry row).

| Id | Req | Verb | Given | When | Then |
|---|---|---|---|---|---|
| AC-501 | REQ-501 | assert | the repository root | `LICENSE` is read | its first line is `MIT License` and a line matches `Copyright (c) YEAR HOLDER` |
| AC-502 | REQ-502 | assert | the repository root | `package.json` is read | `license` is `MIT`, it equals the first word of the `LICENSE` heading, and `files` contains `LICENSE` |
| AC-503 | REQ-503 | assert | the repository root | `package.json` is read | `name` is `builder-pipeline`, `bin["builder-pipeline"]` is `cli.js` and `bin.builder` is `cli.js` |
| AC-504 | REQ-504 | assert | every shipped file (package.json `files` plus README, CHANGELOG, LICENSE) | each is scanned for `@geopjinfo/builder-pipeline` | no hit outside `CHANGELOG.md`, whose history keeps the old name |
| AC-505 | REQ-504 | assert | the README | it is read | it contains `npm i -D github:geopjinfo/builder-pipeline#` and `npx --no-install builder-pipeline --version`, and not `npm i -D builder-pipeline` (DL-11) |
| AC-506 | REQ-505 | assert | the module is required | `badges()` is called | the markup names `pipeline-N_phases` where N is the count of numbered rows in the phase table, `personas-M_agents` where M is the count of `agents/*.md`, `--tool_targets-K` where K is the count of `TOOLS` keys in `cli.js`, `node-%E2%89%A518`, `CLI_dependencies-zero` and `install-npm` |
| AC-507 | REQ-506 | assert | a README text whose phases badge says `10_phases` | `check(TEXT)` is called | one mismatch is returned and it names `pipeline` |
| AC-508 | REQ-506 | assert | a README text whose block equals `badges()` | `check(TEXT)` is called | an empty list is returned |
| AC-509 | REQ-507 | assert | a copy of the README with a drifted badge and a changed first line | `node scripts/readme-badges.cjs --write COPY` | exit 0, the badge block of COPY equals `badges()`, and the first line of COPY is unchanged |
| AC-510 | REQ-507 | assert | the same drifted copy | `node scripts/readme-badges.cjs COPY` | exit 1 and a line names `pipeline` |
| AC-511 | REQ-508 | assert | the repository README | `check(README)` is called | an empty list is returned |
| AC-512 | REQ-509 | assert | the repository README | it is read | it contains the sentence `Built and used by its author on one production backend.` and the sentence `Published measurements start with 2.0.0` |
| AC-513 | REQ-509 | assert | every shipped Markdown document | each is scanned | none contains `proven on`, `15+` or `shipped modules` |
| AC-514 | REQ-510 | assert | `RELEASING.md` | it is read | it contains `readme-badges.cjs --write`, `npm pack --dry-run`, `npm publish --access public`, the words `first registry release is 2.0.0` and a sentence saying the tag and the registry version must match |
| AC-515 | REQ-511 | assert | `scripts/readme-badges.cjs` | its `require` calls are listed | every one names a `node:` built-in or a relative path, and the file loads without error |
| AC-516 | REQ-512 | assert | a Markdown file with no badge block | `node scripts/readme-badges.cjs --write FILE` | exit 2, a line says no badge block was found, and the file is unchanged |
| AC-517 | REQ-512 | assert | a path that does not exist | `node scripts/readme-badges.cjs --write MISSING` | exit 2 and no file is created |

## API contract

No API contract — the module is a licence file, a package manifest, a documentation script and a release routine; it serves no HTTP interface.

## Oracle amendments

| Oracle | Entry | Why | Decision |
|---|---|---|---|

## Open questions

| Id | Question | Blocks | Answer |
|---|---|---|---|
