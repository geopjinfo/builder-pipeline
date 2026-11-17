# Spec — capacity-reporter: a governor that caps parallel lanes by host capacity, and a reporter that sends a progress report on a schedule

Module: capacity-reporter
Status: ratified
Ratified-by: George, 17 November 2026 (autonomy mandate of 16 November 2026; plan decisions D70 to D85)

> The requirements oracle for the 2.1.0 "capacity and reporter agents" release (M15, M16, M17). The planner, the
> tester's requirement pack and the reviewer's alignment audit read these rows verbatim. Check it with
> `node scripts/spec-check.mjs capacity-reporter --ratified`. Every table header is read by the checker; keep it as
> written. Requirements are written in EARS phrasing and ASD-STE100 Simplified Technical English. The exact names of
> flags, keys, codes and files are the ones the tests assert. The ids continue the accounts spec (REQ-101 to REQ-1406,
> D1 to D69) in one kit-wide sequence (D82).

## Intent

> "we need 2 agents one look for system capacity and control parallel tasks and one for 30min or configured time
> update report and send by slack or configured channel - how we will plan this?"
> (George, 17 November 2026, project chat)

> "ADD THE PLAN AND DESIGN THEN" · "after that proceed with plan updates build."
> (George, 17 November 2026, project chat)

The plan artifact https://claude.ai/artifact/H4uYLjSWBN6zsiazKXRTpL is the source of every row below. The accounts
plan https://claude.ai/artifact/FLZ6L6YJqhq8Jd3uV3pvdJ holds the pointer row; the Design page holds the diagrams.

## Scope

- In: M15 Capacity governor — `features.capacity` in §16 (default off), `scripts/lib/capacity.cjs` with a pure
  `govern()`, `scripts/capacity.mjs` (`--once`, `--watch`), the record `capacity.json` beside `ratelimit.json`, one
  more min() term in `nextActions`, `gate-launch --resume` and the loop runner, a hold at 0 lanes, per-pass peak RSS
  sampling, the read-only persona `agents/capacity-steward.md`, doctor and status lines.
- In: M16 Progress reporter — `features.reporter` in §16 (default off), `scripts/lib/report.cjs` with a pure `build()`
  and `digest()`, `scripts/lib/notify.cjs` with the channels stdout, file, webhook (slack, generic) and command,
  `scripts/report.mjs` (`--once`, `--watch`), only-on-change with a heartbeat, opt-in alerts, the outbound guard in
  front of every payload, the experimental persona `agents/experimental/progress-reporter.md` behind
  `features.reporterSummary`, doctor and status lines.
- In: M17 Evidence, docs and release — EXPERIMENTS §21 and §22 with measurements, FEATURES, GUIDE, USAGE, README,
  llms.txt, adapters and doctor rows, the 2.1.0 release PR.
- Out: raising lanes above the planned maximum, or stopping a running lane — D71.
- Out: a remote lane's host capacity and placement across machines; the scope is one machine and its accounts — D84.
- Out: a Slack app, OAuth, bot tokens or any channel other than an Incoming Webhook; every other target goes through
  the command channel — D76.
- Out: a model-written status as the report; the model summary is an experiment that is off by default — D79.
- Out: a webhook URL in §16, the lock, git, memory, a test or a log — D76, D77.

### INVARIANTS

The checker treats these as non-negotiable. Every requirement below holds inside them.

- Zero dependencies and Node 18. The runtime is CommonJS; `.mjs` entry points sit over `.cjs` logic. The webhook
  transport is `node:https` from the standard library.
- Both features are off by default. Nothing changes for a project that does not turn them on. `reporterSummary` is
  experimental-off until EXPERIMENTS §22 has a measurement.
- Numbers by code, words by persona (D70). The governor never decides by model and the reporter never invents a
  figure. Each persona is read-only and explains a record it did not write.
- The governor lowers only (D71). Effective lanes are never above the planned maximum or `BUILDER_ORCH_LANE_CAP`; it
  refuses new launches and never signals a process.
- An unmeasured signal never binds and is said (D72). A missing reading is never 0.
- Neither watcher ever fails a run (D85). A send failure, a stale record or a missing source changes a line, never an
  exit code.
