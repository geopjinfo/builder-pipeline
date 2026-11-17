#!/usr/bin/env node
/**
 * secret-scan — the outbound guard's secret shapes over the tracked tree and, with history on, the added lines of
 * target..HEAD (REQ-1813, REQ-1814; D88, D89, D96). Rule and shapes: scripts/lib/secret-scan.cjs, which imports
 * SHAPES from scripts/lib/outbound-guard.cjs.
 *
 *   npx builder-pipeline run secret-scan [--defaults] [--history] [--target <ref>]
 * (folder layout: node scripts/secret-scan.mjs)
 *
 * Settings (PIPELINE_PROFILE.md §16): features.secretScan.{state, roots, allow, history, maxCommits}. Off →
 * `secretScan: not configured`, exit 3; with --defaults the scan runs with the kit's defaults and says so on the first
 * line. A finding names the kind and the place, never the text. Exit 1 on any finding (a hard check) · 0 clean · 2
 * usage, no git repository, or an invalid profile · 3 off.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runHint } = require('./lib/run-hint.cjs');
const profile = require('./lib/profile.cjs');
const cli = require('./lib/hygiene-cli.cjs');
const scan = require('./lib/secret-scan.cjs');

const USAGE = `usage: ${runHint('secret-scan')} [--defaults] [--history] [--target <ref>]`;
const args = cli.parseArgs(process.argv.slice(2), { flags: ['--defaults', '--history'], valued: ['--target'] });
const die = (m) => {
  console.error(`secret-scan: ${m} — ${USAGE}`);
  process.exit(cli.EXIT.usage);
};
if (!args.ok) die(args.error);
if (args.flags['--help'] || args.flags['-h']) {
  console.log(USAGE);
  process.exit(0);
}
const root = cli.repoRoot(process.cwd());
if (!root) die('not a git repository');
const f = cli.featureFor('secretScan', process.cwd(), { defaults: !!args.flags['--defaults'], profile, runHint });
if ('exit' in f) process.exit(f.exit);
const historyOn = !!args.flags['--history'] || f.config.history === true;
if (f.firstLine) console.log(f.firstLine);
const treeResult = scan.tree({ root, roots: f.config.roots, allow: f.config.allow });
const hist = historyOn ? scan.history({ root, target: args.flags['--target'] ?? null, maxCommits: f.config.maxCommits, allow: f.config.allow }) : null;
console.log(scan.render({ treeResult, hist, historyOn, maxCommits: f.config.maxCommits }));
process.exit(treeResult.findings.length || hist?.findings.length ? cli.EXIT.finding : cli.EXIT.ok);
