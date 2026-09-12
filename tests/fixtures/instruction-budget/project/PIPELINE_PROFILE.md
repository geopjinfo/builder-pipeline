# PIPELINE_PROFILE — fixture: stock service (instruction budget)

Synthetic project for the instruction budget tests. The root file `INSTRUCTIONS.md` is 10 lines by the fixed rule
(`split('\n')`, trailing newline included); the overflow rule file `rules/testing.md` is 7. Budget: 12.

## 16. Pipeline settings

```json pipeline-settings
{
  "schema": 2,
  "features": {
    "instructionBudget": { "state": "on", "files": ["INSTRUCTIONS.md", "rules/testing.md"], "maxLines": 12 }
  }
}
```
