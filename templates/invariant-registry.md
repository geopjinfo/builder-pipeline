# Template — invariant registry (reflexive + system-safety)

The expectations **no declaration implies**. Copy to wherever your audit reads it from
(`invariants.json` is the shape proven in production).

## Why this file exists

Every other layer derives its scenarios from something declared: a requirement row, a permission
matrix, a state machine, an effect inventory. So none of them can produce *"an administrator must
not deactivate their own account"* — because no declaration mentions the case at all. It was found
by a human clicking around, and it had survived every automated gate.

This registry is where those cases live, and where the discipline that keeps them honest is
enforced.

## The discipline: the auditor observes, it never rules

Each entry carries a **disposition**:

| disposition | meaning | what the run does |
|---|---|---|
| `ruled` | a ratified source says what must happen | **asserts** it, like any requirement |
| `unruled` | nothing says | **records** the observed behaviour as `NEEDS-RULING`, and emits a ruling request for a human |

Manufacturing an expectation for an `unruled` case would make the audit the author of the
requirement it is auditing, and no later reader could tell a ratified rule from a test-writer's
opinion. The cost is that a genuine hazard can sit as `NEEDS-RULING` for a while. That is the right
trade: it is **visible** either way, and the report never launders an opinion into a rule.

Watch for a rule that exists but does not bind. One real example: the requirement said *"a user
cannot deactivate their own account"* — but it sat in the customer-portal section and was phrased
as *"no action shown for the current user"*, i.e. a **UI-visibility** rule. No ratified source
obliged the API to refuse, which is precisely why no guard was ever written. A UI-only rule is not
an enforcement; record it as precedent, not as a citation.

## Template

```json
{
  "version": 1,
  "purpose": "Reflexive and system-safety invariants — the checks no declaration implies.",
  "discipline": "unruled entries are OBSERVED and reported NEEDS-RULING, never asserted.",
  "invariants": [
    {
      "id": "SELF-01",
      "module": "<module>",
      "title": "<An actor performs <verb> on their OWN <thing>>",
      "call": "<METHOD /path/{self}/verb>",
      "disposition": "unruled",
      "expect": null,
      "citation": null,
      "precedent": [
        "<cited text that is ADJACENT but does not bind — say why it does not>"
      ],
      "why_unruled": "<what no ratified source states, and the code line that shows no guard exists>",
      "recommendation": "<what backend thinks should happen, and why>",
      "question": "<the single question a human must answer>"
    },
    {
      "id": "SYS-01",
      "module": "<module>",
      "title": "<The LAST <thing> that cannot be recreated is removed>",
      "disposition": "ruled",
      "expect": { "outcome": "refuse", "status": 422, "code": "<house code>" },
      "citation": "<the ADR/ruling that decided it>",
      "precedent": [],
      "why_unruled": null,
      "recommendation": null,
      "question": null
    }
  ]
}
```

## Cases worth seeding in any system

| id | shape | why it bites |
|---|---|---|
| `SELF-*` | actor deactivates / deletes / demotes **themself** | permission held, target exists, transition legal — a correct `200` by every declared measure |
| `SYS-*` | the **last** admin / approver / routing rule is removed | often terminal: the capability needed to undo it is the one just removed |
| lifecycle | a live token after its subject is deleted | revocation is usually declared and rarely observed |
| irreversible | the strongest verb aimed at the caller's own row | hard delete cascades the credential — no recovery path at all |

## Two failure modes that will bite you

1. **The phantom guard.** A refusal that looks exactly like the protection you are testing for, but
   came from somewhere else — an unrelated gate (a "must change password" interstitial), or your own
   malformed request. Both happened here. Defences: give every case a **positive control** (the
   actor completes an ordinary action first), and treat a validation error naming a field the probe
   never sent as **inconclusive**, never as evidence.
2. **Damaging a shared fixture.** Self-destruction tests destroy the actor. Mint a **disposable
   actor per case** rather than self-targeting a seeded persona — otherwise the account that holds
   the only recovery permission destroys itself and every later scenario fails for unrelated
   reasons.

## The ruling request

Generate it from the registry plus the run's observations, so it quotes what the system actually
did. Its required parts: a summary table answerable on its own · evidence marked by how it was
verified (observed / code / ratified) · a recommendation per item · what each possible verdict
triggers · and, per item, whether a response is **blocking**. An item with no response-required line
is a message nobody is obliged to answer.
