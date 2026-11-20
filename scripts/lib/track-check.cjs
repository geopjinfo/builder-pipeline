'use strict';
/**
 * track-check — the size of a change, measured from git (specs/pipeline-sizing.spec.md REQ-2008, D134, D135).
 *
 * The `build-module-pipeline` skill picks a track at Phase 0.5. The SMALL track exists for a change that stays inside
 * one module: at most `maxFiles` production source files (default 4), one module directory, no new dependency, no new
 * migration. This library counts those things in the files changed since a base commit — committed, staged, unstaged
 * and untracked alike — and says SMALL or ESCALATE with one reason per broken limit, in a fixed order.
 *
 * What is NOT a production source file: a test (by folder or by name), a doc, a board, a ledger, a handoff, the
 * profile, a lock file, a manifest, and any file without a code extension. A manifest is judged on its own: a
 * dependency added, removed or re-pinned in package.json is a reason; any edit to another manifest is a reason.
 *
 * Two optional readings (specs/pipeline-cost.spec.md REQ-2018, D145). `--medium N` (default 6): when a SMALL limit
 * breaks but at most N files in one module changed, with no dependency change and at most one new migration, the
 * answer is MEDIUM and the broken SMALL limits are the reading. `--solo N` (default 2): at most N files in one module,
 * no dependency change, no migration, is SOLO. The orchestrator passes a flag only when the matching §16 feature is on.
 *
 * The shared catalogue allowance (specs/pipeline-cost-2.spec.md REQ-2024). `--shared a,b` names the files of profile §5
 * that every module adds a line to (an error catalogue, a config key list). A diff that only adds lines to such a file
 * counts the file but not its module, so one new error code in `src/shared/errors.ts` beside a one-module change is not
 * a second module. A removed or changed line in a shared file is an ordinary edit and counts its module.
 *
 * The MEDIUM auditor (REQ-2027): a MEDIUM answer carries `auditor: invariant-auditor` in `--json`. A new public
 * operation is the orchestrator's reading and makes it `security-auditor`; git cannot see a route.
 *
 * A free check: it reads no PIPELINE_PROFILE.md feature and has no off state (REQ-2009). The protected
 * paths of profile §4 and "no new public operation or permission key" stay the orchestrator's reading of the diff.
 */
const { spawnSync } = require('node:child_process');

const DEFAULT_MAX_FILES = 4;
const DEFAULT_MEDIUM_FILES = 6;
const DEFAULT_SOLO_FILES = 2;
/** The exit code of each answer: SOLO and SMALL stay on the track (0), MEDIUM is its own answer (3), ESCALATE is 1. */
const EXIT = { SOLO: 0, SMALL: 0, MEDIUM: 3, ESCALATE: 1 };
/** Folders a module directory sits under. `src/report/x.ts` → module `report`; `packages/billing/src/a.ts` → `billing`. */
const DEFAULT_SRC = ['src', 'lib', 'app', 'apps', 'server', 'packages', 'services', 'modules'];

const SOURCE_EXT = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|kts|rb|php|cs|swift|scala|c|cc|cpp|h|hpp|m|mm|sql|prisma|graphql|gql|vue|svelte|ex|exs|dart|sh)$/i;
const TEST_PATH = /(?:^|\/)(?:tests?|__tests__|__mocks__|__snapshots__|spec|e2e|fixtures)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)test_[^/]*\.py$|_test\.(?:go|py|rb|ex|exs)$|_spec\.rb$/;
const ARTEFACT_PATH = /(?:^|\/)(?:\.claude|\.agents|\.builder|\.specify|\.pipeline|\.superpowers|\.planning|openspec|specs|tasks|boards|handoffs|runs|adr|decisions)\/|(?:^|\/)(?:DECISIONS|DEFERRED_TASKS|PIPELINE_PROFILE|CHANGELOG|CLAUDE|AGENTS)\.md$/;
const DOC_EXT = /\.(?:md|mdx|txt|rst|adoc)$/i;
const MANIFESTS = new Set(['package.json', 'requirements.txt', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'Gemfile', 'composer.json', 'pom.xml', 'build.gradle', 'build.gradle.kts']);
const LOCKS = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'Cargo.lock', 'poetry.lock', 'Pipfile.lock', 'go.sum', 'Gemfile.lock', 'composer.lock']);
const MIGRATION_PATH = /(?:^|\/)(?:migrations?|migrate)\//;
const DEP_SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

const norm = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '');
const base = (p) => norm(p).split('/').pop();

