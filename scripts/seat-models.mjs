#!/usr/bin/env node
/**
 * seat-models — do the installed seats run the models profile §16 declares? (specs/pipeline-cost-3.spec.md REQ-2029,
 * D151). Rule and reading: scripts/lib/seat-models.cjs.
 *
 *   npx builder-pipeline run seat-models [--write] [--json]
 * (folder layout: node scripts/seat-models.mjs …)
 *
 * Reads `models.strong` / `models.mid` from PIPELINE_PROFILE.md §16 and the `model:` line of every kit agent under
 * `.claude/agents/`. Prints `seat models: in step — …` and exits 0 when every agent runs the model its tier declares,
 * or one `DRIFT: <file> runs <model>, profile §16 declares <tier>=<model>` line per agent and exits 1. `--write`
 * rewrites the drifted lines (and the builder.lock.json hashes) and exits 0. A tier the profile does not declare is
 * in step by definition; a profile without models prints one line and exits 0. Exit 2 on an invalid profile.
 * A free check: no §16 feature, no off state. Claude Code only — other harnesses read §12 at dispatch time.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { runHint } = require('./lib/run-hint.cjs');
const profile = require('./lib/profile.cjs');
const lib = require('./lib/seat-models.cjs');

const argv = process.argv.slice(2);
const USAGE = `usage: ${runHint('seat-models')} [--write] [--json]`;
for (const a of argv) if (!['--write', '--json'].includes(a)) { console.error(`seat-models: unknown argument ${a}\n${USAGE}`); process.exit(2); }

const root = process.cwd();
const kitRoot = process.env.BUILDER_KIT_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..');
const { settings, errors } = profile.load(root);
const fatal = errors.filter((e) => !/unfilled placeholder/.test(e));
if (fatal.length) {
  console.error(`seat-models: the profile is invalid —\n  ${fatal.join('\n  ')}`);
  process.exit(2);
}

const result = lib.check(root, kitRoot, settings);
const written = argv.includes('--write') ? lib.write(root, result) : [];
const after = written.length ? lib.check(root, kitRoot, settings) : result;
if (argv.includes('--json')) console.log(JSON.stringify({ ...after, written }, null, 2));
else {
  for (const f of written) console.log(`written: ${f}`);
  for (const line of lib.render(after)) console.log(line);
}
process.exit(after.drift.length ? 1 : 0);
