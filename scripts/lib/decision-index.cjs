'use strict';
/**
 * The decision index — derived from anchors, never hand-written.
 *
 * WHY. A hand-kept index lists what someone remembered to list. An id that was announced and cited but never
 * given an anchor is then simply not there, and nobody notices an absence. In one adopting project a decision id
 * was cited by a shipped gate and by a changelog line while no heading anywhere defined it. Deriving the index
 * from the anchors themselves turns that absence into a visible row under "Cited but never anchored".
 *
 * ANCHOR (markdown files only, outside fenced code):
 *   - a heading whose first token is an id, optionally backticked:  `## D-12 — title` · ``### `D-12`: title``
 *   - a table row whose FIRST cell is exactly one id (the decision-log format
 *     `| D-1 | date | scope | decision | why | ADR |`); its title is the cell under a `Decision` header when the
 *     table has one, else the remaining cells joined with " · ".
 * CITATION: every other occurrence of an id — including a second id on an anchor line ("D-7 supersedes D-3"),
 * and every occurrence in a non-markdown file, where `# D-2` is a comment, not a heading.
 *
 * Pure over text; the script walks the roots and writes the output.
 */

/**
 * The id pattern is wrapped as `\b(?:<idPattern>)\b`. The trailing `\b` is what makes the match GREEDY on the
 * whole id: without it `D-\d+` could stop at `D-2` inside `D-20260821`, and a longer id would be indexed as a
 * shorter one that was never announced. With it, the engine backtracks only to a match that ends at a token
 * boundary. (An alternation still matches its first branch — list the longer shape first.)
 */
const idGlobal = (idPattern) => new RegExp(`\\b(?:${idPattern})\\b`, 'g');
const idAtStart = (idPattern) => new RegExp(`^(?:${idPattern})\\b`);
const idWhole = (idPattern) => new RegExp(`^(?:${idPattern})$`);

const HEADING = /^#{1,6}\s+(.*)$/;
const FENCE = /^\s*(?:```|~~~)/;
const SEPARATOR = /^:?-+:?$/;

const isMarkdown = (file) => /\.md$/i.test(file);
const cellsOf = (line) =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|\s*$/, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim());
const isTableRow = (line) => line.trim().startsWith('|');
const isSeparator = (line) => isTableRow(line) && cellsOf(line).every((c) => SEPARATOR.test(c));
const plain = (s) => s.replace(/[`*_]/g, '').trim().toLowerCase();

