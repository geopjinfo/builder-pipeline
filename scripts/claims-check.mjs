/**
 * The claims checker at the end of the build and docs phases. Checks: re-run counts, anchored citations,
 * retracted phrases, unresolved NEEDS-RULING / owed notes. Rules: scripts/lib/claims-check.cjs.
 *
 *   node scripts/claims-check.mjs --run <key>
 *       <boards>/<key>.md + <runs>/<key>/{plan,state,review*}.md + <handoffs>/*<key>*handoff*.md
 *       + the counts in <runs>/<key>/claims.jsonl
 *   node scripts/claims-check.mjs --files <a> <b> … [--claims <claims.jsonl>]
 *       exactly these documents (no claims file unless --claims is given)
 *   --no-run-counts      skip re-running claim commands (citations / retracted / owed only)
 *   --only <kinds>       comma list of count,citation,retracted,owed
 *
 * Settings (PIPELINE_PROFILE.md): paths.boards · paths.runs · paths.handoffs · paths.decisions · paths.registry ·
 * paths.citationRoots (empty → every top-level directory present, except node_modules, .git and dot-directories) ·
 * features.claims.{state, retracted, registryIdPattern}. Claim commands run with BUILDER_NO_BASH_CAP=1 so an
 * output cap cannot truncate the figure being checked.
 *
 * Exit 0 clean (or the feature is off) · 1 problems found · 2 usage or an invalid profile.
 */
import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { check } = require('./lib/claims-check.cjs');
const profile = require('./lib/profile.cjs');

const loaded = profile.load(process.cwd());
if (loaded.errors.length > 0) {
  console.error('claims-check: PIPELINE_PROFILE.md is invalid — run node scripts/features.mjs');
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
  console.error('usage: node scripts/claims-check.mjs --run <key> | --files <doc> … [--claims <claims.jsonl>] [--no-run-counts] [--only <kinds>]');
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
const runCommand = (command) => {
  try {
    return { status: 0, output: execSync(command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15 * 60 * 1000, env: { ...process.env, BUILDER_NO_BASH_CAP: '1' } }) };
  } catch (e) {
    return { status: e.status ?? null, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
};

const only = flag('--only')?.split(',');
const problems = check(documents, fsProbe, {
  roots,
  refRoots: [paths.decisions, paths.handoffs],
  registryText: existsSync(paths.registry) ? readFileSync(paths.registry, 'utf8') : '',
  registryIdPattern: feature.config.registryIdPattern,
  retracted,
  claims,
  run: runCommand,
}).filter((p) => !only || only.includes(p.kind));

console.log(`claims-check — ${documents.length} document(s), ${claims.length} count claim(s), citation roots: ${roots.join(', ') || 'none'}`);
console.log(retracted === null ? 'retracted phrases: not configured' : `retracted phrases: ${retracted.length}`);
for (const p of problems) console.log(`  ${p.kind.toUpperCase().padEnd(9)} ${p.where} — ${p.detail}`);
console.log(problems.length === 0 ? 'claims-check: PASS' : `claims-check: FAIL — ${problems.length} problem(s)`);
process.exit(problems.length === 0 ? 0 : 1);
