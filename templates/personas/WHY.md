# Why `personas/` exists — and why it is fenced

> Fiction written to be prompted with, not evidence. Nothing in this folder is a source, a
> decision, or a record of one.

| | |
|---|---|
| **Created** | `<date>` |
| **Owner** | `<who this folder answers to>` |
| **Sanctioned by** | `<record id · ticket · "verbal — name, date">` |
| **Depth** | `<sketch / working / full>` — justified in `_census.md` |
| **Profiles** | `<n>` product · `<n>` delivery · `<n>` governance |
| **Tracked in git** | `<no — personas/.gitignore holds * / yes — chosen by <who> on <date>>` |
| **Review** | `<date or trigger — when the roster is next re-tested>` |

## What this is

`<n>` actor profiles across three sets, each written so an agent can be run as that actor — to
review an artefact from its interest, to give an opinion inside its lane, or to pick up a task kind
it routes. They exist to produce **friction**: two profiles with genuinely different interests find
gaps that one reviewer reading alone does not.

## What this is not

- **Not a specification.** It settles nothing and changes no requirement.
- **Not a description of real people.** Every name, history and device here is invented. Any
  resemblance to `<the actual team / actual users>` is a bug.
- **Not a staffing plan.** A seat is not a body. An agent playing `<seat>` does not discharge the
  `<seat>` effort in `<the plan>`.
- **Not citable.** See the standing rule below.

## Grounding policy

> A persona is a thinking tool. It is never evidence.

| Marker | Meaning | Allowed in |
|---|---|---|
| **Traced** | lifted from a real record, real code or the owner's interview answer, cited to file and section or to the answer | anywhere |
| **Derived** | a reasonable reading of a real source that the source does not state; every researched claim is Derived and carries its URL | anywhere, marked |
| **Invented** | written from scratch, true of nobody | person, voice, backstory — **never** a decision owned, threshold, permission or service level |

Persona output is opinions and questions. Both are useful; neither is a finding until it traces to
a source. **If a profile and a real record disagree, the record is right and the profile is
stale** — amend the profile, never the record.

## The four isolations

| Isolation | Mechanism here | Verify with |
|---|---|---|
| **Git** | `<personas/.gitignore containing * — nothing tracked, including the ignore file / tracked by the owner's choice above>` | `<git status --porcelain personas/ is empty / n/a>` |
| **Gates / CI** | `personas` is in `<the walker / linter / CI job>`'s skip list at `<path>` — never walked, not walkable behind a flag | `<command>` yields no path under `personas/` |
| **Index** | named in no README, manifest, register or table of contents | `<search command>` returns hits only inside this folder |
| **Attention** | the standing rule below, plus the banner on every profile | a profile opened outside the exceptions is a breach |

## The standing rule

> Nothing under `personas/` is read, quoted, cited or updated unless `<owner>` names it in the
> current turn — or one of the scoped exceptions below is running.

Scoped exceptions:

- the persona-detect skill (detect and refresh), which reads and proposes but never overwrites a
  confirmed persona;
- `npx builder-pipeline personas-check`, which validates the roster and renders confirmed personas;
- an agent rendered from a confirmed persona, which reads its own profile only;
- `<any other, with the record that granted it — or "none">`.

## Deviation logged

The skip entry above is a **permanent blind spot in gate coverage**: no check that walks
`<the repo>` will ever see these files, so nothing here is linted or link-checked by the project's
gates, and a broken citation inside a profile will not be caught by any automated means.

| | |
|---|---|
| **What was skipped** | `<gate/job name>` over `personas/**` |
| **Where the skip lives** | `<config path and line>` |
| **Accepted by** | `<who>` on `<date>` |
| **Why accepted** | the alternative is gate output that treats fiction as documentation |

## Disposal

This folder is disposable by design. Delete it when `<condition — the census is stale, the project
ships, the roster is rebuilt from scratch>`.

Nothing may depend on it except rendered persona agents, which are deleted with it. Confirm before
deleting: `<search command>` returns no reference to `personas/` outside this folder and the
rendered agent files. If it returns a hit, the fence has already failed — take that citation
through `<the project's real process>` before removing anything.
