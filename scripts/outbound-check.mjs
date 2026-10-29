/**
 * May this payload go to a model? The command-line door to scripts/lib/outbound-guard.cjs (rules and WHY there).
 *
 *   node scripts/outbound-check.mjs < payload.json        payload { "text": "…", "files": [{ "path", "content" }] }
 *   node scripts/outbound-check.mjs --files a.ts b.md     the named files, read from the project root
 *
 * Prints `SEND <bytes> bytes`, or `NOT SENT` and one line per reason (file, line and kind — never the matched text).
 *
 * Settings (PIPELINE_PROFILE.md §16): features.outboundGuard.{state, maxBytes, denyPaths, envFiles, extraPatterns,
 * timeoutMs}. Off → "outboundGuard: not configured — nothing may be sent", exit 1: the experiments that send are
 * only allowed with the guard on, so an absent guard refuses rather than waves a payload through.
 *
 * Exit 0 SEND · 1 NOT SENT, or the guard is off · 2 an invalid profile or bad input.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const guard = require('./lib/outbound-guard.cjs');
const profile = require('./lib/profile.cjs');

const root = process.cwd();
const loaded = profile.load(root);
if (loaded.errors.length > 0) {
  console.error('outbound-check: PIPELINE_PROFILE.md is invalid — run node scripts/features.mjs');
  for (const e of loaded.errors) console.error(`  ${e}`);
  process.exit(2);
}
const feature = profile.feature(loaded.settings, 'outboundGuard');
if (!feature.enabled) {
  console.log(`${feature.line} — nothing may be sent`);
  process.exit(1);
}

const args = process.argv.slice(2);
const at = args.indexOf('--files');
let payload;
try {
  payload =
    at >= 0
      ? { files: args.slice(at + 1).map((p) => ({ path: p, content: readFileSync(join(root, p), 'utf8') })) }
      : JSON.parse(readFileSync(0, 'utf8') || '{}');
} catch (e) {
  console.error(`outbound-check: cannot read the payload — ${e.message}`);
  process.exit(2);
}

const { send, reasons, bytes } = guard.check(payload, { root, config: feature.config });
if (send) {
  console.log(`SEND ${bytes} bytes`);
  process.exit(0);
}
console.log('NOT SENT');
for (const r of reasons) console.log(`  ${r}`);
process.exit(1);
