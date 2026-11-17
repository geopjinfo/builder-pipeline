#!/usr/bin/env node
/**
 * Paths, links, anchors and `run <name>` commands in the project's documents resolve (specs/repo-hygiene.spec.md
 * REQ-1822, D92). Rule and its WHY: scripts/lib/docs-check.cjs.
 *
 *   npx builder-pipeline run docs-check [FILE|DIR ...] [--json]
 * (folder layout: node scripts/docs-check.mjs in place of npx builder-pipeline run docs-check)
 *
 * Reads every Markdown file under features.docsCheck.roots (default README.md and docs/) and prints one line per
 * finding — `KIND file:line: target — detail` — then one summary line. External URLs are never fetched. Settings
 * (PIPELINE_PROFILE.md §16): features.docsCheck.{state, roots, ignorePaths}.
 *
 * Off → "docsCheck: not configured", exit 3 (the hygiene invariant: off is never a pass). With the feature off and files
 * or folders named on the command line, the check runs over them with the default settings and says so on the first
 * line (the standalone form). Exit 0 clean · 1 a finding · 2 usage or an invalid profile · 3 not configured.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runHint } = require('./lib/run-hint.cjs');
const docs = require('./lib/docs-check.cjs');
const profile = require('./lib/profile.cjs');

const argv = process.argv.slice(2);
const USAGE = `usage: ${runHint('docs-check')} [FILE|DIR ...] [--json]`;
const die = (message) => {
  console.error(`docs-check: ${message} — ${USAGE}`);
  process.exit(2);
};
const known = new Set(['--json', '--help', '-h']);
const unknown = argv.filter((a) => a.startsWith('-') && !known.has(a));
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(USAGE);
  process.exit(0);
}
if (unknown.length) die(`unknown flag "${unknown[0]}"`);
const named = argv.filter((a) => !a.startsWith('-'));
const json = argv.includes('--json');

const root = process.cwd();
const loaded = profile.load(root);
if (loaded.errors.length > 0) {
  console.error(`docs-check: PIPELINE_PROFILE.md is invalid — run ${runHint('features')}`);
  for (const e of loaded.errors) console.error(`  ${e}`);
  process.exit(2);
}
const feature = profile.feature(loaded.settings, 'docsCheck');
const standalone = !feature.enabled && named.length > 0;
if (!feature.enabled && !standalone) {
  console.log(feature.line);
  process.exit(3);
}
// With the feature off only the defaults apply: a config file beside the project has not turned the check on.
const cfg = standalone ? { ...profile.FEATURES.docsCheck.defaults } : feature.config;
const roots = named.length ? named : cfg.roots;
if (standalone) console.log(`${feature.line} — checking ${named.join(', ')} with defaults`);

const paths = docs.markdownFiles(root, roots);
const files = paths.map((p) => ({ path: p, text: docs.read(root, p) }));
const result = docs.check(files, { root, scripts: docs.shippedScripts(), ignorePaths: cfg.ignorePaths ?? [] });
if (json) {
  console.log(JSON.stringify({ ok: result.ok, files: paths, findings: result.findings }, null, 2));
} else {
  if (files.length === 0) console.log('docs-check: no Markdown file under the roots — a check over nothing asserts nothing');
  for (const f of result.findings) console.log(`${f.kind} ${f.file}:${f.line}: ${f.target} — ${f.detail}`);
  const n = result.findings.length;
  console.log(result.ok ? `docs-check: PASS — ${files.length} Markdown file${files.length === 1 ? '' : 's'}, no finding` : `docs-check: FAIL — ${n} finding${n === 1 ? '' : 's'} in ${files.length} file${files.length === 1 ? '' : 's'}`);
}
process.exit(result.ok && files.length > 0 ? 0 : 1);
