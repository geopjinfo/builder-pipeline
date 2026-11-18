#!/usr/bin/env node
/**
 * track-check — is this change SMALL? (specs/pipeline-sizing.spec.md REQ-2008, D134, D135). Rule and counting:
 * scripts/lib/track-check.cjs.
 *
 *   npx builder-pipeline run track-check --since <base> [--max-files 4] [--src src,lib,app] [--json]
 * (folder layout: node scripts/track-check.mjs …)
 *
 * Counts the production source files and module directories changed since <base> (committed, staged, unstaged and
 * untracked), ignoring tests, docs, boards, ledgers and lock files. Prints `SMALL: n source files in m module(s)` and
 * exits 0 when every limit holds; otherwise one `ESCALATE: <reason>` line per broken limit and exit 1. Exit 2 outside
 * a git repository, on an unknown base or on a bad argument. A free check: no profile feature, no off state.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runHint } = require('./lib/run-hint.cjs');
const lib = require('./lib/track-check.cjs');

const USAGE = `usage: ${runHint('track-check')} --since <base> [--max-files ${lib.DEFAULT_MAX_FILES}] [--src <dir,dir>] [--json]`;
const fail = (msg) => {
  console.error(`track-check: ${msg} — ${USAGE}`);
  process.exit(2);
};

const argv = process.argv.slice(2);
const opts = { since: null, maxFiles: lib.DEFAULT_MAX_FILES, src: lib.DEFAULT_SRC, json: false };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const value = () => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('-')) fail(`${a} needs a value`);
    i++;
    return v;
  };
  if (a === '--help' || a === '-h') {
    console.log(USAGE);
    process.exit(0);
  } else if (a === '--since') opts.since = value();
  else if (a === '--max-files') {
    const n = Number(value());
    if (!Number.isInteger(n) || n < 1) fail('--max-files needs a whole number of 1 or more');
    opts.maxFiles = n;
  } else if (a === '--src') opts.src = value().split(',').map((s) => s.trim()).filter(Boolean);
  else if (a === '--json') opts.json = true;
  else fail(`unknown flag "${a}"`);
}
if (!opts.since) fail('--since <base> is required');

const root = lib.repoRoot(process.cwd());
if (!root) fail('not a git repository');

const result = lib.check({ root, since: opts.since, maxFiles: opts.maxFiles, src: opts.src });
if (!result.ok) fail(result.error);
if (opts.json) console.log(JSON.stringify(result, null, 2));
else console.log(lib.render(result));
process.exit(result.track === 'SMALL' ? 0 : 1);
