---
name: persona-detect
description: Use to detect which personas a project involves — read the project, research its domain, run a census of product users, delivery roles and governance approvers, write the fenced persona library with a machine-readable roster, and hold it for human confirm before any persona becomes an agent. Also the refresh pass on a project that already has personas (adds and changes proposed, confirmed personas never overwritten). Trigger on "detect personas", "which personas does this project need", "who are the actors here", "refresh the personas", or as the last step of the builder setup.
---

# Persona detect — who is involved in this project, and who is not

Turn a project into a small, curated roster of actor profiles that agents can later be run as: to
take a decision inside a persona's lane, to review an artefact from that persona's interest, or to
pick up a task kind the persona routes. The work is **deciding who exists and refusing who does
not**, not writing prose. A roster that mirrors a role list one-for-one is a data dump; a roster
where any two profiles can disagree is a tool.

This skill is tool-neutral. "Search the web" means the running tool's own web search, if it has
one. "Ask the human" means the running tool's normal way of asking.

## The rule that makes this safe

> **A persona is a thinking tool. It is never evidence.**

Everything a persona-agent asserts about the project is worth nothing until it traces to a source.
Persona output is *opinions and questions* — both useful, neither a finding. Every claim in a
profile carries one marker:

| Marker | Meaning | Allowed in |
|---|---|---|
| **Traced** | lifted from a real record, real code, or the human's own interview answer — cited to file and section, or to the answer | anywhere |
| **Derived** | a reasonable reading of a real source that the source does not state; **every researched claim is Derived and carries its URL** | anywhere, marked |
| **Invented** | written from scratch, true of nobody | person, voice, backstory — **never** a decision owned, a threshold, a permission or a service level |

If a profile and a real record disagree, the record is right and the profile is stale: amend the
profile, never the record.

## Inputs

| Input | From | Used when |
|---|---|---|
| The repository | the working tree | always |
| Existing `personas/` | the working tree | present → **refresh mode** (Step 7) |
| An interview answer set | the setup step passes it in | the repository is thin (little or nothing to read) |
| Web search | the running tool | available and the human has not said offline |

The interview answer set is short, numbered, and in the human's own words:

| # | Question |
|---|---|
| Q1 | What does the product do, in one sentence? |
| Q2 | Who pays for it, and who uses it day to day? |
| Q3 | Who can do something in it that someone else cannot? |
| Q4 | Who approves, signs off, or can stop a release? |
| Q5 | Does it handle money, personal data, health data, or a named regulation? |
| Q6 | Who builds and runs it (disciplines, not names)? |

An answer is Traced to `interview Q<n>`. An unanswered question stays a gap — never fill it by
guessing. When the setup step passes no answer set and the repository is thin, ask these six and
nothing else.

## Step 1 — Fence it before you fill it

The library breaks the project's grounding rule on purpose, so it is isolated on purpose. Put all
four isolations in place **before writing any profile**:

| Isolation | Mechanism |
|---|---|
| **Git** | `personas/.gitignore` containing `*` by default — nothing tracked. A team that wants the roster shared may track it instead; that is the human's call at confirm, written into `WHY.md` |
| **Gates / CI** | add `personas` to every walker's skip list (claims, citations, link checks) — never walked, not walkable behind a flag |
| **Index** | named in no README, manifest, register or table of contents |
| **Attention** | the standing rule in `WHY.md` and a banner on every profile |

Copy `WHY.md`, `USAGE.md`, `INDEX.md`, `_census.md` and `_TEMPLATE.md` from
`builder/templates/personas/` into `personas/` and fill every `<…>` placeholder. Write them from the
templates, never from scratch — an improvised `WHY.md` reliably drops one isolation.

## Step 2 — Read the project

Detect the shape first; it sets the evidence quality and the depth ceiling.

| Shape | Detect by | Evidence quality |
|---|---|---|
| **A — governed docs** | a requirements document, an architecture document, numbered decision records | highest: roles, stakeholders and sign-offs are *stated* |
| **B — code repository** | a source tree, no decision records | good for authority, poor for intent: code says who *can* act, never who they *are* |
| **C — thin** | a README, a brief, or nothing | weak: use the interview answer set |

Read, in this order, read-only, stating the scope of each search with its result (a bare count
reads as exhaustive):

1. `README*`, `docs/`, any requirements, architecture or decision records — stakeholders, sign-off
   seats, who builds it.
