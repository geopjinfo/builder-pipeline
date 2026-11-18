'use strict';
/**
 * Artifact check — the tree side of the completion gate (specs/repo-hygiene.spec.md M21, REQ-1842, REQ-1843;
 * decisions D99, D100, D101, D103). Over the tracked files (the whole tree, the files changed since a ref, or the
 * index with --staged) it reports:
 *
 *   ASSISTANT-FILE   a tracked path in the assistant catalogue (`.claude/`, `.cursorrules`, `CLAUDE.md`, …)
 *   SCRATCH-FILE     a tracked path in the scratch catalogue (`*.tmp`, `*.bak`, `scratch/`, …)
 *   ARCHIVE          a tracked path in the separation catalogue (deployment archives and packaging output, D103)
 *   ASSISTANT-IGNORE a `.gitignore` line that names an assistant path (the ignore file stays generic)
 *   AI-LABEL         a generated-content label line in a tracked text file
 *
 * `extra` adds paths (globs) to the catalogues; `allow` (globs) is the only way past a finding (D100): the kit installs
 * `.claude/`, `.codex/`, `.agents/` and `CLAUDE.md` into end projects on purpose, and the project says so in §16.
 * Every finding prints the command a person would run; the check runs none of them, writes nothing and never reads a
 * file over 1 MB or a binary file for labels.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { matchesAny, matching } = require('./hygiene-match.cjs');

const ASSISTANT = ['.claude/', '.codex/', '.agents/', '.cursor/', '.cursorrules', '.windsurf/', '.windsurfrules', '.aider*', '.gemini/', 'GEMINI.md', 'CLAUDE.md', 'AGENTS.md', '.clinerules', '.github/copilot-instructions.md', '.mcp.json'];
const SCRATCH = ['*.tmp', '*.bak', '*.orig', '*.rej', '*.swp', '*~', 'scratch/', 'tmp/'];
const ARCHIVE = ['*.zip', '*.tar.gz', '*.tgz', '*.whl', '*.jar', '*.nupkg', '*.deb', '*.rpm', '*.dmg', '*.exe', '*.msi', '*.apk'];
/** A generated-content label: the footer an assistant appends, in a file. The commit-msg hook strips the same shapes from messages. */
const LABEL = /(?:\u{1F916}\s*)?\bgenerated (?:with|by) \[?(?:claude|codex|copilot|cursor|gemini|antigravity|chatgpt|aider|windsurf)\b|^\s*co-authored-by:.*\b(?:claude|codex|copilot|cursor|gemini|antigravity|chatgpt|aider|windsurf)\b/iu;
const ARCHIVE_EXT = /\.(?:zip|tar\.gz|tgz|whl|jar|nupkg|deb|rpm|dmg|exe|msi|apk)$/i;
const MAX_LABEL_BYTES = 1024 * 1024;

function git(repo, args, input) {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: (r.stdout || '').replace(/\r\n/g, '\n'), err: (r.stderr || '').trim() };
}
const lines = (s) => s.split('\n').filter(Boolean);

/** Tracked paths: the whole tree, or the ones changed since `since` (added, modified, renamed) that are still tracked. */
function trackedFiles(repo, since) {
  const all = git(repo, ['ls-files', '-z']);
  if (!all.ok) throw new Error(`git ls-files: ${all.err}`);
  const tracked = all.out.split('\0').filter(Boolean);
  if (!since) return tracked;
  const changed = git(repo, ['diff', '--name-only', '--diff-filter=AMR', '-z', `${since}..HEAD`]);
  if (!changed.ok) throw new Error(`git diff ${since}..HEAD: ${changed.err}`);
  const set = new Set(changed.out.split('\0').filter(Boolean));
  return tracked.filter((p) => set.has(p));
}
/** The index: paths added or modified, as the pre-commit hook sees them (D101). */
function stagedFiles(repo) {
  const r = git(repo, ['diff', '--cached', '--name-only', '--diff-filter=AM', '-z']);
  if (!r.ok) throw new Error(`git diff --cached: ${r.err}`);
  return r.out.split('\0').filter(Boolean);
}

