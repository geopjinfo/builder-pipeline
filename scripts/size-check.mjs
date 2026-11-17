#!/usr/bin/env node
/**
 * size-check — tracked files over the limit, and (history on) large blobs in the history (REQ-1812; D89, D96). Rule:
 * scripts/lib/size-check.cjs.
 *
 *   npx builder-pipeline run size-check [--defaults] [--max-kb N] [--history] [--target <ref>]
 * (folder layout: node scripts/size-check.mjs)
 *
 * Settings (PIPELINE_PROFILE.md §16): features.sizeCheck.{state, maxFileKb, history, maxCommits, allow}. Off →
 * `sizeCheck: not configured`, exit 3; with --defaults the check runs with the kit's defaults and says so on the first
 * line. Exit 1 on a LARGE file in the tree (a hard check) · 0 clean (LARGE-HISTORY is reported, never failed) · 2 usage,
 * no git repository, or an invalid profile · 3 off.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runHint } = require('./lib/run-hint.cjs');
const profile = require('./lib/profile.cjs');
const cli = require('./lib/hygiene-cli.cjs');
const size = require('./lib/size-check.cjs');

const USAGE = `usage: ${runHint('size-check')} [--defaults] [--max-kb N] [--history] [--target <ref>]`;
const args = cli.parseArgs(process.argv.slice(2), { flags: ['--defaults', '--history'], valued: ['--max-kb', '--target'] });
const die = (m) => {
  console.error(`size-check: ${m} — ${USAGE}`);
  process.exit(cli.EXIT.usage);
};
if (!args.ok) die(args.error);
if (args.flags['--help'] || args.flags['-h']) {
  console.log(USAGE);
  process.exit(0);
}
const root = cli.repoRoot(process.cwd());
if (!root) die('not a git repository');
const f = cli.featureFor('sizeCheck', process.cwd(), { defaults: !!args.flags['--defaults'], profile, runHint });
if ('exit' in f) process.exit(f.exit);
const maxFileKb = args.flags['--max-kb'] !== undefined ? Number(args.flags['--max-kb']) : f.config.maxFileKb;
if (!Number.isFinite(maxFileKb) || maxFileKb <= 0) die('--max-kb must be a number > 0');
const historyOn = !!args.flags['--history'] || f.config.history === true;
const target = args.flags['--target'] ?? 'HEAD';
if (f.firstLine) console.log(f.firstLine);
const treeFindings = size.tree({ root, maxFileKb, allow: f.config.allow });
const hist = historyOn ? size.history({ root, maxFileKb, target, maxCommits: f.config.maxCommits, allow: f.config.allow, exclude: treeFindings.map((t) => t.path) }) : null;
console.log(size.render({ maxFileKb, treeFindings, hist, historyOn }));
process.exit(treeFindings.length ? cli.EXIT.finding : cli.EXIT.ok);
