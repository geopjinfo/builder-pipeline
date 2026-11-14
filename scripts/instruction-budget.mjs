/**
 * The root agent-instruction file stays under a line budget. Rule and its WHY: scripts/lib/instruction-budget.cjs.
 *
 *   npx builder run instruction-budget
 * (folder layout: node scripts/instruction-budget.mjs in place of npx builder run instruction-budget)
 *
 * Prints `path  N/max` per listed file (`MISSING/max` for an absent one), then one verdict line.
 *
 * Settings (PIPELINE_PROFILE.md §16): features.instructionBudget.{state, files, maxLines}. `files` are paths from the
 * project root, typically the root instruction file(s) only — path-scoped rule files are the overflow and carry no
 * budget of their own here. Off → "instructionBudget: not configured", exit 0.
 *
 * Exit 0 PASS, or the feature is off · 1 FAIL (a file over budget, or missing) · 2 an invalid profile.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runHint } = require('./lib/run-hint.cjs');
const { judge } = require('./lib/instruction-budget.cjs');
const profile = require('./lib/profile.cjs');

const loaded = profile.load(process.cwd());
if (loaded.errors.length > 0) {
  console.error(`instruction-budget: PIPELINE_PROFILE.md is invalid — run ${runHint('features')}`);
  for (const e of loaded.errors) console.error(`  ${e}`);
  process.exit(2);
}
const feature = profile.feature(loaded.settings, 'instructionBudget');
if (!feature.enabled) {
  console.log(feature.line);
  process.exit(0);
}
const { files, maxLines } = feature.config;

const entries = files.map((path) => ({
  path: path.replace(/\\/g, '/'),
  text: existsSync(path) && statSync(path).isFile() ? readFileSync(path, 'utf8') : null,
}));
const verdict = judge(entries, maxLines);

const width = Math.max(0, ...verdict.rows.map((r) => r.path.length));
for (const r of verdict.rows) console.log(`${r.path.padEnd(width)}  ${r.lines === null ? 'MISSING' : r.lines}/${maxLines}${r.over ? '  OVER' : ''}`);
for (const p of verdict.problems) console.log(`  ${p}`);
console.log(
  verdict.ok
    ? `instruction-budget: PASS — ${verdict.rows.length} file(s) within ${maxLines} lines`
    : `instruction-budget: FAIL — ${verdict.problems.length} problem(s)`,
);
process.exit(verdict.ok ? 0 : 1);