- No secret leaves the project. Every payload passes the outbound guard first; a hit means NOT SENT, logged by kind,
  never by text (D77). The webhook URL comes from an env variable or a 0600 file, never from §16 (D76).
- Project facts live in PIPELINE_PROFILE.md. `perLaneMb` is a profile key; the kit ships no machine figure as a fact
  (D73).
- Every refusal fails closed and names the key, the code or the kind of match. It never carries file text or a value.

## Actors

| Actor | Source |
|---|---|
| project owner — the person who sets the §16 keys, holds the webhook URL and reads the report (George) | intent |
| orchestrating session — the session that plans, launches lanes, starts the watchers at run start and merges | D85 |
| loop runner — `board-loop` or `orch loop`, the one process that knows its worker's pid | D83 |
| governor — `scripts/capacity.mjs` and `capacity.cjs`, the deterministic script that writes `capacity.json` | D70 |
| reporter — `scripts/report.mjs`, `report.cjs` and `notify.cjs`, the deterministic script that writes and sends | D70 |
| channel — a configured recipient: stdout, a file, a Slack or generic webhook, or a command | D76 |
| kit checkers — the tests, scans, gates and doctor rows that fail closed | D77 |

## Requirements

Kind: `behaviour` (what succeeds) · `refusal` (what is refused, and why) · `effect` (what a success leaves behind:
record, event, version) · `constraint` (always true; the only kind no operation needs to reach). Source: `intent` or a
decision id from the plan's decision log.

