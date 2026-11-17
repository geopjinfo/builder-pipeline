# Spec — toolkit-cost-codex: read Codex CLI session transcripts for cost accounting

Module: toolkit-cost-codex
Status: ratified
Ratified-by: George (autonomy mandate of 16 November 2026, applied by the build thread; see Decision log)

> The kit's own spec for the second cost reader, part of release 2.0.0. It follows the installed spec template. Check it
> with `npx builder run spec-check specs/toolkit-cost-codex.spec.md` (folder layout:
> `node scripts/spec-check.mjs specs/toolkit-cost-codex.spec.md`). It is maintainer-only and does not ship in the package.

## Intent

Today `features.costAccounting.reader` accepts one value, `claude-code`. With any other value, `cost-window` prints
"cost window: unmeasurable with this harness" and stops. A team that runs the pipeline on the OpenAI Codex CLI has
transcripts on disk, but the kit does not read them. This module adds a second reader, `codex`, so `cost-window`
can price a time window from Codex session files. The reader reads only the shapes verified from the Codex source.
It says "unmeasurable" with a reason on every shape it does not know. It never reports an unpriced model as $0.

Verified facts (source: the `openai/codex` repository, branch `main`, fetched on 2026-11-17 over
`https://raw.githubusercontent.com/openai/codex/main/` followed by the file path; the GitHub API was not reachable from the build
session, see DL-2):

- Session files live under `CODEX_HOME/sessions/YYYY/MM/DD/rollout-TIMESTAMP-THREAD_ID.jsonl`.
  `CODEX_HOME` defaults to `~/.codex`. Source: `codex-rs/rollout/src/lib.rs` (`SESSIONS_SUBDIR = "sessions"`,
  `ARCHIVED_SESSIONS_SUBDIR = "archived_sessions"`), `codex-rs/rollout/src/recorder.rs` (the `YYYY/MM/DD` path and
  the `rollout-TIMESTAMP-CONVERSATION_ID.jsonl` name), `codex-rs/core/src/config/mod.rs` (`find_codex_home`).
- Each line is one JSON object `{ "timestamp": "UTC ISO with milliseconds and Z", "ordinal"?: n, "type": "KIND", "payload": {…} }`.
  Source: `RolloutLineRef` in `codex-rs/rollout/src/recorder.rs` and `RolloutItemWire` in
  `codex-rs/history/src/rollout_payload.rs` (`#[serde(tag = "type", rename_all = "snake_case")]`, every variant
  carries `payload`).
- `type: "session_meta"`: `payload.id` (thread id), `payload.timestamp`, `payload.cwd`, `payload.originator`,
  `payload.cli_version`, `payload.model_provider`, optional `payload.agent_role`. Source: `SessionMeta` and
  `SessionMetaLine` in `codex-rs/protocol/src/protocol.rs`.
- `type: "turn_context"`: `payload.model` (the model of the turns that follow). Source: `TurnContextItem` in
  `codex-rs/protocol/src/protocol.rs`.
- `type: "event_msg"` with `payload.type: "token_count"`: `payload.info.total_token_usage` (cumulative for the
  thread), `payload.info.last_token_usage`, `payload.info.model_context_window`, `payload.rate_limits`. The event is
  persisted in every history mode. Source: `TokenCountEvent`, `TokenUsageInfo`, `RateLimitSnapshot` in
  `codex-rs/protocol/src/protocol.rs`; `persisted_event_msg` in `codex-rs/rollout/src/policy.rs`.
- `TokenUsage` fields: `input_tokens`, `cached_input_tokens`, `cache_write_input_tokens` (default 0),
  `output_tokens`, `reasoning_output_tokens`, `total_tokens`. `cached_input_tokens` is part of `input_tokens`
  (`non_cached_input = input_tokens - cached_input_tokens`). `reasoning_output_tokens` is part of `output_tokens`
  (it maps the Responses API `output_tokens_details.reasoning_tokens`). Source: `TokenUsage` and `impl TokenUsage` in
  `codex-rs/protocol/src/protocol.rs`; `codex-rs/codex-api/src/sse/responses.rs`.
- `type: "token_usage_record"`: `payload.usage`, `payload.turn_token_usage`, `payload.thread_token_usage`,
  `payload.response_id`. Source: `TokenUsageRecord` in `codex-rs/protocol/src/protocol.rs`. The record layer keeps
  it; the cost layer does not sum it (DL-3).

## Scope

