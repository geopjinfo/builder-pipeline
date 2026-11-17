'use strict';
/**
 * ignore-check — files git tracks but should ignore, and untracked junk that nothing ignores (REQ-1811, D97).
 *
 *   TRACKED-JUNK    a tracked file that matches the catalogue (or `extra`)
 *   UNIGNORED-JUNK  an untracked, not-ignored file that matches
 *
 * The catalogue is built in and `extra` adds to it; nothing removes from it. `allow` suppresses by path. The report
 * prints the .gitignore lines to add and NEVER writes the file: .gitignore is the project's (AGENTS.md rule 12, D97).
 * A soft check: findings exit 0.
 */
const path = require('node:path');
const cli = require('./hygiene-cli.cjs');

/** One entry per line of the report; a trailing slash is a folder name anywhere in the path. */
const CATALOGUE = Object.freeze([
  'node_modules/', 'dist/', 'build/', 'coverage/', 'out/',
  '*.log', '.env', '.env.*', '.DS_Store', 'Thumbs.db', '*.swp', '*~', '*.orig', '*.rej',
  'core dumps',
  '.pipeline/', 'logs/',
]);
const CORE_DUMP = /^core(?:\.\d+)?$/;

/** The catalogue entry `rel` matches, or null. A folder entry matches a path segment; a glob matches the base name. */
function matchOf(rel, catalogue = CATALOGUE) {
  const p = String(rel).replace(/\\/g, '/');
  const segments = p.split('/');
  const base = segments[segments.length - 1];
  for (const entry of catalogue) {
    if (entry === 'core dumps') {
      if (CORE_DUMP.test(base)) return entry;
      continue;
    }
    if (entry.endsWith('/')) {
      if (segments.slice(0, -1).includes(entry.slice(0, -1))) return entry;
      continue;
    }
    if (cli.globToRegex(entry).test(base)) return entry;
  }
  return null;
}

/** The .gitignore line for a catalogue entry. */
const lineFor = (entry) => (entry === 'core dumps' ? 'core\ncore.*' : entry);

/**
 * @param {{ root: string, extra?: string[], allow?: string[], tracked?: string[], untracked?: string[] }} opts
 *   `tracked` and `untracked` are injectable for tests; otherwise read from git.
 */
function check({ root, extra = [], allow = [], tracked, untracked }) {
  const catalogue = [...CATALOGUE, ...extra.filter((e) => typeof e === 'string' && e)];
  const tr = tracked ?? cli.zlist(cli.git(root, ['ls-files', '-z']));
  const un = untracked ?? cli.zlist(cli.git(root, ['ls-files', '-z', '--others', '--exclude-standard']));
  const findings = [];
  for (const [kind, list] of [['TRACKED-JUNK', tr], ['UNIGNORED-JUNK', un]]) {
    for (const rel of list) {
      if (rel === '.gitignore' || cli.allowed(rel, allow)) continue;
      const entry = matchOf(rel, catalogue);
      if (entry) findings.push({ kind, path: rel, entry });
    }
  }
  const lines = [...new Set(findings.map((f) => lineFor(f.entry)))];
  return { findings, lines, tracked: findings.filter((f) => f.kind === 'TRACKED-JUNK').length, unignored: findings.filter((f) => f.kind === 'UNIGNORED-JUNK').length };
}

/** The printed report. */
function render(result) {
  const out = [];
  for (const f of result.findings) out.push(`${f.kind.padEnd(16)}${f.path} — matches ${f.entry}`);
  if (result.lines.length) out.push('', '.gitignore lines to add:', ...result.lines, '');
  out.push(`ignore-check: ${result.findings.length} finding(s) — ${result.tracked} tracked, ${result.unignored} unignored · .gitignore is yours to edit (D97)`);
  return out.join('\n');
}

module.exports = { CATALOGUE, matchOf, lineFor, check, render, relative: (root, p) => path.relative(root, p) };
