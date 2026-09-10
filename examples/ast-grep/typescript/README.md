# Example structural rules — ast-grep, TypeScript

**These are EXAMPLES, not a default rule set.** They show the shape the rules step expects; they are not
tuned to your code, and nothing in the pack enables them. Copy the ones that describe a defect your project
has actually repeated, rewrite their `files:` globs for your layout, and delete the rest.

## Why structural rules at all

A text search sees spellings; a syntax tree sees code. `new Date` without parentheses, `Date['now']()`, a
multi-line object literal, a comment that merely mentions the pattern — a regex either misses the variant or
flags the comment. A rule written against the syntax tree does neither, so a repeat defect found once in
review can be found everywhere, mechanically, before the next review.

## The runner interface

The pipeline does not depend on ast-grep. `scripts/rules-module.mjs` runs whatever `features.rules.scan`
names and reads its standard output as a JSON stream — one object per line with at least:

```json
{ "ruleId": "offset-pagination-without-id-tiebreak", "file": "src/items/items.repository.ts", "text": "{ where, skip, take }", "range": { "start": { "line": 41 } } }
```

(`line` is 0-based.) ast-grep prints exactly that with `--json=stream`. Semgrep, a custom linter, or any
tool whose JSON output a small script maps onto those four fields fits the same interface.

Each hit is keyed by **rule id + file + whitespace-collapsed snippet** — never a line number, so a hit that
merely moved stays baselined and a hit whose code changed does not.

## The rules here

| Rule | Catches | Why it is a defect |
|---|---|---|
| `offset-pagination-without-id-tiebreak` | an ORM query object with `skip` whose `orderBy` is absent or names no `id` | rows sharing a sort key can swap between pages, so a row appears twice or never |
| `ambient-clock-in-controller` | `new Date()`, `Date.now()` and their variants inside a controller | request handlers that read the wall clock cannot be tested at a fixed instant; inject a clock and take business time in the service |
| `clock-read-outside-transaction` | `<something>clock.now()` in a method that opens a `tx.run(callback)` transaction, outside the callback | the instant is taken before (or after) the transaction it stamps, so a retry or a lock wait makes it stale |

The first rule assumes a Prisma-style query object (`skip` / `orderBy`); the third assumes a transaction
runner called as `tx.run(async (tx) => …)`. Adjust the rule's `regex` fields to your own names.

## Layout

```
sgconfig.yml
rules/<rule-id>.yml
rule-tests/<rule-id>-test.yml     valid: must NOT match · invalid: MUST match
```

## Commands

Prove every rule against its own valid and invalid cases (run inside this directory, or wherever you copy it):

```
npx ast-grep test --skip-snapshot-tests
```

Wire the scan into the profile:

```json
"rules": {
  "state": "on",
  "runner": "ast-grep",
  "scan": "npx ast-grep scan --json=stream {target}",
  "baseline": "rules/baseline.json",
  "ratcheted": ["offset-pagination-without-id-tiebreak", "clock-read-outside-transaction"]
}
```

then `node scripts/rules-module.mjs src/items`.

`ratcheted` lists the rule ids whose hits count; leave a census rule (an inventory, not a defect) out of it.
An empty list counts every rule. The baseline is a JSON array of `{ "ruleId", "file", "snippet", "why" }` —
every entry carries a written reason, because a baselined hit is a defect someone chose to carry.

On Windows, prefer invoking the ast-grep binary without a shell when a pattern is passed on the command line:
cmd.exe rewrites some regex metacharacters. Patterns kept in rule files, as here, are unaffected.
