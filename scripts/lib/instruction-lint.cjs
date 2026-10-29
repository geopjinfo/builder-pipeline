'use strict';
/**
 * The instruction lint — what an agent-instruction file states about the repo must still be true of the repo.
 *
 * WHY THIS EXISTS. Instruction files (the root CLAUDE.md / AGENTS.md, rule files, persona and skill files) are read on
 * every turn and believed. They drift the way any prose drifts, but nobody re-reads them, because they look settled.
 * In one adopting project a single audit found a range of decision records frozen at "008…026" when there were ninety,
 * a persona citing a spec version that no longer existed, a reviewer told to read three of the four audit reports it
 * had to pass, a mirror file whose counts were all wrong, and line references (`:124-125`) that had come to point at
 * unrelated text. Every one of those is checkable. This is DESIGN §17 (a figure is read from its source by a test)
 * applied to the files that tell agents what to do.
 *
 * THE RULES. Hard rules fail the gate; ratcheted rules may not grow.
 *   - paths (hard)      every inline-code repo path resolves: from the project root, from the citing file's folder, or —
 *                       because prose names a file the sentence has already located — as the tail of some file in the
 *                       repo (a bare name by its basename, a partial path by its suffix). A token is a path when it ends
 *                       in a known extension or its first segment is a directory that exists; bare extensions
 *                       (`.service.ts`), placeholders (`<key>`, `{x}`, `*`, `…`) and `ignorePaths` matches are skipped.
 *   - lineRefs (hard)   no bare line reference (`:113`, `(:124-125)`) without a file name — it points at whatever moves
 *                       there next. Cite a heading or quote the sentence.
 *   - figures (hard)    every registered figure matches its source: { file, pattern (one capture group), command }.
 *   - sets (hard)       every file that enumerates a declared set names every member of it.
 *   - counts (ratchet)  count-shaped claims ("six seats", "ADR-008…026") not covered by a registered figure.
 *   - history (ratchet) incident history inside a rule ("used to", "fixed 2026-08-19", "until X merges", "first weeks").
 *                       The rule states its mechanism and cites a decision id; the story lives in the decision record.
 *
 * Fenced code blocks are skipped: they hold commands and examples, not claims. Pure over (path, text) pairs; the CLI
 * reads files, runs figure commands and reads and writes the baseline.
 */

const EXT = /\.(md|mjs|cjs|js|ts|tsx|json|jsonl|csv|ya?ml|sql|prisma|ps1|sh|py|toml|txt|html|mermaid|docx|pdf|xlsx)$/i;
const PLACEHOLDER = /[<>{}*?…|$]/;
// "one" is left out on purpose: "one module, one session" is a rule, not a count that can drift.
const NUMBER_WORDS = 'two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen';
const COUNT_NOUNS = 'seats?|skills?|agents?|personas?|ADRs?|modules?|auditors?|keys|roles?|hooks?|gates?|suites?|specs?|scripts?|tiers?|lanes?|columns?|phases?';
const COUNT_CLAIM = new RegExp(`\\b(?:[2-9]|\\d{2,4}|${NUMBER_WORDS})\\s+(?:of the\\s+(?:\\d{1,4}|${NUMBER_WORDS})\\s+)?(?:\`[^\`]+\`\\s+)?(?:${COUNT_NOUNS})\\b`, 'gi');
const RANGE_CLAIM = /\b[A-Z]{2,}-\d{2,}\s*(?:…|\.\.\.|–)\s*\d{2,}\b/g;
const DEFAULT_HISTORY = [
  '\\bused to (?:say|name|read|be|run)\\b',
  '\\b(?:fixed|measured|refreshed|reverses?|removed|added|ratified|landed) (?:on )?20\\d\\d-\\d\\d-\\d\\d\\b',
  '\\buntil (?:the )?[\\w-]+ (?:merges|lands|ships)\\b',
  '\\bin the first (?:weeks|days|runs)\\b',
  '\\bthis (?:step|bullet|rule|section) (?:said|named|read)\\b',
];
const BARE_LINE_REF = /(^|[\s([])`?:(\d+)(?:[-–](\d+))?`?(?=[\s).,;\]]|$)/g;

