'use strict';
/**
 * Attribution check — the commit side of the completion gate (specs/repo-hygiene.spec.md M21, REQ-1841; decisions
 * D99, D102, D104). Over the commits from a ref to HEAD it reports:
 *
 *   TRAILER  a `Co-Authored-By` line naming an assistant, a `<Tool>-Session` line, a `Generated with|by` footer or a
 *            robot-emoji footer in the message
 *   AUTHOR   an author or committer identity in the list of assistant identities
 *   BRANCH   the current branch, or a local branch not contained in `target`, whose name carries an assistant or tool
 *            name (a merged branch is history and is not reported, D104)
 *
 * Each finding carries the short SHA (or the branch name) and the kind, never the message text and never an address.
 * The check amends nothing: it prints the amend command for a commit that is not contained in `target`, and for a
 * commit that is, it says a history rewrite is a person's decision (D102). The rename for a branch is printed as a
 * command (`git branch -m OLD NEW`) and never run.
 *
 * `patterns` (strings, regular expressions) add to the trailer and branch lists; `authors` (strings, matched
 * case-insensitively in "Name <address>") add to the identity list; `allow` holds commit SHA prefixes and branch globs.
 */
const { spawnSync } = require('child_process');
const { matchesAny } = require('./hygiene-match.cjs');

/** Assistant and tool names a trailer, footer, author or branch name is read for. */
const TOOL_NAMES = ['claude', 'codex', 'copilot', 'cursor', 'gemini', 'antigravity', 'chatgpt', 'aider', 'windsurf'];
const TOOL_WORD = new RegExp(`\\b(?:${TOOL_NAMES.join('|')}|fable|opus|sonnet|haiku|gpt-?\\d)\\b`, 'i');
const TOOL_DOMAIN = /@(?:anthropic|openai|cursor|windsurf)\.com\b/i;

/** Built-in trailer and footer shapes: [kind, regular expression over one message line]. */
const TRAILERS = [
  ['co-author trailer', /^\s*co-authored-by:\s*(.*)$/i, (m) => TOOL_WORD.test(m[1]) || TOOL_DOMAIN.test(m[1])],
  ['session line', /^\s*[a-z]+-session:\s*\S/i, (m) => TOOL_WORD.test(m[0]) || /https?:\/\//.test(m[0])],
  ['generated footer', /^\s*(?:\u{1F916}\s*)?generated (?:with|by)\b/iu, () => true],
  ['robot footer', /^\s*\u{1F916}/u, () => true],
];

function git(repo, args) {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: (r.stdout || '').replace(/\r\n/g, '\n'), err: (r.stderr || '').trim() };
}

/** The commits of `since..HEAD` (or every commit when `since` is null): [{ sha, short, author, committer, body }]. */
function commits(repo, since) {
  const range = since ? `${since}..HEAD` : 'HEAD';
  const r = git(repo, ['log', '--format=%H%x00%an <%ae>%x00%cn <%ce>%x00%B%x1e', range]);
  if (!r.ok) throw new Error(`git log ${range}: ${r.err}`);
  return r.out.split('\x1e').map((s) => s.replace(/^\n/, '')).filter((s) => s.trim()).map((rec) => {
    const [sha, author, committer, body] = rec.split('\x00');
    return { sha, short: sha.slice(0, 7), author, committer, body: body || '' };
  });
}

/** The trailer kinds found in one message, by the built-in shapes plus `patterns` (each kind `pattern`). */
function trailerKinds(body, patterns = []) {
  const kinds = [];
  for (const line of body.split('\n')) {
    for (const [kind, re, test] of TRAILERS) {
      const m = line.match(re);
      if (m && test(m)) kinds.push(kind);
    }
    for (const p of patterns) if (new RegExp(p, 'i').test(line)) kinds.push('pattern');
  }
  return [...new Set(kinds)];
}

/** True when "Name <address>" is an assistant identity: a tool name as the name, an assistant domain, or a listed string. */
function isAssistantIdentity(identity, authors = []) {
  const name = identity.replace(/\s*<.*$/, '');
  if (TOOL_WORD.test(name)) return true;
  if (TOOL_DOMAIN.test(identity)) return true;
  return authors.some((a) => identity.toLowerCase().includes(String(a).toLowerCase()));
}