2. The authorization model: role enums, permission checks, guards, a permission catalogue.
3. Ownership and scoped relations: "my data" endpoints, owner comparisons, membership tables.
4. The unauthenticated surface: public routes, sign-up, landing pages.
5. Regulated surfaces: payments, refunds, personal data, erasure, retention, consent.
6. Who owns what: code-owner files, top-level directories, CI and deploy config.
7. Domain terms: the nouns the code and docs repeat — the vocabulary each persona must speak.
8. Existing `personas/` — read `INDEX.md` and every confirmed profile before proposing anything.

Where code and records disagree: **code wins on behaviour, records win on intent** — note the
discrepancy rather than silently picking one. Record every finding with its source in
`_census.md` as you go; a finding you cannot cite becomes Invented later.

## Step 3 — Research the domain

Projects in a domain share actors the repository may not name yet: a regulator, an auditor, a
field operator, an accessibility user. Research closes that gap — and is the easiest place to
import fiction, so it is held tightest.

- **Web search available:** search for the domain's actors, approval chains, regulations and
  common failure points (two to five searches; name the queries in `_census.md`).
- **Offline, or the human said no:** skip this step and write `research: offline — repository only`
  in `_census.md`. Never fill the gap from memory and call it research.

Every researched claim is **Derived** and carries its URL in the profile's grounding table. A
researched actor with no foothold in the repository or the interview is a **candidate**, never an
admission — it goes to the census with "research only" as its evidence, and the human decides.

## Step 4 — Census: who earns a profile

Two admission tests. A candidate must pass **both**:

1. **Distinguishable interest** — it wants something no other candidate wants.
2. **Distinguishable authority** — there is something it can do, decide, or block that another
   candidate cannot.

> If two candidates cannot be put in a room to disagree, they are one profile.

**Product — actors who use the system.** One profile per *authority boundary*, not per label:
two roles with identical permissions are one profile with two names. Add a guest actor when an
unauthenticated surface exists, an ownership actor when ownership checks exist (usually the
privacy actor, and nearly always missed), a scoped-relation actor when membership grants
authority, a privileged operator when there is an actor the audit log exists to watch.

**Delivery — actors who build it.** A discipline earns a seat only when the repository has a
surface it owns: back-end (services), front-end (a UI), data (migrations, a schema), QA (a test
or gate suite), platform (CI, containers, deploy config), design (tokens, a stated accessibility
or localisation requirement), analysis (a spec set someone must keep unambiguous), security
(authorization plus a real exposure), AI/ML (model, prompt or eval code), SRE (alerting,
runbooks). No surface, no seat. **A seat is not a body** — an agent playing QA does not
discharge the QA effort in any plan; a planned-but-unfilled seat carries a banner saying so.

**Governance — actors who judge it.** Interest holders with a veto: the owner (always at least
one — someone bears cost and liability), the operator who runs it day to day, compliance or data
protection when regulated data exists, an external partner with a contractual interest, a
documentation maintainer when a governed docs workspace exists.

**Collapse and refuse.** Several names that are one human in reality → one profile that documents
the collapse. One actor seen through two lenses (a role and a stakeholder) → one file, the second
lens folded in as a section. A candidate that exists only in a rejected or superseded record, or
only in research → **refused**, with the reason.

The **Refused** list is the most valuable part of `_census.md`. Without it the next session
re-proposes everything you deliberately left out.

**Depth follows the evidence, never ambition:** Shape C → 3–6 profiles, mostly Invented, said so;
Shape B → 8–14; Shape A → up to ~25. Past ~25 nobody holds the roster in mind — merge the
weakest-differentiated pairs and record the merge. Declare the depth and its reason at the top of
`_census.md`.

## Step 5 — Write the library

```
personas/
├── .gitignore        *  (unless the human chose to track it)
├── WHY.md            the isolations and the grounding policy
├── USAGE.md          how a confirmed profile becomes an agent
├── INDEX.md          the roster: tables per set, the collisions table, the roster block
├── _TEMPLATE.md      the profile shape
├── _census.md        evidence, research log, Proposed / Refused / Collapsed / Unverified
├── product/<id>.md
├── delivery/<id>.md
└── governance/<id>.md
```

