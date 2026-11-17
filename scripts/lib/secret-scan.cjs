'use strict';
/**
 * secret-scan — the outbound guard's secret shapes over the tree, the history and a staged commit (REQ-1813 to
 * REQ-1815; D88, D89, D96).
 *
 *   SECRET          `file:line — kind` in a tracked text file under `roots`. Never the matched text.
 *   ENV-FILE        a tracked `.env` or `.env.*` file, whatever the roots.
 *   SECRET-HISTORY  `commit file — kind`: an added line of a commit in target..HEAD (history on, maxCommits).
 *
 * A binary file (a NUL byte in the first 8 KB) and a file over 1 MB are skipped and counted. `allow` suppresses by
 * path. Any finding exits 1 (D89). The shapes are imported, never copied: scripts/lib/outbound-guard.cjs SHAPES.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { SHAPES } = require('./outbound-guard.cjs');
const cli = require('./hygiene-cli.cjs');

const MAX_BYTES = 1024 * 1024;
const ENV_FILE = /(?:^|\/)\.env(?:\.[^/]+)?$/;
const ROTATE = 'Rotate the key. The history rewrite is a decision for a person.';

/** [{ kind, line }] for `text`; the matched text is never kept. */
function scanText(text, shapes = SHAPES) {
  const hits = [];
  String(text)
    .split(/\r?\n/)
    .forEach((line, i) => {
      for (const [kind, re] of shapes) if (re.test(line)) hits.push({ kind, line: i + 1 });
    });
  return hits;
}

const isBinary = (buf) => buf.subarray(0, 8192).includes(0);
const underRoots = (rel, roots) => roots.some((r) => {
  const n = String(r).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
  return n === '' || n === '.' || rel === n || rel.startsWith(`${n}/`);
});

/**
 * The tree scan over the tracked files.
 * @returns {{ findings: Array<{kind:string, path:string, line?:number, shape?:string}>, skipped: {binary:number, large:number}, scanned: number }}
 */
function tree({ root, roots = ['.'], allow = [], shapes = SHAPES, files }) {
  const tracked = files ?? cli.zlist(cli.git(root, ['ls-files', '-z']));
  const findings = [];
  const skipped = { binary: 0, large: 0 };
  let scanned = 0;
  for (const rel of tracked) {
    if (cli.allowed(rel, allow)) continue;
    if (ENV_FILE.test(rel)) findings.push({ kind: 'ENV-FILE', path: rel });
    if (!underRoots(rel, roots)) continue;
    let st;
    try {
      st = fs.lstatSync(path.join(root, rel));
    } catch (_) {
      continue;
    }
    if (!st.isFile()) continue;
    if (st.size > MAX_BYTES) {
      skipped.large++;
      continue;
    }
    const buf = fs.readFileSync(path.join(root, rel));
    if (isBinary(buf)) {
      skipped.binary++;
      continue;
    }
    scanned++;
    for (const h of scanText(buf.toString('utf8'), shapes)) findings.push({ kind: 'SECRET', path: rel, line: h.line, shape: h.kind });
  }
  return { findings, skipped, scanned };
}

