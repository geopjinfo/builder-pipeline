# Spec — <module key>: <title, as a person would say the flow>

Module: <module key>
Status: draft
Ratified-by: —

> One spec per module, authored before Phase 1 by the `spec-author` skill and ratified by a person. It is
> the requirements oracle for this module (profile §3): the planner, the tester's requirement pack and the
> reviewer's alignment audit read these rows **verbatim**. Check it with `npx builder-pipeline run spec-check <module key>`
> (folder layout: `node scripts/spec-check.mjs <module key>`); the pipeline refuses a draft. Keep every table
> header exactly as written — the checker reads them.

## Intent

> "<the ask in the words it was given — a quote, not a paraphrase; cite where it came from>"

## Scope

- In: <what this module owns>
- Out: <what it knowingly does not do — each with its deferred-registry row>

## Actors

| Actor | Source |
|---|---|
| <who acts, in the business's words> | <intent / persona catalogue entry> |

## Requirements

Kind: `behaviour` (what succeeds) · `refusal` (what is refused, and why) · `effect` (what a success leaves behind:
audit, event, version) · `constraint` (always true; the only kind no operation needs to reach). Source: `intent`, a
decision id, or an open-question id. At least one `refusal` — a spec that only says what succeeds proves routing.

| Id | Requirement | Actor | Kind | Source |
|---|---|---|---|---|
| <REQ-001> | <one sentence a non-engineer can judge> | <actor> | <kind> | intent |

## Acceptance criteria

Every requirement has at least one row. Verb: `assert` (holds as written) · `by-design` (the intended behaviour
diverges from the text and a decision says so — cite it in Then) · `gap` (knowingly unenforced — cite the
deferred-registry row in Then). `skipped` is a run outcome, never a spec verb. Then names the exact status and
code, or the exact effect — "refused" and "refused with the wrong code" are different facts.

| Id | Req | Verb | Given | When | Then |
|---|---|---|---|---|---|
| <AC-001> | <REQ-001> | <verb> | <precondition> | <the action> | <exact status, code or effect> |

## API contract

One OpenAPI 3 document in the block below — the file `features.contractOracle.spec` points at once the run starts
(`spec-check --contract <out.json>` writes it). Every operation lists the requirement ids it serves in `x-req` and
declares at least one 4xx. A module with no served interface writes the line `No API contract — <reason>` instead.

```json api-contract
{
  "openapi": "3.0.3",
  "info": { "title": "<module key>", "version": "0.1.0" },
  "paths": {}
}
```

## Oracle amendments

A key, code or state this spec needs that no oracle (profile §3) holds. Never invent it in the rows above: list it
here, and the Decision column stays `pending` until a person rules — `accepted <decision id>` or `dropped — <reason>`.
A pending amendment blocks ratification.

| Oracle | Entry | Why | Decision |
|---|---|---|---|
| <oracle> | <exact entry> | <which requirement needs it> | pending |

## Open questions

What the intent does not settle. Each question names the rows it blocks; an unanswered one blocks ratification.
Answers name who answered and when.

| Id | Question | Blocks | Answer |
|---|---|---|---|
| <Q-1> | <the question> | <REQ ids> | |
