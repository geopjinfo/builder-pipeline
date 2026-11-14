/**
 * The claims checker at the end of the build and docs phases. Checks: re-run counts, anchored citations,
 * retracted phrases, unresolved NEEDS-RULING / owed notes. Rules: scripts/lib/claims-check.cjs.
 *
 *   npx builder run claims-check --run <key>
 *       <boards>/<key>.md + <runs>/<key>/{plan,state,review*}.md + <handoffs>/*<key>*handoff*.md
 *       + the counts in <runs>/<key>/claims.jsonl
 *   npx builder run claims-check --files <a> <b> … [--claims <claims.jsonl>]
 *       exactly these documents (no claims file unless --claims is given)
 *   --no-run-counts      skip re-running claim commands (citations / retracted / owed only)
 *   --only <kinds>       comma list of count,citation,retracted,owed,unanchored,named
 *   --extended           also UNANCHORED + NAMED on DONE board rows (off by default; CLAIMS_EXTENDED=1 does
 *                        the same, for shells that drop flags passed through a package-manager script)
 * (folder layout: node scripts/claims-check.mjs in place of npx builder run claims-check)
 *
 * Settings (PIPELINE_PROFILE.md): paths.boards · paths.runs · paths.handoffs · paths.decisions · paths.registry ·
 * paths.citationRoots (empty → every top-level directory present, except node_modules, .git and dot-directories) ·
 * features.claims.{state, retracted, registryIdPattern, jestBatch}. Claim commands run with BUILDER_NO_BASH_CAP=1 so an
 * output cap cannot truncate the figure being checked, and their stdout AND stderr are matched on every exit.
 *
 * Tier lock: when `scripts/lib/tier-lock.cjs` is installed (from examples/jest-tier-runner), a claim command that
 * runs an integration/e2e suite itself takes the machine-wide lock, and one that goes through the tier wrapper is
 * refused while a live run holds it — a refused claim is a COUNT problem, never a pass. Not installed: claim
 * commands run unlocked, and the output says so. Rules: `lockClass` / `makeRunner` in scripts/lib/claims-check.cjs.
 *
 * Exit 0 clean (or the feature is off) · 1 problems found · 2 usage or an invalid profile.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { runHint } = require('./lib/run-hint.cjs');
const { check, makeRunner, lockInstalled } = require('./lib/claims-check.cjs');
const profile = require('./lib/profile.cjs');

const loaded = profile.load(process.cwd());
if (loaded.errors.length > 0) {
  console.error(`claims-check: PIPELINE_PROFILE.md is invalid — run ${runHint('features')}`);
  for (const e of loaded.errors) console.error(`  ${e}`);
  process.exit(2);
}
const { settings } = loaded;
const feature = profile.feature(settings, 'claims');
if (!feature.enabled) {
  console.log(feature.line);
  process.exit(0);
}
const paths = settings.paths;

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1];
};
const key = flag('--run');
const filesAt = argv.indexOf('--files');
if (!key && filesAt === -1) {
  console.error(`usage: ${runHint('claims-check')} --run <key> | --files <doc> … [--claims <claims.jsonl>] [--no-run-counts] [--only <kinds>]`);
  process.exit(2);
}

const documents = [];
const add = (p) => existsSync(p) && statSync(p).isFile() && documents.push({ name: p.replace(/\\/g, '/'), text: readFileSync(p, 'utf8') });
let claimsPath = flag('--claims');
if (key) {
  add(join(paths.boards, `${key}.md`));
  const run = join(paths.runs, key);
  if (existsSync(run)) for (const f of readdirSync(run).sort()) if (/^(plan|state|review.*)\.md$/.test(f)) add(join(run, f));
  if (existsSync(paths.handoffs) && statSync(paths.handoffs).isDirectory()) {
    for (const f of readdirSync(paths.handoffs).sort()) if (f.includes(key) && f.includes('handoff') && f.endsWith('.md')) add(join(paths.handoffs, f));
  }
  claimsPath ??= join(run, 'claims.jsonl');
} else {
  for (const p of argv.slice(filesAt + 1)) {
    if (p.startsWith('--')) break;
    add(p);
  }
}

const claims =
  claimsPath && existsSync(claimsPath) && !argv.includes('--no-run-counts')
    ? readFileSync(claimsPath, 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l))
    : [];

/** null = not configured: the check is skipped and SAID to be skipped, never read as "no retracted phrase found". */
let retracted = null;
if (feature.config.retracted) {
  if (!existsSync(feature.config.retracted)) {
    console.error(`claims-check: features.claims.retracted names ${feature.config.retracted}, which does not exist`);
    process.exit(2);
  }
  retracted = JSON.parse(readFileSync(feature.config.retracted, 'utf8')).phrases ?? [];
}

const roots =
  paths.citationRoots.length > 0
    ? paths.citationRoots
    : readdirSync('.').filter((d) => d !== 'node_modules' && !d.startsWith('.') && statSync(d).isDirectory()).sort();

const cache = new Map();
const fsProbe = {
  exists: (p) => existsSync(p),
  lines: (p) => {
    if (!cache.has(p)) {
      try {
        cache.set(p, readFileSync(p, 'utf8').split(/\r?\n/));
      } catch {
        cache.set(p, null); // a directory, or unreadable: existence is all that can be said
      }
    }
    return cache.get(p);
  },
};
// stdout + stderr on every exit, and the machine-wide tier lock when one is installed (see the header). With
// features.claims.jestBatch, plain jest claims run once per config, and a config's passing result logged at this
// sha on a clean tree is reused, not re-run.
const runCommand = makeRunner({ batch: feature.config.jestBatch ? { cacheDir: feature.config.jestBatch.cacheDir } : null });
const batched = runCommand.prime(claims);

const only = flag('--only')?.split(',');
const problems = check(documents, fsProbe, {
  roots,
  refRoots: [paths.decisions, paths.handoffs],
  registryText: existsSync(paths.registry) ? readFileSync(paths.registry, 'utf8') : '',
  registryIdPattern: feature.config.registryIdPattern,
  retracted,
  claims,
  run: runCommand,
  extended: argv.includes('--extended') || process.env.CLAIMS_EXTENDED === '1',
}).filter((p) => !only || only.includes(p.kind));

console.log(`claims-check — ${documents.length} document(s), ${claims.length} count claim(s), citation roots: ${roots.join(', ') || 'none'}`);
console.log(retracted === null ? 'retracted phrases: not configured' : `retracted phrases: ${retracted.length}`);
if (batched?.claims) console.log(`jest batch: ${batched.claims} claim(s) from ${batched.runs} jest run(s) + ${batched.fromLog} from a same-sha log`);
if (claims.length > 0) console.log(lockInstalled ? 'tier lock: machine-wide (scripts/lib/tier-lock.cjs)' : 'tier lock: not installed — claim commands run unlocked');
for (const p of problems) console.log(`  ${p.kind.toUpperCase().padEnd(9)} ${p.where} — ${p.detail}`);
console.log(problems.length === 0 ? 'claims-check: PASS' : `claims-check: FAIL — ${problems.length} problem(s)`);
process.exit(problems.length === 0 ? 0 : 1);
