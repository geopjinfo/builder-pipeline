/**
 * The progress reporter — `npx builder-pipeline run report` (plan M16, REQ-1611, REQ-1612, REQ-1618; D85).
 * Rules: scripts/lib/report.cjs (the report) and scripts/lib/notify.cjs (the channels).
 *
 *   npx builder-pipeline run report --once                  build and send one report
 *   npx builder-pipeline run report --watch [--interval N]  tick now and every intervalMinutes under a pid lease; poll the
 *                                                           events for alerts every alertPollSeconds while alertOn is set
 * (folder layout: node scripts/report.mjs in place of npx builder-pipeline run report)
 *
 * Settings (PIPELINE_PROFILE.md): features.reporter.{state, channels, intervalMinutes, onlyOnChange, heartbeatEvery,
 * alertOn, alertPollSeconds, maxBytes, timeoutMs, reportsDir} · paths.boards · features.costAccounting.
 *
 * A send failure never changes the exit code; it is in <reportsDir>/report.log.jsonl. Exit 0 · 2 usage or an invalid
 * profile. The feature off prints `reporter: not configured` and exits 0. Two watchers never double-send: a live lease
 * (<reportsDir>/watch.lock) makes the second exit 0 naming the pid; a dead pid is taken over.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { runHint } = require('./lib/run-hint.cjs');
const profile = require('./lib/profile.cjs');
const report = require('./lib/report.cjs');
const store = require('./lib/orch-store.cjs');

const argv = process.argv.slice(2);
const KNOWN = new Set(['--once', '--watch', '--interval', '--max-ticks']);
const unknown = argv.filter((a, i) => a.startsWith('--') && !KNOWN.has(a) && !(argv[i - 1] === '--interval' || argv[i - 1] === '--max-ticks'));
const usage = `usage: ${runHint('report')} --once | --watch [--interval <minutes>] [--max-ticks <n>]`;
if (unknown.length || (!argv.includes('--once') && !argv.includes('--watch'))) {
  console.error(unknown.length ? `report: unknown option ${unknown.join(' ')}\n${usage}` : usage);
  process.exit(2);
}
const flag = (n) => {
  const i = argv.indexOf(n);
  return i === -1 ? null : argv[i + 1];
};
const loaded = profile.load(process.cwd());
if (loaded.errors.length > 0) {
  console.error(`report: PIPELINE_PROFILE.md is invalid — run ${runHint('features')}`);
  for (const e of loaded.errors) console.error(`  ${e}`);
  process.exit(2);
}
const feature = profile.feature(loaded.settings, 'reporter');
if (!feature.enabled) {
  console.log(feature.line);
  process.exit(0);
}
const cfg = feature.config;
const cwd = process.cwd();
let root = null;
try {
  root = store.orchRoot(process.env, cwd);
} catch (_) {
  root = process.env.BUILDER_ORCH_DIR ? path.resolve(process.env.BUILDER_ORCH_DIR) : null;
}
const io = () => ({ cwd, root, settings: loaded.settings, env: process.env, now: Date.now() });
const say = (r) => console.error(`report: ${r.refused ? 'refused (a secret shape) — nothing sent' : r.skipped ? 'no change — file written, nothing sent' : r.heartbeat ? 'heartbeat sent' : 'sent'}${r.failures && r.failures.length ? ` · ${r.failures.length} channel failure(s) in the log` : ''} · ${path.relative(cwd, r.file)}`);

if (argv.includes('--once')) {
  const r = await report.tick(io());
  say(r);
  process.exit(0);
}

// --watch: one watcher per project (REQ-1618)
const dir = path.resolve(cwd, cfg.reportsDir);
const lock = path.join(dir, 'watch.lock');
fs.mkdirSync(dir, { recursive: true });
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';
  }
};
let prior = null;
try {
  prior = JSON.parse(fs.readFileSync(lock, 'utf8'));
} catch (_) {
  prior = null;
}
if (prior && Number.isInteger(prior.pid) && prior.pid !== process.pid && alive(prior.pid)) {
  console.log(`reporter: a watcher is live (pid ${prior.pid}) since ${prior.startedAt} — this one exits`);
  process.exit(0);
}
if (prior && Number.isInteger(prior.pid)) console.log(`reporter: stale lease (pid ${prior.pid}) taken over`);
fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
const release = () => {
  try {
    const cur = JSON.parse(fs.readFileSync(lock, 'utf8'));
    if (cur && cur.pid === process.pid) fs.unlinkSync(lock);
  } catch (_) {
    /* gone */
  }
};
process.on('exit', release);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));

const intervalMs = (Number(flag('--interval')) || cfg.intervalMinutes) * 60000;
const maxTicks = Number(flag('--max-ticks')) || Infinity;
const alertMs = (cfg.alertOn || []).length ? cfg.alertPollSeconds * 1000 : 0;
let ticks = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
console.log(`reporter: watching · every ${intervalMs / 60000} min${alertMs ? ` · alerts ${cfg.alertOn.join(', ')} every ${cfg.alertPollSeconds} s` : ''} · ${path.relative(cwd, dir)}`);
for (;;) {
  try {
    say(await report.tick(io()));
  } catch (e) {
    console.error(`report: tick failed (${String(e && e.message ? e.message : e).split('\n')[0]}) — the next tick retries`);
  }
  ticks += 1;
  if (ticks >= maxTicks) break;
  const until = Date.now() + intervalMs;
  while (Date.now() < until) {
    await sleep(Math.min(alertMs || intervalMs, until - Date.now()));
    if (alertMs) {
      try {
        await report.alertPoll(io());
      } catch (e) {
        console.error(`report: alert poll failed (${String(e && e.message ? e.message : e).split('\n')[0]})`);
      }
    }
  }
}
release();
process.exit(0);
