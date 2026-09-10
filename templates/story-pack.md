# Template — story pack (adversarial scenarios)

Copy to wherever your scenarios live (`scenarios/stories/<module>.stories.pack.<ext>` is the shape
proven in production). One per module, authored from that module's **OPEN invariant candidates**.

## A story is not a requirement pack

| | requirement pack | story |
|---|---|---|
| Asks | *"does the system do what the requirement said?"* | *"what happens when something unusual but entirely possible occurs?"* |
| Oracle | the requirement text | none — **that is the point** |
| Origin | a tracker row | a digest's OPEN invariant candidate |
| When no rule exists | it would not exist | it **records** the observation |

A story exists precisely because nobody wrote the case down. So it must never invent the rule it is
missing: assert the part that is genuinely universal (it did not crash; the refusal is shaped), and
**record** the rest.

## The taxonomy — the completeness guard

Authoring against a fixed axis list makes this a sweep rather than inspiration. Cover each axis, or
say why it does not apply to the module.

| axis | ask |
|---|---|
| **wrong-actor** | right time, wrong person — mid-flow, not just the permission-grid cell |
| **wrong-time** | right person, wrong state — approve after reject, pay a cancelled request, resubmit a closed item |
| **reflexive** | caller == target, or caller's own resource |
| **lifecycle** | act on a deactivated/soft-deleted thing; a live token after its subject dies; case/whitespace variants of a unique field |
| **interleaving** | two actors, one aggregate — the concurrency-guard duel; a decision arriving after the thing moved on |
| **cross-module** | remove something a neighbour still references by key with no foreign key — what happens to the dangling side? |
| **identity-abuse** | ids swapped between modules; a well-formed identifier that belongs to nothing |

## Rules

- **Ban assert-by-absence-of-success** (`!is2xx` and equivalents) in this directory, and enforce it
  with a lint. That idiom is exactly how a duplicate-field `500` passed every gate: `!is2xx(500)` is
  true. Assert an **exact status and code**, or record.
- **Every story names its candidate id**, so it traces back to the reasoning that produced it and
  the digest can learn the candidate is now covered.
- **Give negative assertions a positive control.** Proving "authority is gone after X" requires
  first proving the authority was *there*. A story that grants nothing and then observes nothing has
  proved nothing — this exact mistake shipped once and looked like a pass.
- **Notes must not contradict their own result.** If your step helper attaches its note
  unconditionally, a passing step will print its failure text and a reader will believe the failure.
  Use a helper that shows the note only on failure, and a separate one for observations.
- **Record, don't rule.** Where the correct behaviour is undecided, use the observation verb and
  state what happened, with the pending decision cited.

## Skeleton

```
/**
 * <MODULE> stories — adversarial scenarios derived from the OPEN invariant candidates in
 * <digest path>.
 *
 * Shape assertions only: <banned idiom> does not appear in this file. A refusal is asserted by its
 * exact status and code; where the correct behaviour is genuinely undecided the step RECORDS.
 */

// <MOD>-IC-<n> — <axis>: <one line on why this might not hold>
story('<module>-story-<slug>', async (ctx) => {
  // CONTROL — prove the precondition is real, or nothing below distinguishes
  // "revoked" from "never granted".
  assertExact('<the control>', control.status, 200);

  // THE UNIVERSAL PART — always assertable, whatever the business rule turns out to be.
  assertExact('<the action> returns a decision, not a server error', result.status < 500);

  // THE UNDECIDED PART — recorded, never asserted.
  record('<MOD>-IC-<n>', '<what is undecided>', describe(result));
});
```

## Where stories come from

`digest OPEN candidates → stories → flip candidate to covered (naming the story)`

That loop is the point: the digest's OPEN list is the backlog, and a story is how an entry leaves
it. Covering a candidate without updating `coveredBy` breaks the loop and the worklist silently
lies.
