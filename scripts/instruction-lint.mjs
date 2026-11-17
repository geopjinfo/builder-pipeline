/**
 * What the agent-instruction files state about the repo must still be true of it. Rules and their WHY:
 * scripts/lib/instruction-lint.cjs.
 *
 *   npx builder-pipeline run instruction-lint                  the gate over every file in `files`
 *   npx builder-pipeline run instruction-lint a.md b.md       exactly these files in place of `files`. With the feature off they
 *                                                     are linted with the default settings and no baseline, and the
 *                                                     first line says `instructionLint: not configured — checking
 *                                                     <files> with defaults` (REQ-701); a named file that does not
 *                                                     exist, or an unknown flag, is exit 2 (REQ-703)
 *   npx builder-pipeline run instruction-lint --files a b     only these files (the edit hook). No figure command runs in this
 *                                                     mode (see below); sets naming other files are skipped; the
 *                                                     ratchet still applies
 *   npx builder-pipeline run instruction-lint --list          also print every count claim and history phrase
 *   npx builder-pipeline run instruction-lint --refresh       write the current ratchet counts to `baseline` (review the diff:
 *                                                     a raised count is a decision, never a side effect)
 * (folder layout: node scripts/instruction-lint.mjs in place of npx builder-pipeline run instruction-lint)
 *
 * Settings (PIPELINE_PROFILE.md §16): features.instructionLint.{state, files, ignorePaths, figures, sets, history,
 * baseline}. `files` are globs from the project root (`**` and `*` supported). `figures` are { file, pattern, command,
 * label? }: the pattern's one capture group is the claimed value and the command, run from the project root, prints
 * the true one. `sets` are { name, members | membersFrom: { dir, pattern }, files }. `baseline` is a JSON file
 * { counts: {path: n}, history: {path: n} }; null = the ratchet is reported, never enforced.
 * Off → "instructionLint: not configured", exit 0 — also with `--files`, so the edit hook is unchanged (REQ-702).
 *
 * Exit 0 PASS, or the feature is off · 1 FAIL · 2 an invalid profile or bad arguments.
 */
import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';

const require = createRequire(import.meta.url);
const { runHint } = require('./lib/run-hint.cjs');
const { lint } = require('./lib/instruction-lint.cjs');
const profile = require('./lib/profile.cjs');

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const USAGE = `usage: ${runHint('instruction-lint')} [<file.md> …] [--files <path> …] [--list] [--refresh]`;
const die = (message) => {
  console.error(`instruction-lint: ${message} — ${USAGE}`);
  process.exit(2);
};
// `--files a b` (the edit hook) filters the feature's `files`; a bare path names the files to lint in place of `files`
// (REQ-701, DL-6 of the spec). An unknown flag is refused, never read as a file (REQ-703).
const clean = (p) => p.replace(/\\/g, '/').replace(/^\.\//, '');
let only = null;
const named = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--files') {
    only = [];
    while (i + 1 < args.length && !args[i + 1].startsWith('--')) only.push(clean(args[++i]));
  } else if (a === '--list' || a === '--refresh') continue;
  else if (a.startsWith('--')) die(`unknown flag "${a}"`);
  else named.push(clean(a));
}

const root = process.cwd();
const loaded = profile.load(root);
if (loaded.errors.length > 0) {
  console.error(`instruction-lint: PIPELINE_PROFILE.md is invalid — run ${runHint('features')}`);
  for (const e of loaded.errors) console.error(`  ${e}`);
  process.exit(2);
}
const feature = profile.feature(loaded.settings, 'instructionLint');
if (!feature.enabled && named.length === 0) {
  // No named file: the gate and the edit hook record "not configured" as before (REQ-702).
  console.log(feature.line);
  process.exit(0);
}
for (const p of named) if (!existsSync(p) || !statSync(p).isFile()) die(`${p} not found (a named file must exist)`);
// Named files need nothing from the profile: the lint runs with the default settings and no baseline, and says so, so
// an instruction file can be checked in a project that never adopted the pipeline (REQ-701).
if (!feature.enabled) console.log(`${feature.line} — checking ${named.join(', ')} with defaults`);
const cfg = named.length ? { ...feature.config, files: named } : feature.config;

const SKIP = new Set(['node_modules', '.git', 'dist', 'coverage', 'worktrees']);
// Tokens first, so the `*` of one expansion is never rewritten by the next.
const globRe = (g) =>
  new RegExp(
    `^${g
      .replace(/\*\*\//g, '\u0001')
      .replace(/\*\*/g, '\u0002')
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]')
      .replace(/\u0001/g, '(?:.*/)?')
      .replace(/\u0002/g, '.*')}$`,
  );
