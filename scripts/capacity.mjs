/**
 * The capacity governor — the manual command and the watcher (plan M15, REQ-1501 to REQ-1516). Rules:
 * scripts/lib/capacity.cjs.
 *
 *   npx builder-pipeline run capacity --once            one tick: write <orch root>/capacity.json and print the table
 *   npx builder-pipeline run capacity --watch           tick every intervalSeconds under a pid lease (the orchestrator starts it at run start, D85)
 *   npx builder-pipeline run capacity --json            with --once: print the record as JSON
 * (folder layout: node scripts/capacity.mjs in place of npx builder-pipeline run capacity)
 *
 * Settings (PIPELINE_PROFILE.md §16): features.capacity.{state, perLaneMb, reserveCores, maxLoadPerCore, minFreeMb,
 * minDiskMb, intervalSeconds, ttlSeconds, riseAfterTicks, holdMaxMinutes, explainAfterTicks} ·
 * features.orchestrator.maxLanes (the planned maximum; BUILDER_ORCH_LANE_CAP wins) · features.accounts (the account
 * term) · BUILDER_ORCH_DIR (the orch root).
 *
 * The governor lowers only and never signals a process (D71). Exit 0 always — a reading that fails is unmeasured and
 * said, a second watcher says the first is live — except 2 for a usage error or an invalid profile (REQ-1510).
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runHint } = require('./lib/run-hint.cjs');
const profile = require('./lib/profile.cjs');
const store = require('./lib/orch-store.cjs');
const capacity = require('./lib/capacity.cjs');

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const known = new Set(['--once', '--watch', '--json', '--help']);
const unknown = [...flags].filter((f) => !known.has(f));
const usage = `usage: ${runHint('capacity')} --once [--json] | --watch`;
if (flags.has('--help') || unknown.length || argv.some((a) => !a.startsWith('--')) || (flags.has('--once') && flags.has('--watch')) || !(flags.has('--once') || flags.has('--watch'))) {
  console.error(usage);
  if (unknown.length) console.error(`capacity: unknown flag(s): ${unknown.join(', ')}`);
  process.exit(2);
}
const loaded = profile.load(process.cwd());
if (loaded.errors.length > 0) {
  console.error(`capacity: PIPELINE_PROFILE.md is invalid — run ${runHint('features')}`);
  for (const e of loaded.errors) console.error(`  ${e}`);
  process.exit(2);
}
const f = profile.feature(loaded.settings, capacity.FEATURE);
if (!f.enabled) {
  console.log(f.line);
  process.exit(0);
}
let root;
try {
  root = store.orchRoot(process.env, process.cwd());
} catch (e) {
  console.error(`capacity: no orch root — ${e.message} (set BUILDER_ORCH_DIR, or run inside the git checkout)`);
  process.exit(2);
}

const once = () => {
  const record = capacity.tick(root, loaded.settings, { env: process.env });
  if (flags.has('--json')) console.log(JSON.stringify(record, null, 2));
  else for (const l of capacity.table(record)) console.log(l);
  return record;
};

if (flags.has('--once')) {
  once();
  process.exit(0);
}

// --watch: one watcher per orch root; a live one wins, a dead one's lease is taken over (REQ-1510)
const lease = capacity.takeLease(root);
if (!lease.ok) {
  console.log(`capacity: a watcher is live (pid ${lease.pid} since ${lease.since}) — this one exits`);
  process.exit(0);
}
const intervalMs = f.config.intervalSeconds * 1000;
let ticks = 0;
const stop = () => {
  capacity.releaseLease(root);
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
const run = () => {
  try {
    const record = once();
    ticks += 1;
    if (record.lanes < record.plannedMax && ticks % f.config.explainAfterTicks === 0) console.log(`capacity: bound for ${ticks} ticks — ${runHint('orch')} status shows the line; the capacity-steward persona explains it`);
  } catch (e) {
    console.error(`capacity: tick failed — ${e.message} (the record is unchanged; the readers apply the planned cap once it is stale)`);
  }
};
run();
const timer = setInterval(run, intervalMs);
if (process.env.BUILDER_CAPACITY_WATCH_TICKS) {
  // tests: stop after N ticks
  const max = Number(process.env.BUILDER_CAPACITY_WATCH_TICKS);
  const guard = setInterval(() => {
    if (ticks >= max) {
      clearInterval(timer);
      clearInterval(guard);
      stop();
    }
  }, 20);
}
