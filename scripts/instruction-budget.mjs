/**
 * The root agent-instruction file stays under a line budget. Rule and its WHY: scripts/lib/instruction-budget.cjs.
 *
 *   npx builder-pipeline run instruction-budget                          every file in `files` against `maxLines`
 *   npx builder-pipeline run instruction-budget a.md b.md [--max-lines N]  exactly these files in place of `files`, against N
 *                                                                 lines (default: `maxLines`, 200 without a profile).
 *                                                                 With the feature off they are judged with the default
 *                                                                 settings and the first line says `instructionBudget:
 *                                                                 not configured — checking <files> with defaults`
 *                                                                 (REQ-704); a named file that does not exist, a flag
 *                                                                 without a valid value or an unknown flag is exit 2
 *                                                                 (REQ-706)
 * (folder layout: node scripts/instruction-budget.mjs in place of npx builder-pipeline run instruction-budget)
 *
 * Prints `path  N/max` per listed file (`MISSING/max` for an absent one), then one verdict line.
 *
 * Settings (PIPELINE_PROFILE.md §16): features.instructionBudget.{state, files, maxLines}. `files` are paths from the
 * project root, typically the root instruction file(s) only — path-scoped rule files are the overflow and carry no
 * budget of their own here. Off → "instructionBudget: not configured", exit 0, unless files are named (REQ-705).
 *
 * Exit 0 PASS, or the feature is off · 1 FAIL (a file over budget, or missing) · 2 an invalid profile or bad arguments.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runHint } = require('./lib/run-hint.cjs');
const { judge } = require('./lib/instruction-budget.cjs');
const profile = require('./lib/profile.cjs');

const args = process.argv.slice(2);
const USAGE = `usage: ${runHint('instruction-budget')} [<file.md> …] [--max-lines <n>]`;
const die = (message) => {
  console.error(`instruction-budget: ${message} — ${USAGE}`);
  process.exit(2);
};
// A bare path names the files to judge in place of `files` (DL-6 of the spec); `--max-lines <n>` replaces `maxLines`.
// A flag without a positive integer, or an unknown flag, is refused (REQ-706).
const named = [];
let maxFlag = null;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--max-lines') {
    const value = args[i + 1];
    if (!value || value.startsWith('--')) die('--max-lines needs a value');
    if (!/^[1-9]\d*$/.test(value)) die(`--max-lines <n> must be a positive integer, got "${value}"`);
    maxFlag = Number(value);
    i++;
  } else if (a.startsWith('--')) die(`unknown flag "${a}"`);
  else named.push(a.replace(/\\/g, '/').replace(/^\.\//, ''));
}

const loaded = profile.load(process.cwd());
if (loaded.errors.length > 0) {
  console.error(`instruction-budget: PIPELINE_PROFILE.md is invalid — run ${runHint('features')}`);
  for (const e of loaded.errors) console.error(`  ${e}`);
  process.exit(2);
}
const feature = profile.feature(loaded.settings, 'instructionBudget');
if (!feature.enabled && named.length === 0) {
  // No named file: the gate records "not configured" as before (REQ-705).
  console.log(feature.line);
  process.exit(0);
}
for (const p of named) if (!existsSync(p) || !statSync(p).isFile()) die(`${p} not found (a named file must exist)`);
// Named files need nothing from the profile: the budget runs with the default of 200 lines (or --max-lines) and says
// so, so a root instruction file can be judged in a project that never adopted the pipeline (REQ-704).
if (!feature.enabled) console.log(`${feature.line} — checking ${named.join(', ')} with defaults`);
const files = named.length ? named : feature.config.files;
const maxLines = maxFlag ?? feature.config.maxLines;

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