/** True when a branch name carries an assistant or tool name (built-in list plus `patterns`). */
function branchCarriesTool(name, patterns = []) {
  const segs = name.toLowerCase().split(/[\/._-]+/);
  if (segs.some((s) => TOOL_NAMES.includes(s))) return true;
  return patterns.some((p) => new RegExp(p, 'i').test(name));
}

/** A `feature/` name for a branch that carries a tool name: the tool segments dropped, `feature/` in front. */
function featureName(name) {
  const parts = name.split('/').filter((seg) => !branchCarriesTool(seg)).map((seg) => seg.split(/[._-]+/).filter((w) => !TOOL_NAMES.includes(w.toLowerCase())).join('-')).filter(Boolean);
  const topic = parts.join('/') || 'topic';
  return topic.startsWith('feature/') ? topic : `feature/${topic}`;
}

function localBranches(repo) {
  const r = git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/']);
  return r.ok ? r.out.split('\n').filter(Boolean) : [];
}
function currentBranch(repo) {
  const r = git(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  return r.ok ? r.out.trim() : null; // detached HEAD: no branch name to judge
}
function contained(repo, ref, target) {
  if (!target) return false;
  return spawnSync('git', ['merge-base', '--is-ancestor', ref, target], { cwd: repo }).status === 0;
}

const shaAllowed = (sha, allow) => allow.some((a) => /^[0-9a-f]{7,40}$/i.test(a) && sha.toLowerCase().startsWith(a.toLowerCase()));
const branchAllowed = (name, allow) => matchesAny(name, allow.filter((a) => !/^[0-9a-f]{7,40}$/i.test(a)));

/**
 * Run the check. opts: { repo, since (ref or null), target (branch or null; null = since), patterns, authors, allow }.
 * Returns { findings: [{ kind, ref, short, detail, command }], checked: { commits, branches } }.
 */
function run({ repo, since = null, target = null, patterns = [], authors = [], allow = [] }) {
  const findings = [];
  const base = target || since || null;
  const list = commits(repo, since);
  for (const c of list) {
    if (shaAllowed(c.sha, allow)) continue;
    const onTarget = base ? contained(repo, c.sha, base) : false;
    const amend = onTarget
      ? `contained in ${base}: a history rewrite is a decision for a person`
      : c.sha === list[0].sha ? 'git commit --amend' : `git rebase -i ${c.short}^  (reword or reset-author)`;
    for (const kind of trailerKinds(c.body, patterns)) findings.push({ kind: 'TRAILER', ref: c.sha, short: c.short, detail: kind, command: onTarget ? amend : `${amend} — drop the ${kind}` });
    const who = [];
    if (isAssistantIdentity(c.author, authors)) who.push('author');
    if (isAssistantIdentity(c.committer, authors)) who.push('committer');
    if (who.length) findings.push({ kind: 'AUTHOR', ref: c.sha, short: c.short, detail: `${who.join(' and ')} identity`, command: onTarget ? amend : c.sha === list[0].sha ? 'git commit --amend --reset-author' : `git rebase -i ${c.short}^  (reset-author)` });
  }
  const current = currentBranch(repo);
  const branches = localBranches(repo).filter((b) => b === current || !contained(repo, b, base));
  for (const b of branches) {
    if (!branchCarriesTool(b, patterns) || branchAllowed(b, allow)) continue;
    findings.push({ kind: 'BRANCH', ref: b, short: b, detail: b === current ? 'current branch name' : 'branch name', command: `git branch -m ${b} ${featureName(b)}` });
  }
  return { findings, checked: { commits: list.length, branches: branches.length } };
}

/** One report line per finding: `KIND short — detail · command`. No message text, no address. */
function format(f) {
  return `${f.kind.padEnd(8)}${f.short} — ${f.detail} · ${f.command}`;
}

module.exports = { TOOL_NAMES, TRAILERS, commits, trailerKinds, isAssistantIdentity, branchCarriesTool, featureName, localBranches, currentBranch, contained, run, format };
