#!/usr/bin/env node
/**
 * PreToolUse hook (matcher `ScheduleWakeup|CronCreate|Monitor`) — a pipeline run waits for no timer. CLAUDE CODE ONLY.
 *
 * WHY. The foreground rule (specs/pipeline-sizing.spec.md REQ-2004) says every seat returns in the same step and no
 * timer, wake-up or sleep waits for one. The rule is in the skill text, and the benchmark still measured 9 of 50 runs
 * on the harder bed that scheduled a wake-up (specs/pipeline-cost-2.spec.md REQ-2022). Those runs took 19.7 minutes
 * against 3 to 15 for the same tracks, and their last message was the timer's reply, so the report was lost. A rule
 * that a hook enforces is not forgotten.
 *
 * THE RULE. While a pipeline run is open, the orchestrator may not call a timer tool. A run is open when any file
 * directly under `<paths.runs>/<key>/` (state.md, run.jsonl, plan.md, the brief) was written in the last `openHours`
 * (default 12). The first batch (round-one, D152) read `state.md` alone and let 5 of 9 timer calls through: a SMALL run
 * writes no state.md and a FULL run writes it late. `features.foregroundGuard.scope` is `run` (the default) or
 * `project`: with `project` the hook denies the timer tools whenever the key is on, run or no run — the shape for a
 * checkout whose sessions exist to run the pipeline. The hook denies the call and names the rule; the orchestrator
 * dispatches the seat and waits for its return instead.
 *
 * Protocol: stdin JSON; exit 2 with the reason on stderr blocks the call; exit 0 allows it. A failure in the hook
 * allows the call. The feature key `features.foregroundGuard` gates it: off, or no trusted profile, means the hook
 * passes. Arming is a person's deliberate act: copy this file and `hook-trust.cjs` to `.claude/hooks/` and add the
 * `PreToolUse` entry running `node .claude/hooks/foreground-guard.cjs` (adapters/claude-code.md § Settings).
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const TIMER_TOOLS = ['ScheduleWakeup', 'CronCreate', 'Monitor'];
const DEFAULT_OPEN_HOURS = 12;

const SCOPES = ['run', 'project'];

/**
 * The runs under the runs folder with a file written in the last `openHours`, newest first: { key, path, mtimeMs }
 * where `path` is the newest file (state.md, run.jsonl, plan.md, a brief — anything directly in the run folder).
 */
function openRuns(root, runs, openHours, now = Date.now()) {
  const dir = path.resolve(root, runs);
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const folder = path.join(dir, e.name);
    let files = [];
    try { files = fs.readdirSync(folder, { withFileTypes: true }).filter((f) => f.isFile()); } catch { continue; }
    let newest = null;
    for (const f of files) {
      let st;
      try { st = fs.statSync(path.join(folder, f.name)); } catch { continue; }
      if (!newest || st.mtimeMs > newest.mtimeMs) newest = { key: e.name, path: path.join(folder, f.name), mtimeMs: st.mtimeMs };
    }
    if (newest && now - newest.mtimeMs <= openHours * 3600 * 1000) out.push(newest);
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * @param {object} input     the hook input (`tool_name`, `tool_input`, `cwd`, …)
 * @param {object} settings  merged pipeline settings (`features.foregroundGuard`, `paths.runs`)
 * @param {{ root?: string, now?: number }} [options]
 * @returns {{ block: false } | { block: true, reason: string }}
 */
function decide(input, settings, { root = process.cwd(), now = Date.now() } = {}) {
  if (!input || !TIMER_TOOLS.includes(input.tool_name)) return { block: false };
  const feature = settings?.features?.foregroundGuard;
  const state = feature?.state ?? 'experimental-off';
  if (!/^(on|experimental-on)$/.test(state)) return { block: false };
  const runs = String(settings?.paths?.runs ?? '.pipeline');
  const rule = '  Every seat runs in the foreground (REQ-2004, REQ-2022): dispatch it and wait for its return in the same step. No timer, wake-up or sleep waits for a seat.';
  const scope = SCOPES.includes(feature?.scope) ? feature.scope : 'run';
  if (scope === 'project') {
    return { block: true, reason: `Blocked ${input.tool_name}: features.foregroundGuard.scope is "project" — this checkout runs the pipeline, and a pipeline run waits for no timer.\n${rule}` };
  }
  const open = openRuns(root, runs, Number(feature?.openHours) > 0 ? Number(feature.openHours) : DEFAULT_OPEN_HOURS, now);
  if (!open.length) return { block: false };
  const file = path.relative(root, open[0].path).split(path.sep).join('/');
  return { block: true, reason: `Blocked ${input.tool_name}: a pipeline run is open (${file}, written in the last openHours).\n${rule}` };
}

function trustLib() {
  for (const p of [path.join(__dirname, 'hook-trust.cjs'), path.join(__dirname, 'claude-code', 'hook-trust.cjs')]) if (fs.existsSync(p)) return require(p);
  throw new Error('hook-trust.cjs not found');
}

/** The profile loader, only when it matches HEAD (hook-trust.cjs); otherwise null and the hook passes. */
function loadProfile(root) {
  try {
    const r = trustLib().load(root, __dirname, 'profile.cjs');
    return r.ok ? r.module : null;
  } catch {
    return null;
  }
}

if (require.main === module) {
  let result = { block: false };
  try {
    const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
    const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
    const profile = loadProfile(root);
    if (profile) result = decide(input, profile.load(root).settings, { root });
  } catch {
    result = { block: false };
  }
  if (result.block) {
    process.stderr.write(`${result.reason}\n`);
    process.exit(2);
  }
  process.exit(0);
}

module.exports = { decide, openRuns, TIMER_TOOLS, DEFAULT_OPEN_HOURS, SCOPES };