function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(relative(root, p).replace(/\\/g, '/'));
  }
  return out;
}
function expand(globs) {
  const set = new Set();
  for (const g of globs) {
    if (!/[*?]/.test(g)) { if (existsSync(g) && statSync(g).isFile()) set.add(g); continue; }
    const base = g.slice(0, g.search(/[*?]/)).replace(/\/[^/]*$/, '') || '.';
    const re = globRe(g);
    for (const p of walk(join(root, base))) if (re.test(p)) set.add(p);
  }
  return [...set].sort();
}

let paths = expand(cfg.files);
if (only) paths = paths.filter((p) => only.includes(p));
if (only && paths.length === 0) {
  console.log('instruction-lint: none of the given files is an instruction file — nothing to check');
  process.exit(0);
}
const files = paths.map((path) => ({ path, text: readFileSync(path, 'utf8') }));
const inScope = (f) => !only || only.includes(f);

// Figure commands run only in the full gate, never with --files. The edit hook runs automatically after an agent's
// edit, with no permission prompt, so a command that an agent could have just written into the profile must not
// run there. Figures are checked by the gate and CI, which a person starts.
const figures = (only ? [] : cfg.figures ?? []).map((f) => {
  let actual = null;
  try {
    actual = execSync(f.command, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() || null;
  } catch {
    actual = null;
  }
  return { ...f, actual };
});
const sets = (cfg.sets ?? []).map((s) => {
  let members = s.members ?? [];
  if (s.membersFrom) {
    const re = new RegExp(s.membersFrom.pattern);
    members = existsSync(s.membersFrom.dir) ? readdirSync(s.membersFrom.dir).map((n) => re.exec(n)?.[1]).filter(Boolean).sort() : [];
  }
  return { name: s.name, members, files: s.files.filter(inScope) };
});
const baseline = cfg.baseline && existsSync(cfg.baseline) ? JSON.parse(readFileSync(cfg.baseline, 'utf8')) : null;
if (cfg.baseline && !baseline && !flag('--refresh')) {
  console.error(`instruction-lint: baseline ${cfg.baseline} is missing — run with --refresh once and commit it`);
  process.exit(2);
}

const exists = (rel) => existsSync(join(root, rel));
/** A cited path inside a package that is not installed (no `npm install` yet) is not a dead path: it cannot be judged. */
const unchecked = (token) => {
  const m = /^node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(token);
  return m && !existsSync(join(root, 'node_modules', ...m[1].split('/'))) ? `not configured: ${m[1]} is not installed (run npm install)` : null;
};
const result = lint(files, { exists, unchecked, index: walk(root), ignorePaths: cfg.ignorePaths ?? [], figures, sets, history: cfg.history ?? null, baseline: only ? (baseline ? { counts: baseline.counts, history: baseline.history } : null) : baseline });

if (flag('--refresh')) {
  if (!cfg.baseline) { console.error('instruction-lint: --refresh needs features.instructionLint.baseline'); process.exit(2); }
  writeFileSync(cfg.baseline, `${JSON.stringify({ counts: result.counts, history: result.history }, null, 2)}\n`);
  console.log(`instruction-lint: baseline written to ${cfg.baseline} — review the diff before committing`);
}
for (const p of result.problems) console.log(`  ${p}`);
for (const p of result.notChecked) console.log(`  ${p}`);
for (const p of result.ratchet) console.log(`  ratchet: ${p}`);
if (flag('--list')) {
  for (const l of result.detail.counts) console.log(`  count  ${l}`);
  for (const l of result.detail.history) console.log(`  history  ${l}`);
}
const total = (o) => Object.values(o).reduce((a, b) => a + b, 0);
const ok = result.problems.length === 0 && (flag('--refresh') || result.ratchet.length === 0);
console.log(
  ok
    ? `instruction-lint: PASS — ${files.length} file(s); ${total(result.counts)} count claim(s), ${total(result.history)} history phrase(s) within the baseline${baseline ? '' : ' (no baseline: reported, not enforced)'}${result.notChecked.length ? `; ${result.notChecked.length} path(s) not checked (not configured: a dependency is not installed)` : ''}`
    : `instruction-lint: FAIL — ${result.problems.length} problem(s), ${result.ratchet.length} ratchet rise(s)`,
);
process.exit(ok ? 0 : 1);
