# PIPELINE_PROFILE — fixture: stock-levels service (line citations)

Synthetic project for the line-citations check. One catalogue of action keys; code and notes cite rows by key, and
one rostered notes file still cites two rows by line while it is swept — one of them stale.

## 16. Pipeline settings

```json pipeline-settings
{
  "schema": 2,
  "paths": { "logs": "logs" },
  "features": {
    "lineCitations": {
      "state": "on",
      "catalogues": ["catalogue/actions.csv"],
      "roots": ["."],
      "extensions": [".py", ".md"],
      "roster": "line-citations-roster.json",
      "control": null,
      "minFiles": 3,
      "keyColumn": 0
    }
  }
}
```
