/**
 * What this project has switched on — `npx builder-pipeline run features`.
 * (folder layout: node scripts/features.mjs in place of npx builder-pipeline run features)
 *
 * Loads PIPELINE_PROFILE.md from the current directory (or, without one, the config file named by BUILDER_CONFIG or
 * builder.config.json — REQ-101), prints one line per feature (the same sentence each step
 * prints when it runs), then every validation error. Silence about a feature must never read as "on and passing",
 * so every feature the pack knows gets its line, including the ones the profile never mentions.
 *
 * Exit 0 the profile is valid (or absent — defaults in use) · 1 the profile is invalid.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { relative } from 'node:path';

const require = createRequire(import.meta.url);
const profile = require('./lib/profile.cjs');

const loaded = profile.load(process.cwd());
const shown = (p) => {
  const r = relative(process.cwd(), p).split('\\').join('/');
  return r && !r.startsWith('..') ? r : p;
};
if (loaded.source === 'config') console.log(`no PIPELINE_PROFILE.md — settings from ${shown(loaded.configPath)}`);
else if (!existsSync(loaded.path)) console.log('no PIPELINE_PROFILE.md — defaults in use');
else if (!loaded.found) console.log('PIPELINE_PROFILE.md has no pipeline-settings block — defaults in use');
else console.log('PIPELINE_PROFILE.md — pipeline-settings loaded');
for (const n of loaded.notes ?? []) console.log(n);

// REQ-1401: the decision row of EXPERIMENTS.md beside every experimental or unmeasured flag, read from the kit's own copy.
let experiments = '';
try {
  experiments = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'EXPERIMENTS.md'), 'utf8');
} catch {
  experiments = '';
}
const { decisionFor } = require('./lib/experiments.cjs');
for (const name of Object.keys(profile.FEATURES)) {
  const f = profile.feature(loaded.settings, name);
  const d = /^(experimental-off|experimental-on|unmeasured)$/.test(f.state) && experiments ? decisionFor(experiments, name, profile.FEATURES[name].experiment || profile.FEATURES[name].decisionSection || null) : null;
  console.log(d ? `${f.line} · decision: ${d.verdict} (${d.date})` : f.line);
}

if (loaded.errors.length > 0) {
  console.log(`\n${loaded.errors.length} validation error(s):`);
  for (const e of loaded.errors) console.log(`  ${e}`);
  console.log(`features: INVALID — fix the ${loaded.source === 'config' ? 'config file' : 'profile'}, or set a feature's state to "off"`);
  process.exit(1);
}
console.log('features: profile valid');
