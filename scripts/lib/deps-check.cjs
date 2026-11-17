'use strict';
/**
 * deps-check — the project's dependency tree, read through the project's own package manager (specs/repo-hygiene.spec.md
 * REQ-1821, D90).
 *
 * WHY. A missing lockfile, a broken install tree, a known vulnerability and a package nobody imports any more are the
 * four dependency defects that grow quietly between releases. The kit bundles no analyzer (zero dependencies, AGENTS.md
 * rule 4): it runs the commands the profile names — `npm ls --json --all` and `npm audit --json` by default — and reads
 * their output. `format: npm` reads the JSON those two commands print; `format: lines` counts the output lines of any
 * other tool by a pattern, the lint's figure shape. The reader of import specifiers is the kit's own and sees
 * `require`, `import … from`, `import()`, `export … from`, a bare `import 'x'` and subpath imports.
 *
 *   NO-LOCKFILE    `lockfile` is true and no lockfile sits beside the manifest
 *   LS-PROBLEM     one entry of `problems[]` in the list command's JSON (missing, invalid, extraneous)
 *   AUDIT-<sev>    the count per severity from the audit command's JSON; a count at or above `maxSeverity` fails
 *   UNUSED-DEP     a `dependencies` entry no file under `unused.roots` imports (an `@types/x` entry pairs with x; a name
 *                  a package.json `scripts` line runs counts as used); devDependencies are not judged — their use is
 *                  often a config file or a CLI, which the reader cannot see
 *   LS-LINE / AUDIT-LINE   `format: lines` — an output line that matches `pattern`; an AUDIT-LINE fails like a severity hit
 *   UNMEASURABLE   the command is absent, timed out, exited outside its documented codes (0, or 1 with findings) or
 *                  printed no JSON — reported as such, never as a pass (the hygiene invariant)
 *
 * Pure readers over parsed JSON and text; `runCommand` is the one impure seam and the script calls it.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { builtinModules } = require('module');

const SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical'];
const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock'];
const DEFAULT_EXTENSIONS = ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts'];
const SKIP_DIRS = new Set(['.git', 'node_modules']);
const BUILTINS = new Set(builtinModules);

/** The lockfile finding for a manifest, or null. `exists` answers for a root-relative path. */
function lockfileFinding(manifestRel, exists) {
  const dir = manifestRel.includes('/') ? manifestRel.slice(0, manifestRel.lastIndexOf('/') + 1) : '';
  if (LOCKFILES.some((l) => exists(`${dir}${l}`))) return null;
  return { kind: 'NO-LOCKFILE', text: `${manifestRel}: no ${LOCKFILES.slice(0, -1).join(', ')} or ${LOCKFILES.at(-1)} beside it` };
}

/** `problems[]` of `npm ls --json` (strings), or [] when the tree is clean. */
function lsProblems(json) {
  return Array.isArray(json?.problems) ? json.problems.filter((p) => typeof p === 'string') : [];
}

/** The per-severity counts of `npm audit --json` (v7+ `metadata.vulnerabilities`), every severity present. */
function auditCounts(json) {
  const v = json?.metadata?.vulnerabilities ?? {};
  const out = {};
  for (const s of SEVERITIES) out[s] = Number.isInteger(v[s]) ? v[s] : 0;
  return out;
}

/** The sum of counts at or above `maxSeverity`. */
function atOrAbove(counts, maxSeverity) {
  const from = SEVERITIES.indexOf(maxSeverity);
  return SEVERITIES.slice(from < 0 ? SEVERITIES.length : from).reduce((n, s) => n + (counts[s] || 0), 0);
}

