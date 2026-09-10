'use strict';
/**
 * Sizes jest worker pools to the memory actually free, not to the core count.
 *
 * WHY THIS EXISTS. the source repo measured its integration tier at ~9-10 min
 * GREEN with `maxWorkers: 50%`, and 19 min with FOURTEEN FAILURES at `--maxWorkers=16` on the same
 * commit. Oversubscription here costs correctness, not just time — the losing worker fails on
 * timeouts, which reads as a regression and is not one.
 *
 * It may only ever LOWER the count below the tier's ceiling. Raising it is how the 19-minute shape
 * comes back, and a governor that can raise makes runs non-comparable across machines. CI pins
 * `MAX_TEST_WORKERS` so CI stays deterministic; developer machines float.
 *
 * Design rationale: the source repo's 2026-08-26 run-economy plan (evidence-backed; see PORTING.md).
 */
const os = require('node:os');

const MB = 1024 * 1024;
/** The OS, Docker Desktop and the orchestrator's own Node all need a core. */
const RESERVED_CORES = 2;

function computeWorkers({ cores, freeMb, perWorkerMb, ceiling = Number.POSITIVE_INFINITY, override }) {
  if (override !== undefined && override !== null && override !== '') {
    const explicit = Number(override);
    if (!Number.isInteger(explicit) || explicit < 1) {
      throw new Error(`MAX_TEST_WORKERS must be a positive integer, got ${JSON.stringify(override)}`);
    }
    return explicit;
  }
  const byCpu = cores - RESERVED_CORES;
  const byMemory = Math.floor(freeMb / perWorkerMb);
  return Math.max(1, Math.min(byCpu, byMemory, ceiling));
}

/**
 * `os.loadavg()` is deliberately NOT consulted: it returns [0,0,0] on win32, this repo's primary
 * platform, so a load-based rule would be a no-op exactly where it is needed. Free memory is the
 * signal that is real on every platform we run on.
 */
function maxWorkers({ perWorkerMb, ceiling }) {
  return computeWorkers({
    cores: os.cpus().length,
    freeMb: os.freemem() / MB,
    perWorkerMb,
    ceiling,
    override: process.env.MAX_TEST_WORKERS,
  });
}

module.exports = { computeWorkers, maxWorkers, RESERVED_CORES };
