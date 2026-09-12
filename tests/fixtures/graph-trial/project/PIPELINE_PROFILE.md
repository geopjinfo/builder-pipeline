# Pipeline profile — graph trial fixture

```json pipeline-settings
{
  "schema": 2,
  "features": {
    "graphTrial": {
      "state": "experimental-on",
      "seats": ["orchestrator", "module-planner", "standards-auditor", "invariant-auditor"],
      "callPattern": "(?:^|[\\s;&|/])idx(?:\\.exe)?\\s+(find|vocab|explain|query|path|affected)\\b"
    }
  }
}
```
