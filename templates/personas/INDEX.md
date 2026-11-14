# Persona roster

> `personas/` is outside the documentation set. Fiction written to be prompted with, not evidence.
> See `WHY.md`.

| | |
|---|---|
| **Depth** | `<sketch / working / full>` — `<one-line reason, from _census.md>` |
| **Confirmed** | `<n>` of `<n>` — `<date and who confirmed>` |
| **Research** | `<ran — queries in _census.md / offline — repository only>` |

## How to pick a set

Delivery drafts it, product walks it, governance rules on it.

## Product — actors who use the system

| Id | Persona | Mandate | Routes | Confirmed |
|---|---|---|---|---|

## Delivery — actors who build it

| Id | Persona | Mandate | Routes | Confirmed |
|---|---|---|---|---|

## Governance — actors who judge it

| Id | Persona | Mandate | Routes | Confirmed |
|---|---|---|---|---|

## Collisions

| Persona | Disagrees with | Over |
|---|---|---|

## Roster (machine-readable)

The one block tools read. `node scripts/personas-check.mjs` holds it to the tables above and the
profile files. Only the human sets `confirmed` or `render` to `true`.

```json
{
  "personas": []
}
```
