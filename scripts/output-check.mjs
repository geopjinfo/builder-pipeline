/**
 * Fixed seat output formats. Rules: scripts/lib/output-check.cjs.
 *
 *   node scripts/output-check.mjs plan <runs>/<key>/plan.md
 *   node scripts/output-check.mjs findings <runs>/<key>/findings-<seat>.json [--diff-base <ref>]
 *   node scripts/output-check.mjs review <runs>/<key>/review-pass<n>.md
 *
 * Settings (PIPELINE_PROFILE.md): features.planSchema.{state, sections, tables, taskColumns, oracle} —
 * oracle = { table, column, source, keyColumn }: every cell of that plan column must be a value of the source CSV's
 * key column · features.findingsSchema.state · features.reviewTemplate.state. A feature that is off prints
 * "<feature>: not configured" and exits 0.
 *
 * Exit 0 well-formed (or not configured) · 1 malformed (each error printed) · 2 usage or an invalid profile.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runHint } = require('./lib/run-hint.cjs');
const { checkPlan, checkFindings, checkReview, csvColumn } = require('./lib/output-check.cjs');
const profile = require('./lib/profile.cjs');

const argv = process.argv.slice(2);
const [kind, file] = argv;
const FEATURE = { plan: 'planSchema', findings: 'findingsSchema', review: 'reviewTemplate' };
if (!FEATURE[kind] || !file) {
  console.error(`usage: ${runHint('output-check')} <plan|findings|review> <file> [--diff-base <ref>]`);
  process.exit(2);
}

const loaded = profile.load(process.cwd());
if (loaded.errors.length > 0) {
  console.error(`output-check: PIPELINE_PROFILE.md is invalid — run ${runHint('features')}`);
  for (const e of loaded.errors) console.error(`  ${e}`);
  process.exit(2);
}
const feature = profile.feature(loaded.settings, FEATURE[kind]);
if (!feature.enabled) {
  console.log(feature.line);
  process.exit(0);
}

if (!existsSync(file)) {
  console.error(`${kind}-check: no such file ${file}`);
  process.exit(1);
}
const text = readFileSync(file, 'utf8');
let errors = [];
if (kind === 'plan') {
  const { sections, tables, taskColumns, oracle } = feature.config;
  let oracleKeys;
  if (oracle) {
    // A configured oracle that cannot be read is a failure, not a skip: "never invent a key" is only enforced if
    // the key list is actually loaded.
    if (!oracle.source || !existsSync(oracle.source)) errors.push(`oracle: source ${oracle.source ?? '(unset)'} does not exist`);
    else {
      try {
        oracleKeys = csvColumn(readFileSync(oracle.source, 'utf8'), oracle.keyColumn);
      } catch (e) {
        errors.push(`oracle: ${oracle.source} — ${e.message}`);
      }
    }
  }
  errors.push(...checkPlan(text, { sections, tables, taskColumns, oracle, oracleKeys }));
} else if (kind === 'findings') {
  let data = null;
  try {
    data = JSON.parse(text);
  } catch (e) {
    errors = [`not valid JSON: ${e.message}`];
  }
  if (data) {
    const i = argv.indexOf('--diff-base');
    let diffFiles;
    if (i !== -1) {
      try {
        diffFiles = new Set(execFileSync('git', ['diff', '--name-only', argv[i + 1]], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean));
      } catch (e) {
        console.error(`findings-check: git diff --name-only ${argv[i + 1]} failed — ${e.message.split(/\r?\n/)[0]}`);
        process.exit(2);
      }
    }
    errors = checkFindings(data, { exists: existsSync, diffFiles });
  }
} else {
  errors = checkReview(text);
}
for (const e of errors) console.log(`  ${e}`);
console.log(errors.length === 0 ? `${kind}-check: PASS — ${file}` : `${kind}-check: FAIL — ${errors.length} problem(s) in ${file}`);
process.exit(errors.length === 0 ? 0 : 1);
