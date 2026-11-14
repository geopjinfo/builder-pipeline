# Behavioural gate (P6.5) — the two optional checks

Part of the `build-module-pipeline` skill, step 6.5. Run both after the behavioural suite and the
seeded walk, before the delta-scoped verdict.

## Why a gate that runs the application

Every
phase before it reads statically or tests in-process, which is exactly why a whole class of
defect is unreachable from a module build.

## Judge what the application served against its contract (optional)

```
node scripts/contract-oracle.mjs
```

It reads the run's request/response transcript (`features.contractOracle.transcript`) against the
contract (`features.contractOracle.spec`) and flags served status codes, undeclared query
parameters and error-code families the contract does not declare. Only drift absent from the
baseline fails the gate. A check that compares the contract document with itself cannot see this
class; only what was actually served can. Log it as a `gate` event; feature off →
`contractOracle: not configured`. **The baseline is shrink-only.** A plain `--write-baseline`
only removes resolved entries and refuses while any new finding exists. A new finding is carried
only by name — `--write-baseline --accept "<key>"` — with a registry row saying why. `--initial`
is the adoption path, and works only while no baseline exists. Never accept a finding to turn the
gate green: fix the drift or carry it by name.

## Move any shrink-only gap list by measurement, never by hand (optional)

```
node scripts/ratchet-refresh.mjs
```

Each list in `features.ratchets.lists` is a bank of known gaps (declared effects nothing
exercises, operations not yet baselined) with its ceiling in the same file. The script refuses an
item the run newly measures — that is something shipped without coverage, and the fix is
coverage, not a line in the bank — and drains what is now covered (`--write` applies; the list and
its ceiling move together, so no slack is left for a later entry to slip in). Log a `gate` event;
feature off → `ratchets: not configured`.
