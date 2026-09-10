# PIPELINE_PROFILE — fixture: inventory service (handoff pack)

Synthetic project for the handoff pack tests. Decisions live in a directory; no tracker is configured.

## 16. Pipeline settings

```json pipeline-settings
{
  "schema": 2,
  "paths": {
    "boards": "tasks",
    "registry": "DEFERRED_TASKS.md",
    "runs": ".pipeline",
    "decisions": "decisions",
    "handoffs": "handoffs",
    "logs": "logs",
    "citationRoots": ["app", "tasks"]
  },
  "features": {
    "handoffPack": { "state": "on", "tracker": null }
  }
}
```
