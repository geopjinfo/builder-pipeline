#!/usr/bin/env node
/**
 * The project's dependency tree through its own package manager (specs/repo-hygiene.spec.md REQ-1821, D90). Rule and
 * its WHY: scripts/lib/deps-check.cjs.
 *
 *   npx builder-pipeline run deps-check [--manifest FILE] [--json]
 * (folder layout: node scripts/deps-check.mjs in place of npx builder-pipeline run deps-check)
 *
 * Settings (PIPELINE_PROFILE.md §16): features.depsCheck.{state, manifest, lockfile, listCommand, auditCommand, format,
 * maxSeverity, pattern, timeoutMs, unused: { roots, extensions }}. Prints NO-LOCKFILE, LS-PROBLEM, AUDIT-<severity>,
 * UNUSED-DEP (or LS-LINE and AUDIT-LINE with `format: lines`) and UNMEASURABLE lines, then one summary line.
 *
 * Off → "depsCheck: not configured", exit 3. With the feature off and `--manifest FILE` given, the check runs on that
 * manifest with the default settings and says so on the first line. Exit 0 clean or unmeasurable (the summary says which:
 * UNMEASURABLE is never a pass) · 1 a vulnerability count at or above maxSeverity · 2 usage or an invalid profile ·
 * 3 not configured.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { runHint } = require('./lib/run-hint.cjs');
const deps = require('./lib/deps-check.cjs');
const profile = require('./lib/profile.cjs');

const argv = process.argv.slice(2);
const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const USAGE = `usage: ${runHint('deps-check')} [--manifest FILE] [--json]`;
const die = (message) => { console.error(`deps-check: ${message} — ${USAGE}`); process.exit(2); };
const valued = ['--manifest'];
const known = new Set(['--json', '--help', '-h', ...valued]);
const unknown = argv.filter((a, i) => a.startsWith('-') && !known.has(a) && !valued.includes(argv[i - 1]));
if (argv.includes('--help') || argv.includes('-h')) { console.log(USAGE); process.exit(0); }
if (unknown.length) die(`unknown flag "${unknown[0]}"`);
for (const f of valued) if (argv.includes(f) && (val(f) === undefined || val(f).startsWith('-'))) die(`${f} needs a value`);
const json = argv.includes('--json');

const root = process.cwd();
const loaded = profile.load(root);
if (loaded.errors.length > 0) {
  console.error(`deps-check: PIPELINE_PROFILE.md is invalid — run ${runHint('features')}`);
  for (const e of loaded.errors) console.error(`  ${e}`);
  process.exit(2);
}
const feature = profile.feature(loaded.settings, 'depsCheck');
const standalone = !feature.enabled && val('--manifest') !== undefined;
if (!feature.enabled && !standalone) { console.log(feature.line); process.exit(3); }
const cfg = standalone ? { ...profile.FEATURES.depsCheck.defaults } : feature.config;
const manifestRel = (val('--manifest') ?? cfg.manifest).replace(/\\/g, '/');
if (standalone && !json) console.log(`${feature.line} — checking ${manifestRel} with defaults`);
if (!existsSync(join(root, manifestRel))) die(`${manifestRel} not found`);
let manifest;
try { manifest = JSON.parse(readFileSync(join(root, manifestRel), 'utf8')); } catch (e) { die(`${manifestRel}: ${e.message}`); }

const findings = [];
const unmeasurable = [];
const exists = (rel) => existsSync(join(root, rel));
if (cfg.lockfile) { const f = deps.lockfileFinding(manifestRel, exists); if (f) findings.push(f); }

let failing = 0;
const counts = {};
const commands = { list: cfg.listCommand, audit: cfg.auditCommand };
const results = {};
for (const [which, command] of Object.entries(commands)) {
  const r = deps.runCommand(command, { cwd: root, timeoutMs: cfg.timeoutMs });
  results[which] = r;
  if (!r.ok) { unmeasurable.push({ which, command, why: r.why }); continue; }
  if (cfg.format === 'lines') {
    const lines = deps.matchingLines(r.stdout, cfg.pattern);
    for (const l of lines) findings.push({ kind: which === 'list' ? 'LS-LINE' : 'AUDIT-LINE', text: l });
    if (which === 'audit') failing += lines.length;
    continue;
  }
  const parsed = deps.parseJson(r.stdout);
  if (!parsed) { unmeasurable.push({ which, command, why: `exit ${r.status} with no JSON on stdout` }); continue; }
  if (which === 'list') for (const p of deps.lsProblems(parsed)) findings.push({ kind: 'LS-PROBLEM', text: p });
  else {
    Object.assign(counts, deps.auditCounts(parsed));
    for (const s of [...deps.SEVERITIES].reverse()) findings.push({ kind: `AUDIT-${s}`, text: String(counts[s]) });
    failing += deps.atOrAbove(counts, cfg.maxSeverity);
  }
}

const unusedRoots = cfg.unused?.roots ?? [];
let unused = [];
if (unusedRoots.length) {
  const files = deps.sourceFiles(root, unusedRoots, cfg.unused?.extensions ?? []);
  const { used, usesNode } = deps.usage(root, files);
  unused = deps.unusedDeps(manifest, used, usesNode);
  for (const d of unused) findings.push({ kind: 'UNUSED-DEP', text: `${d} — no file under ${unusedRoots.join(', ')} imports it` });
}

const lsCount = findings.filter((f) => f.kind === 'LS-PROBLEM' || f.kind === 'LS-LINE').length;
const parts = [];
if (findings.some((f) => f.kind === 'NO-LOCKFILE')) parts.push('NO-LOCKFILE');
if (lsCount) parts.push(`${lsCount} ${cfg.format === 'lines' ? 'LS-LINE' : 'LS-PROBLEM'}`);
if (failing) parts.push(`${failing} ${cfg.format === 'lines' ? 'AUDIT-LINE' : `at or above ${cfg.maxSeverity}`}`);
if (unused.length) parts.push(`${unused.length} UNUSED-DEP`);
const verdict = failing > 0 ? 'FAIL' : unmeasurable.length ? 'UNMEASURABLE' : 'PASS';
const summary = verdict === 'UNMEASURABLE'
  ? `deps-check: UNMEASURABLE — ${unmeasurable.map((u) => u.which).join(' and ')} not measured (never a pass)${parts.length ? `; measured: ${parts.join(', ')}` : ''}`
  : `deps-check: ${verdict} — ${parts.length ? parts.join(', ') : `no finding (${manifestRel}, ${cfg.format})`}`;

if (json) {
  console.log(JSON.stringify({ ok: verdict === 'PASS', verdict, manifest: manifestRel, format: cfg.format, maxSeverity: cfg.maxSeverity, counts, findings, unmeasurable, unused }, null, 2));
} else {
  for (const f of findings) console.log(`${f.kind} ${f.text}`);
  for (const u of unmeasurable) console.log(`UNMEASURABLE ${u.which}: \`${u.command}\` — ${u.why}`);
  console.log(summary);
}
process.exit(failing > 0 ? 1 : 0);
