# Template — QA-audit environment targets

Copy to wherever your runner reads config from (`qa-targets.json`, `qa-targets.yaml`, a profile
section — the shape matters, the format does not). One entry per environment.

## The rule this file exists to enforce

The QA audit is **destructive by design**: it locks accounts, revokes grants, rotates passwords,
deletes rows. That is fine where nobody else is looking and unacceptable anywhere else.

**Judge by whose DATA it is, not whose process it is.** An app running on your laptop against a
team database is a SHARED target. The single most likely way to cause an incident with this tool
is to mark such a target destructive because "it's my local app".

`shared: true` forces read-only, and `npx builder check-targets` (folder layout: `node builder/cli.js check-targets`) fails the build if a
shared target is marked destructive — so the rule survives someone editing this file in a hurry.

## Shape

```jsonc
{
  "default": "local",
  "targets": {
    "local": {
      "label": "Local ephemeral stack (recommended)",
      "kind": "ephemeral",        // runner creates AND destroys it
      "shared": false,
      "destructive": true,
      "notes": "Private namespace, shifted ports, volumes destroyed on teardown."
    },
    "hybrid": {
      "label": "Local app + shared services (READ-ONLY)",
      "kind": "attach",           // already running; never started, NEVER torn down
      "shared": true,             // ← the database belongs to the team
      "destructive": false,
      "envFile": "<path your deployment tooling already generates>",
      "host": "<services host>",
      "appHost": "<app host, when it differs — this is the hybrid case>",
      "notes": "App process is yours; the data is not. Read-only."
    },
    "shared-dev": {
      "label": "Shared dev server (READ-ONLY)",
      "kind": "attach",
      "shared": true,
      "destructive": false,
      "envFile": "<…>",
      "host": "<…>"
    }
  }
}
```

## Rules

- **Secrets never live here.** Point at the env file your deployment tooling already generates
  (gitignored), or name an environment variable. Read host, ports and credentials from it at run
  time so the audit cannot drift from how the environment was actually provisioned.
- **Fail loudly on a missing credential** — at resolve time, naming the variable. Not after four
  hundred confusing 401s.
- **`kind: attach` never tears down.** Teardown is a no-op, and the runner does not reach into a
  shared cache/queue it did not create.
- **A read-only target may still have read access to the datastore.** Measuring effect coverage is
  a SELECT and costs a shared environment nothing. Without it, effect coverage is `UNKNOWN` —
  which the report must say, rather than reporting a clean bill.
- **Never flip a shared target to destructive.** Add a disposable one instead.
