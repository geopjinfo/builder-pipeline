# PIPELINE_PROFILE — test fixture

## 16. Pipeline settings

```json pipeline-settings
{
  "schema": 2,
  "features": {
    "rules": {
      "state": "on",
      "runner": "ast-grep",
      "scan": "node print-scan.cjs {target}",
      "baseline": "baseline.json",
      "ratcheted": ["offset-pagination-without-id-tiebreak", "clock-read-outside-transaction"]
    }
  }
}
```
