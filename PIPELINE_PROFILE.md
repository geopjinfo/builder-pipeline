# PIPELINE_PROFILE — the builder kit itself

> Maintainer-only. This file is not shipped (it is in the skip list of `tests/package.test.mjs`). It turns the kit's
> own spec authoring stage on, so the kit's modules are specified in `specs/` before they are built (plan decision
> D28). Project facts the kit needs live here, never in code.

## 1. Project facts

- Visibility: public (the repository is public; nothing in it is private project data).
- Decision log: `DECISIONS.md` at the repo root.
- Deferred work: `DEFERRED_TASKS.md` at the repo root.

## 16. Pipeline settings

```json pipeline-settings
{
  "schema": 2,
  "commands": { "tier": null, "tiers": [], "affected": null, "typecheck": null },
  "paths": { "boards": "tasks", "registry": "DEFERRED_TASKS.md", "runs": ".pipeline", "decisions": "DECISIONS.md" },
  "features": {
    "handoffPack": { "state": "on", "decisionIdPattern": "D\\d+" },
    "specAuthoring": { "state": "on", "dir": "specs", "idPattern": "REQ-\\d+" }
  }
}
```
