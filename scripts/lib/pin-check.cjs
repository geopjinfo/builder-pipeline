'use strict';
/**
 * pin-check — kit commands in the project's text that would fetch a package from the registry (specs/package-pinning.spec.md
 * REQ-2030; D155).
 *
 *   UNPINNED  a line with `npx builder-pipeline …` or `npm exec builder-pipeline …` and no `--no-install`, `--no` or
 *             `@<version>`. Exit 1.
 *
 * WHY. `npx builder-pipeline` runs the installed copy when the project has the kit as a dependency. In any other folder
 * it fetches the newest `builder-pipeline` from the npm registry and runs it. The name is not registered, so a stranger
 * who publishes it would be run by every unpinned line. `npx --no-install builder-pipeline` runs the installed copy or
 * stops ("npx canceled due to missing packages"); a version suffix pins the release. The check reads the tracked files
 * that match `files` (instruction files, docs and shell wrappers by default); `allow` suppresses by path.
 */
const { readFileSync } = require('node:fs');
const path = require('node:path');
const cli = require('./hygiene-cli.cjs');

const DEFAULT_FILES = Object.freeze(['*.md', '*.mdc', '*.txt', '*.toml', '*.sh', '*.ps1']);
/** The bin name after `npx` or `npm exec` with no flag before it and no version after it. */
const UNPINNED = /\b(?:npx|npm\s+exec(?:\s+--)?)\s+builder-pipeline\b(?!@)/g;
const MAX_BYTES = 4 * 1024 * 1024;

/** True when `rel` matches one of the `files` globs. */
const selected = (rel, files) => (files || []).some((g) => cli.globToRegex(g).test(rel));

/** The UNPINNED findings in `text`: [{ kind, path, line, text }]. */
function scanText(rel, text) {
  const out = [];
  String(text).split(/\r?\n/).forEach((l, i) => {
    UNPINNED.lastIndex = 0;
    if (UNPINNED.test(l)) out.push({ kind: 'UNPINNED', path: rel, line: i + 1, text: l.trim().slice(0, 120) });
  });
  return out;
}

/**
 * Scan the tracked files of `root` that match `files` and are not allowed.
 * @param {{ root: string, files?: string[], allow?: string[], tracked?: string[] }} o
 * @returns {{ findings: object[], scanned: number }}
 */
function scan({ root, files = DEFAULT_FILES, allow = [], tracked = null }) {
  const list = (tracked ?? cli.zlist(cli.git(root, ['ls-files', '-z']))).filter((rel) => selected(rel, files) && !cli.allowed(rel, allow));
  const findings = [];
  for (const rel of list) {
    let buf;
    try {
      buf = readFileSync(path.join(root, ...rel.split('/')));
    } catch (_) {
      continue; // listed in the index but not in the working tree
    }
    if (buf.length > MAX_BYTES || buf.includes(0)) continue;
    findings.push(...scanText(rel, buf.toString('utf8')));
  }
  return { findings, scanned: list.length };
}

function render({ findings, scanned }) {
  const out = findings.map((f) => `${'UNPINNED'.padEnd(15)}${f.path}:${f.line} — ${f.text}`);
  out.push(`pin-check: ${findings.length ? 'FAIL' : 'PASS'} — ${findings.length} unpinned kit call(s) in ${scanned} file(s); the pinned form is \`npx --no-install builder-pipeline …\``);
  return out.join('\n');
}

module.exports = { DEFAULT_FILES, UNPINNED, scanText, scan, render };
