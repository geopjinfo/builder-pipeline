# PIPELINE_PROFILE — fixture: inventory service (claims checker)

Synthetic project for the claims checker tests. Runs live under `.pipeline/`, decisions in one `DECISIONS.md` file.

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
    "claims": { "state": "on", "retracted": "retracted-phrases.json", "registryIdPattern": "[A-Z][A-Z0-9]{1,8}-D\\d+[a-z]?" }
  }
}
```
