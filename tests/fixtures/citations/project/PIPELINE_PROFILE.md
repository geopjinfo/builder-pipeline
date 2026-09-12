# PIPELINE_PROFILE — fixture: stock-levels service (citations check)

Synthetic project for the citations check. Four schemes, one per source shape: a requirement register (CSV by header
name), an action catalogue (CSV by index, with a skip so file names are not read as keys), a records directory (ids
from file names) and an invariant list (ids found inside files).

## 16. Pipeline settings

```json pipeline-settings
{
  "schema": 2,
  "paths": { "boards": "tasks", "logs": "logs" },
  "features": {
    "citations": {
      "state": "on",
      "schemes": [
        { "name": "requirement", "pattern": "STK-\\d+", "ignoreCase": true, "source": { "csv": "register/requirements.csv", "column": "id" } },
        { "name": "record", "pattern": "REG-\\d+", "source": { "dir": "records", "filePattern": "^(REG-\\d+)-" } },
        { "name": "invariant", "pattern": "INV-\\d+", "source": { "files": ["notes"], "idPattern": "INV-\\d+" } },
        { "name": "action", "pattern": "[a-z][a-z-]*\\.[a-z][a-z-]*", "skip": "\\.(md|csv|json|py)$", "source": { "csv": "register/actions.csv", "column": 0 } }
      ]
    }
  }
}
```
