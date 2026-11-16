/**
 * Check a module's spec before Phase 1, and write what it feeds forward. Rules: scripts/lib/spec-check.cjs.
 *
 *   npx builder run spec-check <module-key | path/to.spec.md> [--ratified] [--pack] [--rows] [--contract <out.json>]
 * (folder layout: node scripts/spec-check.mjs in place of npx builder run spec-check)
 *
 *   --ratified   refuse a draft (the pipeline's gate before Phase 1)
 *   --pack       print the requirement-pack skeleton (templates/requirement-pack.md shape)
 *   --rows       print one CSV row per requirement (the §3 requirements-tracker rows)
 *   --contract   write the api-contract block to <out.json> — the file features.contractOracle.spec points at
 *
 * Settings (PIPELINE_PROFILE.md §16): features.specAuthoring.{state, dir, idPattern} · paths.decisions ·
 * paths.registry · features.handoffPack.decisionIdPattern · features.claims.registryIdPattern.
 *
 * Exit 0 PASS (or the feature is off) · 1 FAIL · 2 usage, no such spec or an invalid profile.
 * With the feature off, a spec named by its .md PATH is still checked, with the default settings (a module KEY is not:
 * it needs `dir`). The first line then says `specAuthoring: not configured — checking <file> with defaults`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { readContext } from './handoff-check.mjs';

const require = createRequire(import.meta.url);
const { runHint } = require('./lib/run-hint.cjs');
const lib = require('./lib/spec-check.cjs');
const profile = require('./lib/profile.cjs');

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const args = process.argv.slice(2);
  const target = args.find((a) => !a.startsWith('--'));
  const flag = (f) => args.includes(f);
  const contractOut = args.includes('--contract') ? args[args.indexOf('--contract') + 1] : null;
  if (!target || (args.includes('--contract') && (!contractOut || contractOut.startsWith('--')))) {
    console.error(`usage: ${runHint('spec-check')} <module-key | spec.md> [--ratified] [--pack] [--rows] [--contract <out.json>]`);
    process.exit(2);
  }
  const loaded = profile.load(process.cwd());
  if (loaded.errors.length > 0) {
    console.error(`spec-check: PIPELINE_PROFILE.md is invalid — run ${runHint('features')}`);
    for (const e of loaded.errors) console.error(`  ${e}`);
    process.exit(2);
  }
  const feature = profile.feature(loaded.settings, 'specAuthoring');
  const isPath = /\.md$/i.test(target);
  if (!feature.enabled && !isPath) {
    // A module key needs `dir` from the feature; with it off, step 0.7 records "not configured" as before (REQ-402).
    console.log(feature.line);
    process.exit(0);
  }
  const file = isPath ? target : join(feature.config.dir, `${target}.spec.md`);
  const shown = relative(process.cwd(), resolve(file)).split('\\').join('/');
  // A spec named by its path needs nothing from the profile: the checker runs with the default id shape, and says
  // so, so one spec can be checked in a project that never adopted the pipeline (REQ-401).
  if (!feature.enabled) console.log(`${feature.line} — checking ${shown} with defaults`);
  if (!existsSync(file)) {
    console.error(`spec-check: no spec at ${shown} — author one from the installed spec template (the spec-author skill)`);
    process.exit(2);
  }
  // The decision workspace and registry are the same ones the handoff checker reads.
  const handoffFeature = profile.feature(loaded.settings, 'handoffPack');
  const ctx = readContext(loaded.settings, { ...handoffFeature, config: { ...handoffFeature.config, tracker: null } });
  const text = readFileSync(file, 'utf8');
  const result = lib.checkSpec(text, { ...ctx, idPattern: feature.config.idPattern, requireRatified: flag('--ratified') });
  for (const e of result.errors) console.log(`  ${e}`);
  if (result.errors.length > 0) {
    console.log(`spec-check: FAIL — ${result.errors.length} problem(s); ${shown} cannot feed Phase 1`);
    process.exit(1);
  }
  if (result.pending.length > 0) {
    console.log(`before ratification (${result.pending.length}):`);
    for (const p of result.pending) console.log(`  ${p}`);
  }
  if (flag('--pack')) process.stdout.write(lib.packSkeleton(text));
  if (flag('--rows')) process.stdout.write(lib.rowsCsv(text, shown));
  if (contractOut) {
    const { document } = lib.contractOf(text);
    if (!document) console.log('no api-contract block — nothing written');
    else {
      mkdirSync(dirname(resolve(contractOut)), { recursive: true });
      writeFileSync(contractOut, JSON.stringify(document, null, 2) + '\n');
      console.log(`wrote ${contractOut.split('\\').join('/')} — point features.contractOracle.spec at it`);
    }
  }
  console.log(`spec-check: PASS — ${shown} (${result.status})`);
}
