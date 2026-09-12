# PIPELINE_PROFILE — test fixture

## 16. Pipeline settings

```json pipeline-settings
{
  "schema": 2,
  "features": {
    "decisionIndex": {
      "state": "on",
      "roots": ["DECISIONS.md", "notes", "src"],
      "idPattern": "D-\\d+",
      "out": "notes/decision-index.md"
    }
  }
}
```
