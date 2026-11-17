#!/usr/bin/env node
/**
 * `npx builder-pipeline run index-check [--json]` — is the knowledge index fresh? The exit-code contract lives in
 * `scripts/lib/index-check.cjs`:
 *
 *   0 fresh · 1 error · 3 absent · 4 unmeasurable · 10 docs pending · 11 code behind · 12 both
 *
 * (folder layout: node scripts/index-check.mjs in place of npx builder-pipeline run index-check)
 *
 * Runs `features.graph.check` (any index tool's own check command) through the platform shell. The command
 * either exits with a contract code or prints one JSON facts line; the facts, when present, decide. The
 * auto-embed size limit is `features.graph.autoLimitKb`.
 *
 * Feature off → prints "graph: not configured" and exits 3, so the pipeline's "absent → record it and
 * proceed" branch applies rather than a refusal. An invalid profile exits 1.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const profile = require('./lib/profile.cjs');
const { EXIT, fromRun } = require('./lib/index-check.cjs');

const json = process.argv.includes('--json');
const root = process.cwd();

const emit = (result) => {
  if (json) console.log(JSON.stringify(result, null, 2));
  else for (const line of result.lines) console.log(line);
  process.exit(result.code);
};

const { settings, errors } = profile.load(root);
if (errors.length > 0) emit({ code: EXIT.ERROR, lines: ['index-check: the profile is invalid —', ...errors.map((e) => `  ${e}`)] });

const feature = profile.feature(settings, 'graph');
if (!feature.enabled) emit({ code: EXIT.ABSENT, lines: [feature.line] });

const run = spawnSync(feature.config.check, { cwd: root, shell: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true });
if (run.status !== 0 && run.stderr) process.stderr.write(run.stderr.trim().split(/\r?\n/).slice(-10).join('\n') + '\n');
emit(fromRun({ spawnError: Boolean(run.error), status: run.status, stdout: run.stdout }, { autoLimitKb: feature.config.autoLimitKb }));
