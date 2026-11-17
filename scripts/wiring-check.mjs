/**
 * A declared seam must have something on the other end of it. Rule and its WHY: scripts/lib/wiring.cjs.
 *
 *   npx builder-pipeline run wiring-check                    inventory every seam, judge it, end in one verdict line
 *   npx builder-pipeline run wiring-check --list            also print the whole inventory (joined / UNJOINED / not-evaluable)
 *   npx builder-pipeline run wiring-check --allow <file>    judge against this allow file instead of features.wiring.allow
 * (folder layout: node scripts/wiring-check.mjs in place of npx builder-pipeline run wiring-check)
 *
 * `--allow` exists so a red-proof test can point the check at a fixture allow file: proving the dead-waiver guard
 * fires must never mean editing the live allow file. Production runs never pass it.
 *
 * Settings (PIPELINE_PROFILE.md §16): features.wiring.{state, roots, extensions, testPattern, allow, kinds}.
 *   roots         directories walked (node_modules and .git skipped)
 *   extensions    file suffixes read, e.g. [".ts"]
 *   testPattern   a regular expression over the forward-slash path; matching files are tests and never declare or
 *                 join a seam. null → every file is production.
 *   allow         a JSON file of ruled latent seams: [{ "id", "kind"?, "reason", "citation" }]. null, absent or
 *                 empty → no waivers.
 *   kinds         [{ "name", "declare", "join", "detail"?, "scope"?: "other-file" | "any-file", "optional"?: bool }]
 * Off → "wiring: not configured", exit 0. An example kinds set for one stack: examples/wiring/.
 *
 * Exit 0 PASS, or the feature is off · 1 FAIL (an unjoined seam, a dead or unreasoned waiver, an empty inventory)
 * · 2 an invalid profile, a root that does not exist, an unreadable allow file, or bad arguments.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { runHint } = require('./lib/run-hint.cjs');
const wiring = require('./lib/wiring.cjs');
const profile = require('./lib/profile.cjs');

/**
 * Exit only after stdout/stderr have drained. A bare process.exit() right after many console.log() calls can cut a
 * piped stdout short (observed: a --list run captured 170 of 228 lines). Same exit codes; top-level await keeps the
 * code after the call from running. usage() stays synchronous: its output is two lines on stderr.
 */
async function exitFlushed(code) {
  await new Promise((resolve) => process.stdout.write('', resolve));
  await new Promise((resolve) => process.stderr.write('', resolve));
  process.exit(code);
}

const usage = (why) => {
  console.error(`wiring-check: ${why}`);
  console.error(`usage: ${runHint('wiring-check')} [--list] [--allow <file>]`);
  process.exit(2);
};

const loaded = profile.load(process.cwd());
if (loaded.errors.length > 0) {
  console.error(`wiring-check: PIPELINE_PROFILE.md is invalid — run ${runHint('features')}`);
  for (const e of loaded.errors) console.error(`  ${e}`);
  await exitFlushed(2);
}
const feature = profile.feature(loaded.settings, 'wiring');
if (!feature.enabled) {
  console.log(feature.line);
  await exitFlushed(0);
}
const { roots, extensions, testPattern, kinds } = feature.config;

const argv = process.argv.slice(2);
const listAll = argv.includes('--list');
let allowPath = feature.config.allow;
let allowExplicit = false;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--list') continue;
  if (argv[i] === '--allow') {
    if (!argv[i + 1] || argv[i + 1].startsWith('--')) usage('--allow needs a file');
    allowPath = argv[++i];
    allowExplicit = true;
    continue;
  }
  usage(`unknown argument ${argv[i]}`);
}

const kindErrors = wiring.validateKinds(kinds);
if (kindErrors.length > 0) {
  console.error('wiring-check: features.wiring.kinds is invalid');
  for (const e of kindErrors) console.error(`  ${e}`);
  await exitFlushed(2);
}

const posix = (p) => p.replace(/\\/g, '/');
const testRe = testPattern ? new RegExp(testPattern) : null;
const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir).sort()) {
    if (name === 'node_modules' || name === '.git') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (extensions.some((ext) => name.endsWith(ext))) {
      const p = posix(path);
      files.push({ path: p, text: readFileSync(path, 'utf8'), production: !(testRe && testRe.test(p)) });
    }
  }
};
for (const root of roots) {
  if (!existsSync(root) || !statSync(root).isDirectory()) usage(`features.wiring.roots names ${root}, which is not a directory`);
  walk(root);
}

let allowText = null;
if (allowPath) {
  if (existsSync(allowPath)) allowText = readFileSync(allowPath, 'utf8');
  else if (allowExplicit) usage(`--allow ${allowPath} does not exist`);
}
const allow = wiring.parseAllow(allowText);
if (allow.error) {
  console.error(`wiring-check: allow file ${allowPath} is unusable — ${allow.error}`);
  await exitFlushed(2);
}

const seams = wiring.inventory(files, kinds);
const verdict = wiring.judge({ seams, kinds, allow: allow.rows });
const production = files.filter((f) => f.production).length;

console.log(
  `wiring-check — ${files.length} file(s) under ${roots.join(', ')} (${production} production) · ` +
    `kinds: ${Object.entries(verdict.perKind).map(([k, n]) => `${k} ${n}`).join(' · ')} · allow: ${allowPath && allowText !== null ? `${posix(allowPath)} (${allow.rows.length} row(s))` : 'none'}`,
);
if (listAll) {
  for (const s of seams) {
    const label = { joined: 'joined       ', unjoined: 'UNJOINED     ', 'not-evaluable': 'not-evaluable' }[s.status];
    console.log(`  ${label} ${s.kind.padEnd(14)} ${s.id.padEnd(36)} ${s.where}`);
  }
}
for (const s of verdict.notEvaluable) console.log(`  not-evaluable [${s.kind}] ${s.id} at ${s.where} — ${s.detail}`);
for (const s of verdict.waived) {
  const row = allow.rows.find((r) => r && r.id === s.id && (r.kind === undefined || r.kind === s.kind));
  console.log(`  waived [${s.kind}] ${s.id} at ${s.where} — ${row.reason} (${row.citation})`);
}
for (const p of verdict.problems) console.log(`  ${p}`);

if (verdict.ok) {
  console.log(`wiring-check: PASS — ${seams.length} seam(s), ${verdict.waived.length} ruled latent, ${verdict.notEvaluable.length} not-evaluable, 0 unjoined`);
  await exitFlushed(0);
}
console.log(
  `wiring-check: FAIL — ${verdict.problems.length} problem(s), ${verdict.unjoined.length} unjoined of ${seams.length} seam(s). ` +
    'Join it, delete it, or rule it latent with a reason and a citation in the allow file.',
);
await exitFlushed(1);
