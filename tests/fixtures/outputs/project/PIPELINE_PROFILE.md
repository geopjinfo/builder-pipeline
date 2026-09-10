# PIPELINE_PROFILE — fixture: inventory service (output formats)

Synthetic project for the plan / findings / review checkers. The plan's Interfaces table carries an access-key
column held to `access-keys.csv`.

## 16. Pipeline settings

```json pipeline-settings
{
  "schema": 2,
  "paths": { "runs": ".pipeline" },
  "features": {
    "planSchema": {
      "state": "on",
      "sections": ["Track", "Context", "Interfaces", "Tasks", "BLOCKERS"],
      "tables": { "interfaces": "| Method | Path | Access key | Handler |" },
      "oracle": { "table": "interfaces", "column": "Access key", "source": "access-keys.csv", "keyColumn": "key" }
    }
  }
}
```
