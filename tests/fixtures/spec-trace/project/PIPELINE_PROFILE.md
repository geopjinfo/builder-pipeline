# PIPELINE_PROFILE — fixture: orders service (spec-trace check)

Synthetic project for the spec-trace check. Six requirements in `docs/requirements.md`: one traced by a test, five by
requirement-pack steps (two `assert`, one `by-design` with its citation, one `gap`, one `skipped`). The pack's prose
note and the test helper both mention ids without being steps or tests, so neither traces anything.

## 16. Pipeline settings

```json pipeline-settings
{
  "schema": 2,
  "features": {
    "specTrace": {
      "state": "on",
      "idPattern": "REQ-\\d+",
      "requirements": ["docs"],
      "tests": ["tests"],
      "testPattern": "\\.test\\.ts$",
      "packs": ["packs"]
    }
  }
}
```
