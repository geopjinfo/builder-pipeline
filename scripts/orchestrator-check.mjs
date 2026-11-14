#!/usr/bin/env node
/**
 * `npx builder run orchestrator-check [--session <id>] [--transcript <file.jsonl>]`
 * (folder layout: node scripts/orchestrator-check.mjs in place of npx builder run orchestrator-check)
 *
 * Pipeline step 0: is this session on the declared orchestrator model (`models.orchestrator`)?
 * Verdict: `scripts/lib/orchestrator-check.cjs`.
 *
 * Exit codes
 *   0  as declared · unmeasured · unmeasurable · feature not configured
 *   5  diverged — a WARNING; the run may proceed if the run state records it
 *   2  the profile is invalid
 *
 * HARNESS. Observing the model needs a transcript this script can read. Only the Claude Code layout is
 * read (`features.costAccounting.reader === "claude-code"`): the session is the one named by `--session`,
 * else the `CLAUDE_CODE_SESSION_ID` environment variable (Claude Code specific — the harness exports the
 * running session's id to the shells it starts), else the project transcript written most recently (a
 * concurrent session can make that one wrong, hence the order). A session named by id that is not in this
 * checkout's folder is looked up in every project folder (a worktree run). `--transcript` reads a file directly.
 * Any other reader prints "orchestrator model: unmeasurable with this harness" and exits 0.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const profile = require('./lib/profile.cjs');
const { observe, verdict, RECENT_TURNS } = require('./lib/orchestrator-check.cjs');

const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1] ?? null;
};

const root = process.cwd();
const { settings, errors } = profile.load(root);
if (errors.length > 0) {
  console.error(`orchestrator-check: the profile is invalid —\n  ${errors.join('\n  ')}`);
  process.exit(2);
}

const feature = profile.feature(settings, 'orchestratorModel');
if (!feature.enabled) {
  console.log(feature.line);
  process.exit(0);
}

const declared = settings.models?.orchestrator ?? null;
const reader = profile.feature(settings, 'costAccounting').config.reader;
// `recentTurns` is optional; the default honours a model switch made earlier in a long session.
const recent = Number(feature.config.recentTurns) > 0 ? Number(feature.config.recentTurns) : RECENT_TURNS;

function records(file) {
  if (!file || !existsSync(file)) return [];
  const out = [];
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.includes('"assistant"')) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* a torn last line while the session is live */
    }
  }
  return out;
}

/**
 * A known session id is looked up in this checkout's transcript folder first, then in every sibling project
 * folder. WHY: the folder is derived from the working directory, and a run that works in a separate worktree
 * keeps its session transcript under the folder the session was STARTED from — so the check found nothing and
 * printed "unmeasured" with exit 0, which reads as a pass. A session id is unique across folders, so searching
 * them all cannot pick the wrong session. Only a known id is searched; the newest-file fallback stays local.
 */
function byId(dir, id) {
  const here = join(dir, `${id}.jsonl`);
  if (existsSync(here)) return here;
  const projects = dirname(dir);
  if (!existsSync(projects)) return here;
  for (const project of readdirSync(projects)) {
    const candidate = join(projects, project, `${id}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return here;
}

function sessionFile() {
  if (arg('--transcript')) return resolve(root, arg('--transcript'));
  const { transcriptDir } = require('./lib/transcript-usage.cjs');
  const dir = transcriptDir(root);
  if (arg('--session')) return byId(dir, arg('--session'));
  if (process.env.CLAUDE_CODE_SESSION_ID) return byId(dir, process.env.CLAUDE_CODE_SESSION_ID);
  if (!existsSync(dir)) return null;
  const newest = readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => ({ f, m: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m)[0];
  return newest ? join(dir, newest.f) : null;
}

const measurable = reader === 'claude-code' || Boolean(arg('--transcript'));
const result = verdict({
  declared,
  measurable,
  observed: measurable ? observe(records(sessionFile()), recent) : null,
});
console.log(result.line);
process.exit(result.code);
