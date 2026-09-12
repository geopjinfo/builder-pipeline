# PIPELINE_PROFILE — test fixture

## 16. Pipeline settings

```json pipeline-settings
{
  "schema": 2,
  "features": {
    "ratchets": {
      "state": "on",
      "lists": [
        { "name": "unexercised-effects", "bank": "ratchets/unexercised-effects.json", "measured": "reports/unexercised-effects.json" },
        { "name": "untyped-files", "bank": "ratchets/untyped-files.json", "measured": "reports/untyped-files.json" }
      ]
    }
  }
}
```
