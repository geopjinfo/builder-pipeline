# Pipeline profile — personas fixture

```json pipeline-settings
{
  "schema": 2,
  "features": {
    "personas": {
      "state": "experimental-on",
      "catalogue": "catalogue/grants.csv",
      "keyColumn": "key",
      "labelColumn": "label",
      "roleColumns": null,
      "grant": "1",
      "out": "roles",
      "logins": "catalogue/logins.json",
      "citationPattern": "`[^`\\s]+\\.[a-z]+:\\d+`|\\bRULE-\\d+\\b"
    }
  }
}
```
