# Spec — stock-levels: reorder levels per warehouse

Module: stock-levels
Status: ratified
Ratified-by: the inventory lead, 2026-02-02

## Intent

> "A warehouse manager should be able to set the level at which an item is reordered, for their own
> warehouse only, and we need to see who changed it."

## Scope

- In: reading and setting the reorder level of an item in one warehouse; the audit entry for a change.
- Out: supplier lead times (STK-D1).

## Actors

| Actor | Source |
|---|---|
| warehouse manager | intent |
| auditor | intent |

## Requirements

| Id | Requirement | Actor | Kind | Source |
|---|---|---|---|---|
| REQ-001 | A warehouse manager can set the reorder level of an item in their own warehouse | warehouse manager | behaviour | intent |
| REQ-002 | A manager of another warehouse is refused | warehouse manager | refusal | intent |
| REQ-003 | A level that is not a whole number of units is refused | warehouse manager | refusal | D-1 |
| REQ-004 | Every change writes one audit entry naming the actor and the old and new level | auditor | effect | intent |
| REQ-005 | The level of an item is readable by its warehouse's manager | warehouse manager | behaviour | Q-1 |
| REQ-006 | A reorder level is never negative | warehouse manager | constraint | intent |

## Acceptance criteria

| Id | Req | Verb | Given | When | Then |
|---|---|---|---|---|---|
| AC-001 | REQ-001 | assert | a manager of warehouse W and an item in W | they set its reorder level to 12 | 200, and a read returns 12 |
| AC-002 | REQ-002 | assert | a manager of warehouse V | they set the level of an item in W | 403 `FORBIDDEN_SCOPE`, and the level is unchanged |
| AC-003 | REQ-003 | by-design | a manager of W | they send 2.5 | 422 `LEVEL_NOT_WHOLE` — whole units per D-1 |
| AC-004 | REQ-004 | assert | a level changed from 4 to 12 | the audit trail is read | one entry: actor, 4, 12 |
| AC-005 | REQ-005 | assert | a manager of W | they read an item's level | 200 with the level |
| AC-006 | REQ-006 | gap | a manager of W | they send -1 | recorded: refused today only by the UI (STK-D1 tracks the server check) |

## API contract

```json api-contract
{
  "openapi": "3.0.3",
  "info": { "title": "stock-levels", "version": "0.1.0" },
  "paths": {
    "/warehouses/{warehouseId}/items/{itemId}/reorder-level": {
      "parameters": [
        { "name": "warehouseId", "in": "path", "required": true, "schema": { "type": "string" } },
        { "name": "itemId", "in": "path", "required": true, "schema": { "type": "string" } }
      ],
      "get": {
        "x-req": ["REQ-005"],
        "responses": {
          "200": { "description": "the level" },
          "403": { "description": "out of scope", "content": { "application/json": { "example": { "code": "FORBIDDEN_SCOPE" } } } }
        }
      },
      "put": {
        "x-req": ["REQ-001", "REQ-002", "REQ-003", "REQ-004"],
        "responses": {
          "200": { "description": "set" },
          "403": { "description": "out of scope", "content": { "application/json": { "example": { "code": "FORBIDDEN_SCOPE" } } } },
          "422": { "description": "not whole", "content": { "application/json": { "example": { "code": "LEVEL_NOT_WHOLE" } } } }
        }
      }
    }
  }
}
```

## Oracle amendments

| Oracle | Entry | Why | Decision |
|---|---|---|---|
| permission catalogue | `stock.level.write` | REQ-001 needs a write key; none exists | accepted D-2 |

## Open questions

| Id | Question | Blocks | Answer |
|---|---|---|---|
| Q-1 | Can a manager read levels, or only set them? | REQ-005 | read and set — the inventory lead, 2026-02-02 |
