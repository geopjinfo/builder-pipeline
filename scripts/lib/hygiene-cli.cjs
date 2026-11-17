'use strict';
/**
 * The shared command-line shell of the tree hygiene checks (specs/repo-hygiene.spec.md, M19): ignore-check, size-check
 * and secret-scan. One parser, one profile step, one "not configured" rule.
 *
 *   off, no --defaults     prints `<feature>: not configured` and exits 3 — never a pass (the spec's INVARIANTS)
 *   off, --defaults        runs with the feature's defaults; the first line says so (the standalone form)
 *   on                     runs with §16 merged over the defaults
 *   a flag without a value, an unknown flag, no git repository, an invalid profile: exit 2
 */
const { spawnSync } = require('node:child_process');

const EXIT = Object.freeze({ ok: 0, finding: 1, usage: 2, off: 3 });

/**
 * @param {string[]} argv
 * @param {{ valued?: string[], flags?: string[] }} spec   the flags that take a value, and the bare ones
 * @returns {{ ok: true, flags: Record<string, string|true>, rest: string[] } | { ok: false, error: string }}
 */
function parseArgs(argv, { valued = [], flags = [] } = {}) {
  const out = {};
  const rest = [];
  const known = new Set([...valued, ...flags, '--help', '-h']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('-')) {
      rest.push(a);
      continue;
    }
    if (!known.has(a)) return { ok: false, error: `unknown flag "${a}"` };
    if (valued.includes(a)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('-')) return { ok: false, error: `${a} needs a value` };
      out[a] = v;
      i++;
    } else out[a] = true;
  }
  return { ok: true, flags: out, rest };
}

/** The repository root of `cwd`, or null outside a git work tree. */
function repoRoot(cwd) {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', windowsHide: true });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

/** git stdout at `cwd`, or null on a non-zero exit. */
function git(cwd, args, opts = {}) {
  const r = spawnSync('git', args, { cwd, encoding: opts.buffer ? 'buffer' : 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) return null;
  return r.stdout;
}

/** NUL-separated git output → paths with forward slashes. */
const zlist = (out) => (out ? String(out).split('\0').filter(Boolean).map((p) => p.replace(/\\/g, '/')) : []);

/** `*` and `?` inside one segment, `**` across segments; a pattern without a slash matches the base name too. */
function globToRegex(glob) {
  const g = String(glob).replace(/\\/g, '/').replace(/^\.\//, '');
  const body = g
    .split('**')
    .map((part) => part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]'))
    .join('.*');
  return new RegExp(g.includes('/') ? `^${body}$` : `(?:^|/)${body}$`);
}

/** True when `rel` is covered by one of the `allow` globs (by path, never by content). */
function allowed(rel, allow = []) {
  const p = String(rel).replace(/\\/g, '/');
  return (allow || []).some((g) => globToRegex(g).test(p) || globToRegex(String(g).replace(/\/$/, '') + '/**').test(p));
}

/**
 * Resolve the feature for a check: loads the profile, applies the off rule and the --defaults form.
 * @returns {{ exit: number } | { config: object, firstLine: string|null, settings: object }}
 */
function featureFor(name, cwd, { defaults = false, profile, runHint, log = console.log, error = console.error }) {
  const loaded = profile.load(cwd);
  if (loaded.errors.length > 0) {
    error(`${name}: PIPELINE_PROFILE.md is invalid — run ${runHint('features')}`);
    for (const e of loaded.errors) error(`  ${e}`);
    return { exit: EXIT.usage };
  }
  const feature = profile.feature(loaded.settings, name);
  if (!feature.enabled && !defaults) {
    log(feature.line);
    return { exit: EXIT.off };
  }
  // The standalone form reads only the kit's defaults: a profile that has not switched the check on sets nothing (REQ-710's rule).
  const config = feature.enabled ? feature.config : { ...profile.FEATURES[name].defaults };
  return { config, settings: loaded.settings, firstLine: feature.enabled ? null : `${feature.line} — checking with defaults` };
}

module.exports = { EXIT, parseArgs, repoRoot, git, zlist, globToRegex, allowed, featureFor };