/** Added lines of `git show -U0 <commit>` by file: [{ file, text }]. */
function addedLines(patch) {
  const out = [];
  let file = null;
  for (const line of String(patch).split('\n')) {
    if (line.startsWith('+++ ')) {
      file = line.slice(4).replace(/^b\//, '').trim();
      if (file === '/dev/null') file = null;
      continue;
    }
    if (file && line.startsWith('+') && !line.startsWith('+++')) out.push({ file, text: line.slice(1) });
  }
  return out;
}

/**
 * The history scan: added lines of each commit in `target..HEAD` (or HEAD's last `maxCommits` without a target).
 * @returns {{ findings: Array<{kind:'SECRET-HISTORY', commit:string, path:string, shape:string}>, commits: number }}
 */
function history({ root, target = null, maxCommits = 200, allow = [], shapes = SHAPES }) {
  const range = target ? `${target}..HEAD` : 'HEAD';
  const commits = String(cli.git(root, ['rev-list', `--max-count=${maxCommits}`, range]) ?? '').split('\n').filter(Boolean);
  const findings = [];
  const seen = new Set();
  for (const c of commits) {
    const patch = cli.git(root, ['show', '--format=', '--no-color', '-U0', '--diff-filter=AM', c]);
    if (patch === null) continue;
    for (const { file, text } of addedLines(patch)) {
      if (cli.allowed(file, allow)) continue;
      for (const h of scanText(text, shapes)) {
        const key = `${c}\0${file}\0${h.kind}`;
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push({ kind: 'SECRET-HISTORY', commit: c.slice(0, 7), path: file, shape: h.kind });
      }
    }
  }
  return { findings, commits: commits.length };
}

/** The staged scan for the pre-commit hook: added lines of `git diff --cached -U0`. */
function staged({ root, allow = [], shapes = SHAPES }) {
  const r = spawnSync('git', ['diff', '--cached', '--no-color', '-U0', '--diff-filter=AM'], { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) return { findings: [], error: (r.stderr || 'git diff failed').trim() };
  const findings = [];
  const seen = new Set();
  for (const { file, text } of addedLines(r.stdout)) {
    if (cli.allowed(file, allow)) continue;
    for (const h of scanText(text, shapes)) {
      const key = `${file}\0${h.kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({ kind: 'SECRET-STAGED', path: file, shape: h.kind });
    }
  }
  return { findings };
}

/** The profile's `features.secretScan.allow`, read as data from the §16 block; [] when absent or malformed. */
function allowFromProfile(root) {
  try {
    const text = fs.readFileSync(path.join(root, 'PIPELINE_PROFILE.md'), 'utf8');
    if (Buffer.byteLength(text) > MAX_BYTES) return [];
    const blocks = [...text.matchAll(/```json[ \t]+pipeline-settings[ \t]*\r?\n([\s\S]*?)\r?\n```/g)];
    if (blocks.length !== 1) return [];
    const raw = JSON.parse(blocks[0][1]);
    const list = raw?.features?.secretScan?.allow;
    return Array.isArray(list) && list.every((g) => typeof g === 'string') ? list : [];
  } catch (_) {
    return [];
  }
}

/** What the pre-commit hook runs: exit 1 with the kinds and files on stderr, exit 0 clean. No unlock variable exists. */
function precommit(root, { shapes = SHAPES, error = console.error } = {}) {
  const r = staged({ root, allow: allowFromProfile(root), shapes });
  if (r.error) {
    error(`secret-scan pre-commit: ${r.error} — the commit goes through (the hook never guesses)`);
    return 0;
  }
  if (!r.findings.length) return 0;
  error('BLOCKED: a staged change carries a secret shape (secret-scan pre-commit, PIPELINE_PROFILE.md §16 features.secretScan.allow is the only exception):');
  for (const f of r.findings) error(`  - ${f.path} — ${f.shape}`);
  error('Remove the value (and rotate it if it was real), then commit again.');
  return 1;
}

function render({ treeResult, hist, historyOn, maxCommits }) {
  const out = [];
  for (const f of treeResult.findings) {
    if (f.kind === 'SECRET') out.push(`${'SECRET'.padEnd(16)}${f.path}:${f.line} — ${f.shape}`);
    else out.push(`${'ENV-FILE'.padEnd(16)}${f.path} — a tracked env file`);
  }
  for (const f of hist?.findings ?? []) out.push(`${'SECRET-HISTORY'.padEnd(16)}${f.commit} ${f.path} — ${f.shape}`);
  if (hist?.findings?.length) out.push(ROTATE);
  const total = treeResult.findings.length + (hist?.findings.length ?? 0);
  const skipped = `${treeResult.skipped.binary} binary file(s) skipped, ${treeResult.skipped.large} over 1 MB skipped`;
  out.push(`secret-scan: ${total ? 'FAIL' : 'PASS'} — ${total} finding(s) · ${skipped}` + (historyOn ? ` · history: ${hist.commits} commit(s) read (maxCommits ${maxCommits})` : ' · history off'));
  return out.join('\n');
}

module.exports = { MAX_BYTES, ROTATE, SHAPES, scanText, isBinary, tree, addedLines, history, staged, allowFromProfile, precommit, render };
