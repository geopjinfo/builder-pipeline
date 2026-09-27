'use strict';
/**
 * EXAMPLE — a worker-pool governor for jest. The interface it implements is in README.md beside this file.
 *
 * Sizes jest worker pools to the memory actually free, not to the core count.
 *
 * WHY THIS EXISTS. In one project an integration tier ran green at half the cores, and on the same
 * commit, with the worker count pushed towards the core count, took about twice as long and failed a
 * dozen-plus tests. Oversubscription costs correctness, not just time — the losing worker fails on
 * timeouts, which reads as a regression and is not one.
 *
 * It may only ever LOWER the count below the tier's ceiling. Raising it is how the slow, flaky shape
 * comes back, and a governor that can raise makes runs non-comparable across machines. CI pins
 * `MAX_TEST_WORKERS` so CI stays deterministic; developer machines float.
 */
const os = require('node:os');

const MB = 1024 * 1024;
/** The OS, the container runtime and the orchestrator's own Node all need a core. */
const RESERVED_CORES = 2;

const isSet = (v) => v !== undefined && v !== null && v !== '';

function positiveInteger(name, raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  return n;
}

/**
 * The worker count, and why it is not the number someone asked for.
 *
 * `override` (`MAX_TEST_WORKERS`) PINS the count — CI's determinism — but only at or below the tier's
 * ceiling. An override returned before the ceiling applied is how a single-worker tier ends up booting
 * ten apps, and how a unit tier outruns the memory it was sized for. `cap` (`TEST_WORKER_CAP`) only ever
 * LOWERS whatever the governor or the pin decided: use it, never a jest CLI `--maxWorkers`, when a
 * wrapper wants a smaller pool — the CLI flag REPLACES the governed answer, so a host with memory for
 * two workers runs six. A clamp is reported in `notes`, never done silently.
 */
function describeWorkers({ cores, freeMb, perWorkerMb, ceiling = Number.POSITIVE_INFINITY, override, cap }) {
  const notes = [];
  let workers;
  if (isSet(override)) {
    const explicit = positiveInteger('MAX_TEST_WORKERS', override);
    workers = Math.min(explicit, ceiling);
    if (explicit > ceiling) {
      notes.push(
        `MAX_TEST_WORKERS=${explicit} is above this tier's ceiling of ${ceiling}; running ${ceiling} (an override may lower a tier, never raise it)`,
      );
    }
  } else {
    const byCpu = cores - RESERVED_CORES;
    const byMemory = Math.floor(freeMb / perWorkerMb);
    workers = Math.max(1, Math.min(byCpu, byMemory, ceiling));
  }
  if (isSet(cap)) workers = Math.min(workers, positiveInteger('TEST_WORKER_CAP', cap));
  return { workers, notes };
}

function computeWorkers(input) {
  return describeWorkers(input).workers;
}

/**
 * `os.loadavg()` is deliberately NOT consulted: it returns [0,0,0] on win32, so a load-based rule
 * would be a no-op on every Windows developer machine, exactly where it may be needed. Free memory is
 * the signal that is real on every platform.
 */
function maxWorkers({ perWorkerMb, ceiling }) {
  const { workers, notes } = describeWorkers({
    cores: os.cpus().length,
    freeMb: os.freemem() / MB,
    perWorkerMb,
    ceiling,
    override: process.env.MAX_TEST_WORKERS,
    cap: process.env.TEST_WORKER_CAP,
  });
  for (const note of notes) process.stderr.write(`[capacity] ${note}\n`);
  return workers;
}

module.exports = { computeWorkers, describeWorkers, maxWorkers, RESERVED_CORES };
