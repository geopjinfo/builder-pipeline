/**
 * What this project has switched on — `node scripts/features.mjs`.
 *
 * Loads PIPELINE_PROFILE.md from the current directory, prints one line per feature (the same sentence each step
 * prints when it runs), then every validation error. Silence about a feature must never read as "on and passing",
 * so every feature the pack knows gets its line, including the ones the profile never mentions.
 *
 * Exit 0 the profile is valid (or absent — defaults in use) · 1 the profile is invalid.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const profile = require('./lib/profile.cjs');

const loaded = profile.load(process.cwd());
if (!existsSync(loaded.path)) console.log('no PIPELINE_PROFILE.md — defaults in use');
else if (!loaded.found) console.log('PIPELINE_PROFILE.md has no pipeline-settings block — defaults in use');
else console.log('PIPELINE_PROFILE.md — pipeline-settings loaded');

for (const name of Object.keys(profile.FEATURES)) console.log(profile.feature(loaded.settings, name).line);

if (loaded.errors.length > 0) {
  console.log(`\n${loaded.errors.length} validation error(s):`);
  for (const e of loaded.errors) console.log(`  ${e}`);
  console.log('features: INVALID — fix the profile, or set a feature\'s state to "off"');
  process.exit(1);
}
console.log('features: profile valid');
