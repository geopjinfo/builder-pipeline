# PIPELINE_PROFILE — sample: a small Python service

Fixture for the pack's own tests and the adopter dogfood. A Flask + SQLite service with pytest; no API contract
file, no permission catalogue, no knowledge graph, no mutation tool. Every optional feature is therefore `off`,
which is exactly what the dogfood proves: an absent feature is reported, never a crash and never a pass.

## 1. Project identity

- **Project:** inventory-service — stock levels for a small warehouse
- **Stack:** Python 3.12 · Flask · SQLite · pytest

## 16. Pipeline settings

```json pipeline-settings
{
  "schema": 2,
  "commands": {
    "tier": "python -m pytest tests/{tier} -q",
    "tiers": ["unit", "integration"],
    "affected": null,
    "typecheck": "python -m mypy app"
  },
  "paths": {
    "boards": "tasks",
    "registry": "DEFERRED_TASKS.md",
    "runs": ".pipeline",
    "decisions": "DECISIONS.md",
    "handoffs": "handoffs",
    "logs": "logs",
    "citationRoots": ["app", "tests", "docs", "tasks"]
  },
  "models": { "orchestrator": null, "strong": "strong-model", "mid": "mid-model" },
  "protected": ["app/core/**", "migrations/**"],
  "features": {
    "planSchema": { "state": "on", "sections": ["Track", "Context", "Schema", "Routes", "Tasks", "BLOCKERS"], "tables": { "routes": "| Method | Path | Handler |" }, "oracle": null },
    "contractOracle": { "state": "off" },
    "rules": { "state": "off" },
    "mutation": { "state": "off" },
    "graph": { "state": "off" }
  }
}
```