/** @returns {{ id: string, title: string } | null} */
function headingAnchor(line, idPattern) {
  const h = HEADING.exec(line);
  if (!h) return null;
  const rest = h[1].replace(/\s+#+\s*$/, '');
  const ticked = rest.startsWith('`');
  const body = ticked ? rest.slice(1) : rest;
  const m = idAtStart(idPattern).exec(body);
  if (!m) return null;
  let after = body.slice(m[0].length);
  let qualifier = '';
  if (ticked) {
    const close = after.indexOf('`');
    if (close >= 0) {
      qualifier = after.slice(0, close).trim();
      after = after.slice(close + 1);
    }
  }
  const title = `${qualifier} ${after.replace(/^\s*(?:—|–|-|:)\s*/, '')}`.trim();
  return { id: m[0], title };
}

/** @returns {{ id: string, title: string } | null} */
function rowAnchor(cells, header, idPattern) {
  const first = cells[0]?.replace(/^`(.*)`$/, '$1') ?? '';
  if (!idWhole(idPattern).test(first)) return null;
  const col = header ? header.findIndex((h) => plain(h) === 'decision') : -1;
  const title = col > 0 && cells[col] !== undefined ? cells[col] : cells.slice(1).filter(Boolean).join(' · ');
  return { id: first, title: title.replace(/\\\|/g, '|') };
}

/**
 * @param {string} file  project-relative path, forward slashes
 * @param {string} text
 * @param {string} idPattern
 * @returns {{ anchors: { id: string, title: string, where: string }[], citations: { id: string, where: string }[] }}
 */
function scanText(file, text, idPattern) {
  const anchors = [];
  const citations = [];
  const lines = String(text).split(/\r?\n/);
  const md = isMarkdown(file);
  let fenced = false;
  let header = null;
  lines.forEach((line, i) => {
    const where = `${file}:${i + 1}`;
    let anchor = null;
    if (md) {
      if (FENCE.test(line)) fenced = !fenced;
      else if (!fenced) {
        if (!isTableRow(line)) header = null;
        else if (isSeparator(line)) {
          /* the header row was captured on the line above */
        } else if (i + 1 < lines.length && isSeparator(lines[i + 1])) header = cellsOf(line);
        else anchor = rowAnchor(cellsOf(line), header, idPattern);
        if (!isTableRow(line)) anchor = headingAnchor(line, idPattern);
      }
    }
    if (anchor) anchors.push({ ...anchor, where });
    let skipped = !anchor;
    for (const m of line.matchAll(idGlobal(idPattern))) {
      // The anchor id is the first id on its line (the heading's first token, or the row's first cell).
      if (!skipped && m[0] === anchor.id) {
        skipped = true;
        continue;
      }
      citations.push({ id: m[0], where });
    }
  });
  return { anchors, citations };
}

/** Trailing number first, then plain code-unit order — independent of the machine's locale. */
function compareIds(a, b) {
  const n = (id) => {
    const m = /(\d+)$/.exec(id);
    return m ? Number(m[1]) : Infinity;
  };
  return n(a) - n(b) || (a < b ? -1 : a > b ? 1 : 0);
}

/**
 * @param {{ file: string, text: string }[]} files
 * @returns {Map<string, { anchors: object[], citations: object[] }>} in id order
 */
function buildIndex(files, idPattern) {
  const byId = new Map();
  const slot = (id) => byId.get(id) ?? byId.set(id, { anchors: [], citations: [] }).get(id);
  for (const { file, text } of [...files].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))) {
    const { anchors, citations } = scanText(file, text, idPattern);
    for (const a of anchors) slot(a.id).anchors.push(a);
    for (const c of citations) slot(c.id).citations.push(c);
  }
  return new Map([...byId].sort(([a], [b]) => compareIds(a, b)));
}

/** @returns {{ unanchored: string[], duplicates: string[] }} */
function problems(index) {
  const all = [...index];
  return {
    unanchored: all.filter(([, v]) => v.anchors.length === 0).map(([id]) => id),
    duplicates: all.filter(([, v]) => v.anchors.length > 1).map(([id]) => id),
  };
}

const esc = (s) => String(s).replace(/\|/g, '\\|');

/** The generated file. No timestamp: the same corpus must render the same bytes. */
function render(index) {
  const { unanchored, duplicates } = problems(index);
  const out = [
    '# Decision index',
    '',
    '<!-- generated by decision-index — regenerate with `node scripts/decision-index.mjs`, never hand-edit -->',
    '',
    '_Derived from the anchors: a heading, or a decision-log table row, whose first token is the id. An id that is',
    'cited but never anchored is listed under its own heading below — never silently absent._',
    '',
    '| id | decision | anchor | cited |',
    '|---|---|---|---|',
  ];
  for (const [id, v] of index) {
    if (!v.anchors.length) continue;
    const [first, ...more] = v.anchors;
    out.push(`| \`${id}\` | ${esc(first.title)} | \`${first.where}\`${more.length ? ` (+${more.length})` : ''} | ${v.citations.length} |`);
  }
  out.push('', '## Cited but never anchored', '');
  if (!unanchored.length) out.push('_none_');
  for (const id of unanchored) {
    const c = index.get(id).citations;
    out.push(`- \`${id}\` — cited ${c.length}× · ${c.slice(0, 3).map((x) => `\`${x.where}\``).join(' · ')}${c.length > 3 ? ' · …' : ''}`);
  }
  out.push('', '## Anchored more than once', '');
  if (!duplicates.length) out.push('_none_');
  for (const id of duplicates) out.push(`- \`${id}\` — ${index.get(id).anchors.map((a) => `\`${a.where}\``).join(' · ')}`);
  return `${out.join('\n')}\n`;
}

module.exports = { scanText, buildIndex, problems, render, compareIds, idGlobal };
