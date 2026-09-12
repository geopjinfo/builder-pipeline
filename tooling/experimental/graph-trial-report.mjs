#!/usr/bin/env node
/**
 * EXPERIMENTAL (`features.graphTrial`) — per-seat knowledge-index usage over one or more sessions.
 * CLAUDE CODE TRANSCRIPTS ONLY; see EXPERIMENTS.md, graph seat trial. Rule: graph-trial.cjs.
 *
 *   node scripts/experimental/graph-trial-report.mjs <sessionId>… [--dir <transcripts dir>] [--json]
 *
 * Installed by `node builder/cli.js unpack --experimental` beside `graph-trial.cjs` in `scripts/experimental/`.
 *
 * Reads the harness transcripts, never the seats' own accounting: `<dir>/<session>.jsonl` for the orchestrator
 * (sidechain records excluded) and `<dir>/<session>/subagents/agent-*.jsonl` + `.meta.json` for every
 * dispatched seat. `--dir` overrides the harness's per-project transcript directory.
 *
 * Settings: features.graphTrial.seats (the trial group; every other seat is control and should read 0) ·
 * features.graphTrial.callPattern (a regular expression; capture 1 = subcommand).
 *
 * Exit 0 report printed (also when the feature is not enabled) · 1 a named session transcript is missing ·
 * 2 usage, or an invalid profile.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
/** A pack lib: `scripts/lib/` beside an installed copy, or the pack's own `scripts/lib/` when run in the pack. */
const lib = (name) => [join(here, '..', 'lib', name), join(here, '..', '..', 'scripts', 'lib', name)].find((p) => existsSync(p));
const profile = require(lib('profile.cjs'));
const { transcriptDir } = require(lib('transcript-usage.cjs'));
const { seatRow, withoutSidechain, summarise, renderMarkdown } = require(join(here, 'graph-trial.cjs'));

const USAGE = 'usage: node scripts/experimental/graph-trial-report.mjs <sessionId>… [--dir <transcripts dir>] [--json]';

const loaded = profile.load(process.cwd());
if (loaded.errors.length > 0) {
  console.error('graph-trial-report: PIPELINE_PROFILE.md is invalid — run node scripts/features.mjs');
  for (const e of loaded.errors) console.error(`  ${e}`);
  process.exit(2);
}
const feature = profile.feature(loaded.settings, 'graphTrial');
if (!feature.enabled) {
  console.log(feature.line);
  process.exit(0);
}
const { seats, callPattern } = feature.config;

const args = process.argv.slice(2);
const dirAt = args.indexOf('--dir');
if (dirAt !== -1 && (!args[dirAt + 1] || args[dirAt + 1].startsWith('--'))) {
  console.error(USAGE);
  process.exit(2);
}
const unknown = args.filter((a, i) => a.startsWith('--') && a !== '--dir' && a !== '--json' && i !== dirAt + 1);
const sessions = args.filter((a, i) => !a.startsWith('--') && !(dirAt !== -1 && i === dirAt + 1));
if (sessions.length === 0 || unknown.length > 0) {
  console.error(USAGE);
  process.exit(2);
}

const dir = dirAt !== -1 ? resolve(args[dirAt + 1]) : transcriptDir();
const posix = (p) => p.replace(/\\/g, '/');
const lines = (file) => readFileSync(file, 'utf8').split(/\r?\n/);
const rows = [];

for (const session of sessions) {
  const main = join(dir, `${session}.jsonl`);
  if (!existsSync(main)) {
    console.error(`graph-trial-report: no transcript ${posix(main)}`);
    process.exit(1);
  }
  rows.push({ session, ...seatRow('orchestrator', withoutSidechain(lines(main)), callPattern, seats) });

  const subagents = join(dir, session, 'subagents');
  if (!existsSync(subagents)) continue;
  for (const name of readdirSync(subagents).filter((f) => f.endsWith('.jsonl')).sort()) {
    let agentType = 'unknown';
    try {
      agentType = JSON.parse(readFileSync(join(subagents, name.replace(/\.jsonl$/, '.meta.json')), 'utf8')).agentType ?? 'unknown';
    } catch {
      /* meta missing or torn — keep the row and name the seat unknown; dropping it would hide its calls */
    }
    rows.push({ session, ...seatRow(agentType, lines(join(subagents, name)), callPattern, seats) });
  }
}

if (args.includes('--json')) {
  console.log(JSON.stringify({ feature: feature.line, seats, rows, summary: summarise(rows) }, null, 2));
  process.exit(0);
}
console.log(feature.line);
console.log(renderMarkdown(rows));