One file per persona from `_TEMPLATE.md`. Every heading is required — write `n/a` rather than
delete one. Each profile names: **role and mandate** (one sentence; two means two actors),
**goals**, **decisions owned** (Traced or Derived only), **expertise**, **what they do NOT know**
(fill this first — it is the strongest control in the file), **when to consult**, **routing
hints** (the task kinds the persona takes or rules on, which become the roster's `routes`), the
**agent seed** (second person, under 400 words, carrying the grounding rule), and the **grounding
table** with honest counts. Invent the person, never the project.

### The roster block

`INDEX.md` carries exactly one fenced `json` block — the machine-readable roster the lead reads to
render confirmed personas into agents. The human tables around it are for people; the block is for
tools, and `node scripts/personas-check.mjs` holds the two together.

```json
{
  "personas": [
    {
      "id": "end-user",
      "name": "End user",
      "set": "product",
      "confirmed": false,
      "routes": ["journey-review", "acceptance-walkthrough"],
      "file": "product/end-user.md",
      "render": false,
      "tier": "mid"
    }
  ]
}
```

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | lower-case slug, unique; the agent name becomes `persona-<id>` |
| `name` | yes | display name |
| `set` | yes | `product` · `delivery` · `governance` |
| `confirmed` | yes | `true` only after the human confirmed this persona (Step 6) |
| `routes` | yes | task kinds the persona takes or rules on (lower-case slugs) — the lead's routing table |
| `file` | no | profile path relative to `personas/`; default `<set>/<id>.md` |
| `render` | no | `true` asks the lead to render this persona as an agent; only a confirmed persona may carry it |
| `tier` | no | `strong` · `mid` · `low`; default `mid` |

A new detection writes every entry with `"confirmed": false` and `"render": false`.

## Step 6 — Human confirm (the gate)

**Nothing becomes an agent before the human confirms it.** Present the roster in one pass:

| # | Persona | Set | Interest | Authority / decisions owned | Routes | Evidence | Collides with |
|---|---|---|---|---|---|---|---|

plus, in the same pass: **Refused** (with reasons), **Collapsed** (which names merged, and the
source), **Research only** (candidates with no repository foothold), **Unverified** (every place a
Derived or Invented claim sits in a decision owned, so the human can supply the fact instead), and
the depth declared.

The human answers per persona: confirm, amend, refuse. Then, and only then, set `"confirmed": true`
on the confirmed entries, move refused ones to the Refused list, and ask which confirmed personas
to render now (`"render": true`). Silence is not a confirm. A persona the human did not name stays
`"confirmed": false`. Run `node scripts/personas-check.mjs` — exit 0 before you report.

## Step 7 — Refresh mode (an existing `personas/`)

When `personas/INDEX.md` already exists, this run **proposes additions and changes only**:

1. Parse the existing roster first. Every `"confirmed": true` entry and its profile file are
   **never overwritten** — not rewritten, renamed, re-routed or deleted by this skill.
2. Run Steps 2–4 again and diff the result against the existing roster:
   - a new candidate → a proposed **addition** (`"confirmed": false`);
   - new evidence about a confirmed persona → a proposed **change**, written as a diff in
     `_census.md` under "Proposed changes to confirmed personas", for the human to apply or decline;
   - an unconfirmed existing entry may be replaced by the new proposal.
3. Present only the additions and changes at the confirm gate. Applying a change to a confirmed
   persona needs its own yes, per persona.

`mergeProposal` in `builder/scripts/lib/personas.cjs` implements this rule (confirmed entries kept
verbatim, their proposed changes returned separately) — use it rather than editing the block by
hand.

## Step 8 — Verify

| Check | How | Fail means |
|---|---|---|
| The roster holds | `node scripts/personas-check.mjs` exits 0 | duplicate ids, a missing field, a missing profile, or an unconfirmed persona marked to render |
| Every Traced row resolves | open each cited file and section | the citation is decoration — downgrade to Derived or delete |
| Every researched claim has a URL | grep the grounding tables for Derived rows from research | research became memory |
| The fence holds | `git status --porcelain personas/` is empty (untracked mode); the walkers yield no path under it | the isolation is theoretical |
| A profile disagrees | give it something wrong for its interest | traits too weak, or the seed too polite |
| A profile says "I don't know" | ask what no source answers | **the most common failure** — strengthen "does not know" |

Never merge two profiles into one prompt: a prompt asked to be both the engineer and the QA
engineer approves its own work.

## From confirmed persona to agent

`node scripts/personas-check.mjs --render <dir>` writes one neutral agent file per entry that is
both `"confirmed": true` and `"render": true` (`name: persona-<id>`, a "use when" description built
from the routes, `capabilities: read-only`, the entry's tier, the agent seed as the body). It
refuses while any roster problem stands. The tool's adapter installs those files the way it
installs the kit's own seats; `USAGE.md` records every promotion. A persona agent is read-only by
default — a persona that can write will eventually edit the project to agree with itself. The
lead routes a task to a persona by matching the task kind against `routes`; the persona's answer
is an opinion or a question to take to a real source, never a ruling.

## Report

The confirmed / proposed / refused counts, the depth and its reason, whether research ran (with
the queries) or was offline, the personas-check exit code, and the list of personas rendered (or
"none — awaiting confirm").
