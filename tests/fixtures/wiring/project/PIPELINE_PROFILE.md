# PIPELINE_PROFILE — fixture: stock service (wiring check)

Synthetic TypeScript project for the wiring check tests. Its kinds are the example set in
`examples/wiring/typescript-di.kinds.json`, verbatim — a test holds the two equal.

Baseline: 7 seams — 1 ruled latent (`drainPending`, only a test turns it), 1 not-evaluable (a loop variable passed
to `subscribe`), 0 unjoined.

## 16. Pipeline settings

```json pipeline-settings
{
  "schema": 2,
  "features": {
    "wiring": {
      "state": "on",
      "roots": ["src"],
      "extensions": [".ts"],
      "testPattern": "\\.test\\.ts$",
      "allow": "wiring.allow.json",
      "kinds": [
        {
          "name": "motor",
          "declare": "^[ \\t]*(?:(?:public|protected|static|override)[ \\t]+)*async[ \\t]+(dispatch\\w*|drain\\w*|flush\\w*|pump\\w*|\\w+Batch|run\\w*Cycle)[ \\t]*\\(",
          "join": "\\.{id}\\s*\\(",
          "detail": "no production caller — the queue has no motor"
        },
        {
          "name": "subscription",
          "declare": "\\.subscribe\\(\\s*(?:['\"`]([^'\"`\\n]+)['\"`]|[A-Za-z_$][\\w$.]*)",
          "join": "['\"`]{id}['\"`]",
          "detail": "no other production file constructs this event name — the handler can never run"
        },
        {
          "name": "provider",
          "declare": "(?<=providers\\s*:\\s*\\[[^\\]]*)\\b([A-Z][a-z0-9][A-Za-z0-9_$]*)\\b",
          "join": ":\\s*{id}\\b|\\bnew\\s+{id}\\s*\\(|\\binject\\w*\\(\\s*{id}\\b",
          "detail": "registered as a provider and injected nowhere — nothing is on the other end"
        }
      ]
    }
  }
}
```
