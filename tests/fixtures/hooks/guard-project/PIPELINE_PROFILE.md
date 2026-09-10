# PIPELINE_PROFILE — test fixture

## 16. Pipeline settings

```json pipeline-settings
{
  "schema": 2,
  "paths": { "registry": "DEFERRED_TASKS.md", "runs": ".pipeline" },
  "features": {
    "registryGuard": { "state": "on", "seats": ["module-builder", "module-tester"] },
    "bashCap": { "state": "off" }
  }
}
```
