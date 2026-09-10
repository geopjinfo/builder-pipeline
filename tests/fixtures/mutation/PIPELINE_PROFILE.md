# PIPELINE_PROFILE — test fixture

## 16. Pipeline settings

```json pipeline-settings
{
  "schema": 2,
  "paths": { "logs": "logs-under-test" },
  "features": {
    "mutation": {
      "state": "on",
      "tool": "example",
      "command": "node fake-mutate.cjs {module}",
      "report": "reports-under-test/{module}/mutation.json",
      "payloadPattern": "\\bdetail\\b|\\brule\\s*:"
    }
  }
}
```
