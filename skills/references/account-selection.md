# Account selection — the rulebook for the orchestrator

This file says which account a job goes to. The orchestrator reads it before every placement. The fixed parts of
the rule run inside `orch next`, `orch claim` and `orch gate-launch` (the placement rule inside `orch`).
The judgement parts are yours. The registry is `features.accounts` in §16 of
`PIPELINE_PROFILE.md`; one entry is one account. Every key below is a key of that registry.

## 1. Terms

- **Account** — one entry of `features.accounts.accounts`. Its `worker` is `claude-code`, `codex` or `session`
  (the orchestrating session itself). Its `pays` is `subscription`, `gateway`, `free` or `api-key`.
- **Ready** — the readiness assessment says `ready`. `not ready` carries a reason. `unmeasured` is not ready by
  default and is never a pass.
- **Hold** — a `LIMIT`, `BUDGET` or `AUTH` state with an `until` time. The account is not ready until then.
- **Content class** — the `content` key: `public`, `scratch`, `any`, or a list of path roots.
- **Needs-account** — a brief whose `Account:` line names one account. The job may run only there.
- **Headless roles** — the roles a worker runs with no person present: module-tester, module-reviewer,
  standards-auditor, invariant-auditor, security-auditor, vuln-auditor and docs-maintainer. The other roles
  (orchestrator, module-planner, module-builder) stay on a session or a terminal worker.

## 2. Ready only

1. Run `orch status`. Read the account lines. Each line shows the state, the reading and its time.
2. Place a lane only on an account that reads `ready`. The kit refuses the other states; do not argue with it.
3. An account whose reading is older than `features.accounts.usageStaleMinutes` is unmeasured. Only the first
   account in order may launch unmeasured. Measure the others first (`orch usage-read <run>`).
4. The `note` of an account is a rule, not a comment. Obey it as you obey this file. Example: `note: "pay-as-you-go
   overflow — do not use above the soft limit"` means that account takes needs-account work only.
5. An account with a `smokeCommand` proves it can write before its first launch in a run. A failed smoke makes it
   not ready. Fix the account; do not move the work around the failure in silence.

## 3. Classify the content first

The project states its visibility in §1 of `PIPELINE_PROFILE.md`: `private` (the default) or `public`. Before you
place a lane, read the class of each account against that fact.

| The account's `content` | A private project | A public project |
|---|---|---|
| `public` | refused (the kit names the class and the account) | allowed |
| `scratch` | refused: scratch accounts see no project source | refused |
| `any` | allowed | allowed |
| a list of path roots | allowed only for a lane whose claimed files lie inside the roots; the worker runs in a sparse worktree with deny rules | the same |

A path-root account on a worker whose adapter cannot write deny rules is refused. A refusal names the path, never
the file text. When the kit refuses, re-split the lane or pick another account. Do not widen the roots to make a
launch pass.

## 4. Match the role to the account's roles

- An account with an empty `roles` list takes any role. An account with a list takes only those roles.
- A lane needs the module-builder role. A pipeline lane also needs the planner, tester, reviewer and auditor roles
  inside its own session; the lane's account must allow module-builder, and the brief says the rest.
- A headless job (a credit job, a P4 auditor, a tester) needs only its own role. An account limited to the headless
  roles can take it; a lane cannot go there.
- Building, planning, reviewing another person's work and orchestrating never go to a `free` account on a shared
  host. A `free` account may take headless, read-only roles on public content.

## 5. The task-to-account table

| The job | First choice | Then | Never |
|---|---|---|---|
| a full or lite pipeline lane | a ready `subscription` account with worker `claude-code` or `codex` whose roles allow module-builder | a ready `gateway` account | a `session` account through the terminal launcher |
| a SOLO lane (record-only) | the `session` account, as a sub-agent | a ready terminal worker account | an `api-key` account |
| a P4 auditor or a P3 tester | a ready account limited to the headless roles | the lane's own account (the worker runs its owed seats itself: `SELF-AUDIT`) | the orchestrating session |
| a second opinion on P4 findings | an account of another `family` than the writer's, at or above the writer's tier, when one exists | none: say that no second family is configured | a `scratch` account |
| a code-reading or docs credit job | a ready `gateway` or `free` account with the role | an `api-key` account, announced | a `session` account |

Spread parallel lanes over accounts. Two lanes on one account share its turn budget and its rate limit; one `LIMIT`
then stops both. Place the second lane on the next ready account before you place it on the same one.

