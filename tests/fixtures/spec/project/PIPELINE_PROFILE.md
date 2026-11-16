# PIPELINE_PROFILE — fixture: inventory service (spec authoring)

Synthetic project for the spec-check tests. Specs live under `specs/`; decisions in one file.

## 16. Pipeline settings

```json pipeline-settings
{
  "schema": 2,
  "paths": {
    "boards": "tasks",
    "registry": "DEFERRED_TASKS.md",
    "runs": ".pipeline",
    "decisions": "DECISIONS.md",
    "handoffs": "handoffs",
    "logs": "logs",
    "citationRoots": ["app", "tasks"]
  },
  "features": {
    "specAuthoring": { "state": "on", "dir": "specs", "idPattern": "REQ-\\d+" }
  }
}
```