- In: the `codex` value of `features.costAccounting.reader` and its validation · `scripts/lib/codex-usage.cjs` with
  two layers (a record layer: `parseLine`, `records`; a cost layer: `collect`, `sessionUsage`, `sessionsDir`) ·
  `cost-window` on the Codex reader with `--transcripts DIR` · an explicit "unmeasurable" line with a reason in
  `seat-peaks` and `orchestrator-check` for the Codex reader · fixtures and tests · FEATURES.md, adapters/codex.md,
  CHANGELOG.
- Out: OpenAI rates in `scripts/lib/pricing.cjs` (DL-4) · reading `archived_sessions` (DL-8) · the board renderer's
  per-seat columns for Codex (a later spec) · rate-limit reporting itself (the accounts thread; the record layer
  surfaces the payload for it) · Antigravity transcripts.

## Actors

| Actor | Source |
|---|---|
| a team that runs the pipeline on Codex CLI | intent |
| a CI job | intent |
| the accounts thread (rate limits) | coordinator note, 2026-11-17 |
| a maintainer of the kit | AGENTS.md rules 11 and 13 |

Decision log (the plan's rule: each decision taken without George is logged with its reasoning so he can change it):

| Id | Decision | Reasoning | Date |
|---|---|---|---|
| DL-1 | This spec is ratified by the build thread, not by George in person. | George's mandate of 16 November 2026: fill open decisions with the recommended option and complete the work. Each acceptance criterion has a passing test in `tests/toolkit-cost-codex.test.mjs`. | 2026-11-17 |
| DL-2 | The transcript format is taken from the `openai/codex` source on `main`, fetched file by file over `raw.githubusercontent.com` on 2026-11-17. The commit hash is not recorded. | The GitHub API refused the build session (HTTP 403, repository not attached), so the commit hash could not be read. The raw files fetched are listed in the Intent. Assumption: `main` on 2026-11-17 matches the Codex CLI builds a team runs. A later Codex version that changes a shape makes the reader say "unmeasurable" with the line number, never guess. | 2026-11-17 |
| DL-3 | Usage is summed as the differences between consecutive `token_count` events' `total_token_usage` in one file. `last_token_usage` and `token_usage_record` are parsed but not summed. | `total_token_usage` is cumulative for the thread, so a repeated event (for example a rate-limit refresh with the same totals) adds zero, and a resumed session continues the sum. `token_usage_record` is a newer item that older Codex builds do not write; summing both would count a response twice. A total that decreases marks the file unmeasurable with the line number. | 2026-11-17 |
| DL-4 | No OpenAI rates ship in `pricing.cjs`. Codex usage is reported with its tokens and marked unpriced, unless `--rates FILE` names a table. | The brief allows rates only with a pricing page fetched the same day. On 2026-11-17 `https://developers.openai.com/api/docs/pricing` listed no `gpt-5` or `gpt-5.x-codex` model, and its flagship tables carry tier labels the fetch could not attach to the figures. `https://openai.com/api/pricing/` showed seat prices only. An unverified rate is worse than "unpriced". | 2026-11-17 |
| DL-5 | Price mapping: `inputTokens = input_tokens - cached_input_tokens`, `cacheReadTokens = cached_input_tokens`, `cacheWriteTokens = cache_write_input_tokens`, `outputTokens = output_tokens`. Reasoning tokens are not added again. | Verified in `impl TokenUsage` (`non_cached_input`) and `codex-rs/codex-api/src/sse/responses.rs`, where `reasoning_output_tokens` maps `output_tokens_details.reasoning_tokens`, a part of `output_tokens`. The fields match what `pricing.cost()` already reads, so a `--rates` table prices Codex usage with the same function. | 2026-11-17 |
| DL-6 | A session's seat is `session_meta.payload.agent_role` when present, else `codex-session`. One session file is one dispatch. | Codex writes no `agentType`. `agent_role` (alias `agent_type` in the source) is the only role field in `SessionMeta`. Assumption: it names the role of a Codex sub-agent. A team that needs finer seats narrows the window to one run. | 2026-11-17 |
| DL-7 | Window filtering compares the line's `timestamp` string with `--since` / `--until` as strings. | The recorder writes `YYYY-MM-DDTHH:MM:SS.mmmZ` (UTC), so lexical order is time order, the same rule `cost-window` already applies to Claude Code timestamps. A `--since` without a time zone is read as UTC. | 2026-11-17 |
| DL-8 | The reader walks `CODEX_HOME/sessions` recursively and reads `*.jsonl` files whose name starts with `rollout-`. `archived_sessions` is not read by default. | The recorder writes new sessions under `sessions/YYYY/MM/DD`. Archived sessions are moved by the user and are often old. A team can pass `--transcripts CODEX_HOME/archived_sessions` to price them. The file cap and the "scanned n of m" coverage line follow `transcript-usage.cjs`. | 2026-11-17 |
| DL-9 | `seat-peaks` and `orchestrator-check` print an "unmeasurable" line with a reason for the `codex` reader instead of a Codex implementation. | `seat-peaks` needs a per-turn prompt size with a message id; Codex writes `last_token_usage` per response, and its de-duplication rule is not verified. `orchestrator-check` reads the current session's model; a Codex session has no "current session" the kit can name. Both say why, so a team does not read the line as a pass. | 2026-11-17 |
| DL-10 | A non-JSON last line is tolerated and reported as `torn`, not as an unrecognised shape. Any other non-JSON line, and any JSON line without `timestamp` and `type`, is `unrecognised`. | A live session has a partly written last line; refusing the whole file would hide a day of spend. A torn line in the middle of a file is not a live write and is reported. | 2026-11-17 |
| DL-11 | The record layer exports `parseLine` and `records`, keeps every recognised kind, and surfaces `payload.rate_limits` raw. | Coordinator note of 2026-11-17: the accounts thread will read rate limits from the newest session file (its REQ-203) and must not need a second parser. Only the shape verified in `RateLimitSnapshot` is named; the payload is passed through as written. | 2026-11-17 |

## Requirements

Kind: `behaviour` (what succeeds) · `refusal` (what is refused, and why) · `effect` (what a success leaves behind) ·
`constraint` (always true).

| Id | Requirement | Actor | Kind | Source |
|---|---|---|---|---|
| REQ-601 | `features.costAccounting.reader` accepts `claude-code` and `codex` | a team that runs the pipeline on Codex CLI | behaviour | intent |
| REQ-602 | Any other `reader` value is refused at load with a validation error that names both accepted values | a CI job | refusal | AGENTS.md rule 11 |
| REQ-603 | The Codex sessions directory is `--transcripts DIR` when given, else `$CODEX_HOME/sessions`, else `~/.codex/sessions`; the reader walks it recursively for `rollout-*.jsonl` files | a team that runs the pipeline on Codex CLI | behaviour | DL-8 |
| REQ-604 | `parseLine` turns a verified line into a typed record (`session_meta`, `turn_context`, `token_count`, `token_usage_record`, or `other` for a line with the envelope and another `type`); `records` does so for a whole file and keeps every record in file order | the accounts thread (rate limits) | behaviour | DL-11 |
| REQ-605 | A `token_count` record carries `payload.rate_limits` unchanged as `rateLimits` (`null` when absent) | the accounts thread (rate limits) | effect | DL-11 |
| REQ-606 | A line the reader does not recognise (not JSON, or JSON without the `timestamp` and `type` envelope, or a `token_count` whose usage fields are not numbers) is reported as `unrecognised` with its line number and a reason; it is never summed | a maintainer of the kit | refusal | DL-10 |
| REQ-607 | A session's usage is the sum of the differences between consecutive `token_count` totals, each difference attributed to the model of the latest `turn_context` before it | a team that runs the pipeline on Codex CLI | behaviour | DL-3 |
| REQ-608 | A difference whose event timestamp is outside `--since` / `--until` is not summed | a team that runs the pipeline on Codex CLI | constraint | DL-7 |
| REQ-609 | A session whose cumulative total decreases is unmeasurable with the line number as the reason, and `cost-window` prints it | a maintainer of the kit | refusal | DL-3 |
| REQ-610 | A model with no rate in the table in use is counted as unpriced and the total is marked partial; it is never added as $0 | a team that runs the pipeline on Codex CLI | constraint | DL-4 |
| REQ-611 | `--rates FILE` prices Codex usage with the fields of DL-5 through `pricing.cost()` | a team that runs the pipeline on Codex CLI | behaviour | DL-5 |
| REQ-612 | `cost-window` runs the Codex reader when `reader` is `codex`, keeps the Claude Code path when it is `claude-code`, and prints "unmeasurable with this harness" for any other value the loader let through | a CI job | behaviour | intent |
| REQ-613 | `seat-peaks` and `orchestrator-check` print an "unmeasurable" line that names the Codex reader and a reason, and exit 0 | a CI job | constraint | DL-9 |
| REQ-614 | `npx builder run features` prints `costAccounting: on` for a valid profile with `reader: "codex"`; its output is otherwise unchanged | a CI job | effect | intent |

## Acceptance criteria

Verb: `assert` (holds as written) · `by-design` (cite a decision) · `gap` (cite a deferred-registry row).

| Id | Req | Verb | Given | When | Then |
|---|---|---|---|---|---|
| AC-601 | REQ-601 | assert | a profile with `costAccounting` on and `reader: "codex"` | the profile is parsed | no validation error |
| AC-602 | REQ-602 | assert | a profile with `costAccounting` on and `reader: "gemini"` | the profile is parsed | one error names `features.costAccounting.reader`, `claude-code` and `codex` |
| AC-603 | REQ-603 | assert | `CODEX_HOME` set to a directory | `sessionsDir()` | the path is `CODEX_HOME/sessions`; with no `CODEX_HOME` it ends in `.codex/sessions`; an explicit directory wins over both |
| AC-604 | REQ-603 | assert | a fixture tree `2026/11/16/rollout-a.jsonl`, `2026/11/17/rollout-b.jsonl` and a `notes.txt` | `jsonlFiles(dir)` | both rollout files and nothing else |
| AC-605 | REQ-604 | assert | the fixture session `rollout-a.jsonl` | `records(text)` | the kinds in order are `session_meta`, `turn_context`, `token_count`, `token_count`, `other`, `token_count`; the `session_meta` record has `sessionId`, `model` is on the `turn_context` record |
| AC-606 | REQ-605 | assert | the fixture's second `token_count` line, which carries `rate_limits` | `records(text)` | the record's `rateLimits` deep-equals the payload's `rate_limits` object; the first `token_count` has `rateLimits: null` |
| AC-607 | REQ-606 | assert | a line that is not JSON in the middle of a file, a JSON line without `type`, and a `token_count` whose `input_tokens` is a string | `records(text)` | three `unrecognised` records with line numbers and reasons |
| AC-608 | REQ-606 | assert | a file whose last line is cut | `records(text)` | one `torn` record, and `sessionUsage` still sums the complete lines |
| AC-609 | REQ-607 | assert | the fixture session (totals 1000/200 → 3000/500 → 3000/500 → 6000/1100 after a model change) | `sessionUsage(records)` | three events summed; per model `model-alpha` has 3000 input-class tokens and 500 output tokens, `model-beta` has 3000 and 600; the repeated total adds zero |
| AC-610 | REQ-607 | assert | the same session | `sessionUsage(records)` | `inputTokens` is `input_tokens - cached_input_tokens`, `cacheReadTokens` is `cached_input_tokens`, `cacheWriteTokens` is `cache_write_input_tokens`, `outputTokens` is `output_tokens` |
| AC-611 | REQ-608 | assert | the same session and a window that covers only the last event | `sessionUsage(records, { since, until })` | only `model-beta` is summed; `firstTs` is the last event's timestamp |
| AC-612 | REQ-609 | assert | a session whose third total is lower than its second | `sessionUsage(records)` | `measurable: false` and a reason that names the line number |
| AC-613 | REQ-609 | assert | a transcripts directory with that session | `cost-window --since … --until … --transcripts DIR` with `reader: "codex"` | exit 0 and a line `unmeasurable: FILE: REASON` |
| AC-614 | REQ-610 | assert | the fixture tree with no `--rates` | `cost-window … --transcripts DIR --json` | `partial` is true, `unpriced` is 2, `total` is 0, and the output never shows the sessions as `$0.00` without `unpriced` beside it |
| AC-615 | REQ-611 | assert | a rates file that prices `model-alpha` and `model-beta` | `cost-window … --transcripts DIR --rates FILE --json` | `partial` is false and `total` equals the hand-computed cost |
| AC-616 | REQ-612 | assert | a profile with `reader: "claude-code"` | `cost-window --since … --until …` | the output does not contain `unmeasurable with this harness` and the window line is printed |
| AC-617 | REQ-612 | assert | a profile whose reader is forced past validation to `other` | `cost-window` | exit 0 and the output is `cost window: unmeasurable with this harness` |
| AC-618 | REQ-613 | assert | a profile with `reader: "codex"` | `seat-peaks` | exit 0 and a line that starts `seat peaks: unmeasurable` and contains `codex` |
| AC-619 | REQ-613 | assert | a profile with `reader: "codex"`, `orchestratorModel` on and `models.orchestrator` set | `orchestrator-check` | exit 0 and a line that starts `orchestrator model: unmeasurable` and contains `codex` |
| AC-620 | REQ-614 | assert | a profile with `costAccounting` on and `reader: "codex"` | `run features` | exit 0, `costAccounting: on` and `features: profile valid` are printed |
| AC-621 | REQ-604 | assert | the fixture session | `collect(dir)` | one session row per file with `file`, `sessionId`, `seat` (`codex-session`, or the `agent_role` when the fixture sets one) and its summary |

## API contract

No API contract - the module is a set of command-line tools with exit codes and printed lines; it serves no HTTP interface.

## Oracle amendments

| Oracle | Entry | Why | Decision |
|---|---|---|---|

## Open questions

| Id | Question | Blocks | Answer |
|---|---|---|---|
