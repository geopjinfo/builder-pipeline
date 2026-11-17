# Spec — repo-hygiene: the kit keeps an end project's repository clean

Module: repo-hygiene
Status: ratified
Ratified-by: George (plan approved 17 November 2026, "Approve, ship in 2.1.0"; the spec text is ratified under the autonomy mandate of 16 November 2026; see Decision log)

> The kit's own spec for repo hygiene in the projects that install it, part of release 2.1.0 (plan page "Repo Hygiene
> Plan", modules M18 to M22, decisions D86 to D98). It follows the installed spec template and the shape of
> `specs/toolkit-hygiene-standalone.spec.md`. Check it with
> `npx builder-pipeline run spec-check specs/repo-hygiene.spec.md` (folder layout: `node scripts/spec-check.mjs specs/repo-hygiene.spec.md`).
> It is maintainer-only and does not ship in the package.

## Intent

> "also is repo hygiene as part of our builder pipeline plan? builder should also take case this in end projects as
> well - how we will approach this." — George, project chat, 17 November 2026. The plan's answer: eight opt-in checks in
> the kit's checker pattern, one runner, one read-only persona, no removal without `--apply`, and `--apply` removes only
> what a person can get back.

## Scope

- In: `branch-sweep`, `run-sweep`, `ignore-check`, `size-check`, `secret-scan`, `deps-check`, `docs-check` and
  `dead-code` as kit scripts, one §16 feature each, default `off` (`deadCode` is `experimental-off`) · the
  `hygiene` runner over every hygiene-class check that is on · the pre-commit secret hook and the Claude Code secret
  write guard, copied and never armed · the `repo-steward` persona · the Phase 7 step, the readiness item, the
  orchestrator `next:` lines, the `builder-init` proposal step · the `hygiene` tool group · the reporter's HYGIENE
  section (M16) · EXPERIMENTS §23 · the standalone form of every check.
