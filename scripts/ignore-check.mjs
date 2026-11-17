#!/usr/bin/env node
/**
 * ignore-check — files git tracks but should ignore, and untracked junk nothing ignores (REQ-1811, D97). Rule and
 * catalogue: scripts/lib/ignore-check.cjs.
 *
 *   npx builder-pipeline run ignore-check [--defaults]
 * (folder layout: node scripts/ignore-check.mjs)
 *
 * Settings (PIPELINE_PROFILE.md §16): features.ignoreCheck.{state, extra, allow}. Off → `ignoreCheck: not configured`,
 * exit 3; with --defaults the check runs with the kit's defaults and says so on the first line. It prints the
 * .gitignore lines to add and never writes the file. Exit 0 with or without findings (a soft check, D89) · 2 usage,
 * no git repository, or an invalid profile · 3 off.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runHint } = require('./lib/run-hint.cjs');
const profile = require('./lib/profile.cjs');
const cli = require('./lib/hygiene-cli.cjs');
const check = require('./lib/ignore-check.cjs');

const USAGE = `usage: ${runHint('ignore-check')} [--defaults]`;
const args = cli.parseArgs(process.argv.slice(2), { flags: ['--defaults'] });
if (!args.ok) {
  console.error(`ignore-check: ${args.error} — ${USAGE}`);
  process.exit(cli.EXIT.usage);
}
if (args.flags['--help'] || args.flags['-h']) {
  console.log(USAGE);
  process.exit(0);
}
const root = cli.repoRoot(process.cwd());
if (!root) {
  console.error(`ignore-check: not a git repository — ${USAGE}`);
  process.exit(cli.EXIT.usage);
}
const f = cli.featureFor('ignoreCheck', process.cwd(), { defaults: !!args.flags['--defaults'], profile, runHint });
if ('exit' in f) process.exit(f.exit);
if (f.firstLine) console.log(f.firstLine);
console.log(check.render(check.check({ root, extra: f.config.extra, allow: f.config.allow })));
process.exit(cli.EXIT.ok);
