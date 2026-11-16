/**
 * Every requirement id must have a test or a requirement-pack step. Rule: scripts/lib/spec-trace.cjs.
 *
 *   npx builder run spec-trace-check                      every id in features.specTrace.requirements
 *   npx builder run spec-trace-check <requirements.md> …  exactly these requirement files (one module's register)
 *   --list                                                every requirement with its verdict and traces
 *   --json                                                machine-readable results
 * (folder layout: node scripts/spec-trace-check.mjs in place of npx builder run spec-trace-check)
 *
 * Settings: features.specTrace — idPattern (the id shape) · requirements (files or folders that declare ids) ·
 * tests + testPattern (test files: any whole-token mention traces) · packs (requirement-pack files: a step traces —
 * assert · by-design <cite> · gap · skipped; a plain mention does not). Paths resolve against the project root.
 * Off → "specTrace: not configured", exit 0.
 *
 * Exit 0 PASS · 1 any UNTRACED id, a by-design step with no citation, requirement files that declare zero ids, or no
 *      test/pack file read · 2 an invalid profile or a missing / unreadable source.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';

const require = createRequire(import.meta.url);
const { runHint } = require('./lib/run-hint.cjs');
const lib = require('./lib/spec-trace.cjs');
const profile = require('./lib/profile.cjs');

const NAME = 'spec-trace-check';
const loaded = profile.load(process.cwd());
if (loaded.errors.length > 0) {
  console.error(`${NAME}: PIPELINE_PROFILE.md is invalid — run ${runHint('features')}`);
  for (const e of loaded.errors) console.error(`  ${e}`);
  process.exit(2);
}
const feature = profile.feature(loaded.settings, 'specTrace');
if (!feature.enabled) {
  console.log(feature.line);
  process.exit(0);
}

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const list = args.includes('--list');
const named = args.filter((a) => !a.startsWith('--'));
const slash = (p) => p.replace(/\\/g, '/');
const rel = (p) => slash(relative(process.cwd(), p) || p);

const die = (message) => {
  console.error(`${NAME}: ${message}`);
  process.exit(2);
};

const walk = (p, out = []) => {
  if (statSync(p).isDirectory()) for (const entry of readdirSync(p).sort()) walk(join(p, entry), out);
  else out.push(p);
  return out;
};
const readAll = (paths, setting, filter = () => true) => {
  const files = [];
  for (const p of paths) {
    if (!existsSync(p)) die(`source missing — ${slash(p)} (${setting}). A source that is not there declares and traces nothing; fix the path, never read it as a pass.`);
    try {
      for (const f of walk(p)) if (filter(rel(f))) files.push({ path: rel(f), text: readFileSync(f, 'utf8') });
    } catch (e) {
      die(`source unreadable — ${slash(p)} (${setting}): ${e.message}`);
    }
  }
  return files;
};

const { config } = feature;
const idRe = lib.compileId(config.idPattern);
const testRe = config.testPattern ? new RegExp(config.testPattern) : null;
const requirementFiles = readAll(named.length ? named : config.requirements, named.length ? 'named requirement file' : 'features.specTrace.requirements');
const testFiles = readAll(config.tests ?? [], 'features.specTrace.tests', (p) => !testRe || testRe.test(p));
const packFiles = readAll(config.packs ?? [], 'features.specTrace.packs');

const declaredMap = lib.declared(requirementFiles, idRe);
let steps = [];
let uncited = [];
for (const [files, role] of [[testFiles, 'test'], [packFiles, 'pack']]) {
  for (const f of files) {
    const scan = lib.scanFile(f.text, f.path, idRe, role);
    steps = steps.concat(scan.steps);
    uncited = uncited.concat(scan.uncited);
  }
}
const { results, undeclared, kinds } = lib.trace(declaredMap, steps);
const untraced = results.filter((r) => r.verdict === 'UNTRACED');
const read = testFiles.length + packFiles.length;

const problems = [];
if (declaredMap.size === 0) problems.push(`the requirement file(s) declare zero ids matching ${config.idPattern} — a set of nothing is traced by nothing`);
if (read === 0) problems.push('no test or pack file was read — a trace that read nothing traced nothing (check tests, testPattern and packs)');
if (untraced.length > 0) problems.push(`${untraced.length} of ${results.length} requirement(s) have no test and no requirement-pack step (assert · by-design · gap · skipped)`);
if (uncited.length > 0) problems.push(`${uncited.length} by-design step(s) carry no citation`);

const kindLine = lib.KINDS.map((k) => `${kinds[k]} ${k}`).join(' · ');
const verdict = problems.length ? 'FAIL' : 'PASS';

if (asJson) {
  console.log(JSON.stringify({ feature: feature.line, requirementFiles: requirementFiles.map((f) => f.path), filesRead: read, kinds, results, undeclared, uncited, problems, verdict }, null, 2));
  process.exit(problems.length ? 1 : 0);
}

if (list) {
  for (const r of results) {
    const traces = r.traces.map((t) => `${t.kind} ${t.path}:${t.line}`).join(' · ') || '—';
    console.log(`${r.verdict.padEnd(9)} ${r.id.padEnd(12)} ${traces}`);
  }
}
for (const s of undeclared) console.log(`  undeclared ${s.id} at ${s.path}:${s.line} — a ${s.kind} for an id no requirement file declares`);

if (problems.length > 0) {
  for (const u of uncited) console.error(`  UNCITED ${u.id}  at ${u.path}:${u.line} — a by-design step names the ruling that documents the divergence, or it is a gap`);
  for (const r of untraced) console.error(`  UNTRACED ${r.id}  declared at ${r.declaredAt.path}:${r.declaredAt.line}`);
  if (untraced.length > 0) console.error('  A requirement nobody traced has no outcome: write the test, or give it one honest pack step — assert, by-design <cite>, gap or skipped.');
  console.error(`${NAME}: ${verdict} — ${problems.join(' · ')}`);
  process.exit(1);
}
console.log(`${NAME}: PASS — ${results.length} of ${results.length} requirement(s) traced (${kindLine}), from ${requirementFiles.length} requirement file(s) and ${read} test/pack file(s)`);