| Id | Requirement | Actor | Kind | Source |
|---|---|---|---|---|
| REQ-1501 | The kit shall list `features.capacity` in the FEATURES table with the default off. When the profile loads with `capacity.state: on`, the kit shall require `perLaneMb` and shall validate every number. If `perLaneMb` is absent or a number is out of range, then the kit shall refuse the profile and name the key. | project owner | refusal | D73 |
| REQ-1502 | The governor shall take its host readings with a source for each: memory and cores measured on every platform, load unmeasured on win32, disk unmeasured when the filesystem call fails. A missing reading shall be null with the source unmeasured, never 0. | governor | constraint | D72 |
| REQ-1503 | The kit shall provide a pure `govern(readings, policy, plannedMax, prev)` that returns lanes, binding, caps and reasons. Lanes shall be the minimum of `plannedMax` and every measured cap; an unmeasured signal shall never bind; lanes may be 0. | governor | behaviour | D71 |
| REQ-1504 | The account cap shall be the count of accounts that are ready, placeable, free of LIMIT, BUDGET and AUTH, and under `softLimitPct` or unmeasured. The governor shall read `accounts-readiness.json` and refresh it when older than `usageStaleMinutes`. While `features.accounts` is off, the account cap shall not bind and one reason line shall say so. | governor | behaviour | D72 |
| REQ-1505 | The 429 record shall be one term: its lane count, and 0 while `holdUntil` runs. | governor | behaviour | D74 |
| REQ-1506 | When a tick computes fewer lanes than the previous record, the drop shall apply at once. When ticks compute more lanes, the rise shall apply by one lane after `riseAfterTicks` consecutive ticks that allow it. | governor | behaviour | D71 |
| REQ-1507 | The governor shall write the record `capacity.json` in the orch root with lanes, plannedMax, binding, caps, reasons, at, ttlSeconds and tick, atomically under a lock. A reader shall ignore a record older than `ttlSeconds` and print one line that starts `CAPACITY: record from`. | governor | effect | D74 |
| REQ-1508 | The effective lane count in `nextActions` and `gate-launch --resume` shall be the minimum of `maxLanes`, the 429 cap and the record's lanes. While the record binds, the kit shall print one line `CAPACITY: lanes capped at N of M` with the binding signal and shall not offer ADD-LANES under `laneCap`. `BUILDER_ORCH_LANE_CAP` shall still win. | orchestrating session | behaviour | D71, D74 |
| REQ-1509 | The loop runner shall read the record before each pass. While the record is at 0 lanes, it shall wait `intervalSeconds` and read again, up to `holdMaxMinutes`, then stop with the reason `capacity`. The hold shall be one run-log row `capacity.hold`. | loop runner | behaviour | D71 |
| REQ-1510 | `run capacity --once` shall print the table and exit 0. `--watch` shall tick every `intervalSeconds` under a pid lease. If a watcher is live, then a second watcher shall exit 0 and say so. No reading error shall change the exit code; only a usage or profile error exits 2. | governor | behaviour | D85 |
| REQ-1511 | `orch status` shall print one line that starts `capacity:`. `doctor` shall print one advisory row per tool that says load is unmeasured on win32. | orchestrating session | effect | D72 |
| REQ-1512 | The kit shall ship `agents/capacity-steward.md` with neutral frontmatter, read-only tools and tier mid. The persona shall return the binding signal in words, one profile change and a decision row. The orchestrator skill shall name when it is dispatched. | kit checkers | behaviour | D70 |
| REQ-1513 | The governor shall never write orch run state and shall never signal a process. | governor | constraint | D71 |
| REQ-1514 | The kit shall ship no file that names a machine size as a fact. `perLaneMb` shall be a profile key with the value null in the template; the template comment shall carry the §21 measured figure with its source. | kit checkers | constraint | D73 |
| REQ-1515 | Every refusal and every printed line shall name the figure and the unit (MB or GB), never only a ratio. | governor | constraint | D72 |
| REQ-1516 | While `features.capacity` is on, the loop runner shall sample its worker's peak RSS each pass (`ps -o rss= -p` on Unix, unmeasured on win32) and write `passPeakRssMb` into the pass row. | loop runner | effect | D83 |
| REQ-1601 | The kit shall list `features.reporter` in the FEATURES table with the default off. When the profile loads with `reporter.state: on`, the kit shall require one or more `channels`, each with kind in stdout, file, webhook or command; a webhook `format` in slack or generic; and `alertOn` from the closed set stall, failed, conflict, rate-limit, limit, run-complete. If a webhook entry carries a literal `url`, then the kit shall refuse the profile, name `urlEnv` or `urlFile`, and never echo the URL. | project owner | refusal | D76, D78 |
| REQ-1602 | The reporter shall read every run's state and next actions, the events since the last offset, the board counts, the capacity record, the readiness record, the 429 record, and the cost window while `costAccounting` is on. If a source is missing, then its section shall print its own "not configured" or "no runs" line and shall never be dropped. | reporter | behaviour | D75 |
| REQ-1603 | The report shall have the fixed section order RUNS AND LANES, SINCE LAST REPORT, NEEDS A PERSON, CAPACITY AND ACCOUNTS, COST, NEXT, and shall be deterministic for the same inputs and clock. | reporter | constraint | D75 |
| REQ-1604 | `digest()` shall hash the state parts and not the time. While `onlyOnChange` is on, a tick whose digest equals the last sent digest shall write the file and send nothing; every `heartbeatEvery`-th skipped tick shall send one heartbeat line. | reporter | behaviour | D75 |
| REQ-1605 | The file channel shall write a dated report file, `latest.md` and `state.json` under `.pipeline/reports/`, atomically. The first report shall say that it is the first. | channel | effect | D75 |
| REQ-1606 | The webhook transport shall use `node:https`. Plain `http:` shall be accepted only for 127.0.0.1 or localhost. No redirect shall be followed; a 3xx response fails the send. The timeout shall default to 10 s. The response body shall never be logged; the log shall name host and status only. | channel | behaviour | D76 |
| REQ-1607 | Every payload shall pass the outbound guard with the project's env secrets first. If the guard hits, then the payload is NOT SENT, the log shall read `report.refused` with the kind and the line number, and the next report's header shall say that the last send was refused. | reporter | refusal | D77 |
| REQ-1608 | The Slack text shall be mrkdwn under `maxBytes`. When the report is cut, the NEEDS A PERSON section and the run lines shall survive and the last line shall name the full report file. | channel | behaviour | D76 |
| REQ-1609 | The generic webhook payload shall be a JSON object with title, text, digest, at and runs, where each run carries runId and a lanes count per status. | channel | behaviour | D76 |
| REQ-1610 | The command channel shall fill `{file}` in the command, pass the text on stdin, run through the platform shell with the headless env allowlist under `timeoutMs`. If the command exits non-zero, then the log shall say `command exited` with the code and never the output. | channel | behaviour | D76 |
| REQ-1611 | `run report --once` shall build and send once. `--watch` shall tick at start and every `intervalMinutes` under a pid lease. A send failure shall never change the exit code; only a usage or profile error exits 2. | reporter | behaviour | D85 |
| REQ-1612 | While `alertOn` is not empty, the watcher shall poll `events.jsonl` every `alertPollSeconds`. When an event matches, the watcher shall send a one-line alert at once, once per event offset. | reporter | behaviour | D78 |
| REQ-1613 | `orch status` shall print one line `reporter: last sent` with the time and the channel kinds. `doctor` shall print one advisory row. The orchestrator skill shall start the watcher at run start beside board-watch. | orchestrating session | effect | D85 |
| REQ-1614 | The kit shall ship `agents/experimental/progress-reporter.md`, read-only, installed with `--experimental` only, and `features.reporterSummary` experimental-off with an EXPERIMENTS §22 entry. The report shall include `summary.md` under a section SUMMARY (model) only while the file is younger than one interval. | reporter | behaviour | D79 |
| REQ-1615 | The report shall never carry a key, a URL with credentials or an env value. A readiness reason shall be included only after the guard. If a line is refused, then the file copy shall carry `[refused:` with the kind in its place and nothing shall be sent. | kit checkers | constraint | D77 |
| REQ-1616 | The kit shall document the reporter with a FEATURES row, a GUIDE section, USAGE runbook lines, an llms.txt entry, a doctor row and a CHANGELOG entry. | kit checkers | effect | intent |
| REQ-1617 | The watcher and the channels shall run on Windows: paths through `path`, the command channel through the platform shell, no `ps`. | reporter | constraint | D72 |
| REQ-1618 | Two watchers shall never double-send. If a watcher is live, then a second watcher shall exit 0 and name the pid. If the lease's process is gone, then the second watcher shall take the lease over. | reporter | refusal | D85 |
| REQ-1701 | EXPERIMENTS §21 shall hold the measured per-lane peak RSS from the loop runner's test project, a recorded tick log where the governor bound, and a keep-or-drop criterion: no false bind in the recorded run. The template comment figure shall equal the §21 figure. | kit checkers | effect | D83 |
| REQ-1702 | EXPERIMENTS §22 shall hold the reporter's bytes per report, the only-on-change suppression ratio over a recorded run, and the summary trial's criterion. | kit checkers | effect | D79 |
| REQ-1703 | The kit shall document both agents: FEATURES rows, GUIDE sections, one README line each, the llms.txt map, adapter notes for the two personas, and the doctor matrix. | kit checkers | effect | intent |
| REQ-1704 | The kit shall ship the change as minor version 2.1.0 in one release PR with the CHANGELOG heading and the version bump only. The tag shall follow a green CI on main and the owner's word. | project owner | effect | D80 |

