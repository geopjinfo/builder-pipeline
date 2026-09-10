# Tooling — generic run-economy scripts (ported 2026-08-26 from the source repo)

Drop into the target repo as `scripts/run-tier.mjs` + `scripts/lib/*.cjs`, then localize the
FOUR project-specific knobs — everything else runs as-is on Node 20+, zero dependencies:

| File | Localize |
|---|---|
| `run-tier.mjs` | the `CONFIGS` map (tier name → jest config path) and the `gates` command; the `--since` default branch |
| `capacity.cjs` | env override name is `MAX_TEST_WORKERS` (rename if your CI convention differs — pin it in CI); per-tier `perWorkerMb`/`ceiling` at the call sites in your jest configs — ceilings AT OR BELOW the tier's current worker count, the governor only ever lowers |
| `tier-lock.cjs` | `DEFAULT_LOCK` filename (machine-wide tmpdir path — keep it machine-wide: the contended resource is the Docker daemon, not the repo; a worktree-scoped lock is an absent lock). `MAX_PLAUSIBLE_RUN_MS` to your longest tier ×2 (pid-reuse ceiling — observed in production, not hypothetical) |
| `affected.cjs` | `FULL_RUN_PATTERNS` — YOUR migrations dir, YOUR platform/shared-kernel path, YOUR test-harness dirs, the jest configs, package.json. Anything the import graph cannot see through belongs on it; a false `full` costs minutes, a false `related` costs a missed regression |
| `instruction-trailer.cjs` | `INSTRUCTION_DIFF` — YOUR instruction-file paths. Wire `instruction-trailer-check` style entry into CI before the gate step |

Not included: the PreToolUse fence hook (harness-specific — Claude Code hooks; the Codex adapter
has no equivalent seam) and the path-scoped rules content (project constitution, write your own —
but DO use the pattern: root instruction file under ~200 lines, path-scoped rule files for
anything that only matters in one directory, and a gate on the line count so it cannot grow back).

House rules that ride with these scripts (bake into your orchestrator playbook):
- never run a suite bare — wrapper only, digest spoken, full log kept;
- selective is inner-loop only, never merge evidence;
- one suite at a time when suites share an external resource (DB container).
