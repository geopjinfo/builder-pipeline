# Spec — accounts: one person runs several accounts and the kit places every lane on the right one

Module: accounts
Status: ratified
Ratified-by: George, 16 November 2026 (plan decisions D1 to D60)

> The requirements oracle for the 2.0.0 "accounts" release (profile §3). The planner, the tester's requirement pack
> and the reviewer's alignment audit read these rows verbatim. Check it with `node scripts/spec-check.mjs accounts
> --ratified`. Every table header is read by the checker; keep it as written. Requirements are written in EARS
> phrasing (ubiquitous, event-driven, state-driven, unwanted behaviour) and ASD-STE100 Simplified Technical English
> (D45). The exact names of flags, keys, codes and files are the ones the tests assert.

## Intent

> "tag all features done - everything should be in 2.0 version (everything planned)"
> (George, 16 November 2026, project chat)

> "if there is any open questions or decisions - proceed with recommended way and start building it - sub agent
> driven multiple lanes - complete fast as possible"
> (George, 16 November 2026, project chat)

The plan artifact https://claude.ai/artifact/FLZ6L6YJqhq8Jd3uV3pvdJ is the source of every row below.

## Scope

- In: M0 Spec and decisions — this file, the decision-log entries D1 to D60, `specs/` on the package skip list, a
  golden placement fixture from the 1.0 orch suite.
- In: M1 Account registry — `features.accounts` in §16 (default off), load-time validation, `account-paths.cjs`,
  the refusal of 1.0 `seats`, `limits`, `secondaryConfigDir` and `credit`, and `accounts migrate`.
- In: M2a Readiness assessment — pure `assess(account, probes, usage, now)`, built-in Claude Code and Codex probes,
  the Codex `rate_limits` reader, usage sources, the OAuth-expiry probe, redaction.
- In: M2b Report command and foreign probes — `npx builder-pipeline accounts [--json]`, Antigravity and gateway probes, the
  snapshot reader, working with the orchestrator off.
- In: M3 Placement over accounts — `placement()`, percent and USD budgets, soft and hard limits, `classifyError`,
  OVERLOAD backoff, shadow placement, budget warnings, 1.0 state read-only.
- In: M4 Content policy and settings scan — content classes at gate-launch, sparse worktrees for path roots, the
  data-recipient rule, the settings scan and `--settings` pin, worktree hygiene.
- In: M5 Delegation rulebook — `skills/references/account-selection.md`, the brief's `Account:` line, worker
  recipes per harness.
- In: M6 Worker adapters — the Codex adapter beside the Claude Code adapter, the inherited-env allowlist, turn caps
  and timeouts, the verdict schema bound to the head, the TaskCompleted gate hook.
- In: M7 Docs, doctor and changelog — doctor rows, GUIDE, FEATURES, README, llms.txt, the CHANGELOG Breaking section,
  the 2.0.0 bump in the release PR.
- In: M8 Cross-family second opinion — `familyReview` and `routerHint`, experimental-off, measured first.
- In: M9 Loop runner above a board — `npx builder-pipeline run board-loop` and `orch loop`, caps and named stops, one commit
  per passing pass, scope control, commit trailers, the aider-polyglot measurement.
- In: M10 Accounts command — `accounts add`, `note`, `key`, `key --remove`, `remove`, `list`, `migrate`; key entry
  and storage; named refusal codes; leases.
- In: M11 Wrappers, gateway and free accounts — `accounts install`, the refusal wrapper, `accounts policy`,
  `accounts usage-snapshot`, the OmniRoute adapter, the free-model MCP server, the sandbox-runtime profile.
- In: M12 Remote lanes — `features.remoteLanes`, experimental-off: machine rows, ssh transport, preflight, git-only
  data path, remote launch, liveness, merge back, redaction.
- In: M13 Distribution — MIT licence, package and bin `builder-pipeline`, README badges read from source, the proof
  statement, the publish step in RELEASING.md.
- In: M14 Evidence programme — decision rows in every EXPERIMENTS section, one recorded run, measured or off
  defaults, time to first value, false-positive rates, the 2.0.0 build log as evidence.
- Out: a remote-lane daemon, relay, pairing flow, live terminal or phone approvals — KIT-DEF-1.
- Out: automatic placement of lanes over machines; one machine per lane is placed by hand — KIT-DEF-2.
- Out: features for regulated or client-facing shops — KIT-DEF-3.
- Out: transcript checkpoints in a ref namespace — KIT-DEF-4.
- Out: Antigravity as a headless account; it stays a wrapper in 2.0.0 — KIT-DEF-5.
- Out: a keychain key store (`--store keychain`); the helper seam exists — KIT-DEF-6.
- Out: reading an API key's credit balance; such an account is ready with the balance unmeasured — KIT-DEF-7.
- Out: reading Claude subscription usage from the CLI; a Claude plan account stays unmeasured — KIT-DEF-8.
- Out: per-account cost on the live page and in cost-window — KIT-DEF-9.
- Out: an account-level concurrency cap — KIT-DEF-10.
- Out: an alias layer that keeps 1.0 `seats` profiles loading — KIT-DEF-11.
- Out: gateway machine provisioning (users, systemd units, polkit, idle timer) — KIT-DEF-12.
- Out: desktop-app registration of the free-model MCP server; the kit prints the block — KIT-DEF-13.

### INVARIANTS

The checker treats these as non-negotiable (D45). Every requirement below holds inside them.

- Zero dependencies and Node 18. The runtime is CommonJS; `.mjs` entry points sit over `.cjs` logic.
- No secret lives anywhere but the account's own folder at 0600 or the harness's own store. No secret is printed,
  logged, written to the profile, the lock, git or a test.
- "Lane" keeps its meaning: one unit of work in the orchestrator (D32). The registry is `features.accounts`; an
  entry is an account.
- Every refusal fails closed and names the class, the key or the code. It never carries file text or a value.
- A feature that is off prints `FEATURE: not configured`, where FEATURE is the feature key. It never prints a pass.
- An unmeasured reading is unmeasured. It is never 0 %, never ready by default, never a pass.
- A spec change after ratification is an amendment row in this file (D45). A ratified row is never edited in place.
- Commits carry no AI attribution trailers (AGENTS.md rule 15).

## Actors

| Actor | Source |
|---|---|
| account owner — the person who signs in to each account, enters keys, ratifies and merges (George) | intent |
| orchestrating session — the session that plans, places lanes, dispatches loops and merges | D36 |
| worker — a headless Claude Code, Codex or Antigravity process launched on one account | D4, D26 |
| gateway — a pluggable adapter in front of a provider (OmniRoute first, Bifrost second) | D8 |
| kit checkers — the tests, scans, gates and doctor rows that fail closed | D5, D7 |

## Requirements

Kind: `behaviour` (what succeeds) · `refusal` (what is refused, and why) · `effect` (what a success leaves behind:
audit, event, version) · `constraint` (always true; the only kind no operation needs to reach). Source: `intent` or a
decision id from DECISIONS.md.

| Id | Requirement | Actor | Kind | Source |
|---|---|---|---|---|
| REQ-101 | The kit shall list `features.accounts` in the FEATURES table with the default off. When the profile loads with `accounts.state: on`, the kit shall validate every account. If an account lacks `worker` or `pays`, then the kit shall refuse the profile and name the account and the field. | account owner | refusal | D7 |
| REQ-102 | The kit shall accept `pays` in subscription, gateway, free or api-key; `content` in public, scratch, any, or a list of path roots; `roles` only from the persona roles the orchestrator knows; and `worker` in claude-code, codex or session. The session worker is the orchestrating session itself; it is never spawned, and at most one account carries it. If a value is outside its set, or two accounts carry worker session, then the kit shall refuse the profile and print the allowed set. | account owner | refusal | D36 |
| REQ-103 | While `features.orchestrator` is on, if a profile still carries `seats`, `limits`, `secondaryConfigDir` or `credit`, then the kit shall refuse it at load with a message that names the keys found and `npx builder-pipeline accounts migrate`, and shall not half-load it. While the orchestrator is off, the kit shall load that profile with one warning line and run every other checker. | account owner | refusal | D22, D33 |
| REQ-104 | The kit shall ship no file that names a real account, host or key file. A separate secret-shape scan shall cover the shipped files and `tests/fixtures`. | kit checkers | constraint | D9, D18 |
| REQ-105 | The §16 account settings shall never hold a secret. If a value matches an outbound-guard secret shape, then the kit shall refuse the profile and name the account and the kind of match, never the text. | account owner | constraint | D2 |
| REQ-106 | When `accounts migrate` runs, the kit shall rewrite the legacy keys into an equivalent account list once, write a backup, and change nothing outside §16. A second run on a migrated profile shall change nothing. If an orchestrator run is live, then migrate shall refuse and name the run. | account owner | behaviour | D22, D34 |
| REQ-107 | The kit shall ship the change as major version 2.0.0 with a Breaking section in the CHANGELOG, a GUIDE migration note, and an advisory doctor row that names the legacy keys. The version bump shall land in the release PR only. | account owner | effect | D22, D38 |
| REQ-108 | While a worker runs on an account, the kit shall hold a lease file for that account. If a lease is held, then `accounts remove` and `accounts migrate` shall refuse and name the pid. If the lease's process is gone, then the kit shall report a stale lease and proceed. | orchestrating session | refusal | intent |
| REQ-201 | When `assess` runs, the kit shall produce one assessment per account with name, state, reason, note, budget and roles. The state shall be ready, not ready with a reason, or unmeasured. | orchestrating session | behaviour | D3 |
| REQ-202 | The assessment shall never carry an env value or a key. If a probe prints a secret-shaped string, then the rendered assessment shall carry the redaction marker in its place. | kit checkers | constraint | D2 |
| REQ-203 | The kit shall parse usage as "$X of $Y" from `usageCommand`, from the gateway snapshot JSON (`spend`, `maxBudget`, `budgetResetAt`), and from the Codex session `rate_limits`. A Claude plan account has no reader; the kit shall report it unmeasured, never 0 %. No headless surface prints a Claude percentage. | orchestrating session | behaviour | D3, D43 |
| REQ-204 | While `features.accounts` is on and `features.orchestrator` is off, the `accounts` command shall print the report and exit 0. | account owner | behaviour | D25 |
| REQ-205 | While `features.accounts` is off, `npx builder-pipeline accounts` shall print `accounts: not configured` and exit 0. While it is on, the report shall follow the shape of `gh auth status`: one block per account, exit 1 when any account is not ready, exit 0 with `--json`. | account owner | behaviour | D7, D25 |
| REQ-206 | While an account has `smokeCommand`, the kit shall mark it ready for a writing role only while its last smoke pass is younger than `smokeMaxAgeHours`. When the pass is older, the kit shall report ready (read-only: smoke stale). | orchestrating session | behaviour | D31 |
| REQ-207 | The kit shall read each worker's version from `versionCommand`. If there is no `versionCommand`, then the version shall be unmeasured. | orchestrating session | behaviour | D4 |
| REQ-208 | The kit shall ship built-in probes. Claude Code: `claude auth status` (JSON `authMethod` and `configDirectory`, exit 1 when signed out), or a key file plus `apiKeyHelper` in the account settings. Codex: `codex login status` read from stderr and the exit code (ChatGPT login, API key or not logged in; no plan tier). Antigravity: a models call under a timeout; the words "sign in" in the output mean not ready. Gateway: wrapper present, not marked closed, gateway key present. | orchestrating session | behaviour | D43, D53 |
| REQ-209 | While a key account's balance cannot be read, the kit shall show it ready (balance unmeasured) and sort it last. | orchestrating session | behaviour | D3 |
| REQ-210 | When `assess` runs, the kit shall run every usage reader it has inside the readiness assessment. An account with no reader shall be unmeasured. | orchestrating session | behaviour | D31 |
| REQ-211 | If a probe exposes a credential expiry (Claude `claude auth status`, Codex `auth.json`) and the credential expires inside `authMinMinutes` (default 120) or has expired, then the assessment shall report AUTH with the expiry time and name the sign-in command. Placement shall treat AUTH like LIMIT. If the probe output shows no expiry, then the state shall be unchanged. | orchestrating session | behaviour | D46 |
| REQ-212 | Each usage reading shall carry a source: measured (a statusline `rate_limits` capture or a gateway snapshot), estimate (computed from transcripts or pricing), or unmeasured. The report shall print the source and the time of the reading. An estimate shall never print as a percentage without the word estimate. A model with no pinned rate shall make the estimate unpriced. Placement shall prefer measured over estimate. | orchestrating session | behaviour | D51 |
| REQ-301 | When a lane is placed, the kit shall walk the ordered accounts filtered by role. An account at or above its hard cap is not ready, and the placement line shall say why. | orchestrating session | behaviour | D1, D24 |
| REQ-302 | While an account is above its soft limit, the kit shall place on it only work marked needs-account. A plain job shall read NEEDS-IT-ONLY for that account. A brief that names the account shall be placed on it. | orchestrating session | behaviour | D24 |
| REQ-303 | The kit shall place `pays: api-key` accounts last. When a launch happens on one, the kit shall write `account.paid` and a decision-log line. | orchestrating session | effect | intent |
| REQ-304 | While a reading is older than `usageStaleMinutes`, the kit shall treat it as unmeasured. Only the first account in order may launch unmeasured. | orchestrating session | behaviour | D3 |
| REQ-305 | Every launch shall carry `maxTurns` and `timeoutMinutes`. A model with no rate shall be shown unpriced. `--max-budget-usd` shall be passed only as a backstop and never counted as a cap. If `maxTurns` is missing, then gate-launch shall refuse and name the field. | orchestrating session | refusal | D12, D43 |
| REQ-306 | When a provider or gateway responds with an error, the adapter's `classifyError` shall map it to one of four kinds with an until time: LIMIT (429 with Retry-After, or a usage-limit refusal text with a reset time), BUDGET (gateway budget codes 400, 402, 403 or 429 with a budget body, or `resetsAt`), OVERLOAD (529, 503 or an overloaded body; until is the next backoff step), AUTH (401, a 403 auth body, or an expired credential). LIMIT, BUDGET and AUTH shall mark the account not ready until that time. OVERLOAD is not an account state. The orchestrator's own global 429 record shall stay unchanged. | gateway | behaviour | D35, D46 |
| REQ-307 | When an orch command places a lane, the kit shall run the full readiness assessment itself before every placement. A person shall never have to run `accounts` first. If an account went not ready since the last assessment, then placement shall skip it and the placement line shall say why. | orchestrating session | behaviour | D31 |
| REQ-308 | When an account's last smoke pass is older than the stale window, the kit shall re-run its `smokeCommand` before its first launch. If the smoke fails, then the account is not ready and the launch is refused naming the account. | orchestrating session | behaviour | D31 |
| REQ-309 | When any orch command runs and a usage or budget reading is older than `usageStaleMinutes`, the kit shall refresh the reading and print its time. | orchestrating session | behaviour | D31 |
| REQ-310 | When a job ends in LIMIT, BUDGET or AUTH, the kit shall retry it once on the next ready account allowed by its content class and roles, and tell the person once in the status line. When a job ends in OVERLOAD, the kit shall retry it on the same account with the same prompt after min(10 s times 2 to the power n, 5 min), at most `overloadRetries` (default 4) times. After that the job is FAILED-OVERLOAD and the account stays ready. | orchestrating session | behaviour | D46 |
| REQ-312 | `features.accounts.placement` shall be on (default) or shadow. While it is shadow, placement shall compute the account it would choose, write a `placement.shadow` event with that account and the reason, and then place the lane the 1.0 way (first ready account by order). EXPERIMENTS reads the events. | orchestrating session | effect | D52 |
| REQ-313 | While a percent or USD budget is at or above its soft limit, `orch status` and the board row shall show `budget warn USED of CAP` for that account. If a change raises a hard cap or a soft limit in §16 without a decision-log line that carries the old and the new value, then gate-launch shall refuse and name the field and the expected entry. | orchestrating session | refusal | D49 |
| REQ-311 | The kit shall read orch state written by 1.0 (`state.json` with embedded seats and limits, `ratelimit.json`, credit `task.json` and `running.json`) and shall never write it back in the old shape. When `accounts migrate` runs, the kit shall rewrite finished state so that it names accounts, archive it, and write a `.bak` backup. | orchestrating session | behaviour | D34 |
| REQ-401 | If a public-only account is asked to launch on a private project, then gate-launch shall refuse with exit 3 and name the class and the account. | orchestrating session | refusal | D5, D23 |
| REQ-402 | When an account has a path-root list, the kit shall launch the worker in a sparse worktree that holds only the roots, plus deny rules for everything else. If the adapter cannot do that, or a claimed file lies outside the roots, then the kit shall refuse the launch and name the path, never its content. | worker | refusal | D5, D23 |
| REQ-403 | If a new data recipient has no decision-log entry, then the kit shall refuse its first launch and name the entry it expects. | orchestrating session | refusal | D5 |
| REQ-404 | Before every launch, the kit shall scan the project's and the worktree's `.claude/settings.json`, `.claude/settings.local.json` and the account's own settings. If the scan finds `apiKeyHelper`, an `env.ANTHROPIC_*` or `env.CLAUDE_CODE_*` key, a proxy or CA variable, or a hook not recorded in the lock, then the kit shall refuse the launch with exit 3 and name the key and the file, never the value. Every launch shall pass a `--settings` pin that carries the account's env block. | orchestrating session | refusal | D40 |
| REQ-405 | When a lane worktree is created, the kit shall create it on a fresh branch named from the lane id, never on a branch another worktree holds. Files listed in `features.accounts.worktree.include` shall be copied into the new worktree, never symlinked across lanes. `worktree-sweep --keep LANE` shall leave that worktree in place and say so. GUIDE shall state that worktrees separate working files and do not sandbox processes or prevent merge conflicts. | orchestrating session | behaviour | D50 |
| REQ-501 | The rulebook shall name only feature keys the loader knows. | kit checkers | constraint | intent |
| REQ-502 | The worker brief shall carry an `Account:` line that the orchestrator fills. | orchestrating session | effect | intent |
| REQ-601 | When a headless launch starts, the kit shall build the child env from an allowlist of inherited variables: `PATH`, `HOME`, `LANG`, `TERM`, `TMPDIR` and the account's own block. `ANTHROPIC_*`, `CLAUDE*`, `OPENAI_*`, `CODEX_*`, `GEMINI_*`, `NODE_OPTIONS`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_*`, `*_PROXY`, `LD_PRELOAD` and `XDG_CONFIG_HOME` shall never be inherited. The Codex adapter shall set `CODEX_HOME`; the Claude adapter shall set `CLAUDE_CONFIG_DIR`. | worker | behaviour | D42 |
| REQ-602 | If a worker cannot prove its key source, then it shall stop before any model call. Where the Codex CLI exposes no source, the kit shall state unconfirmed. | worker | refusal | D20 |
| REQ-603 | The Claude Code adapter shall pass `--max-turns`, `--permission-mode`, `--permission-prompts none` and `--settings`. Codex has no turn-cap or timeout flag, so the runner shall enforce the pass timeout and a stall timeout on the event stream for both workers. If a worker never exits, then the job is FAILED-TIMEOUT and the process is stopped. If a worker stops emitting events for the stall window, then the job is FAILED-STALL. | worker | behaviour | D12, D43 |
| REQ-604 | The kit shall read the verdict from a required result schema (`--json-schema` for Claude, `--output-schema` for Codex) with `verdict` in PASS, CHANGES_REQUESTED or ERROR, `summary`, `filesTouched`, `head` (the commit the worker judged) and `requirements` (the REQ ids it judged). If a field is missing or malformed, then the job is FAILED. If the exit code is 0 with no verdict, then the job is FAILED. If `head` differs from the worktree head at read time, then the job is FAILED-STALE-VERDICT. If `requirements` misses an id the lane claimed, then the job is FAILED. If the status shows a denied tool (`permission_denials`, soft-deny), then the job is INCOMPLETE. | worker | refusal | D13, D47 |
| REQ-605 | The `--settings` pin for a Claude Code lane shall carry a TaskCompleted hook and a Stop hook that run the lane's gate. If the gate fails, then the hook shall return exit 2 and refuse completion with the gate output as the reason. Every kit hook entry shall carry the kit's marker and be removable. | worker | behaviour | D52 |
| REQ-701 | `doctor` shall show one accounts row per tool with the reason. The rows are advisory and the exit code is unchanged. | account owner | behaviour | D37 |
| REQ-702 | The CHANGELOG `[Unreleased]` section shall carry one entry per module with its tests. | kit checkers | effect | intent |
| REQ-703 | When gate-launch runs, it shall run the pre-launch checks: legacy profile, unknown worker, missing account dir and failed settings scan. If any check faults, then the kit shall block the launch and name the check. | orchestrating session | refusal | D37 |
| REQ-801 | `familyReview` shall be experimental-off. EXPERIMENTS §16 shall state what it must prove. While the flag is off, nothing of it runs. | account owner | constraint | D6, D14 |
| REQ-802 | While `familyReview` is on, the kit shall assign a second reader only on an account at or above the writer's tier. If no such account exists, then there is no second reader and the reason is logged. | orchestrating session | behaviour | D14 |
| REQ-901 | `features.boardLoop` shall be experimental-off. While it is on, the profile shall carry `promptFile`, `gate`, `maxPasses`, `passTimeoutMinutes` (default 60), `maxTurnsPerPass` (default 20), `stallMinutes` (default 5), `maxRetriesPerRow` (default 2), `maxConsecutiveFailures` (default 3) and `maxConsecutiveNoProgress` (default 3). If `maxPasses` is missing while on, then the profile is invalid. While off, the command shall print the not-configured line and exit 0. | account owner | behaviour | D17, D44, D48 |
| REQ-902 | When a pass starts, the runner shall start a fresh worker session from the same prompt file. A pass ends on the gate exit code and the worker verdict together. If the verdict is PASS while the gate exits 1, then the pass has failed. | worker | behaviour | D44 |
| REQ-903 | When a pass ends, the runner shall feed the gate output, capped at `bashCap.limitBytes`, and a one-line progress note written by the runner to the next pass. The board, the progress log and git are the only memory between passes. | worker | behaviour | D44 |
| REQ-904 | The loop shall stop when every row passes, at `maxPasses`, when the account reads not ready, on no progress, or on the row retry ceiling. It shall print one summary line with the stop reason and shall never push. When it stops with open rows, it shall exit 10. | orchestrating session | behaviour | D44, D48 |
| REQ-905 | When a pass passes, the runner shall make one commit. When a pass fails, the runner shall leave no commit, pin the pass to a snapshot ref, and restore and clean the tree and the worktree. | worker | effect | intent |
| REQ-906 | The runner shall apply an exact allow list. The gate script, the test roots, the prompt file and the harness config shall be denied whatever the scope. If the worker writes to the gate script, then the pass is FAILED-SCOPE and the loop stops. | worker | refusal | D44 |
| REQ-907 | When a pass ends, the runner shall write one run-log row: pass, row, rows passing, retries, gate digest, turns, cost or unmeasured, and stop reason. | orchestrating session | effect | intent |
| REQ-908 | When `orch loop BOARD` runs, the orchestrator shall place the loop on an account like any lane (M3 placement, the account's caps, the content check, the settings scan), record it in the orch state as kind loop with the account and the cap, and show the pass count and the stop reason in `orch status`. If the account is not ready, then the loop is refused before any pass. The manual command stays, and both share one runner, so the run-log rows are the same. | orchestrating session | behaviour | D30, D37 |
| REQ-909 | The measurement shall run on a schedule the project owns against the throwaway aider-polyglot project. When a scheduled run completes, the kit shall append a dated row to EXPERIMENTS §17 with pass rate, cost, turns, timeouts and silent failures, and `boardLoop` shall stay unchanged. The promote-or-keep-off decision stays with a person. | account owner | effect | D17, D30 |
| REQ-910 | If `maxConsecutiveNoProgress` consecutive passes have an identical diff hash or an identical gate digest, then the loop shall stop with STOP no-progress. | orchestrating session | behaviour | D44, D48 |
| REQ-911 | If a row fails `maxRetriesPerRow` times, then the runner shall mark it blocked on the board and move to the next row. When every open row is blocked, the loop shall stop. | orchestrating session | behaviour | D44 |
| REQ-912 | The runner, not the worker, shall choose the row (first open, not blocked) and flip its status. If the worker edits the board outside that row, then the pass is FAILED-SCOPE. | worker | refusal | D44 |
| REQ-913 | Every pass shall run under the harness's sandbox and a permission mode that never bypasses prompts. If a prompt file, the profile or the account command asks for a bypass flag such as `--dangerously-skip-permissions`, then the loop shall refuse to start and name the flag. | worker | refusal | D44 |
| REQ-914 | If `maxConsecutiveFailures` consecutive passes fail (gate fail, FAILED verdict, timeout or stall), then the loop shall stop with STOP consecutive-failures. Every stop shall write one reason from the closed set all-pass, max-passes, not-ready, no-progress, consecutive-failures, rows-blocked, scope, stall to the summary line, the run log and the orch state. When a restart passes `--more-passes N`, the runner shall add N passes once for that run and log it. | orchestrating session | effect | D48 |
| REQ-915 | When a loop pass or a lane makes a commit, the commit shall carry the trailers `Builder-Account:` with the account name and `Builder-Requirement:` with the requirement ids, and no other kit trailer. No trailer shall carry a prompt, a transcript or a key. Transcript refs shall not be written. | worker | effect | D52 |
| REQ-1001 | When `accounts add` runs, the kit shall write a valid account into §16 and create its dir. If the name exists, is a reserved kit name, or is outside `^[a-z][a-z0-9]{0,15}$`, or the account would carry a second payment kind, then the kit shall refuse with the named code: E_ACCOUNT_EXISTS, E_ACCOUNT_NAME, E_PAYS_TWICE or E_BASEURL_SUB. | account owner | refusal | D9 |
| REQ-1002 | When `accounts key` runs on a TTY, the kit shall read the key with echo off in raw mode and restore the terminal on Ctrl-C. When stdin is not a TTY, it shall read to EOF and say that echo may be visible. It shall accept printable ASCII only and offer no argv or env entry form. A Claude key shall go only to the account's key file, created with O_CREAT, O_EXCL and O_NOFOLLOW at 0600 in a 0700 dir, and `apiKeyHelper` in the account's settings shall point at `node scripts/account-key.cjs read NAME`. Settings edits and rotation shall be temp plus rename after an lstat check. The confirmation line shall carry no part of the value. If a symlink is planted at the key path, then the kit shall fail with EEXIST and write nothing through it. | account owner | behaviour | D2, D20, D42 |
| REQ-1003 | When `accounts key` runs for a Codex account, the kit shall pipe the key to `codex login --with-api-key` with `CODEX_HOME` set to the account dir and `cli_auth_credentials_store = "file"` written in its `config.toml`. The kit shall never write the key. The kit shall read and report the mode of the resulting `auth.json`. `key --remove` shall run `codex logout`. | account owner | behaviour | D20 |
| REQ-1004 | When `key --remove` runs, the kit shall delete the key file and the helper setting, nothing else. When `remove` runs, the kit shall delete the wrapper, the key and the §16 entry and keep the profile folder. The key file shall never be in `accounts.lock.json` or an upgrade backup. | account owner | effect | D2, D19 |
| REQ-1005 | The report shall show the key as present or absent, never the value. On POSIX, if the key file is wider than 0600, then the account reads not ready and names the key file mode. On Windows the mode check is skipped and the ACL state is reported. | account owner | behaviour | D2 |
| REQ-1006 | On Windows, when the account dir is created, the kit shall give it an owner-only ACL through `icacls /inheritance:r /grant:r` where available. If that is not available, then the report shall say mode unverified. Fixtures shall include Windows paths. | account owner | behaviour | D2 |
| REQ-1007 | No fixture, log, run file or memory shall hold a real-looking key. Fakes shall be built at runtime. The secret-shape scan shall cover fixtures, a temp HOME and captured stdio. | kit checkers | constraint | D9 |
| REQ-1101 | When `accounts install` runs, the kit shall write one wrapper per account (sh and ps1) that unsets the denylist and sets the account dir. A gateway Claude account shall get its token through `apiKeyHelper`, never env. A gateway Codex account shall get a `model_providers` `env_key` entry bounded by a budget-capped key. Model aliases shall go through `ANTHROPIC_DEFAULT_*_MODEL`. A subscription account's wrapper shall never set a base URL. No wrapper shall export `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY`. | account owner | behaviour | D41 |
| REQ-1102 | When wrappers and composed settings are written, the kit shall record them in `accounts.lock.json` under the kit's data dir, back them up before an upgrade overwrites them, and never arm them in a live tool config outside the kit-created account dir. | account owner | effect | D19, D38 |
| REQ-1103 | If the policy closes an account, then `accounts install` shall write a refusal wrapper that only explains why. The combo shall be resolved at write time. If the policy is unreadable, then the kit shall leave a working wrapper alone. | gateway | refusal | D8 |
| REQ-1104 | `accounts policy show`, `dry-run` and `apply` shall work through a gateway adapter: idempotent; the token from a 0600 file owned by the user; Node fetch with `redirect: 'error'`; plain http only to loopback; every error redacted with an allowlist of printed fields; an applied sha marker that records the gateway version. If the gateway is unknown, then the kit shall refuse and print the known list. If the policy names a subscription provider, then the kit shall refuse. OmniRoute endpoints (`/api/keys`, `/api/keys/{id}/access`, `/api/combos`, `/api/usage/budget`, `/api/pricing`) shall be pinned per version with a golden fixture each. | gateway | behaviour | D8, D43 |
| REQ-1105 | When `accounts usage-snapshot` runs, the kit shall write the snapshot shape the assessment reads and never the token or a key. | gateway | effect | D8 |
| REQ-1106 | While a session bus is reachable, the Antigravity wrapper shall drop the `SSH_*` variables. While none is reachable, it shall keep them. | worker | behaviour | D26 |
| REQ-1107 | The free-model MCP server shall speak stdio JSON-RPC on the 2026-07-28 spec (`server/discover`, per-request `_meta`, `resultType`) with a legacy `initialize` fallback, with Node built-ins only, one tool, one fixed route, loopback only and no redirects. It shall read the key at call time and replace it in any error text, apply the per-account `promptMaxBytes`, and run the outbound guard over the prompt and the system text. If the prompt matches a secret shape, then the server shall refuse and name the kind of match. | account owner | behaviour | D15, D43 |
| REQ-1108 | When `builder verify` runs, the kit shall show gateway policy drift (the diff `accounts policy dry-run` would print) as an advisory row that names the drifted keys and the apply command, and shall write nothing. Applying stays a manual command run as the user. | account owner | behaviour | D8 |
| REQ-1109 | When `accounts install` runs for a Claude Code account, the kit shall write a sandbox-runtime settings file `srt-settings.json` in the account dir: `denyRead` lists every other account dir and the user's own `~/.claude` and `~/.codex`; `allowWrite` lists the lane worktree; the credentials block masks the account key and injects it only toward the account's API host. The wrapper shall pass the file to `srt`. If the file is invalid, then the wrapper shall refuse the launch and name the file. | worker | behaviour | D52 |
| REQ-1201 | `features.remoteLanes` shall be experimental-off. A machine shall be a row in `state.json` with `host`, `user`, `remoteRoot`, `status` and `lastSeen`; a lane may carry `machine`; no other state shape changes. While the flag is off, if a plan names a machine, then orch shall print `remoteLanes: not configured` and place the lane locally. While the flag is on, if a lane names an unknown machine, then the lane is refused naming the row. | orchestrating session | behaviour | D58 |
| REQ-1202 | The remote transport shall be `spawn('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', host, cmd])` with Node built-ins only. If ssh exits 255, then the kit shall record ssh-failed as the event `remote_unknown` and never as the worker's verdict. If the remote command exits 1, then that exit code is the remote command's. The result of the preflight `ssh host true` shall be stored on the machine row. | orchestrating session | behaviour | D58 |
| REQ-1203 | When a machine is first used, the kit shall run one preflight call that runs `claude auth status`, `claude --version` and `git --version` and tests that `remoteRoot/.git` exists. If a check fails, then the machine is not ready with the failing check named and is never placed. If the login is expired or missing, then the status is `machine_unauthenticated`. | orchestrating session | refusal | D58 |
| REQ-1204 | The data path shall be git through a shared origin both hosts reach. The kit shall never mount, copy or rsync a worktree. If a `remoteRoot` is on a network file system and that is detectable, then preflight shall refuse and name the path. GUIDE shall carry the Git FAQ warning against sharing a working tree across systems. | orchestrating session | refusal | D58 |
| REQ-1205 | When a remote lane starts, the kit shall make one ssh call that runs `git fetch origin`, `git worktree add` on a fresh lane branch from the origin base, and `setsid nohup claude -p … --output-format json` into `.lane/out.json` with the pid in `.lane/pid`. The remote env shall set `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`. The worker shall never spawn. | worker | behaviour | D58 |
| REQ-1206 | While a remote lane runs, the kit shall poll liveness every `remotePollSeconds` (default 30) with one ssh call that checks the pid and the mtimes of `.lane/out.json` and `.lane/err.log`. The orchestrator shall write `lane.heartbeat` with its own clock. A stall shall be judged on remote mtimes against the kit's idle threshold; past it the lane is FAILED-STALL. When cancel runs, the kit shall kill the remote process group and keep the lane cancelling until a poll confirms exit. | orchestrating session | behaviour | D58 |
| REQ-1207 | When a remote lane exits, the remote shell shall commit, push the lane branch to origin and write the head sha to `.lane/head`. The orchestrator shall fetch, read `.lane/out.json`, validate the verdict schema of REQ-604 against the fetched head, and merge locally one lane at a time as today. If the verdict names another head, then the lane is FAILED-STALE-VERDICT. If a 255 happens during the fetch, then the state is `remote_unknown` and the fetch is retried, never FAILED. | orchestrating session | behaviour | D47, D58 |
| REQ-1208 | Every remote launch shall pass the same `--settings` pin as a local launch (REQ-404). The pin shall be copied to the remote worktree for the launch and removed after. If a hook the pin needs is absent on the remote, then the launch is refused and the event names the hook. | orchestrating session | refusal | D40, D58 |
| REQ-1209 | The kit shall never copy `~/.claude`, credentials, key files, `.env` or ssh keys to the remote; a person logs the remote in once. Every `.lane/err.log` line shall pass the outbound guard before it enters `events.jsonl`. | kit checkers | constraint | D58 |
| REQ-1210 | The kit shall store remote timestamps as `remoteTs` data and never use them for ordering. The orchestrator's clock and the event sequence shall order events. | orchestrating session | behaviour | D58 |
| REQ-1211 | EXPERIMENTS §18 shall state the measurement before the flag exists: the loop runner's aider-polyglot project run with one local and one remote lane, comparing pass rate, wall time, ssh failures, orphaned workers and cost-or-unmeasured. The promote-or-keep-off decision stays with George. `features` shall print `remoteLanes: experimental-off` and name §18. | account owner | constraint | D57, D58 |
| REQ-1301 | The package licence shall be MIT: `package.json` `license` is MIT, and a LICENSE file with the MIT text and the owner's name ships in the package. | account owner | constraint | D56 |
| REQ-1302 | The package name shall be `builder-pipeline` and the bin `builder-pipeline` only; no `builder` bin remains. Every shipped document, skill, adapter and the setup prompt shall use `npx builder-pipeline`. The folder layout keeps `node builder/cli.js`. | account owner | constraint | D56 |
| REQ-1303 | Every figure in a README badge shall be read from its source by a test: the phase count from the pipeline skill, the persona count from `agents/`, the target count from `cli.js`. | kit checkers | constraint | D56 |
| REQ-1304 | The sentence "proven on a production modular-monolith backend (15+ shipped modules)" and the badge "battle-tested 15+ modules" shall be replaced everywhere by the proof statement: built and used by its author on one production backend; that project's data cannot ship; published measurements start with 2.0.0 and live in EXPERIMENTS.md. | kit checkers | constraint | D55 |
| REQ-1305 | Every page that describes guards or hooks shall say "fail-closed on Claude Code; CI gates and reports on Codex and Antigravity". No page shall say the kit verifies on three agents. | kit checkers | constraint | D55 |
| REQ-1306 | RELEASING.md shall carry the registry publish step (`npm publish --access public` after the tag, by George). The kit itself shall never publish. The git-tag install path stays documented as the alternative. | account owner | constraint | D56 |
| REQ-1401 | Every EXPERIMENTS section shall carry a decision row: `decision:` keep, drop or not yet measured, a date, and the number or the words no measurement. `features` shall print the decision beside each experimental flag. | kit checkers | constraint | D57 |
| REQ-1402 | One recorded end-to-end pipeline run on a throwaway test project shall ship as EXPERIMENTS §19 with the board, the run log, the cost per seat or unmeasured, the fix-of-fix rate and the silent failures. The run files shall be in the project Library and named from §19. | account owner | effect | D57 |
| REQ-1403 | `builderBatch` and `fixLane` shall be measured in the §19 run or set to off by default. If a board has no FIX rows, then fix-rate shall print `fixLane: unmeasured` and exit with the not-configured code, never a pass. | kit checkers | refusal | D57 |
| REQ-1404 | A timed script shall install the package in an empty repository and run `inventory` and `claims-check --files`. The wall time shall be recorded in EXPERIMENTS §20 and shall be under 5 minutes on the reference machine. If the time is above 300 s, then the first-value test fails. | kit checkers | behaviour | D57 |
| REQ-1405 | Every default-on check (check-ledgers, claims-check, output-check, fix-rate, inventory) shall be run on three public repositories and the findings classified true or false by hand. The false-positive rate per check shall be in EXPERIMENTS §20. If a check is above 20 % false positives, then it shall be set off by default before release. | kit checkers | constraint | D57 |
| REQ-1406 | The 2.0.0 modules shall be built through the kit's own orchestrator over the configured accounts. The run log and `events.jsonl` of that build shall ship in the Library and be cited from EXPERIMENTS §19 as the second recorded run. | orchestrating session | effect | D57, D60 |

## Acceptance criteria

Every requirement has at least one row. Verb: `assert` (holds as written) · `by-design` (the intended behaviour
diverges from the text and a decision says so — cite it in Then) · `gap` (knowingly unenforced — cite the
deferred-registry row in Then). `skipped` is a run outcome, never a spec verb. Then names the exact status and
code, or the exact effect. The plan's test name closes each Then in brackets.

| Id | Req | Verb | Given | When | Then |
|---|---|---|---|---|---|
| AC-101a | REQ-101 | assert | `accounts.state: on` and an account missing `worker` or `pays` | the profile loads | the profile is invalid and the error names the account and the field (profile.test, features.test) |
| AC-101b | REQ-101 | assert | the shipped FEATURES table | features.test reads the row for accounts | the default is off (features.test) |
| AC-102a | REQ-102 | assert | an account with a value outside its set, or two accounts with worker session | the profile loads | the profile is refused and the message prints the allowed set (profile.test) |
| AC-103a | REQ-103 | assert | a 1.0 orch fixture profile with the orchestrator on | the profile loads | the profile is invalid, the message names the keys found and `npx builder-pipeline accounts migrate`, and no step runs (profile.test) |
| AC-103b | REQ-103 | assert | the same 1.0 profile with the orchestrator off | claims-check runs | it completes and stderr carries exactly one warning line (cli-commands.test) |
| AC-104a | REQ-104 | assert | the shipped files | genericity.test scans them | only the three neutral example names appear (genericity.test) |
| AC-104b | REQ-104 | assert | a planted secret shape in a fixture | secret-shapes.test runs | the test fails and names the file (secret-shapes.test) |
| AC-105a | REQ-105 | assert | a §16 value that matches an outbound-guard secret shape | the profile loads | the profile is refused naming the account and the kind of match, and the text is absent from the output (profile.test) |
| AC-106a | REQ-106 | assert | each 1.0 orch fixture and the golden placement fixture | migrate runs and the orch suite runs against the result | placements equal the golden fixture, a `.bak` exists, the file is byte-identical outside §16, and a second run changes nothing (accounts-migrate.test) |
| AC-106b | REQ-106 | assert | a live run in the state dir | migrate runs | it refuses and names the run (accounts-migrate.test) |
| AC-107a | REQ-107 | assert | a project on a 1.0 profile | `builder doctor` runs | one row reads `profile: legacy seats, run npx builder-pipeline accounts migrate` and the exit code is unchanged (doctor.test) |
| AC-107b | REQ-107 | assert | the release files | release-check runs | the version 2.0.0 and the CHANGELOG Breaking section agree (release-check) |
| AC-108a | REQ-108 | assert | a held lease on an account | `accounts remove` runs | it refuses naming the pid (accounts-cli.test) |
| AC-108b | REQ-108 | assert | a lease whose pid is gone | `accounts remove` runs | the report says stale lease and the command proceeds (accounts-cli.test) |
| AC-201a | REQ-201 | assert | passing, failing and absent probes | assess runs | the states read ready, not ready with the reason, and unmeasured (accounts.test) |
| AC-202a | REQ-202 | assert | a probe that echoes a secret-shaped string | the assessment renders | the output carries the redaction marker for an Anthropic key and never the string (accounts.test) |
| AC-203a | REQ-203 | assert | each usage shape: usageCommand text, gateway snapshot JSON, Codex rate_limits | the reading is parsed | the reading is the computed percent, or null where nothing is readable (accounts.test, codex-usage.test) |
| AC-203b | REQ-203 | assert | a Claude plan account | assess runs | the reading is unmeasured, never 0 % (accounts.test) |
| AC-204a | REQ-204 | assert | accounts on and the orchestrator off | the `accounts` command runs | it prints the report and exits 0 (cli-commands.test) |
| AC-205a | REQ-205 | assert | `features.accounts` off | `npx builder-pipeline accounts` runs | it prints `accounts: not configured` and exits 0 (cli-commands.test) |
| AC-205b | REQ-205 | assert | accounts on with one not-ready account | `npx builder-pipeline accounts` runs | one block per account in the `gh auth status` shape and exit 1; with `--json` exit 0 (cli-commands.test, pack-prose.test) |
| AC-206a | REQ-206 | assert | a smoke pass 3 days old with 48 h allowed | the account is assessed | the state is ready (read-only: smoke stale) (accounts.test) |
| AC-207a | REQ-207 | assert | a versionCommand stub printing 1.2.3 | the account is assessed | the assessment carries version 1.2.3; with no versionCommand it carries unmeasured (accounts.test) |
| AC-208a | REQ-208 | assert | fixtures for each probe state of Claude Code, Codex, Antigravity and gateway accounts | each account is assessed | each account shows the state and the reason the devbox tool would (accounts-probes.test) |
| AC-209a | REQ-209 | assert | a key account whose balance cannot be read | the accounts are assessed and sorted | it reads ready (balance unmeasured) and sorts last (accounts.test) |
| AC-210a | REQ-210 | assert | an account of each kind | assess runs | each reading comes from its reader, and the account with no reader says unmeasured (accounts.test) |
| AC-211a | REQ-211 | assert | a probe fixture with an expiry 30 minutes ahead | the account is assessed | not ready, the reason reads AUTH until that time, and the line names `claude auth login` (accounts-probes.test) |
| AC-211b | REQ-211 | assert | a probe output with no expiry | the account is assessed | the state is unchanged (accounts-probes.test) |
| AC-212a | REQ-212 | assert | a measured and an estimated reading for one account | the account is assessed | the measured one is used and the line reads `42 % (measured 09:14)` (accounts.test) |
| AC-212b | REQ-212 | assert | only an estimate | the account is assessed | the line reads `~40 % (estimate)`; with no reading it reads unmeasured (accounts.test) |
| AC-301a | REQ-301 | assert | account A at 90 % with cap 85 and account B at 40 % | a lane is placed | B is chosen and the why names A's cap (orch-state.test) |
| AC-302a | REQ-302 | assert | account A at 82 % with soft limit 80 and a plain job | the job is placed | A reads NEEDS-IT-ONLY; a brief naming A is placed on A (orch-state.test) |
| AC-303a | REQ-303 | assert | a ready `pays: api-key` account and another ready account | a lane is placed | the api-key account is last; a launch on it writes `account.paid` and a decision-log line (orch-state.test) |
| AC-304a | REQ-304 | assert | a reading older than `usageStaleMinutes` | a lane is placed | the account is treated as unmeasured and only the first account in order may launch unmeasured (orch-state.test) |
| AC-305a | REQ-305 | assert | an account with no `maxTurns` | gate-launch runs | it refuses naming the field (orch-state.test) |
| AC-305b | REQ-305 | assert | a model with no pinned rate | the launch line renders | the cost reads unpriced and `--max-budget-usd` is not counted as a cap (pricing.test) |
| AC-306a | REQ-306 | assert | a 429 with Retry-After 2400 | classifyError runs | LIMIT until now plus 40 min (classify-error.test) |
| AC-306b | REQ-306 | assert | a refusal text "usage limit reached, resets at 3pm (Europe/London)" | classifyError runs | LIMIT until that time (classify-error.test) |
| AC-306c | REQ-306 | assert | a 402 with a reset time | classifyError runs | BUDGET until that time (classify-error.test) |
| AC-306d | REQ-306 | assert | a 529 | classifyError runs | OVERLOAD, and the account stays ready (orch-ratelimit.test) |
| AC-306e | REQ-306 | assert | a 401 | classifyError runs | AUTH (classify-error.test) |
| AC-306f | REQ-306 | assert | the orchestrator's own 429 | the record is written | the global 429 record is written as today (orch-state.test, orch-ratelimit.test) |
| AC-307a | REQ-307 | assert | an account that went not ready since the last assessment | a lane is placed | placement skips it and the placement line says why (orch-state.test) |
| AC-308a | REQ-308 | assert | a smoke result older than `usageStaleMinutes` | the account is placed | the smoke runs first; a failure refuses the launch naming the account (orch-preflight.test) |
| AC-309a | REQ-309 | assert | a stale usage reading | `orch status` runs | the reader runs and the time of the reading is printed (orch-state.test) |
| AC-310a | REQ-310 | assert | a 429 on account A and a ready account B | the job is retried | it runs on B, A shows the limit time, and no second notice is printed (orch-ratelimit.test) |
| AC-310b | REQ-310 | assert | a stub that returns 529 three times then succeeds | the job runs | one launch on A with three backoff waits and no account change (orch-ratelimit.test) |
| AC-312a | REQ-312 | assert | placement shadow and two ready accounts | a lane is placed | the `placement.shadow` event names the account the rule would pick and the lane runs on the first ready account (orch-state.test) |
| AC-313a | REQ-313 | assert | account A at 82 % with soft limit 80 | `orch status` runs | A's line carries `budget warn` with used and cap (orch-state.test) |
| AC-313b | REQ-313 | assert | a cap raised in §16 without a decision-log line | gate-launch runs | it refuses naming the field and the expected entry (account-policy.test) |
| AC-311a | REQ-311 | assert | a 1.0 state fixture | `orch status` runs | it prints the same rows as 1.0 and leaves the file unchanged (orch-state.test) |
| AC-311b | REQ-311 | assert | the same 1.0 state fixture | migrate runs | the state names accounts and a `.bak` exists (accounts-migrate.test) |
| AC-401a | REQ-401 | assert | `visibility: private` and a public-only account | gate-launch runs | exit 3 naming the class and the account (account-policy.test) |
| AC-402a | REQ-402 | assert | roots `src/public` and a claimed file outside them | gate-launch runs | the refusal names the path and never its content (account-policy.test) |
| AC-402b | REQ-402 | assert | a worker launched under path roots | the worktree is listed | it holds only those roots (account-policy.test) |
| AC-403a | REQ-403 | assert | a new data recipient with no matching decision-log entry | its first launch is attempted | the refusal names the entry it expects (account-policy.test) |
| AC-404a | REQ-404 | assert | a project settings file with a marker `env.ANTHROPIC_BASE_URL` | gate-launch runs | exit 3 names the key and the file, and the marker value is absent from the output (account-policy.test) |
| AC-404b | REQ-404 | assert | a clean project | a lane launches | the launch command carries `--settings` with the account's env block (orch-worker-claude-code.test) |
| AC-405a | REQ-405 | assert | two lanes | both worktrees are created | their branches differ and `git worktree list` shows no shared branch (orch-preflight.test) |
| AC-405b | REQ-405 | assert | `include: [".env"]` | a worktree is created | the file exists in the worktree and is not a symlink (orch-preflight.test) |
| AC-405c | REQ-405 | assert | `worktree-sweep --keep` with a lane | the sweep runs | the report lists that worktree as kept, and pack-prose finds the GUIDE sentence (worktree-sweep.test, pack-prose.test) |
| AC-501a | REQ-501 | assert | the rulebook `skills/references/account-selection.md` | pack-prose and instruction-lint run | every feature key named is one the loader knows (pack-prose.test, instruction-lint) |
| AC-502a | REQ-502 | assert | a plan with a placed lane | the worker brief renders | the brief carries an `Account:` line filled with the account name (orch-plan.test) |
| AC-601a | REQ-601 | assert | a stub binary and a polluted parent env | a job starts | the child env holds only the allowlist and the account dir variable (orch-worker-codex.test, orch-worker-claude-code.test) |
| AC-602a | REQ-602 | assert | a worker whose key source cannot be proved | the job starts | it stops before any model call; a Codex account reads unconfirmed in doctor (orch-worker-codex.test, doctor.test) |
| AC-603a | REQ-603 | assert | a stub worker that never exits | the pass timeout passes | FAILED-TIMEOUT and the process is stopped (orch-worker-codex.test, orch-worker-claude-code.test) |
| AC-603b | REQ-603 | assert | a stub that stops emitting events for the stall window | the stall timeout passes | FAILED-STALL (orch-worker-codex.test, orch-worker-claude-code.test) |
| AC-603c | REQ-603 | assert | a Claude Code lane | the launch command renders | it carries `--max-turns`, `--permission-mode`, `--permission-prompts none` and `--settings` (orch-worker-claude-code.test) |
| AC-604a | REQ-604 | assert | a verdict whose head is the previous commit | the verdict is read | FAILED-STALE-VERDICT (orch-worker-codex.test, orch-worker-claude-code.test) |
| AC-604b | REQ-604 | assert | a verdict without `requirements` | the verdict is read | FAILED naming the field (orch-worker-codex.test, orch-worker-claude-code.test) |
| AC-604c | REQ-604 | assert | exit 0 with no verdict, or a status with `permission_denials` | the verdict is read | FAILED for the missing verdict; INCOMPLETE for the denied tool (orch-worker-codex.test, orch-worker-claude-code.test) |
| AC-605a | REQ-605 | assert | a stub gate that exits 1 | the worker reports done | the TaskCompleted hook returns exit 2 and the verdict stays open (orch-worker-claude-code.test) |
| AC-605b | REQ-605 | assert | the `--settings` pin | its hook entries are read | every kit hook entry carries the kit's marker (orch-worker-claude-code.test) |
| AC-701a | REQ-701 | assert | accounts configured for two tools | `doctor` runs | one accounts row per tool with the reason, and the exit code is unchanged (doctor.test) |
| AC-702a | REQ-702 | assert | the CHANGELOG at release time | the reviewer reads `[Unreleased]` | one entry per module names its tests (review) |
| AC-703a | REQ-703 | assert | an account whose dir is missing | gate-launch runs | nothing launches and the output is the check line (orch-preflight.test) |
| AC-801a | REQ-801 | assert | the shipped FEATURES table and EXPERIMENTS.md | features.test and pack-prose run | `familyReview` is experimental-off and §16 states the measurement (features.test, pack-prose.test) |
| AC-802a | REQ-802 | assert | a mid-tier other-family account and a strong writer | the plan is made | no second reader is assigned and the reason is logged (orch-plan.test) |
| AC-901a | REQ-901 | assert | `features.boardLoop` off | `board-loop` runs | it prints the not-configured line and exits 0 (board-loop.test) |
| AC-901b | REQ-901 | assert | `features.boardLoop` on and `maxPasses` missing | the profile loads | the profile is invalid naming `maxPasses` (board-loop.test) |
| AC-902a | REQ-902 | assert | a verdict of PASS while the gate exits 1 | the pass ends | the pass is recorded as failed (board-loop.test) |
| AC-903a | REQ-903 | assert | 20 KB of gate output | the next pass starts | its input holds the digest, the progress note and the prompt file only (board-loop.test) |
| AC-904a | REQ-904 | assert | 5 rows, one passing per pass, `maxPasses` 8 | the loop runs | it stops at pass 5 with reason all-pass and never pushes (board-loop.test) |
| AC-904b | REQ-904 | assert | 5 rows, one passing per pass, `maxPasses` 3 | the loop runs | it stops with 2 rows open, reason max-passes, exit 10 (board-loop.test) |
| AC-905a | REQ-905 | assert | a passing pass and a failing pass | the commits are read | the passing pass is one commit; the failing pass leaves no commit, a snapshot ref exists, and the tree is clean (board-loop.test, orch-snapshot) |
| AC-906a | REQ-906 | assert | a worker that writes to the gate script | the pass ends | FAILED-SCOPE and the loop stops (board-loop.test) |
| AC-907a | REQ-907 | assert | a finished pass | the run log is read | one row holds pass, row, rows passing, retries, gate digest, turns, cost or unmeasured, and stop reason (board-loop.test, run-log) |
| AC-908a | REQ-908 | assert | a board and a ready builder account | `orch loop` runs | the state file holds a loop job with the account and the cap (orch-loop.test) |
| AC-908b | REQ-908 | assert | a board and a not-ready account | `orch loop` runs | it refuses before any pass (orch-loop.test) |
| AC-908c | REQ-908 | assert | a stopped loop | `orch status` runs | it prints the stop reason, and the run-log rows equal a manual run's (orch-loop.test) |
| AC-909a | REQ-909 | assert | a scheduled measurement run | it completes | EXPERIMENTS §17 has a new dated row and `boardLoop` is unchanged (board-loop.test) |
| AC-910a | REQ-910 | assert | a stub that repeats the same diff, `maxConsecutiveNoProgress` 3 | the loop runs | it stops after pass 3 with STOP no-progress (board-loop.test) |
| AC-911a | REQ-911 | assert | one row that always fails and one that passes, `maxRetriesPerRow` 2 | the loop runs | the board shows one row blocked and one done (board-loop.test) |
| AC-912a | REQ-912 | assert | a worker that marks a second row done | the pass ends | FAILED-SCOPE (board-loop.test) |
| AC-913a | REQ-913 | assert | `--dangerously-skip-permissions` in the account command | the loop starts | it refuses naming the flag (board-loop.test) |
| AC-914a | REQ-914 | assert | three failing passes in a row, `maxConsecutiveFailures` 3 | the loop runs | it stops with STOP consecutive-failures and the run-log row carries that reason (board-loop.test) |
| AC-914b | REQ-914 | assert | a stopped loop restarted with `--more-passes 5` | the loop restarts | the cap rises by 5 for that run only and the grant is logged (board-loop.test) |
| AC-915a | REQ-915 | assert | a passing pass | the commit is read | `Builder-Account:` and `Builder-Requirement:` are present, no other kit trailer exists, and no trailer holds a prompt, a transcript or a key (board-loop.test) |
| AC-1001a | REQ-1001 | assert | an existing name, a reserved kit name, a name outside the rule, and a second payment kind | `accounts add` runs for each | the refusal codes are E_ACCOUNT_EXISTS, E_ACCOUNT_NAME, E_PAYS_TWICE and E_BASEURL_SUB (accounts-cli.test) |
| AC-1001b | REQ-1001 | assert | a valid new name | `accounts add` runs | §16 holds the account and its dir exists (accounts-cli.test) |
| AC-1002a | REQ-1002 | assert | a piped fake key | `accounts key` runs | the key file has mode 0600, no substring of the key is in stdout or stderr, and the profile, the lock and git are unchanged (account-secrets.test) |
| AC-1002b | REQ-1002 | assert | a planted symlink at the key path | `accounts key` runs | EEXIST and nothing is written through the symlink (account-secrets.test) |
| AC-1003a | REQ-1003 | assert | a stub `codex` binary | `accounts key` runs for a Codex account | the stub received the value on stdin, no file under the kit holds it, and the report shows the auth file mode (account-secrets.test) |
| AC-1004a | REQ-1004 | assert | an account with a key, a wrapper and a §16 entry | `key --remove` and then `remove` run | the key file and the helper setting go first; then the wrapper, key and entry go and the profile folder stays (accounts-cli.test) |
| AC-1004b | REQ-1004 | assert | `accounts.lock.json` and an upgrade backup | they are read | neither holds the key file (lock.test) |
| AC-1005a | REQ-1005 | assert | a key file at 0644 on POSIX | the account is assessed | not ready, the reason reads key file mode 0644 (account-secrets.test) |
| AC-1006a | REQ-1006 | assert | a Windows path fixture | the account dir is created | `icacls /inheritance:r /grant:r` is applied where available; otherwise the report says mode unverified (account-secrets.test) |
| AC-1007a | REQ-1007 | assert | a planted real-looking key shape in a fixture, a temp HOME or captured stdio | secret-shapes.test runs | it fails naming the file (secret-shapes.test) |
| AC-1101a | REQ-1101 | assert | four accounts of four kinds | `accounts install` runs | four wrapper pairs exist, only the gateway and free ones mention the base URL, and no wrapper exports `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY` (accounts-install.test) |
| AC-1102a | REQ-1102 | assert | installed wrappers and a kit upgrade | the upgrade runs | the wrappers are in `accounts.lock.json`, a backup exists, and nothing is armed in a live tool config (lock.test, upgrade.test) |
| AC-1103a | REQ-1103 | assert | an account the policy closes | `accounts install` runs | a refusal wrapper that only explains why; an unreadable policy leaves a working wrapper alone (accounts-install.test) |
| AC-1104a | REQ-1104 | assert | the fixture policy and a stub management API | `accounts policy dry-run` runs | the request plan matches the golden fixture for that OmniRoute version (gateway-policy.test) |
| AC-1104b | REQ-1104 | assert | an unknown gateway name, and a policy that names a subscription provider | `accounts policy apply` runs for each | the first is refused with the known list; the second is refused as a subscription provider (gateway-policy.test) |
| AC-1105a | REQ-1105 | assert | a stub gateway with keys and budget rows | `accounts usage-snapshot` runs | the snapshot has the shape the assessment reads and holds neither the token nor a key (gateway-usage.test) |
| AC-1106a | REQ-1106 | assert | a reachable session bus, then none | the Antigravity wrapper renders | `SSH_*` is dropped in the first case and kept in the second (accounts-install.test) |
| AC-1107a | REQ-1107 | assert | a secret-shaped prompt | the MCP tool is called | a refusal naming the kind of match (free-model-mcp.test) |
| AC-1107b | REQ-1107 | assert | a 2026-07-28 client and a legacy `initialize` client | each makes a tool call | both complete the call (free-model-mcp.test) |
| AC-1108a | REQ-1108 | assert | a policy file that differs from the profile | `builder verify` runs | the advisory row names the drifted keys and the apply command, and nothing is written (cli-commands.test) |
| AC-1109a | REQ-1109 | assert | three Claude Code accounts | `accounts install` runs | each `srt-settings.json` denies the two other account dirs (accounts-install.test) |
| AC-1109b | REQ-1109 | assert | an `srt-settings.json` with an unknown key | the wrapper starts | it refuses naming the file (accounts-install.test) |
| AC-1201a | REQ-1201 | assert | the flag off and a plan with a `machine` field | orch reads the plan | it prints `remoteLanes: not configured` and places the lane locally (orch-remote.test) |
| AC-1201b | REQ-1201 | assert | the flag on and an unknown machine name | the lane is placed | the lane is refused naming the row (orch-remote.test) |
| AC-1202a | REQ-1202 | assert | a stub ssh that exits 255 | a lane is polled | the event is `remote_unknown` and the lane is not FAILED (orch-remote.test) |
| AC-1202b | REQ-1202 | assert | a stub ssh that exits 1 | a lane is polled | the recorded exit code is the remote command's (orch-remote.test) |
| AC-1203a | REQ-1203 | assert | a stub whose `claude auth status` exits 1 | preflight runs | the machine row reads not ready (`machine_unauthenticated`) and no lane is placed on it (orch-remote.test) |
| AC-1204a | REQ-1204 | assert | a plan whose `remoteRoot` matches a mount path pattern | preflight runs | it refuses naming the path (orch-remote.test) |
| AC-1204b | REQ-1204 | assert | the GUIDE | pack-prose runs | it finds the Git FAQ sentence about sharing a working tree across systems (pack-prose.test) |
| AC-1205a | REQ-1205 | assert | a stub ssh that records its command | a remote lane starts | the command holds the fetch, the worktree add on a fresh branch, the nohup launch and `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` (orch-remote.test) |
| AC-1206a | REQ-1206 | assert | a stub with a live pid and unchanged mtimes past the idle threshold | the lane is polled | FAILED-STALL (orch-remote.test) |
| AC-1206b | REQ-1206 | assert | cancel and a stub that reports the pid alive once | the lane is polled twice | the state is cancelling, then cancelled (orch-remote.test) |
| AC-1207a | REQ-1207 | assert | a stub that pushes a branch and writes a verdict whose head equals the branch tip | the lane exits | the lane is merged by the existing merge path (orch-remote.test, orch-merge.test) |
| AC-1207b | REQ-1207 | assert | a verdict with another head | the lane exits | FAILED-STALE-VERDICT (orch-remote.test) |
| AC-1208a | REQ-1208 | assert | a pin that names a kit hook file the remote lacks | a remote lane launches | the launch is refused and the event names the hook (orch-remote.test) |
| AC-1209a | REQ-1209 | assert | a stub `.lane/err.log` with a secret-shaped line | it is fetched | the event carries the redaction marker and never the text (orch-remote.test, secret-shapes.test) |
| AC-1209b | REQ-1209 | assert | the recorded remote launch command | it is read | no path under the user's home is copied (orch-remote.test) |
| AC-1210a | REQ-1210 | assert | a remote whose clock is one hour ahead | events are written | their order follows the sequence number, and the remote time is stored as `remoteTs` (orch-remote.test) |
| AC-1211a | REQ-1211 | assert | the flag `remoteLanes` | `features` runs | it prints `remoteLanes: experimental-off` and names §18, and pack-prose finds the §18 measurement text (features.test, pack-prose.test) |
| AC-1301a | REQ-1301 | assert | the package files | package.test runs | `package.json` says MIT and a LICENSE file with the MIT text is present, and they agree (package.test) |
| AC-1302a | REQ-1302 | assert | the shipped files | the invocation test scans them | no form of the dropped `builder` bin remains outside the CHANGELOG history, and the only bin is `builder-pipeline` (bin-rename.test, invocation.test, package.test) |
| AC-1303a | REQ-1303 | assert | the README | readme-figures.test runs | each badge value equals the value counted from its source (readme-figures.test) |
| AC-1304a | REQ-1304 | assert | the shipped docs | pack-prose runs | the old sentence and badge are absent and the proof statement is present in README and DESIGN (pack-prose.test) |
| AC-1305a | REQ-1305 | assert | README, FEATURES, GUIDE and hooks/README | pack-prose runs | the sentence "fail-closed on Claude Code; CI gates and reports on Codex and Antigravity" is present and the word "natively" is absent from the guard rows (pack-prose.test) |
| AC-1306a | REQ-1306 | assert | RELEASING.md | pack-prose runs | the `npm publish --access public` step is present after the tag step (pack-prose.test) |
| AC-1401a | REQ-1401 | assert | EXPERIMENTS.md | experiments.test runs | all 15 sections have a decision row and none is blank (experiments.test) |
| AC-1401b | REQ-1401 | assert | the experimental flags | `features` runs | each experimental line carries the decision (features.test) |
| AC-1402a | REQ-1402 | assert | EXPERIMENTS §19 | experiments.test runs | the row names a run id, a cost line and a fix-rate line (experiments.test) |
| AC-1403a | REQ-1403 | assert | a board with no FIX rows | fix-rate runs | the output is `fixLane: unmeasured` and the exit code is the not-configured code (fix-rate.test) |
| AC-1404a | REQ-1404 | assert | the timed first-value script | first-value.test runs | it prints the wall time and fails above 300 s (first-value.test) |
| AC-1405a | REQ-1405 | assert | EXPERIMENTS §20 | experiments.test runs | each default-on check has a false-positive rate (experiments.test) |
| AC-1405b | REQ-1405 | assert | a check with a rate above 20 % | features.test runs | FEATURES shows that check off by default (features.test) |
| AC-1406a | REQ-1406 | assert | the Library folder of the 2.0.0 build | the release check runs | the run log exists and names every merged module PR (review, release-check) |

## API contract

No API contract — the module is a CLI and a library with no served HTTP interface; the contract oracle does not apply.

## Oracle amendments

| Oracle | Entry | Why | Decision |
|---|---|---|---|
| decision log | none | no catalogue entry is needed; every rule cites D1 to D60 | dropped — nothing pending |

## Open questions

| Id | Question | Blocks | Answer |
|---|---|---|---|
| Q-0 | none open; Q1 to Q22 of the plan were answered on 16 November 2026 | — | George, 16 November 2026: every question took the recommended option (D53 to D60) |

## Amendments

A change to a ratified row is a new row here. The row above is never edited in place (D45).

| Id | Date | Changes | Decision | By |
|---|---|---|---|---|
| A-0 | 2026-11-16 | Initial ratification; no change | D45 | George |