## 6. Budget: the soft limit and the hard cap

- `budget.hard` is a cap. At or above it the account is not ready. The placement line names the cap.
- `budget.soft` (else `features.accounts.softLimitPct`) is a soft limit. At or above it the account takes only
  needs-account work. A plain job reads `NEEDS-IT-ONLY` for that account in the `next` output.
- Mark a job needs-account only when the work can run nowhere else: a resume of a lane that already ran there, a
  lane whose claimed files lie only inside that account's path roots, or a note that pins the work. Write the
  account name on the brief's `Account:` line. The kit places the lane there and says why.
- A raised `hard` or `soft` value in §16 needs a decision-log line that carries the account, the field, the old
  value and the new value. Without it `gate-launch` refuses and names the entry it expects.
- `orch status` and the board row show `budget warn USED of CAP` at or above the soft limit. Read it as a warning,
  not as a refusal.

## 7. The pays order

Place on `subscription` first, then `gateway`, then `free`. `api-key` accounts come last, whatever their position in
the registry. A launch on an `api-key` account is announced twice: the kit writes an `account.paid` event and a
decision-log row. Say it in your status line as well: "lane l3 ran on charlie (api-key)". A plan account that
overflows into pay-as-you-go is an `api-key` account for this rule; its `note` says so.

## 8. Holds: LIMIT, BUDGET, AUTH and OVERLOAD

- `LIMIT` (a 429 with a reset time), `BUDGET` (a budget code or a `resetsAt`) and `AUTH` (an expired or refused
  credential) mark the account not ready until the `until` time. `orch status` shows the kind and the time.
- The kit retries a held job once, on the next ready account its roles and content class allow, and says so once in
  the status line. After that the job is yours. One retry, never a retry loop: do not relaunch the same job on the
  same held account before `until`.
- `OVERLOAD` (a 529, a 503, an overloaded body) is not an account state. The kit retries the same prompt on the
  same account with a backoff, at most `features.accounts.overloadRetries` times, then reports `FAILED-OVERLOAD`.
  The account stays ready.
- An `AUTH` hold says what to run (for example `claude auth login` under the account's config dir). Run it; do not
  move a lane to another account to avoid a sign-in.

## 9. Resume, drafts and the record

- Never resume a lane on another account. A session lives in one account's store; a resume elsewhere starts a copy
  with no memory of the work. A lane that must move starts again from its branch, with a new brief.
- A worker's answer is a draft until its result file is read and its diff is reviewed. Treat the `RESULT:` line
  as the worker's claim, not as the kit's verdict.
- Say which account did what. The brief's `Account:` line, the `account.paid` event, the lane row in `orch status`
  and your own status line carry the account name. A merge record names the account that produced the lane.

## 10. Shadow mode

With `features.accounts.placement: shadow` the kit computes the account this rulebook would choose, writes a
`placement.shadow` event with that account and its reason, and then places the 1.0 way: the first ready account by
order. Use shadow mode to measure the rule on a project before you turn it on. Read the events; compare the chosen
account with the placed one; turn `placement` to `on` when the chosen account is the one you would have picked.

## 11. Never

- Never start a worker in a permission-bypass mode. No account, note or deadline allows a bypass flag.
- Never place a lane on an account whose worker runs without the repo's own hooks (the Claude Code `--bare` form, a
  harness with no hook support on a lane that needs the guards). A worker without hooks has no fence.
- Never print, log, copy or quote a key or a token. The account's folder and the harness's own store hold them.
  A `--settings` pin carries the account's env block and its config dir, never a key.
- Never write a project fact into an account entry. An account carries how it pays and what it may see; the
  project carries what is private.

## 12. What the kit enforces and what you judge

| The kit refuses or does on its own | You judge |
|---|---|
| a not-ready account, a hard cap, a stale reading, a missing `maxTurns` or `timeoutMinutes` | which ready account a job fits best (the table in §5) |
| a `public` or `scratch` account on a private project; a claimed file outside the roots | whether a lane should be re-split for a path-root account |
| `api-key` last; `account.paid` and the decision-log row | whether to wait for a plan account instead of paying |
| the one retry after a hold; the OVERLOAD backoff | whether a stalled lane goes to another account or waits |
| the `--settings` pin; the settings scan; the fresh branch per lane worktree | the brief: pointers, the done-test, the `Account:` line |