/** The text of a tracked or staged file for the label scan, or null when it is binary, too large or unreadable. */
function textOf(repo, rel, staged) {
  let buf;
  try {
    if (staged) {
      const r = spawnSync('git', ['show', `:${rel}`], { cwd: repo, maxBuffer: MAX_LABEL_BYTES + 1 });
      if (r.status !== 0) return null;
      buf = r.stdout;
    } else {
      const abs = path.join(repo, rel);
      const st = fs.statSync(abs);
      if (!st.isFile() || st.size > MAX_LABEL_BYTES) return null;
      buf = fs.readFileSync(abs);
    }
  } catch (_) {
    return null;
  }
  if (buf.length > MAX_LABEL_BYTES) return null;
  const probe = buf.subarray(0, 8000);
  if (probe.includes(0)) return null; // binary
  return buf.toString('utf8');
}

/** The label lines of one text: [{ line, text }] — `text` is the line, kept for the command, never the whole file. */
function labelLines(text) {
  const out = [];
  text.split('\n').forEach((l, i) => {
    if (LABEL.test(l)) out.push({ line: i + 1 });
  });
  return out;
}

/** The `.gitignore` lines that name an assistant path, with their line numbers. */
function assistantIgnoreLines(text, assistant) {
  const out = [];
  text.split('\n').forEach((raw, i) => {
    const l = raw.trim().replace(/^!/, '').replace(/^\//, '');
    if (!l || l.startsWith('#')) return;
    if (matchesAny(l.replace(/\/$/, ''), assistant) || assistant.some((a) => a.replace(/\/$/, '') === l.replace(/\/$/, '').replace(/\*+$/, ''))) out.push({ line: i + 1, text: raw.trim() });
  });
  return out;
}

/**
 * Run the check. opts: { repo, since (ref or null), staged (bool), extra, allow }.
 * Returns { findings: [{ kind, path, line?, detail, command }], checked: { files, mode } }.
 */
function run({ repo, since = null, staged = false, extra = [], allow = [] }) {
  // `extra`: an archive extension joins the separation catalogue, everything else the scratch catalogue.
  const assistant = [...ASSISTANT];
  const scratch = [...SCRATCH, ...extra.filter((e) => !ARCHIVE_EXT.test(e))];
  const archive = [...ARCHIVE, ...extra.filter((e) => ARCHIVE_EXT.test(e))];
  const files = staged ? stagedFiles(repo) : trackedFiles(repo, since);
  const findings = [];
  const push = (kind, p, detail, command, line) => {
    if (matchesAny(p, allow)) return;
    findings.push({ kind, path: p, ...(line ? { line } : {}), detail, command });
  };
  for (const p of files) {
    const a = matching(p, assistant);
    const s = matching(p, scratch);
    const z = matching(p, archive);
    if (a.length) push('ASSISTANT-FILE', p, `assistant path (${a[0]})`, staged ? `git rm --cached ${quote(p)}  (and leave it untracked)` : `git rm --cached ${quote(p)}`);
    else if (s.length) push('SCRATCH-FILE', p, `scratch path (${s[0]})`, `git rm --cached ${quote(p)}`);
    else if (z.length) push('ARCHIVE', p, `archive or packaging output (${z[0]})`, `git rm --cached ${quote(p)}`);
    if (!a.length && !s.length && !z.length) {
      const text = textOf(repo, p, staged);
      if (text) for (const l of labelLines(text)) push('AI-LABEL', p, 'generated-content label', `remove line ${l.line} of ${p}`, l.line);
    }
  }
  // .gitignore: the whole tree reads it always; --since and --staged only when it is among the changed or staged files.
  const readIgnore = staged || since ? files.includes('.gitignore') : fs.existsSync(path.join(repo, '.gitignore'));
  if (readIgnore) {
    const text = textOf(repo, '.gitignore', staged);
    if (text) for (const l of assistantIgnoreLines(text, ASSISTANT)) push('ASSISTANT-IGNORE', '.gitignore', `line ${l.line} names an assistant path`, `drop the line \`${l.text}\` from .gitignore (keep it generic)`, l.line);
  }
  return { findings, checked: { files: files.length, mode: staged ? 'staged' : since ? `since ${since}` : 'tree' } };
}

const quote = (p) => (/[\s"'$&|;<>()]/.test(p) ? JSON.stringify(p) : p);

/** One report line per finding: `KIND path[:line] — detail · command`. */
function format(f) {
  return `${f.kind.padEnd(18)}${f.path}${f.line ? `:${f.line}` : ''} — ${f.detail} · ${f.command}`;
}

module.exports = { ASSISTANT, SCRATCH, ARCHIVE, LABEL, trackedFiles, stagedFiles, textOf, labelLines, assistantIgnoreLines, run, format };