- Out: deleting a remote branch, a force delete or a history rewrite (the kit prints the command; D86) · writing
  `.gitignore` (D97) · unused-export analysis (deferred; D91) · typed audit parsers for pnpm, yarn, pip, cargo or go
  (the `lines` format covers them; deferred) · a licence check of dependencies (deferred) · line endings and
  whitespace (the project's formatter owns them) · worktrees on a remote host (waits for EXPERIMENTS §18).

### INVARIANTS

The checker treats these as non-negotiable (D45). Every requirement below holds inside them.

- Zero dependencies and Node 18. The runtime is CommonJS; `.mjs` entry points sit over `.cjs` logic. The checks use
  `git` and Node built-ins only; the dependency check runs the project's own package manager (D90).
- Nothing is removed without `--apply`. With `--apply`, a sweep removes only what a person can restore: a merged local
  branch after a snapshot ref, a folder by a rename into a trash folder. No file in this module holds a recursive
  delete. The kit never runs a remote delete, a force delete or a history rewrite (D86).
- A finding names the kind, the path and the line or the commit. It never prints a secret's text (D88).
- A feature that is off prints `FEATURE: not configured`, where FEATURE is the feature key, and exits 3. It never
  prints a pass. The `hygiene` runner is a script, not a feature (D87).
- `secretScan` and `sizeCheck` are hard checks: a finding exits 1 when the feature is on. Every other check reports
  and exits 0 with findings (D89).
- Lists in §16 add to the built-in catalogues and never remove from them. `allow` suppresses by path only.
- Numbers come from code. The `repo-steward` persona writes words, never runs `--apply`, never edits §16 (D94).
- A spec change after ratification is an amendment row in this file (D45). A ratified row is never edited in place.

## Actors

| Actor | Source |
|---|---|
| a person who merges and cleans up | intent; scripts/lib/worktree-sweep.cjs |
| a CI job | intent |
| the build-module-pipeline at Phase 7 | skills/build-module-pipeline.md |
| the orchestrator after a merge | skills/orchestrator.md |
| a team that runs another orchestrator | specs/toolkit-hygiene-standalone.spec.md |
| the repo-steward persona | this spec, REQ-1835 |
| the progress reporter (M16) | specs/capacity-reporter.spec.md |
| a person who sets up the kit | skills/builder-init.md |

Decision log (the plan's rule: each decision is logged with its reasoning so George can change it):

| Id | Decision | Reasoning | Date |
|---|---|---|---|
| D86 | Hygiene reports first and removes second. `--apply` removes only what a person can restore. The kit never runs a remote delete, a force delete or a history rewrite; it prints the command. | The worktree sweep's WHY block states the risk: a hand-typed recursive delete destroys evidence. A remote delete and a history rewrite reach other people's clones and the kit cannot undo them. DESIGN §12, the human seam. | 2026-11-17 |
| D87 | One feature per check, flat in the FEATURES table. The `hygiene` runner is a script, not a feature. | AGENTS.md rule 11, the `features` command and `tests/pack-prose.test.mjs` know flat keys. `board-check-all` is the runner shape. A project switches one check on without the others. | 2026-11-17 |
| D88 | The secret scan, the pre-commit hook and the write guard import the outbound guard's shapes from one exported list. | Two lists drift. The guard's rule "name the kind, never the text" exists and is tested; the scan inherits it. | 2026-11-17 |
| D89 | `secretScan` and `sizeCheck` fail the gate (exit 1) when on. The other six checks report. | A leaked key and a committed binary have a cost that grows with every clone. The others need judgment. | 2026-11-17 |
| D90 | The dependency check runs the project's package manager through profile commands and reads its JSON; `npm` is the first format, `lines` covers any other tool by a pattern. | AGENTS.md rule 4. `npm ls --json` and `npm audit --json` are stable surfaces. | 2026-11-17 |
| D91 | `deadCode` ships `experimental-off`. Orphan files and old TODO markers first; unused exports deferred. The baseline is a ratchet bank. | Dynamic imports and framework conventions make false positives likely; EXPERIMENTS §23 measures the rate before any gate. | 2026-11-17 |
| D92 | `docs-check` is a new script that imports the instruction lint's path resolver; the lint is unchanged. | The lint's counts and history ratchets fit instruction files. A mode flag would change what the lint's baseline means in installed projects. | 2026-11-17 |
| D93 | A `hygiene` tool group in `scripts/lib/tool-groups.cjs`. | The toolkit brief's "Swiss tool" rule; the group guard test requires every file to be mapped. | 2026-11-17 |
| D94 | Numbers come from code; words come from the `repo-steward` persona, read-only, never `--apply`. | The capacity plan's D70 rule applied here. | 2026-11-17 |
| D95 | Release 2.1.0, with M15 to M17. George chose this option on 17 November 2026. | Additive and off by default; the reporter's HYGIENE line is the one cross-plan seam. | 2026-11-17 |
| D96 | History modes are off by default and bounded by `maxCommits`. | A walk over a long history is slow; the §23 runner-time trial sets the defaults. | 2026-11-17 |
| D97 | `ignore-check` never writes `.gitignore`; it prints the lines to add. | `.gitignore` is a project-owned file (AGENTS.md rule 12). | 2026-11-17 |
| D98 | Ids REQ-1801 onward, decisions D86 onward, modules M18 to M22, one kit-wide sequence. | D82 of the capacity plan: one log for the kit. REQ-1801 is the first free block after REQ-1704. | 2026-11-17 |
| DL-1 | This spec text is ratified by the plan thread under the mandate; the plan itself was approved by George in person. | George's mandate of 16 November 2026 covers spec ratifications (logged). Each acceptance criterion names its test. | 2026-11-17 |

## Requirements

Kind: `behaviour` (what succeeds) · `refusal` (what is refused, and why) · `effect` (what a success leaves behind) ·
`constraint` (always true). Phrasing is EARS: "shall", "When", "If … then".

| Id | Requirement | Actor | Kind | Source |
|---|---|---|---|---|
| REQ-1801 | The kit shall list `features.branchSweep` in the FEATURES table with the default off and `target` required. If `remote` is outside `list` or `off`, or a number is negative, then the kit shall refuse the profile and print the allowed set. | a person who merges and cleans up | refusal | D87 |
| REQ-1802 | When `branch-sweep` runs, the kit shall give every local branch one verdict: MERGED when its tip is contained in `target`, with the age of its last commit; STALE when it is not contained and its last commit is older than `staleDays`; KEEP, with the reason, for `target`, the current branch, a `keep` match and a branch checked out in any worktree. | a person who merges and cleans up | behaviour | plan M18 |
| REQ-1803 | `branch-sweep` shall be a dry run unless `--apply` is given. With `--apply`, for each MERGED branch the kit shall write `refs/builder/branches/NAME` at its tip and then run `git branch -d`, never `-D`. STALE and KEEP are never deleted. The summary shall name every ref written and the command that restores a branch. Exit 0 clean, 1 a delete failed, 2 usage or an invalid profile. | a person who merges and cleans up | effect | D86 |
| REQ-1804 | With `remote: list`, the kit shall list remote-tracking branches contained in `target` with the exact push command that deletes them, and shall never run a push. With `--apply` the kit shall prune stale remote-tracking refs only. | a person who merges and cleans up | constraint | D86 |
| REQ-1805 | The kit shall mark a branch under the orchestrator's `branchPrefix` MERGED only when its tip is contained in `target` and no orchestrator run holds it in LAUNCHED or STALLED; otherwise KEEP names the run and the lane. | the orchestrator after a merge | constraint | plan M18 |
| REQ-1806 | The kit shall list `features.runSweep` with the default off. When `run-sweep` runs, it shall list under `roots` the run folders, worktree backups, report folders, `PIPELINE_PROFILE.md.bak` and upgrade backups older than `keepDays`, each with its size and age; a folder of a run with a lane in LAUNCHED or STALLED is KEEP. With `--apply` each SWEEP item is moved by rename into `LOGS/trash/DATE/`. No recursive delete exists in the module. Snapshot refs of merged lanes are listed with the delete command, never deleted. | a person who merges and cleans up | effect | D86 |
| REQ-1807 | With the feature off, `branch-sweep --target X [--stale-days N] [--apply]` and `run-sweep [--keep-days N] [--apply]` shall run with the default settings and say so on the first line. A flag without its value, an unknown flag and a missing `--target` are usage errors with exit 2. | a team that runs another orchestrator | behaviour | specs/toolkit-hygiene-standalone.spec.md |
| REQ-1811 | The kit shall list `features.ignoreCheck` with the default off and carry a built-in junk catalogue (`node_modules/`, `dist/`, `build/`, `coverage/`, `out/`, `*.log`, `.env`, `.env.*`, `.DS_Store`, `Thumbs.db`, `*.swp`, `*~`, `*.orig`, `*.rej`, core dumps, the kit's run folders) that `extra` adds to. When `ignore-check` runs, it shall report TRACKED-JUNK for a tracked file that matches and UNIGNORED-JUNK for an untracked, not-ignored file that matches; `allow` suppresses by path. It shall print the `.gitignore` lines to add and shall never write the file. | a CI job | behaviour | D97 |
| REQ-1812 | The kit shall list `features.sizeCheck` with the default off. When `size-check` runs, every tracked file over `maxFileKb` is LARGE with its size; an LFS pointer file is not large; `allow` suppresses by path. If `history` is true, then blobs over the limit reachable from `target` within `maxCommits` are LARGE-HISTORY with the first commit that added them. LARGE in the tree exits 1; LARGE-HISTORY is reported. | a CI job | refusal | D89, D96 |
| REQ-1813 | The kit shall list `features.secretScan` with the default off. When `secret-scan` runs, it shall scan every tracked text file under `roots` with the outbound guard's secret shapes and the private-key header, and shall report every tracked `.env` or `.env.*` file. A finding names the kind and `file:line`, never the matched text. A binary file and a file over 1 MB are skipped and counted. `allow` suppresses by path. Any finding exits 1. | a CI job | refusal | D88, D89 |
| REQ-1814 | If `history` is true, then `secret-scan` shall scan the added lines of each commit in `target..HEAD`, bounded by `maxCommits`. A hit names the commit and the kind, never the text, prints "Rotate the key. The history rewrite is a decision for a person." and exits 1. | a person who merges and cleans up | refusal | D86, D96 |
| REQ-1815 | The kit shall ship `hooks/secret-scan-precommit.sh`, copied by `unpack` and never armed. When armed, it shall scan the staged added lines through `scripts/lib/secret-scan.cjs` as data and reject a commit with a hit, naming the kind and the file. No unlock variable exists; the profile's `allow` list is the only exception. `doctor` shall report armed, missing or foreign in the `git-hooks` shape. | a CI job | refusal | D88 |
| REQ-1816 | The kit shall ship `hooks/claude-code/secret-write-guard.cjs`, a PreToolUse hook, copied and never armed. When armed, it shall judge the `content` of Write and the `new_string` of Edit and MultiEdit against the same shapes, deny a write with a hit naming the kind, and pass a path in `allow`. Hook trust applies. The settings block is printed in `adapters/claude-code.md`. | the build-module-pipeline at Phase 7 | refusal | D88 |
| REQ-1817 | The secret shapes shall be exported from `scripts/lib/outbound-guard.cjs` only; the guard, the scan, the hook and the write guard import them. A test fails when a second copy exists. | a CI job | constraint | D88 |
| REQ-1821 | The kit shall list `features.depsCheck` with the default off. When `deps-check` runs, it shall report NO-LOCKFILE when `lockfile` is true and none exists beside the manifest; LS-PROBLEM per entry of `problems[]` in the list command's JSON; AUDIT-SEVERITY counts from the audit command's JSON, with exit 1 when a count at or above `maxSeverity` is non-zero; UNUSED-DEP for a dependency no file under `unused.roots` imports (require, import, dynamic import, subpath imports, an `@types/*` package paired with its runtime package). Commands run through the platform shell with a timeout. If a command is absent or fails outside its documented non-zero exit, then the result is UNMEASURABLE, never a pass. With `format: lines`, the project's commands are counted by a pattern. | a CI job | behaviour | D90 |
| REQ-1822 | The kit shall list `features.docsCheck` with the default off. When `docs-check` runs over every Markdown file under `roots`, an inline-code repo path shall resolve (the lint's resolver), a relative link shall resolve to a file, a `#anchor` shall exist as a heading in the target file (the GitHub slug rule), and a fenced `npx builder-pipeline run NAME` shall name a shipped script. Findings BROKEN-PATH, BROKEN-LINK, BROKEN-ANCHOR and UNKNOWN-SCRIPT at `file:line`; external URLs are never fetched; `ignorePaths` suppresses. A finding exits 1. | a CI job | refusal | D92 |
| REQ-1823 | The kit shall list `features.deadCode` as `experimental-off`. When on, `dead-code` shall report ORPHAN for a file under `roots` with an extension in `extensions` that no other file imports and that is not an entry (package.json `main`, `bin`, `exports`, the test pattern, `entries` globs). `baseline` is a ratchet bank: a new ORPHAN is REFUSED (exit 1), a removed one shrinks the bank. Off, nothing of it runs. | a person who merges and cleans up | refusal | D91 |
| REQ-1824 | When on, `dead-code` shall report STALE-TODO for a `TODO`, `FIXME`, `HACK` or `XXX` marker whose line is older than `todoDays` by `git blame`, with the age in days and a pointer to the deferred registry; the author is not printed. Reported, never failed. | a person who merges and cleans up | behaviour | D91 |
| REQ-1825 | EXPERIMENTS.md §23 shall state, before the code, the measurement for `deadCode` (the ORPHAN false-positive rate on the kit's own repo and on the loop runner's test project) and the keep rule (under 10 percent on both, else drop). | a CI job | constraint | D91 |
| REQ-1831 | `npx builder-pipeline run hygiene [--json] [--since REF] [--check LIST] [--apply]` shall run every hygiene-class check whose feature is on (the eight checks, `worktreeSweep`, `instructionLint`, `instructionBudget`) and print one report: findings grouped by check, one count line per check, one summary line. A check that is off prints its `not configured` line. `--apply` reaches only the three sweeps. Exit 1 when a hard check found something, 0 clean, 3 when no check is on, 2 usage. | a CI job | behaviour | D87 |
| REQ-1832 | `--since REF` shall narrow `secretScan`, `sizeCheck`, `ignoreCheck` and `docsCheck` to the files changed since REF; the sweeps and `depsCheck` ignore it and say so in one line. | the build-module-pipeline at Phase 7 | behaviour | plan M21 |
| REQ-1833 | Phase 7 of `build-module-pipeline` shall run `hygiene --since BASE --json`. A hard finding opens a `FIX-n` row; soft findings go to the handoff pack gaps. `module-readiness-check` shall carry one item: no hard finding since base; feature off is recorded as `not configured`, not a pass. | the build-module-pipeline at Phase 7 | effect | plan M21 |
| REQ-1834 | When `orch merge` completes a lane and `branchSweep` or `worktreeSweep` is on, `nextActions` shall offer the sweep as a dry run and shall never offer `--apply`. | the orchestrator after a merge | constraint | D86 |
| REQ-1835 | The kit shall ship `agents/repo-steward.md` with neutral frontmatter, capabilities `read-only`, tier `mid`, effort `low` and the five-clause contract. Its input is the hygiene JSON. Its output per soft finding is keep, fix or allow with a reason, the allow-list or baseline row to add, and one decision-log row. It never edits §16, never runs `--apply`, never spawns another agent. The orchestrator skill dispatches it when a report has soft findings. | the repo-steward persona | constraint | D94 |
| REQ-1836 | When `features.reporter` is on and at least one hygiene check is on, the report shall carry a HYGIENE section with one line per check from the last `hygiene --json`; with no JSON yet, the line says `hygiene: no run yet`. | the progress reporter (M16) | behaviour | D95 |
| REQ-1837 | `doctor` shall print one row per tool for the secret-scan pre-commit hook (armed, missing, foreign) and for the secret write guard (copied, not armed; Claude Code only; Codex Bash-only note; Antigravity unsupported). | a person who sets up the kit | behaviour | plan M21 |
| REQ-1838 | The `builder-init` skill shall propose the hygiene keys from the repo (the integration branch, build output folders for `ignoreCheck.extra`, the package manager from the lockfile found, the document roots from §10) and a person shall confirm before the keys are written. `unpack` shall copy the two hooks and print their settings lines. | a person who sets up the kit | behaviour | plan M21 |
| REQ-1839 | Every new file shall belong to exactly one tool group. The group `hygiene` shall exist; `unpack --tools hygiene` installs the eight checks, the runner, the two hooks and the persona plus the core set. | a team that runs another orchestrator | constraint | D93 |
| REQ-1840 | FEATURES.md, GUIDE.md, USAGE.md, the profile template §16 block, llms.txt and CHANGELOG [Unreleased] shall carry the hygiene features. Nothing shipped names a project, a host or a size as a fact. | a person who sets up the kit | constraint | AGENTS.md rules 7, 13 |

## Acceptance criteria

Verb: `assert` (holds as written) · `by-design` (cite a decision) · `gap` (cite a deferred-registry row).

| Id | Req | Verb | Given | When | Then |
|---|---|---|---|---|---|
| AC-1801 | REQ-1801 | assert | a profile with `branchSweep.state: on` and no `target` | the profile loads | invalid, the error names `branchSweep.target` (tests/profile.test.mjs) |
| AC-1801b | REQ-1801 | assert | `branchSweep.remote: "delete"` | the profile loads | invalid, the error prints `list, off` (tests/profile.test.mjs, tests/features.test.mjs) |
| AC-1802 | REQ-1802 | assert | five branches with injected `merge-base` and `worktree list` output | `judge` runs | each verdict and reason matches the fixture: MERGED with age, STALE, KEEP for target, current, keep match, checked out (tests/branch-sweep.test.mjs) |
| AC-1803 | REQ-1803 | assert | a temp repo with one merged and one unmerged branch | `branch-sweep --target main --apply` | the merged branch is gone, `refs/builder/branches/NAME` exists at the old tip, the unmerged branch remains, the output holds `git branch NAME refs/builder/branches/NAME`, exit 0 (tests/branch-sweep.test.mjs) |
| AC-1803b | REQ-1803 | assert | the same repo | `branch-sweep --target main` without `--apply` | both branches remain, the first line says dry run (tests/branch-sweep.test.mjs) |
| AC-1804 | REQ-1804 | assert | a temp remote with a merged branch and a gone tracking ref | `branch-sweep --target main --apply` | the remote still has the branch, the output holds `git push origin --delete NAME`, the gone tracking ref is pruned (tests/branch-sweep.test.mjs) |
| AC-1805 | REQ-1805 | assert | an orch state with one LAUNCHED lane whose branch tip is contained in target | `judge` runs with the injected state | KEEP with the run id and the lane id (tests/branch-sweep.test.mjs) |
| AC-1806 | REQ-1806 | assert | a temp project with one run folder 40 days old and one with a LAUNCHED lane | `run-sweep --apply` with `keepDays` 30 | the old folder is under `trash/DATE/` with its content, the live folder is in place, exit 0 (tests/run-sweep.test.mjs) |
| AC-1806b | REQ-1806 | assert | the sources `scripts/lib/run-sweep.cjs` and `scripts/lib/branch-sweep.cjs` | the source guard test runs | neither holds `rmSync` with `recursive`, nor `rm -rf` (tests/run-sweep.test.mjs) |
| AC-1807 | REQ-1807 | assert | no profile | `branch-sweep --target main` | the first line says the defaults are in use, the verdicts print, exit 0 (tests/branch-sweep.test.mjs) |
| AC-1807b | REQ-1807 | assert | no profile | `branch-sweep --stale-days` with no value; `run-sweep --bogus` | exit 2 both times with a usage line (tests/cli-commands.test.mjs) |
| AC-1811 | REQ-1811 | assert | a temp repo that tracks `debug.log` and holds an untracked `.env` | `ignore-check` | one TRACKED-JUNK, one UNIGNORED-JUNK, the two lines to add, exit 0, `.gitignore` unchanged (tests/ignore-check.test.mjs) |
| AC-1811b | REQ-1811 | assert | the same repo with `debug.log` in `allow` | `ignore-check` | one finding only (tests/ignore-check.test.mjs) |
| AC-1812 | REQ-1812 | assert | a temp repo with a 600 KB tracked file and a 2 MB blob deleted two commits ago, `maxFileKb` 512, `history: true` | `size-check` | one LARGE with the size in KB, one LARGE-HISTORY with the adding commit, exit 1 (tests/size-check.test.mjs) |
| AC-1812b | REQ-1812 | assert | a tracked LFS pointer file | `size-check` | no LARGE for it (tests/size-check.test.mjs) |
| AC-1813 | REQ-1813 | assert | a tracked file with a fake AWS key shape and a tracked `.env` | `secret-scan` | two findings with kind and line, the key text absent from stdout and stderr, exit 1 (tests/secret-scan.test.mjs) |
| AC-1813b | REQ-1813 | assert | the same with the file in `allow` and a 2 MB text file | `secret-scan` | exit 0 for the allowed file, the large file counted as skipped (tests/secret-scan.test.mjs) |
| AC-1814 | REQ-1814 | assert | a branch where a key shape was added and removed in two commits, `history: true` | `secret-scan` | the adding commit is named, the text is absent, the rotate sentence prints, exit 1 (tests/secret-scan.test.mjs) |
| AC-1815 | REQ-1815 | assert | the hook armed in a temp repo and a staged file with a key shape | `git commit` | the commit fails, stderr names the kind and the file, the text is absent; with the file in `allow` the commit succeeds (tests/hooks.test.mjs, tests/package-hooks.test.mjs) |
| AC-1815b | REQ-1815 | assert | the hook armed, missing, and a foreign pre-commit | `doctor --json` | the row states armed, missing, foreign in turn (tests/doctor.test.mjs) |
| AC-1816 | REQ-1816 | assert | a Write input with a GitHub token shape | the hook runs | exit 2, the reason names the kind, the token is absent; a fixture path in `allow` exits 0 (tests/hooks.test.mjs, tests/hook-trust.test.mjs) |
| AC-1817 | REQ-1817 | assert | the sources | the shapes test runs | `secret-scan.cjs` and the two hooks import `SHAPES` from the guard and hold no regular expression literal that matches a known shape (tests/secret-scan.test.mjs) |
| AC-1821 | REQ-1821 | assert | a fixture project with a stub `npm` on PATH that prints recorded `ls` and `audit` JSON | `deps-check` | the LS-PROBLEM and AUDIT-high counts match the fixture, exit 1 (tests/deps-check.test.mjs) |
| AC-1821b | REQ-1821 | assert | a dependency no file under `unused.roots` imports; a stub that is absent | `deps-check` | one UNUSED-DEP; then UNMEASURABLE with exit 0 (tests/deps-check.test.mjs) |
| AC-1822 | REQ-1822 | assert | a docs folder with one broken link, one missing anchor, one unknown script name, and an injected fetch that throws | `docs-check` | three findings at their lines, fetch never called, exit 1 (tests/docs-check.test.mjs) |
| AC-1823 | REQ-1823 | assert | a fixture with one imported and one orphan file and an empty bank | `dead-code` | one ORPHAN REFUSED, exit 1; with the orphan in the bank exit 0; with the feature off `deadCode: not configured` (tests/dead-code.test.mjs) |
| AC-1824 | REQ-1824 | assert | a temp repo with a marker committed under an old `GIT_COMMITTER_DATE` | `dead-code` | one STALE-TODO with the age, no author name, exit 0 (tests/dead-code.test.mjs) |
| AC-1825 | REQ-1825 | assert | EXPERIMENTS.md | `run experiments --check` | §23 has a measurement and a decision cell; `features` prints the §23 decision for `deadCode` (tests/experiments.test.mjs, tests/features.test.mjs) |
| AC-1831 | REQ-1831 | assert | `secretScan` and `ignoreCheck` on, a tracked key shape | `hygiene --json` | two check blocks, the other checks `not configured`, exit 1 (tests/hygiene.test.mjs) |
| AC-1831b | REQ-1831 | assert | every check off | `hygiene` | exit 3 and one line per feature (tests/hygiene.test.mjs) |
| AC-1832 | REQ-1832 | assert | two tracked key shapes, one added after REF | `hygiene --since REF` | one finding and one line naming the checks that ignore `--since` (tests/hygiene.test.mjs) |
| AC-1833 | REQ-1833 | assert | the two skill files | pack-prose.test runs | both name the command and the off rule; the kit's own instruction lint is green (tests/pack-prose.test.mjs) |
| AC-1834 | REQ-1834 | assert | a state with one merged lane and both features on | `orch next` | two SWEEP lines without `--apply`; with the features off, none (tests/orch-state.test.mjs) |
| AC-1835 | REQ-1835 | assert | the persona file and the three adapters | the persona and adapter tests run | neutral frontmatter, the contract present, each rendered output names read-only tools only (tests/persona.test.mjs, tests/adapters.test.mjs) |
| AC-1836 | REQ-1836 | assert | the report fixture with a hygiene JSON; then without | `build` | the HYGIENE section holds the counts; then `hygiene: no run yet` (tests/report.test.mjs) |
| AC-1837 | REQ-1837 | assert | a temp project | `doctor --json` | the two rows exist per tool with the stated status, exit 0 (tests/doctor.test.mjs) |
| AC-1838 | REQ-1838 | assert | the skill file; `unpack --tool claude-code --dry-run` | pack-prose.test runs; the unpack runs | the skill names each key it proposes and the confirm step; the two hooks are listed as copied, never armed (tests/pack-prose.test.mjs, tests/setup-flow.test.mjs) |
| AC-1839 | REQ-1839 | assert | the install list | toolkit-unpack-groups.test runs; `unpack --tools hygiene --dry-run` | no unmapped file; the count per group prints (tests/toolkit-unpack-groups.test.mjs) |
| AC-1840 | REQ-1840 | assert | the shipped files | genericity, pack-prose, invocation and kit-location tests run | green (the four tests) |

## API contract

No API contract — the module is a set of command-line tools, hooks and a persona with exit codes and printed lines; it serves no HTTP interface.

## Oracle amendments

| Oracle | Entry | Why | Decision |
|---|---|---|---|

## Open questions

| Id | Question | Blocks | Answer |
|---|---|---|---|
