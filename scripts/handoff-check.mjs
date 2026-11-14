/**
 * Refuse a handoff pack until every section is complete. Rules: scripts/lib/handoff-check.cjs.
 *
 *   node scripts/handoff-check.mjs <paths.handoffs>/<date>-<key>-handoff.md
 *
 * Settings (PIPELINE_PROFILE.md): paths.decisions (a file or a directory of .md files — any decision id either
 * mentions counts as existing) · paths.registry · features.claims.registryIdPattern ·
 * features.handoffPack.{state, decisionIdPattern, tracker}. tracker = null, or
 * { files: [...], lists: "<csv of allowed values>", columnLists: { "<file>": { "<column>": "<list column>" } } }.
 *
 * Exit 0 PASS (or the feature is off) · 1 FAIL · 2 usage or an invalid profile.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { runHint } = require('./lib/run-hint.cjs');
const lib = require('./lib/handoff-check.cjs');
const profile = require('./lib/profile.cjs');

/** Load the profile, or exit: invalid → 2; the feature off → its "not configured" line and 0. */
export function settingsOrExit(tool) {
  const loaded = profile.load(process.cwd());
  if (loaded.errors.length > 0) {
    console.error(`${tool}: PIPELINE_PROFILE.md is invalid — run ${runHint('features')}`);
    for (const e of loaded.errors) console.error(`  ${e}`);
    process.exit(2);
  }
  const feature = profile.feature(loaded.settings, 'handoffPack');
  if (!feature.enabled) {
    console.log(feature.line);
    process.exit(0);
  }
  return { settings: loaded.settings, feature };
}

function markdownUnder(path) {
  if (!existsSync(path)) return [];
  if (statSync(path).isFile()) return [readFileSync(path, 'utf8')];
  return readdirSync(path).flatMap((name) => {
    const p = join(path, name);
    if (statSync(p).isDirectory()) return markdownUnder(p);
    return name.endsWith('.md') ? [readFileSync(p, 'utf8')] : [];
  });
}

/** Everything the checker needs, read from disk. Throws with a plain message when the tracker lists are missing. */
export function readContext(settings, feature) {
  const decisionIdPattern = feature.config.decisionIdPattern || lib.DEFAULT_DECISION_ID;
  const registryIdPattern = settings.features?.claims?.registryIdPattern || lib.DEFAULT_REGISTRY_ID;
  // Any id the decision workspace mentions counts as existing. Heading styles differ between decision files, and
  // a stricter scan (headings only) called real ids missing the first time it ran; this still refuses an id no
  // decision file has ever named.
  const decisionIds = new Set();
  for (const text of markdownUnder(settings.paths.decisions)) for (const id of lib.idsIn(text, decisionIdPattern)) decisionIds.add(id);
  const registryText = existsSync(settings.paths.registry) ? readFileSync(settings.paths.registry, 'utf8') : '';
  const registryIds = lib.registryRowIds(registryText, registryIdPattern);
  let tracker = null;
  const t = feature.config.tracker;
  if (t) {
    if (!t.lists || !existsSync(t.lists)) throw new Error(`features.handoffPack.tracker.lists names ${t.lists ?? '(unset)'}, which does not exist`);
    tracker = { files: t.files ?? [], lists: lib.parseLists(readFileSync(t.lists, 'utf8')), columnLists: t.columnLists ?? {} };
  }
  return { decisionIds, registryIds, decisionIdPattern, registryIdPattern, tracker };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const file = process.argv[2];
  if (!file || file.startsWith('--')) {
    console.error(`usage: ${runHint('handoff-check')} <pack.md>`);
    process.exit(2);
  }
  const { settings, feature } = settingsOrExit('handoff-check');
  if (!existsSync(file)) {
    console.error(`handoff-check: no such file ${file}`);
    process.exit(2);
  }
  let ctx;
  try {
    ctx = readContext(settings, feature);
  } catch (e) {
    console.error(`handoff-check: ${e.message}`);
    process.exit(2);
  }
  if (!ctx.tracker) console.log('tracker: not configured');
  const errors = lib.checkHandoff(readFileSync(file, 'utf8'), ctx);
  for (const e of errors) console.log(`  ${e}`);
  console.log(errors.length === 0 ? `handoff-check: PASS — ${file}` : `handoff-check: FAIL — ${errors.length} problem(s); the run cannot close on this pack`);
  process.exit(errors.length === 0 ? 0 : 1);
}
