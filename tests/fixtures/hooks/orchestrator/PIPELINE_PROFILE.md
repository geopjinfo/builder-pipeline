# PIPELINE_PROFILE — test fixture

## 16. Pipeline settings

```json pipeline-settings
{
  "schema": 2,
  "models": { "orchestrator": "model-alpha", "strong": "model-alpha", "mid": "model-beta" },
  "features": {
    "orchestratorModel": { "state": "on" },
    "costAccounting": { "state": "on", "reader": "claude-code" }
  }
}
```
