# Deferred & Follow-up Task Registry (all modules)

> **Install this file as `DEFERRED_TASKS.md` at the target repo root** (the unpack step does
> this). Keep the header + rules; start with an empty table.

**Single, git-tracked, cross-module backlog of deferred work.** One row per deferred task, keyed
by the module that raised it, with **Status · Dependency · Why blocked · When it can be done**.
This is where a build agent looks to answer *"did the module I just built unblock anything?"*

Deferrals live **here and only here** — never in a module folder, a gitignored file, or chat
history.

## How build agents use this (wired into build-module-pipeline)

- **On entry (before planning):** read this file. If the module about to be built is a
  **Dependency** of any open row, surface it to the human for a fold-in vs defer-again ruling.
- **On exit (MERGE-READY):** add a row for every item this module deferred; flip any row whose
  dependency this module resolved to `NOW UNBLOCKED`/`DONE`; bump `Last reviewed`.

## Row rules (learned the hard way — consider gating them mechanically)

1. Every row id is unique.
2. No row stays flagged "verify?" — resolve the doubt, either way, before it can mislead.
3. A row whose dependency has **landed** is *work*, not a deferral — move it to the active
   tracker/board; a registry note is the wrong home and is why such rows sit forever.
4. No merge condition stays open past the build it conditioned.
5. Statuses use the registry vocabulary below — a value outside it is silently dropped by every
   report that counts rows.

**When you add a deferral, give it a way to be remembered.** Ranked by observed reliability:
**self-resolving** (a default that closes it unless someone acts) · **structural** (the
architecture forces the next builder to ask) · **scheduled** (a tracker row with an owner) ·
**registry-only** (relies on someone reading this file at the right moment — the weakest; avoid
if any stronger form is available).

## Format

_Last reviewed: <date>_

| Id | Raised by | Task | Status | Dependency | Why blocked | How to resume |
|----|-----------|------|--------|------------|-------------|---------------|
| <MOD>-D1 | <moduleKey> | <what was deferred> | DEFERRED | <module/capability it waits on> | <one line> | <exact steps/files> |

**Statuses:** `DEFERRED` · `NOW UNBLOCKED` · `DONE` · `DROPPED` (reason in Task cell).
