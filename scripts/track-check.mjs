#!/usr/bin/env node
/**
 * track-check — is this change SMALL? (specs/pipeline-sizing.spec.md REQ-2008, D134, D135). Rule and counting:
 * scripts/lib/track-check.cjs.
 *
 *   npx builder-pipeline run track-check --since <base> [--max-files 4] [--medium [6]] [--solo [2]] [--shared a,b] [--src src,lib,app] [--json]
 * (folder layout: node scripts/track-check.mjs …)
 *
 * Counts the production source files and module directories changed since <base> (committed, staged, unstaged and
 * untracked), ignoring tests, docs, boards, ledgers and lock files. Prints `SMALL: n source files in m module(s)` and
 * exits 0 when every limit holds; otherwise one `ESCALATE: <reason>` line per broken limit and exit 1. Exit 2 outside
 * a git repository, on an unknown base or on a bad argument. A free check: no profile feature, no off state.
 *
 * `--medium [N]` (specs/pipeline-cost.spec.md REQ-2018): a diff past a SMALL limit that stays at or under N files
 * (default 6) in one module, with no dependency change and at most one new migration, prints `MEDIUM: … — <reading>`
 * and exits 3. `--solo [N]`: at most N files (default 2) in one module, no dependency change, no migration, prints
 * `SOLO: …` and exits 0. Pass each flag only when its §16 feature (mediumTrack, soloTrack) is on.
 *
 * `--shared <a,b>` (specs/pipeline-cost-2.spec.md REQ-2024): the shared catalogue files of profile §5. A file in the
 * list that only gained lines counts as a file but not as a second module; the line names it as a shared addition.
 * Under `--medium`, `--json` carries the auditor the reading requires (REQ-2027).
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runHint } = require('./lib/run-hint.cjs');
const lib = require('./lib/track-check.cjs');

const USAGE = `usage: ${runHint('track-check')} --since <base> [--max-files ${lib.DEFAULT_MAX_FILES}] [--medium [${lib.DEFAULT_MEDIUM_FILES}]] [--solo [${lib.DEFAULT_SOLO_FILES}]] [--shared <file,file>] [--src <dir,dir>] [--json]`;
const fail = (msg) => {
  console.error(`track-check: ${msg} — ${USAGE}`);
  process.exit(2);
};

const argv = process.argv.slice(2);
const opts = { since: null, maxFiles: lib.DEFAULT_MAX_FILES, medium: null, solo: null, shared: [], src: lib.DEFAULT_SRC, json: false };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const value = () => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('-')) fail(`${a} needs a value`);
    i++;
    return v;
  };
  /** An optional whole-number value: `--medium` alone takes the default, `--medium 8` takes 8. */
  const optional = (dflt) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('-')) return dflt;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1) fail(`${a} needs a whole number of 1 or more`);
    i++;
    return n;
  };
  if (a === '--help' || a === '-h') {
    console.log(USAGE);
    process.exit(0);
  } else if (a === '--since') opts.since = value();
  else if (a === '--max-files') {
    const n = Number(value());
    if (!Number.isInteger(n) || n < 1) fail('--max-files needs a whole number of 1 or more');
    opts.maxFiles = n;
  } else if (a === '--medium') opts.medium = optional(lib.DEFAULT_MEDIUM_FILES);
  else if (a === '--solo') opts.solo = optional(lib.DEFAULT_SOLO_FILES);
  else if (a === '--shared') opts.shared = value().split(',').map((s) => s.trim()).filter(Boolean);
  else if (a === '--src') opts.src = value().split(',').map((s) => s.trim()).filter(Boolean);
  else if (a === '--json') opts.json = true;
  else fail(`unknown flag "${a}"`);
}
if (!opts.since) fail('--since <base> is required');

const root = lib.repoRoot(process.cwd());
if (!root) fail('not a git repository');

const result = lib.check({ root, since: opts.since, maxFiles: opts.maxFiles, medium: opts.medium, solo: opts.solo, shared: opts.shared, src: opts.src });
if (!result.ok) fail(result.error);
if (opts.json) console.log(JSON.stringify(result, null, 2));
else console.log(lib.render(result));
process.exit(lib.exitCode(result.track));