/** Lines outside fenced code blocks, with their 1-based numbers. */
function proseLines(text) {
  const out = [];
  let fence = null;
  String(text).replace(/\r\n/g, '\n').split('\n').forEach((line, i) => {
    const m = /^\s*(```+|~~~+)/.exec(line);
    if (m) {
      if (!fence) fence = m[1][0];
      else if (m[1][0] === fence) fence = null;
      return;
    }
    if (!fence) out.push({ n: i + 1, line });
  });
  return out;
}

/** Inline-code tokens that look like repo paths, normalised (trailing `:line`, `#anchor` and punctuation removed). */
function pathCandidates(text, { dirExists = () => false } = {}) {
  const found = [];
  for (const { n, line } of proseLines(text)) {
    for (const m of line.matchAll(/`([^`\s]+)`/g)) {
      let t = m[1].replace(/[.,;:)]+$/, '').replace(/#.*$/, '').replace(/:\d+(?:[-–]\d+)?$/, '');
      if (!t || PLACEHOLDER.test(t) || /^(?:https?:|mailto:|~|\/|-|@|\.\.?$)/.test(t)) continue;
      t = t.replace(/^\.\//, '');
      if (/^\.[\w-]+(?:\.[\w-]+)*$/.test(t)) continue; // a bare extension or suffix, not a file
      const first = t.split('/')[0];
      if (EXT.test(t) || (t.includes('/') && dirExists(first))) found.push({ n, token: t });
    }
  }
  return found;
}

function bareLineRefs(text) {
  const hits = [];
  for (const { n, line } of proseLines(text)) {
    if (/^\s*\|?\s*:?-{3,}/.test(line)) continue; // a markdown table's alignment row
    for (const m of line.matchAll(BARE_LINE_REF)) hits.push({ n, ref: `:${m[2]}${m[3] ? `-${m[3]}` : ''}` });
  }
  return hits;
}

function countClaims(text) {
  const hits = [];
  for (const { n, line } of proseLines(text)) {
    for (const re of [COUNT_CLAIM, RANGE_CLAIM]) for (const m of line.matchAll(re)) hits.push({ n, claim: m[0] });
  }
  return hits;
}

function historyHits(text, patterns = DEFAULT_HISTORY) {
  const res = patterns.map((p) => new RegExp(p, 'gi'));
  const hits = [];
  for (const { n, line } of proseLines(text)) for (const re of res) for (const m of line.matchAll(re)) hits.push({ n, phrase: m[0] });
  return hits;
}

/**
 * @param {{ path: string, text: string }[]} files
 * @param {{
 *   exists: (rel: string) => boolean,            a project-relative path exists (file or directory)
 *   index?: string[],                            every project-relative file path, for tail resolution
 *   ignorePaths?: string[],                      regexes; a path token matching one is not checked
 *   figures?: { file: string, pattern: string, actual: string | null, label?: string }[],   actual = the command's output
 *   sets?: { name: string, members: string[], files: string[] }[],
 *   history?: string[] | null,
 *   baseline?: { counts?: Record<string, number>, history?: Record<string, number> } | null,
 * }} opts
 */
function lint(files, opts) {
  const { exists, index = [], ignorePaths = [], figures = [], sets = [], history = null, baseline = null } = opts;
  const ignore = ignorePaths.map((p) => new RegExp(p));
  const basenames = new Set(index.map((p) => p.slice(p.lastIndexOf('/') + 1)));
  const atTail = (t) => (t.includes('/') ? index.some((p) => p === t || p.endsWith(`/${t}`)) : basenames.has(t));
  const problems = [];
  const counts = {};
  const historyCounts = {};
  const detail = { counts: [], history: [] };
  if (files.length === 0) problems.push('no instruction file matched — a lint over nothing asserts nothing');
  const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
  const figureLines = new Map();

  for (const f of figures) {
    const file = files.find((x) => x.path === f.file);
    const label = f.label ?? f.pattern;
    if (!file) { problems.push(`figure "${label}": ${f.file} is not among the linted files`); continue; }
    const re = new RegExp(f.pattern);
    const hit = proseLines(file.text).find(({ line }) => re.test(line));
    if (!hit) { problems.push(`figure "${label}": its pattern no longer matches ${f.file} — update the figure with the text`); continue; }
    figureLines.set(`${f.file}:${hit.n}`, true);
    const claimed = re.exec(hit.line)[1];
    if (f.actual === null || f.actual === undefined) problems.push(`figure "${label}": its command produced no value`);
    else if (String(claimed).trim() !== String(f.actual).trim()) problems.push(`${f.file}:${hit.n}: figure "${label}" says ${claimed}, the source says ${String(f.actual).trim()}`);
  }

  for (const s of sets) {
    if (!s.members.length) { problems.push(`set "${s.name}": no members — a set of nothing asserts nothing`); continue; }
    for (const p of s.files) {
      const file = files.find((x) => x.path === p);
      if (!file) { problems.push(`set "${s.name}": ${p} is not among the linted files`); continue; }
      const missing = s.members.filter((m) => !new RegExp(`(^|[^\\w-])${m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\w-])`).test(file.text));
      if (missing.length) problems.push(`${p}: enumerates the set "${s.name}" without ${missing.join(', ')}`);
    }
  }

  for (const { path, text } of files) {
    const here = dirOf(path);
    const dirExists = (seg) => exists(seg);
    for (const { n, token } of pathCandidates(text, { dirExists })) {
      if (ignore.some((re) => re.test(token))) continue;
      const fromFile = here ? `${here}/${token}`.split('/').reduce((acc, s) => (s === '..' ? acc.slice(0, -1) : s === '.' ? acc : [...acc, s]), []).join('/') : token;
      if (!exists(token) && !exists(fromFile) && !atTail(token)) problems.push(`${path}:${n}: \`${token}\` does not exist`);
    }
    for (const { n, ref } of bareLineRefs(text)) problems.push(`${path}:${n}: bare line reference \`${ref}\` — name the file, cite a heading, or quote the sentence`);
    const c = countClaims(text).filter(({ n }) => !figureLines.has(`${path}:${n}`));
    const h = historyHits(text, history ?? DEFAULT_HISTORY);
    if (c.length) counts[path] = c.length;
    if (h.length) historyCounts[path] = h.length;
    detail.counts.push(...c.map((x) => `${path}:${x.n}: ${x.claim}`));
    detail.history.push(...h.map((x) => `${path}:${x.n}: ${x.phrase}`));
  }

  const ratchet = [];
  if (baseline) {
    for (const [kind, now, base] of [['count claims', counts, baseline.counts ?? {}], ['history phrases', historyCounts, baseline.history ?? {}]]) {
      for (const [p, k] of Object.entries(now)) if (k > (base[p] ?? 0)) ratchet.push(`${p}: ${k} unregistered ${kind}, baseline ${base[p] ?? 0} — register or reword the new ones (--list shows them)`);
    }
  }
  return { ok: problems.length === 0 && ratchet.length === 0, problems, ratchet, counts, history: historyCounts, detail };
}

module.exports = { lint, pathCandidates, bareLineRefs, countClaims, historyHits, proseLines, DEFAULT_HISTORY };
