'use strict';
/**
 * size-check — tracked files over `maxFileKb`, and (history on) blobs over the limit in the history (REQ-1812, D89, D96).
 *
 *   LARGE          a tracked blob over the limit: its size in KB. A Git LFS pointer file is never large. Exit 1.
 *   LARGE-HISTORY  a blob over the limit reachable from `target` within `maxCommits`, with the first commit that
 *                  added it. Reported, never failed: the rewrite is a person's decision (D86).
 *
 * `allow` suppresses by path. Sizes come from the object store (`git cat-file --batch-check`), never from the working
 * tree, so an edited but unstaged file does not change the verdict.
 */
const { spawnSync } = require('node:child_process');
const cli = require('./hygiene-cli.cjs');

const LFS = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\r?\n/;
const kb = (bytes) => Math.ceil(bytes / 1024);
const isLfsPointer = (buf) => buf.length < 1024 && LFS.test(buf.toString('utf8', 0, Math.min(buf.length, 200)));

/** `git ls-files -s -z` → [{ path, oid }]. */
function trackedBlobs(root) {
  const out = cli.git(root, ['ls-files', '-s', '-z']);
  if (out === null) return [];
  return String(out)
    .split('\0')
    .filter(Boolean)
    .map((rec) => {
      const m = /^(\d+) ([0-9a-f]+) (\d)\t(.*)$/.exec(rec);
      return m ? { mode: m[1], oid: m[2], path: m[4].replace(/\\/g, '/') } : null;
    })
    .filter((x) => x && x.mode !== '160000');
}

/** git with stdin at `root`; stdout, or null on a non-zero exit. */
function gitIn(root, args, input) {
  const r = spawnSync('git', args, { cwd: root, input, encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}

function tree({ root, maxFileKb, allow = [] }) {
  const limit = maxFileKb * 1024;
  const blobs = trackedBlobs(root);
  const out = gitIn(root, ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], blobs.map((b) => b.oid).join('\n') + '\n');
  const size = new Map();
  for (const line of String(out ?? '').split('\n')) {
    const [oid, type, n] = line.split(' ');
    if (oid && type === 'blob') size.set(oid, Number(n));
  }
  const findings = [];
  for (const b of blobs) {
    const bytes = size.get(b.oid);
    if (bytes === undefined || bytes <= limit || cli.allowed(b.path, allow)) continue;
    const head = gitIn(root, ['cat-file', 'blob', b.oid], undefined);
    if (head !== null && isLfsPointer(Buffer.from(head.slice(0, 300), 'utf8'))) continue;
    findings.push({ kind: 'LARGE', path: b.path, bytes, kb: kb(bytes) });
  }
  return findings;
}

/** Blobs over the limit in `maxCommits` commits from `target`, each with the first commit that added it; `exclude` holds the paths the tree already reported. */
function history({ root, maxFileKb, target = 'HEAD', maxCommits = 500, allow = [], exclude = [] }) {
  const limit = maxFileKb * 1024;
  const commits = String(cli.git(root, ['rev-list', `--max-count=${maxCommits}`, target]) ?? '').split('\n').filter(Boolean);
  if (!commits.length) return { findings: [], commits: 0 };
  const objects = gitIn(root, ['rev-list', '--objects', '--stdin'], commits.join('\n') + '\n');
  const byOid = new Map();
  for (const line of String(objects ?? '').split('\n')) {
    const sp = line.indexOf(' ');
    if (sp > 0) byOid.set(line.slice(0, sp), line.slice(sp + 1).replace(/\\/g, '/'));
  }
  const check = gitIn(root, ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], [...byOid.keys()].join('\n') + '\n');
  const findings = [];
  const seen = new Set(exclude);
  for (const line of String(check ?? '').split('\n')) {
    const [oid, type, n] = line.split(' ');
    if (!oid || type !== 'blob' || Number(n) <= limit) continue;
    const p = byOid.get(oid);
    if (!p || seen.has(p) || cli.allowed(p, allow)) continue;
    seen.add(p);
    const adds = String(cli.git(root, ['log', '--diff-filter=A', '--format=%h', `--max-count=${maxCommits}`, target, '--', p]) ?? '').trim().split('\n').filter(Boolean);
    findings.push({ kind: 'LARGE-HISTORY', path: p, bytes: Number(n), kb: kb(Number(n)), commit: adds[adds.length - 1] || null });
  }
  return { findings, commits: commits.length };
}

function render({ maxFileKb, treeFindings, hist, historyOn }) {
  const out = [];
  for (const f of treeFindings) out.push(`${'LARGE'.padEnd(15)}${f.path} — ${f.kb} KB (limit ${maxFileKb} KB)`);
  for (const f of hist?.findings ?? []) out.push(`${'LARGE-HISTORY'.padEnd(15)}${f.path} — ${f.kb} KB, added in ${f.commit ?? 'an unlisted commit'} (reported: the rewrite is a person's decision)`);
  const verdict = treeFindings.length ? 'FAIL' : 'PASS';
  out.push(
    `size-check: ${verdict} — ${treeFindings.length} large file(s) in the tree` +
      (historyOn ? `, ${hist.findings.length} in history (reported) · ${hist.commits} commit(s) read` : ' · history off'),
  );
  return out.join('\n');
}

module.exports = { kb, isLfsPointer, trackedBlobs, tree, history, render };
