# PIPELINE_PROFILE — sample for the board tests

Fixture: declares the orchestrator's model, so the renderer can be checked against the profile rather than a
harness-specific skill file.

## 16. Pipeline settings

```json pipeline-settings
{
  "schema": 2,
  "commands": { "tier": "python -m pytest tests/{tier} -q", "tiers": ["unit"], "affected": null, "typecheck": null },
  "paths": {
    "boards": "tasks",
    "registry": "DEFERRED_TASKS.md",
    "runs": ".pipeline",
    "decisions": "DECISIONS.md",
    "handoffs": "handoffs",
    "logs": "logs",
    "citationRoots": ["app", "tests", "tasks"]
  },
  "models": { "orchestrator": "claude-opus-5", "strong": "claude-opus-5", "mid": "claude-sonnet-5" },
  "protected": [],
  "features": {}
}
```
