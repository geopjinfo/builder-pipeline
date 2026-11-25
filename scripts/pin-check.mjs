#!/usr/bin/env node
/**
 * pin-check — kit commands in the project's text that would fetch a package from the registry (REQ-2030; D155). Rule:
 * scripts/lib/pin-check.cjs.
 *
 *   npx builder-pipeline run pin-check [--defaults] [--json]
 * (folder layout: node scripts/pin-check.mjs)
 *
 * Settings (PIPELINE_PROFILE.md §16): features.pinCheck.{state, files, allow}. Off → `pinCheck: not configured`, exit 3;
 * with --defaults the check runs with the kit's defaults and says so on the first line. Exit 1 on an UNPINNED line (a
 * hard check) · 0 clean · 2 usage, no git repository, or an invalid profile · 3 off.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runHint } = require('./lib/run-hint.cjs');
const profile = require('./lib/profile.cjs');
const cli = require('./lib/hygiene-cli.cjs');
const pin = require('./lib/pin-check.cjs');

const USAGE = `usage: ${runHint('pin-check')} [--defaults] [--json]`;
const args = cli.parseArgs(process.argv.slice(2), { flags: ['--defaults', '--json'] });
const die = (m) => {
  console.error(`pin-check: ${m} — ${USAGE}`);
  process.exit(cli.EXIT.usage);
};
if (!args.ok) die(args.error);
if (args.flags['--help'] || args.flags['-h']) {
  console.log(USAGE);
  process.exit(0);
}
const root = cli.repoRoot(process.cwd());
if (!root) die('not a git repository');
const f = cli.featureFor('pinCheck', process.cwd(), { defaults: !!args.flags['--defaults'], profile, runHint });
if ('exit' in f) process.exit(f.exit);
if (f.firstLine) console.log(f.firstLine);
const result = pin.scan({ root, files: f.config.files, allow: f.config.allow });
console.log(args.flags['--json'] ? JSON.stringify(result, null, 2) : pin.render(result));
process.exit(result.findings.length ? cli.EXIT.finding : cli.EXIT.ok);