## Acceptance criteria

Every requirement has at least one row. Verb: `assert` (holds as written) · `by-design` (the intended behaviour
diverges from the text and a decision says so — cite it in Then) · `gap` (knowingly unenforced — cite the
deferred-registry row in Then). `skipped` is a run outcome, never a spec verb. Then names the exact status and
code, or the exact effect. The plan's test name closes each Then in brackets.

| Id | Req | Verb | Given | When | Then |
|---|---|---|---|---|---|
| AC-1501a | REQ-1501 | assert | `capacity.state: on` and no `perLaneMb` | the profile loads | the profile is invalid and the error names `perLaneMb` (profile.test) |
| AC-1501b | REQ-1501 | assert | `reserveCores: -1` | the profile loads | the profile is invalid and the error names `reserveCores` (profile.test) |
| AC-1501c | REQ-1501 | assert | the shipped FEATURES table | features.test reads the row for capacity | the default is off (features.test) |
| AC-1502a | REQ-1502 | assert | an injected os with platform win32 | readings run | load.source is unmeasured and load.value is null (capacity.test) |
| AC-1502b | REQ-1502 | assert | a filesystem call that throws | readings run | disk.source is unmeasured and the run continues (capacity.test) |
| AC-1503a | REQ-1503 | assert | 16 GB total, 2.9 GB free, perLaneMb 1500, minFreeMb 1024, 8 cores, plannedMax 4 | govern runs | lanes is 1 and binding is memory (capacity.test) |
| AC-1503b | REQ-1503 | assert | free memory under minFreeMb | govern runs | lanes is 0 and reasons name the free figure (capacity.test) |
| AC-1503c | REQ-1503 | assert | load unmeasured and every other cap above plannedMax | govern runs | lanes equals plannedMax and binding is none (capacity.test) |
| AC-1504a | REQ-1504 | assert | three accounts: ready at 62 %, ready unmeasured, LIMIT until later | govern runs with the injected readiness record | the account cap is 2 and the LIMIT account is named in reasons (capacity.test) |
| AC-1504b | REQ-1504 | assert | `features.accounts` off | govern runs | no account cap and one reason line says accounts are off (capacity.test) |
| AC-1505a | REQ-1505 | assert | a ratelimit record in hold | govern runs | lanes is 0 and binding is rate-limit (capacity.test) |
| AC-1506a | REQ-1506 | assert | a previous record at 1 lane and three ticks that compute 3 | govern runs each tick | lanes read 1, 1, 2 (capacity.test) |
| AC-1506b | REQ-1506 | assert | a previous record at 2 lanes and one tick that computes 0 | govern runs | lanes is 0 at once (capacity.test) |
| AC-1507a | REQ-1507 | assert | a record 10 minutes old with ttlSeconds 180 | nextActions runs | the effective cap is the planned one and the first line starts `CAPACITY: record from` (orch-state.test) |
| AC-1507b | REQ-1507 | assert | a tick with an injected fs | the record is written | the write is atomic under the lock and the record holds the eight fields (capacity.test) |
| AC-1508a | REQ-1508 | assert | maxLanes 3, no 429, a record at 1, three PLANNED lanes | nextActions runs | exactly one LAUNCH line and one `CAPACITY: lanes capped at 1 of 3` line (orch-state.test) |
| AC-1508b | REQ-1508 | assert | a capacity policy with laneCap 4, a fresh seat under its percentage and a binding record | nextActions runs | no ADD-LANES line (orch-gaps.test) |
| AC-1508c | REQ-1508 | assert | a resume with one live lane and a record at 1 | gate-launch --resume runs | exit 3 naming the slot (orch-worker-account-mode.test) |
| AC-1508d | REQ-1508 | assert | `BUILDER_ORCH_LANE_CAP=1` and a record at 3 | nextActions runs | exactly one LAUNCH line (orch-state.test) |
| AC-1509a | REQ-1509 | assert | a record at 0 and an injected clock | the loop runs | no worker is spawned, the run log holds `capacity.hold`, and after holdMaxMinutes the summary reads `stop: capacity` (board-loop.test) |
| AC-1509b | REQ-1509 | assert | a record that rises to 1 on the second read | the loop runs | the pass runs (board-loop.test) |
| AC-1510a | REQ-1510 | assert | the feature off | `run capacity --once` runs | stdout reads `capacity: not configured` and exit 0 (capacity-cli.test) |
| AC-1510b | REQ-1510 | assert | a live lease | a second `--watch` starts | it says a watcher is live and exits 0 (capacity-cli.test) |
| AC-1510c | REQ-1510 | assert | an injected os whose disk call throws | `--once` runs | the table prints disk unmeasured and exit 0 (capacity-cli.test) |
| AC-1511a | REQ-1511 | assert | a fresh record | `orch status` runs | one line starts `capacity:` (orch-gaps.test) |
| AC-1511b | REQ-1511 | assert | `doctor --json` | doctor runs | the capacity row exists, is advisory, and exit 0 (doctor.test) |
| AC-1512a | REQ-1512 | assert | the persona file | the persona tests run | frontmatter is neutral and the five-clause contract is present (persona.test) |
| AC-1512b | REQ-1512 | assert | the three adapters | they render the persona | each output names read-only tools only (adapters.test) |
| AC-1512c | REQ-1512 | assert | the orchestrator skill | pack-prose.test runs | the skill names when capacity-steward is dispatched (pack-prose.test) |
| AC-1513a | REQ-1513 | assert | a full tick with injected fs and process | the tick runs | the only write is `capacity.json` and process.kill is never called (capacity.test) |
| AC-1514a | REQ-1514 | assert | the shipped files | genericity.test runs | green (genericity.test) |
| AC-1514b | REQ-1514 | assert | the template | the §16 block parses | `capacity.perLaneMb` is null (template.test) |
| AC-1515a | REQ-1515 | assert | a memory bind | the line prints | it holds the free figure and the per-lane figure, each with MB or GB (capacity.test) |
| AC-1516a | REQ-1516 | assert | an injected ps that prints 1572864 | a pass ends | the run-log row holds `passPeakRssMb: 1536` (board-loop.test) |
| AC-1516b | REQ-1516 | assert | platform win32 | a pass ends | the field is null with source unmeasured (board-loop.test) |
| AC-1601a | REQ-1601 | assert | a channel with kind email | the profile loads | invalid and the message prints the allowed set (profile.test) |
| AC-1601b | REQ-1601 | assert | a webhook entry with a literal url | the profile loads | invalid, the message names `urlEnv` or `urlFile`, and the URL is absent from the output (profile.test) |
| AC-1601c | REQ-1601 | assert | the shipped FEATURES table | features.test reads the row for reporter | the default is off (features.test) |
| AC-1601d | REQ-1601 | assert | `alertOn: ["email"]` | the profile loads | invalid and the message prints the closed set (profile.test) |
| AC-1602a | REQ-1602 | assert | no orch root | build runs | the RUNS AND LANES section reads no runs (report.test) |
| AC-1602b | REQ-1602 | assert | `costAccounting` off | build runs | the COST section reads `costAccounting: not configured` (report.test) |
| AC-1603a | REQ-1603 | assert | the golden fixture and a fixed clock | build runs twice | the text equals `tests/fixtures/report/golden.md` byte for byte (report.test) |
| AC-1604a | REQ-1604 | assert | the same state at two ticks | the second tick runs | the file exists and the channel stub received nothing (report.test) |
| AC-1604b | REQ-1604 | assert | heartbeatEvery 3 and three skipped ticks | the third skipped tick runs | one heartbeat line was sent (report.test) |
| AC-1605a | REQ-1605 | assert | an empty reports dir | a tick runs | the dated file, `latest.md` and `state.json` exist and the header holds first report (report.test) |
| AC-1606a | REQ-1606 | assert | a local node:http server | the slack channel posts | the server receives a JSON body with text and a JSON content type (notify.test) |
| AC-1606b | REQ-1606 | assert | the server answers 302 | the slack channel posts | the send fails as HTTP 302 and no second request is made (notify.test) |
| AC-1606c | REQ-1606 | assert | `http://example.test` as the URL | the channel sends | refused before any request (notify.test) |
| AC-1606d | REQ-1606 | assert | a server that answers 500 with a body | the channel sends | the log names host and status and holds no body text (notify.test) |
| AC-1607a | REQ-1607 | assert | a readiness reason that holds an env value | a tick runs | nothing reaches the channel stub, the log reads `report.refused` with the kind and never the value, and the next header holds last send refused (report.test, outbound-guard.test) |
| AC-1608a | REQ-1608 | assert | a report of 12 kB and maxBytes 3500 | the slack text is built | it is under 3500 bytes, holds NEEDS A PERSON whole and ends with the file path (notify.test) |
| AC-1609a | REQ-1609 | assert | the golden fixture | the generic payload is built | it equals `tests/fixtures/report/generic.json` (notify.test) |
| AC-1610a | REQ-1610 | assert | a stub command that writes stdin to a file | the command channel runs | the file equals the report (notify.test) |
| AC-1610b | REQ-1610 | assert | a stub command that exits 3 and prints | the command channel runs | the log reads `command exited 3` and holds no output (notify.test) |
| AC-1611a | REQ-1611 | assert | the feature off | `run report --once` runs | stdout reads `reporter: not configured` and exit 0 (report-cli.test) |
| AC-1611b | REQ-1611 | assert | a channel that fails | the watcher ticks | exit stays 0 and the failure is in the log (report-cli.test) |
| AC-1612a | REQ-1612 | assert | `alertOn: ["stall"]` and a new lane.stall event | the poll runs | one alert reaches the stub (report.test) |
| AC-1612b | REQ-1612 | assert | the same event offset | the poll runs again | no alert is sent (report.test) |
| AC-1613a | REQ-1613 | assert | a reporter state file | `orch status` runs | one line starts `reporter: last sent` (orch-gaps.test) |
| AC-1613b | REQ-1613 | assert | `doctor --json` | doctor runs | the reporter row exists and is advisory (doctor.test) |
| AC-1613c | REQ-1613 | assert | the orchestrator skill | pack-prose.test runs | the skill names `features.reporter` beside board-watch (pack-prose.test) |
| AC-1614a | REQ-1614 | assert | a summary file 40 minutes old and intervalMinutes 30 | build runs | no SUMMARY section (report.test) |
| AC-1614b | REQ-1614 | assert | a summary file 5 minutes old | build runs | the SUMMARY (model) section exists and is labelled (report.test) |
| AC-1614c | REQ-1614 | assert | the experimental persona and FEATURES | extras-agents.test and experiments.test run | the persona installs with `--experimental` only and `reporterSummary` is experimental-off with a §22 entry (extras-agents.test, experiments.test) |
| AC-1615a | REQ-1615 | assert | fixtures with each secret shape in a reason | a tick runs | the file copy carries `[refused:` with the kind in place of the line and nothing is sent (report.test) |
| AC-1616a | REQ-1616 | assert | the docs | cli-commands.test, kit-location.test, invocation.test and genericity.test run | green (cli-commands.test, kit-location.test, invocation.test, genericity.test) |
| AC-1617a | REQ-1617 | assert | the suite on the Windows CI job | it runs | green (CI) |
| AC-1618a | REQ-1618 | assert | a live lease | a second watcher starts | it exits 0 naming the pid (report-cli.test) |
| AC-1618b | REQ-1618 | assert | a lease with a dead pid | a second watcher starts | it takes the lease over and ticks (report-cli.test) |
| AC-1701a | REQ-1701 | assert | EXPERIMENTS.md | experiments.test runs | §21 has a measurement row, a recorded tick log reference and a criterion (experiments.test) |
| AC-1701b | REQ-1701 | assert | the template comment | experiments.test runs | its figure equals the §21 figure (experiments.test) |
| AC-1702a | REQ-1702 | assert | EXPERIMENTS.md | experiments.test runs | §22 has the bytes row, the suppression ratio row and the summary criterion (experiments.test) |
| AC-1703a | REQ-1703 | assert | the docs | the prose tests run | green (pack-prose.test, genericity.test) |
| AC-1703b | REQ-1703 | assert | `doctor --json` for the three tools | doctor runs | both agent rows appear (doctor.test) |
| AC-1704a | REQ-1704 | assert | the release files | version.test and package.test run | green with version 2.1.0 (version.test, package.test) |

## API contract

No API contract — the module is a CLI and a library with no served HTTP interface; the webhook is an outbound client
call, not a served endpoint, so the contract oracle does not apply.

## Oracle amendments

| Oracle | Entry | Why | Decision |
|---|---|---|---|
| decision log | none | no catalogue entry is needed; every rule cites D70 to D85 in the plan's decision log | dropped — nothing pending |

## Open questions

| Id | Question | Blocks | Answer |
|---|---|---|---|
| Q-0 | none open; the plan's questions were answered on 17 November 2026 | — | George, 17 November 2026: every question took the recommended option (D70 to D85) under the mandate of 16 November 2026 |

## Amendments

A change to a ratified row is a new row here. The row above is never edited in place.

| Id | Date | Changes | Decision | By |
|---|---|---|---|---|
| A-0 | 2026-11-17 | Initial ratification; no change | D82 | George |
