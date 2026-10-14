# Plan: orchestrator sample (FAKE rows — never run)
plan: orchestrator sample
run: sample-1
source: fake rows for tests/orch-plan.test.mjs

## Rows
| id | title | source | kind | files | depends-on | flags | level |
|---|---|---|---|---|---|---|---|
| R1 | Payments: refund verb | FAKE-1 | build | src/modules/payments/**; CHANGELOG.md; contracts/openapi.json | - | money | |
| R2 | Payments: refund report | FAKE-2 | build | src/modules/payments/reports/refunds.ts | R1 | - | |
| R3 | Projects: archive verb | FAKE-3 | build | src/modules/projects/**; db/migrations/** | - | workflow | |
| R4 | Projects: archive scenario | FAKE-4 | build | test/e2e/projects.archive.yaml | R3 | - | |
| R5 | Currency label fix | FAKE-5 | fix | src/modules/currencies/currency.mapper.ts; CHANGELOG.md | - | - | |
| R6 | Ledger note | FAKE-6 | record | tasks/n6.md | - | record-only | |
| R7 | Record-only claim that touches src | FAKE-7 | record | src/modules/inbox/inbox.module.ts | - | record-only | |
| R8 | New permission key wiring | FAKE-8 | build | config/permissions.csv; src/modules/inbox/inbox.controller.ts | - | - | |
| R9 | Small hint while Small is off | FAKE-9 | fix | src/modules/stakeholders/stakeholder.mapper.ts | - | - | small |
| R10 | Cross-module seam | FAKE-10 | build | src/modules/inbox/inbox.facade.ts; src/modules/approvals/approvals.facade.ts | - | - | |
