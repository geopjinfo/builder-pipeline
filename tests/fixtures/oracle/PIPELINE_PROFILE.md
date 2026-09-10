# PIPELINE_PROFILE — test fixture

## 16. Pipeline settings

```json pipeline-settings
{
  "schema": 2,
  "features": {
    "contractOracle": {
      "state": "on",
      "adapter": "openapi3",
      "spec": "inventory.openapi.json",
      "transcript": "transcript.jsonl",
      "baseline": "baseline.json",
      "codeField": "code",
      "statusFamilies": { "409": ["CONFLICT", "STALE_VERSION"] },
      "platformCodePattern": "^[A-Z][A-Z_]+$"
    }
  }
}
```
