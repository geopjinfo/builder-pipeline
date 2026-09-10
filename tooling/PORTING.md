# Tooling — porting the run economy

The pipeline needs two commands from your project, set in `PIPELINE_PROFILE.md` §16: `commands.tier`
(a tier runner that writes the full log and prints a bounded digest) and `commands.affected` (a
selective inner-loop run that escalates to a full run when shared files change). The interface they
must honour is written out in
[`../examples/jest-tier-runner/README.md`](../examples/jest-tier-runner/README.md).

`examples/jest-tier-runner/` is **one example** implementation, for a JavaScript project on jest. On
any other stack, write the equivalent in your own tooling and point §16 at it. To use the example,
copy it into the target repo as `scripts/run-tier.mjs` + `scripts/lib/*.cjs`, then localize the
project-specific knobs below — everything else runs as-is on Node 18 or newer (the pack's floor),
with no dependencies beyond jest:

| File (in `examples/jest-tier-runner/`) | Localize |
|---|---|
| `run-tier.mjs` | the `CONFIGS` map (tier name → your test runner's config path) and the `gates` command; the `--since` default branch. Point `commands.tier` in profile §16 at it |
| `capacity.cjs` | env override name is `MAX_TEST_WORKERS` (rename if your CI convention differs — pin it in CI); per-tier `perWorkerMb`/`ceiling` at the call sites in your test-runner configs — ceilings AT OR BELOW the tier's current worker count, the governor only ever lowers |
| `tier-lock.cjs` | `DEFAULT_LOCK` filename (machine-wide tmpdir path — keep it machine-wide: the contended resource is the container daemon or database, not the repo; a worktree-scoped lock is an absent lock). `MAX_PLAUSIBLE_RUN_MS` to your longest tier ×2 (pid-reuse ceiling — observed in production, not hypothetical) |
| `affected.cjs` | `FULL_RUN_PATTERNS` — YOUR migrations dir, YOUR shared-kernel path, YOUR test-harness dirs, the test-runner configs, the package manifest. Anything the import graph cannot see through belongs on it; a false `full` costs minutes, a false `related` costs a missed regression. Point `commands.affected` at it |
| `instruction-trailer.cjs` | `INSTRUCTION_DIFF` — YOUR instruction-file paths. Wire an `instruction-trailer-check` style entry into CI before the gate step |

Not included: a protected-path fence for shell and interpreter writes (harness-specific; the
Claude Code tool-call fence is `hooks/protected-paths.js`, and the universal backstop is the
pre-commit guard) and the path-scoped rules content (project constitution, write your own — but DO
use the pattern: root instruction file under ~200 lines, path-scoped rule files for anything that
only matters in one directory, and a gate on the line count so it cannot grow back).

Rules that ride with any tier runner (bake into your orchestrator playbook):
- never run a suite bare — wrapper only, digest spoken, full log kept. This is also what stands in
  for an output-capping hook in harnesses that have none, and inside subagents where such a hook
  does not take effect;
- selective is inner-loop only, never merge evidence;
- one suite at a time when suites share an external resource (DB container).

## Knowledge index (optional)

If the target keeps a knowledge index (a code/doc graph or an embedding store) for seats to query,
it plugs in through `features.graph` in profile §16 and one exit-code contract, with no
index-specific code in the pipeline. The contract, the three refresh triggers, the lock, the
automatic-embed size limit and the code-vs-docs refresh split are in
[`optional/README.md`](optional/README.md). The graphify scripts there are one example of a tool
meeting part of that contract.