/** Every import specifier in a source text: require, import … from, import(), export … from, bare import. */
function specifiers(text) {
  const out = new Set();
  const bare = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
  for (const m of bare.matchAll(/\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g)) out.add(m[1]);
  for (const m of bare.matchAll(/\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g)) out.add(m[1]);
  for (const m of bare.matchAll(/\b(?:import|export)\b[^'";]*?\bfrom\s*['"]([^'"\n]+)['"]/g)) out.add(m[1]);
  for (const m of bare.matchAll(/\bimport\s*['"]([^'"\n]+)['"]/g)) out.add(m[1]);
  return [...out];
}

/** The package name of a specifier (`@s/p/sub` → `@s/p`, `debug/src/x` → `debug`), or null for a relative, absolute or `node:` one. */
function packageOf(spec) {
  if (!spec || /^(?:\.|\/|node:|#|[a-zA-Z]:[\\/])/.test(spec)) return null;
  const seg = spec.split('/');
  return spec.startsWith('@') ? (seg.length >= 2 ? `${seg[0]}/${seg[1]}` : null) : seg[0];
}

const posix = (p) => p.split(path.sep).join('/');
/** Source files under `roots` (root-relative) with one of `extensions`, as root-relative posix paths. */
function sourceFiles(root, roots, extensions = DEFAULT_EXTENSIONS) {
  const exts = extensions.length ? extensions : DEFAULT_EXTENSIONS;
  const out = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && exts.some((x) => e.name.endsWith(x))) out.push(posix(path.relative(root, full)));
    }
  };
  for (const r of roots) {
    const full = path.join(root, r);
    if (!fs.existsSync(full)) continue;
    if (fs.statSync(full).isFile()) out.push(posix(path.normalize(r)));
    else walk(full);
  }
  return out.sort();
}

/**
 * The `dependencies` entries no source imports. `used` is the set of package names the sources import, plus the names
 * of Node builtins they import (for the `@types/node` pairing); `scripts` is the manifest's scripts map.
 */
function unusedDeps(manifest, used, usesNode = false) {
  const deps = Object.keys(manifest?.dependencies ?? {});
  const scriptText = Object.values(manifest?.scripts ?? {}).join('\n');
  const inScripts = (name) => new RegExp(`(^|[\\s"'=/])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([\\s"'/]|$)`).test(scriptText);
  return deps.filter((d) => {
    if (d.startsWith('@types/')) {
      const runtime = d.slice('@types/'.length);
      return !(runtime === 'node' ? usesNode : used.has(runtime) || used.has(`@${runtime.replace('__', '/')}`));
    }
    return !used.has(d) && !inScripts(d);
  });
}

/** Read the sources once: { used: Set<package>, usesNode: boolean }. */
function usage(root, files) {
  const used = new Set();
  let usesNode = false;
  for (const f of files) {
    let text = '';
    try { text = fs.readFileSync(path.join(root, f), 'utf8'); } catch { continue; }
    for (const s of specifiers(text)) {
      if (s.startsWith('node:') || BUILTINS.has(s.split('/')[0])) { usesNode = true; continue; }
      const name = packageOf(s);
      if (name) used.add(name);
    }
  }
  return { used, usesNode };
}

/**
 * Run one project command through the platform shell with a timeout — the one impure seam.
 * @returns {{ ok: boolean, status: number|null, stdout: string, stderr: string, why: string|null }}
 *   `ok` is false (UNMEASURABLE) when the command is absent, timed out, was killed or exited outside 0 and 1.
 */
function runCommand(command, { cwd, timeoutMs = 120000, env = process.env } = {}) {
  const r = spawnSync(command, { cwd, shell: true, encoding: 'utf8', timeout: timeoutMs, env, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  const stdout = r.stdout || '';
  const stderr = r.stderr || '';
  if (r.error && r.error.code === 'ETIMEDOUT') return { ok: false, status: null, stdout, stderr, why: `timed out after ${timeoutMs} ms` };
  if (r.error) return { ok: false, status: null, stdout, stderr, why: r.error.message };
  if (r.signal) return { ok: false, status: null, stdout, stderr, why: `killed by ${r.signal}` };
  if (r.status !== 0 && r.status !== 1) return { ok: false, status: r.status, stdout, stderr, why: `exit ${r.status}${stderr.trim() ? ` — ${stderr.trim().split(/\r?\n/)[0].slice(0, 160)}` : ''}` };
  return { ok: true, status: r.status, stdout, stderr, why: null };
}

/** The JSON object in a command's stdout (npm prints it alone; a stray warning line before it is skipped), or null. */
function parseJson(stdout) {
  const at = stdout.indexOf('{');
  if (at < 0) return null;
  try { return JSON.parse(stdout.slice(at)); } catch { return null; }
}

/** Output lines matching `pattern` (case-insensitive), the `lines` format. */
function matchingLines(stdout, pattern) {
  const re = new RegExp(pattern, 'i');
  return stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && re.test(l));
}

module.exports = { SEVERITIES, LOCKFILES, DEFAULT_EXTENSIONS, lockfileFinding, lsProblems, auditCounts, atOrAbove, specifiers, packageOf, sourceFiles, unusedDeps, usage, runCommand, parseJson, matchingLines };