/** `source` | `test` | `doc` | `artefact` | `manifest` | `lock` | `other`, from the path alone. */
function kindOf(path) {
  const p = norm(path);
  const name = base(p);
  if (LOCKS.has(name)) return 'lock';
  if (MANIFESTS.has(name)) return 'manifest';
  if (ARTEFACT_PATH.test(p)) return 'artefact';
  if (TEST_PATH.test(p)) return 'test';
  if (DOC_EXT.test(p)) return 'doc';
  if (SOURCE_EXT.test(p)) return 'source';
  return 'other';
}

/** The module directory of a path: the folder under a source root, else the top folder, else `.`. */
function moduleOf(path, src = DEFAULT_SRC) {
  const parts = norm(path).split('/');
  if (parts.length === 1) return '.';
  if (src.includes(parts[0])) {
    // packages/<name>/src/<file>: the package is the module, not its inner src folder
    if (parts.length > 3 && src.includes(parts[2]) && parts[0] !== parts[2]) return parts[1];
    return parts.length > 2 ? parts[1] : parts[0];
  }
  return parts[0];
}

const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });

/** The repository root of `cwd`, or null. */
function repoRoot(cwd) {
  const r = git(cwd, ['rev-parse', '--show-toplevel']);
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

/**
 * Every path changed since `since`: the diff of the working tree against it (tracked files) plus the untracked files
 * git does not ignore. Deleted files count as changed. A rename counts once, under its new name.
 * @returns {{ ok: true, paths: string[] } | { ok: false, error: string }}
 */
function changedSince(root, since) {
  const ok = git(root, ['rev-parse', '--verify', '--quiet', `${since}^{commit}`]);
  if (ok.status !== 0) return { ok: false, error: `"${since}" is not a commit in this repository` };
  const diff = git(root, ['diff', '--name-status', '-z', '-M', since, '--']);
  if (diff.status !== 0) return { ok: false, error: (diff.stderr || 'git diff failed').trim() };
  const paths = new Set();
  const fields = diff.stdout.split('\0').filter((f) => f.length > 0);
  for (let i = 0; i < fields.length; i++) {
    const status = fields[i];
    if (/^[RC]/.test(status)) {
      paths.add(norm(fields[i + 2]));
      i += 2;
    } else {
      paths.add(norm(fields[i + 1]));
      i += 1;
    }
  }
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z']);
  for (const p of (untracked.stdout || '').split('\0').filter(Boolean)) paths.add(norm(p));
  return { ok: true, paths: [...paths].sort() };
}

/** The dependency map of a package.json text: `name → range` over the four sections, or {} when unreadable. */
function depsOf(text) {
  try {
    const pkg = JSON.parse(text);
    const out = {};
    for (const s of DEP_SECTIONS) for (const [k, v] of Object.entries(pkg[s] || {})) out[`${s}:${k}`] = String(v);
    return out;
  } catch {
    return {};
  }
}

/** The reasons a changed manifest gives. package.json is compared by dependency; any edit to another manifest counts. */
function dependencyChanges(root, since, manifests, readFile) {
  const reasons = [];
  for (const m of manifests) {
    if (base(m) !== 'package.json') {
      reasons.push(`dependency change in ${m}`);
      continue;
    }
    const before = git(root, ['show', `${since}:${m}`]);
    const was = depsOf(before.status === 0 ? before.stdout : '{}');
    const now = depsOf(readFile(m));
    const added = Object.keys(now).filter((k) => !(k in was));
    const removed = Object.keys(was).filter((k) => !(k in now));
    const changed = Object.keys(now).filter((k) => k in was && was[k] !== now[k]);
    const name = (k) => k.split(':').slice(1).join(':');
    const parts = [];
    if (added.length) parts.push(`added ${added.map(name).join(', ')}`);
    if (removed.length) parts.push(`removed ${removed.map(name).join(', ')}`);
    if (changed.length) parts.push(`re-pinned ${changed.map(name).join(', ')}`);
    if (parts.length) reasons.push(`dependency change in ${m} (${parts.join('; ')})`);
  }
  return reasons;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * The answer from the counted facts. Reasons, in order: the file count, the module count, each dependency change,
 * each new migration. With `solo`, a diff of at most `solo` files in one module with no dependency change and no
 * migration is SOLO. With `medium`, a diff that breaks a SMALL limit but stays at or under `medium` files in one
 * module, with no dependency change and at most one new migration, is MEDIUM; its reasons are the reading, not an
 * escalation. Otherwise SMALL when no reason, ESCALATE when one.
 */
function judge({ files, modules, dependency = [], migrations = [], sharedAdditions = [], maxFiles = DEFAULT_MAX_FILES, medium = null, solo = null }) {
  const reasons = [];
  if (files.length > maxFiles) reasons.push(`${plural(files.length, 'source file')} changed, limit ${maxFiles}`);
  if (modules.length > 1) reasons.push(`${plural(modules.length, 'module')} touched (${modules.join(', ')}), limit 1`);
  for (const r of dependency) reasons.push(r);
  for (const m of migrations) reasons.push(`new migration ${m}`);
  const oneModule = modules.length <= 1;
  let track = reasons.length ? 'ESCALATE' : 'SMALL';
  if (track === 'SMALL' && solo && files.length <= solo && migrations.length === 0) track = 'SOLO';
  if (track === 'ESCALATE' && medium && oneModule && dependency.length === 0) {
    if (files.length > medium) reasons.push(`${plural(files.length, 'source file')} changed, limit ${medium}`);
    else if (migrations.length > 1) reasons.push(`${plural(migrations.length, 'new migration')}, limit 1`);
    else track = 'MEDIUM';
  }
  // under --medium the SMALL-limit reasons are a reading; an ESCALATE prints only the MEDIUM limits that broke
  const printed = track === 'ESCALATE' && medium && oneModule && dependency.length === 0 ? reasons.filter((r) => !r.endsWith(`limit ${maxFiles}`) && !r.startsWith('new migration ')) : reasons;
  const auditor = track === 'MEDIUM' ? 'invariant-auditor' : null;
  return { track, files, modules, reasons: printed, maxFiles, mediumMaxFiles: medium, soloMaxFiles: solo, sharedAdditions, auditor };
}

/** The exit code of an answer (REQ-2018). */
const exitCode = (track) => EXIT[track] ?? 1;

/** The lines to print: one SMALL line, or one ESCALATE line per reason. */
function render(result) {
  const shared = result.sharedAdditions?.length ? `; shared additions: ${result.sharedAdditions.join(', ')}` : '';
  const size = `${plural(result.files.length, 'source file')} in ${plural(result.modules.length, 'module')}`;
  if (result.track === 'SOLO' || result.track === 'SMALL') return `${result.track}: ${size}${shared}`;
  if (result.track === 'MEDIUM') return `MEDIUM: ${size} — ${result.reasons.join('; ')}${shared}`;
  return result.reasons.map((r) => `ESCALATE: ${r}`).join('\n');
}

/**
 * The whole check over a repository.
 * @param {{ root: string, since: string, maxFiles?: number, medium?: number|null, solo?: number|null, shared?: string[], src?: string[], readFile?: (rel: string) => string }} o
 * @returns {{ ok: false, error: string } | { ok: true, track, files, modules, reasons, maxFiles, base, ignored }}
 */
/** True when `p` existed at `since` and the diff since then only adds lines (git numstat deletions 0). */
function additionsOnly(root, since, p) {
  if (git(root, ['cat-file', '-e', `${since}:${p}`]).status !== 0) return false;
  const r = git(root, ['diff', '--numstat', since, '--', p]);
  if (r.status !== 0) return false;
  const line = (r.stdout || '').trim().split('\n').find((l) => l.trim());
  if (!line) return false;
  const [added, deleted] = line.split('\t');
  return Number(deleted) === 0 && Number(added) > 0;
}

function check({ root, since, maxFiles = DEFAULT_MAX_FILES, medium = null, solo = null, shared = [], src = DEFAULT_SRC, readFile }) {
  const read = readFile || ((rel) => { try { return require('node:fs').readFileSync(require('node:path').join(root, rel), 'utf8'); } catch { return '{}'; } });
  const changed = changedSince(root, since);
  if (!changed.ok) return changed;
  const files = [];
  const manifests = [];
  const migrations = [];
  const ignored = { test: [], doc: [], artefact: [], lock: [], other: [] };
  for (const p of changed.paths) {
    const kind = kindOf(p);
    if (kind === 'source') {
      files.push(p);
      // a migration file that did not exist at the base is a new table or column: never SMALL
      if (MIGRATION_PATH.test(p) && git(root, ['cat-file', '-e', `${since}:${p}`]).status !== 0) migrations.push(p);
    } else if (kind === 'manifest') manifests.push(p);
    else ignored[kind].push(p);
  }
  const sharedSet = new Set((shared || []).map(norm));
  const sharedAdditions = files.filter((f) => sharedSet.has(f) && additionsOnly(root, since, f)).sort();
  const modules = [...new Set(files.filter((f) => !sharedAdditions.includes(f)).map((f) => moduleOf(f, src)))].sort();
  const dependency = dependencyChanges(root, since, manifests, read);
  const judged = judge({ files, modules, dependency, migrations, sharedAdditions, maxFiles, medium, solo });
  return { ok: true, ...judged, base: since, ignored };
}

module.exports = { DEFAULT_MAX_FILES, DEFAULT_MEDIUM_FILES, DEFAULT_SOLO_FILES, DEFAULT_SRC, kindOf, exitCode, moduleOf, repoRoot, changedSince, dependencyChanges, additionsOnly, judge, render, check };
