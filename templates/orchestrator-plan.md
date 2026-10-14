# Orchestrator plan file — template

One plan per batch of work, handed to the batch orchestrator (`skills/orchestrator.md`).
`node scripts/orch.mjs split <plan.md> --out <lanes.json>` reads it. A plan written in any other shape — a board,
a bullet list, a page — goes through `node scripts/orch.mjs digest <artifact>` first, which writes this shape and
marks every cell it had to infer `⚠ CONFIRM`. Copy from the `---` line down. One row per deliverable.

**Header lines** (`key: value`, before `## Rows`):

| key | meaning |
|---|---|
| `plan:` | a short title |
| `run:` | run id: lowercase, digits and `-`, 2–41 chars (it names the lane branches `<branchPrefix><run>-l<n>` and worktrees) |
| `source:` | where the rows came from: tracker rows, change requests, a review's findings |

**Row columns** (all required except `source`, `level` and `confirm`):

| column | rule |
|---|---|
| `id` | unique in this plan (the tracker id when there is one) |
| `title` | one line |
| `source` | the requirement, ticket or finding the row answers |
| `kind` | `build` · `fix` · `rulings` · `record` |
| `files` | every file or glob the row touches, `;`-separated, repo-relative. Rows that share an owned file go in the same lane. Hot files (`features.orchestrator.hot`, the registry, the gate queue) never join lanes; the merge queue takes them one at a time |
| `depends-on` | row ids that must land first, `;`-separated, or `-`. A dependency puts both rows in one lane, in order |
| `flags` | any of `money` · `workflow` · `migration` · `platform` · `permission` · `cross-module` · `record-only`, or `-`. migration, platform, permission and cross-module are also inferred from `files` by the project's path rules (`riskPaths`, `modulePattern`) |
| `level` | optional hint. It can raise a row's level, never lower it. `Small` is ignored unless `smallEnabled` |
| `confirm` | written by `digest`: what it inferred. `split` refuses while any row still says `⚠ CONFIRM` |

**Level rule** (the reason is logged per row in lanes.json and the run state):

- **Full** — rows flagged or inferred money, workflow, migration, platform, permission or cross-module. Track FULL,
  or PLATFORM when the row touches a platform path. Dispatch: the full pipeline.
- **Micro** — record-only rows with no production-source file. Track SOLO. Dispatch: one agent, no pipeline.
- **Standard** — everything else. Track ADDITIVE; a `fix` row FIX; a `rulings` row with no production-source file
  RULINGS. Dispatch: `features.orchestrator.standardPipeline` — the full pipeline, or the lite split.
- A track is a floor: a lane may escalate mid-flight, never de-escalate (the playbook's track rules).

---

```markdown
# Plan: <title>
plan: <title>
run: <run-id>
source: <tracker rows / tickets / findings>

## Rows
| id | title | source | kind | files | depends-on | flags | level |
|---|---|---|---|---|---|---|---|
| T-1 | Orders: cancel verb | REQ-12 | build | src/modules/orders/**; tests/orders/**; CHANGELOG.md | - | workflow | |
| T-2 | Fix the currency label | BUG-7 | fix | src/modules/catalog/currency.ts | - | - | |
| T-3 | Board note for T-1 | — | record | tasks/orders.md | T-1 | record-only | |

## Notes
Anything the orchestrator should know that is not a row. Pointers only.
```
