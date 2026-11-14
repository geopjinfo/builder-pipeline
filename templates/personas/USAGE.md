# Using a persona

> `personas/` is outside the documentation set. Fiction written to be prompted with, not evidence.
> See `WHY.md`.

A profile is source material for a prompt, not the prompt itself. The **Agent seed** block is the
only part an agent ever receives; the persona, traits and grounding sections are for the human
maintaining the file.

## The gate

Only a persona whose roster entry in `INDEX.md` says `"confirmed": true` may be run as an agent.
A persona is rendered only when its entry also says `"render": true`. Both flags are set by the
human at the confirm gate, never by an agent.

## Three routes

| Route | Use when | How | Promote after |
|---|---|---|---|
| **Inline** | one-off — "read `<file>` and answer as this actor" | paste the agent seed into a fresh sub-agent prompt | second use |
| **Rendered agent** | the persona takes a task kind repeatedly | `node scripts/personas-check.mjs --render <dir>`, then install the files with the tool's adapter | — |
| **Skill** | the persona *is* a procedure — a review, a checklist, a sign-off | a skill whose body is the seed plus the procedure | — |

Start inline. Most profiles never need promoting, and an agent file that exists but is never
invoked is a maintenance cost with no return.

## Routing

The lead matches a task's kind against each confirmed persona's `routes`. A match means "consult
this persona" — to draft an opinion, to review, or to say what it would block. The answer is an
opinion or a question to take to a real source. A persona never closes a decision a real record or
a real person owns.

## Tool policy

The default is read-only. A persona that can write will eventually edit the project to agree with
itself.

| Set | Grant | Never grant | Why |
|---|---|---|---|
| **Product** | read-only | file edits, state-changing commands | it walks a journey and complains; it does not change files |
| **Delivery** | read-only — plus edits only for `<the surface that seat owns>`, recorded below | edits outside its own surface | a seat that edits another seat's surface is the collapse the census prevents |
| **Governance** | read-only | file edits | a veto is an opinion returned to the owner, not an edit |

Record every grant wider than read-only in the log at the bottom of this file, with the reason.

## Pairings that produce friction

| Pair | Run on | Looks for |
|---|---|---|
| analyst → QA | a spec | error cases stated but untestable |
| engineer → documentation maintainer | an implementation | "where is your citation?" |
| designer → end user on a bad connection | a screen | what the happy path assumed |
| customer → owner | a feature | "what does that cost me per month?" |
| `<add your own from the collisions table in INDEX.md>` | | |

**Never merge two profiles into one prompt.** A prompt asked to be both the engineer and the QA
engineer approves its own work.

## Reading the output

| Output | Treat as |
|---|---|
| an objection | a question to take to a real source |
| a question | the useful half — usually points at a genuine gap |
| a fact, number, threshold or date | **unverified** until traced. The seed forbids it; agents do it anyway |
| agreement with everything | a failed profile. Back to the census admission tests |

## Promotion log

| Persona id | Route | Path | Capabilities | Wider than read-only because | Confirmed by | Date |
|---|---|---|---|---|---|---|
| | | | | | | |
