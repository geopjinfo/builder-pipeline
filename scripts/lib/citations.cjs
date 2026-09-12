'use strict';
/**
 * Every board row's `Cites` id must resolve to its source.
 *
 * WHY THIS EXISTS. The failure mode the pipeline fears most is the invented fact: under pressure to finish, a seat
 * writes a key, a requirement id or a decision number that looks plausible and is wrong. A `Cites` column is the
 * defence — and an unchecked citation is just a more confident-looking invention. `STK-014` reads exactly like
 * `STK-004`, and only one of them exists. In one adopting project, most of a batch of escalations turned out to be
 * already answered by the requirement register; forcing every row to name a source that resolves is how that gets
 * noticed before the escalation instead of after it.
 *
 * WHAT IS JUDGED. Only tokens a configured scheme OWNS. The first scheme whose `pattern` matches the WHOLE token
 * (anchored here, whatever the profile wrote) and whose `skip` does not match owns it; the token then resolves or is
 * UNRESOLVED against that scheme's id set. A token no scheme owns — a document section, a prose reference, a path —
 * is NOT-EVALUABLE, never failed and never passed: this check refuses to pretend it read a PDF. A token in a known
 * scheme that resolves to nothing IS failed, because that is precisely the invention shape.
 *
 * TWO CONTROLS. A scheme whose source yields zero ids is a failure, not a pass: a set of nothing resolves nothing and
 * rejects nothing, so every token it owns would be judged against a blank. And boards that exist with no `Cites`
 * column anywhere are a failure: the board format requires the column, and a check that saw none checked nothing.
 *
 * Pure over text; `scripts/citations-check.mjs` reads the boards and the sources.
 */
const { csvCells } = require('./output-check.cjs');

const EMPTY_CELLS = new Set(['', '—', '-']);

/** Cells of a markdown table line. An escaped `\|` stays inside its cell (and is unescaped). */
function cells(line) {
  return line
    .split(/(?<!\\)\|/)
    .slice(1, -1)
    .map((c) => c.trim().replace(/\\\|/g, '|'));
}

/** `|---|:--:|` is a table separator, not a row; its cells are not citations. */
const isSeparator = (line) => /^\s*\|[\s:|-]+\|\s*$/.test(line) && line.includes('-');

/** One `Cites` cell may carry several ids: `STK-004 · REG-002`, `a, b`, `a; b`, `a + b`. */
function tokensOf(cell) {
  if (EMPTY_CELLS.has(String(cell ?? '').trim())) return [];
  return String(cell)
    .split(/[·,;]|\s+\+\s+/)
    .map((raw) => raw.trim().replace(/`/g, '').replace(/\*/g, '').trim())
    .filter((t) => !EMPTY_CELLS.has(t));
}

/**
 * Every citation site on one board.
 * A header row with a cell exactly `Cites` sets the column for the table rows that follow it; a new header re-sets it.
 * @returns {{ hasCites: boolean, sites: { path: string, line: number, token: string }[] }}
 */
function scanBoard(text, path) {
  const sites = [];
  let column = -1;
  let hasCites = false;
  String(text)
    .split(/\r?\n/)
    .forEach((line, i) => {
      if (!line.trim().startsWith('|')) {
        column = -1; // a table ended; the next table must name its own Cites column
        return;
      }
      if (isSeparator(line)) return;
      const row = cells(line);
      const header = row.indexOf('Cites');
      if (header !== -1) {
        column = header;
        hasCites = true;
        return;
      }
      if (column === -1) return;
      for (const token of tokensOf(row[column])) sites.push({ path, line: i + 1, token });
    });
  return { hasCites, sites };
}

/** Anchor a profile pattern so it must match the whole token. */
const anchored = (source, flags) => new RegExp(`^(?:${source})$`, flags);

/**
 * Compile the profile's schemes. `ignoreCase` applies to the pattern, the skip and the source's own regex, and ids
 * are compared upper-cased on both sides.
 */
function compileSchemes(schemes) {
  return schemes.map((s) => {
    const flags = s.ignoreCase ? 'i' : '';
    return {
      name: s.name,
      ignoreCase: Boolean(s.ignoreCase),
      pattern: anchored(s.pattern, flags),
      skip: s.skip ? new RegExp(s.skip, flags) : null,
      source: s.source,
    };
  });
}

const norm = (scheme, id) => (scheme.ignoreCase ? id.toUpperCase() : id);

/** The ids of a CSV column — by header name or 0-based index. The header row is never an id. */
function idsFromCsv(text, column) {
  const rows = String(text).replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  const header = csvCells(rows[0] ?? '');
  const at = Number.isInteger(column) ? column : header.indexOf(column);
  if (at < 0 || at >= Math.max(header.length, 1)) throw new Error(`no column ${JSON.stringify(column)} (columns: ${header.join(', ')})`);
  return rows.slice(1).map((r) => csvCells(r)[at] ?? '').filter(Boolean);
}

/** Capture 1 of `filePattern` on each file name; names that do not match, or match without the group, add nothing. */
function idsFromNames(names, filePattern, flags = '') {
  const re = new RegExp(filePattern, flags);
  return names.map((n) => re.exec(n)?.[1]).filter(Boolean);
}

/** Every whole match of `idPattern` across the given texts. */
function idsFromTexts(texts, idPattern, flags = '') {
  const re = new RegExp(idPattern, `g${flags}`);
  return texts.flatMap((t) => [...String(t).matchAll(re)].map((m) => m[0]).filter(Boolean));
}

/** The scheme that owns a token, or null (prose). */
function ownerOf(token, schemes) {
  return schemes.find((s) => s.pattern.test(token) && !(s.skip && s.skip.test(token))) ?? null;
}

/**
 * @param {{ path: string, line: number, token: string }[]} sites
 * @param {{ name: string, pattern: RegExp, skip: RegExp|null, ignoreCase: boolean, ids: Set<string> }[]} schemes  ids already normalised
 * @returns {{ path, line, token, scheme: string, verdict: 'resolved'|'UNRESOLVED'|'not-evaluable' }[]}
 */
function judge(sites, schemes) {
  return sites.map((site) => {
    const scheme = ownerOf(site.token, schemes);
    if (!scheme) return { ...site, scheme: 'prose', verdict: 'not-evaluable' };
    return { ...site, scheme: scheme.name, verdict: scheme.ids.has(norm(scheme, site.token)) ? 'resolved' : 'UNRESOLVED' };
  });
}

/** Normalise a raw id list into the scheme's comparison set. */
const idSet = (scheme, ids) => new Set(ids.map((id) => norm(scheme, String(id).trim())).filter(Boolean));

function counts(results) {
  const by = (v) => results.filter((r) => r.verdict === v).length;
  return { resolved: by('resolved'), prose: by('not-evaluable'), unresolved: by('UNRESOLVED') };
}

module.exports = { cells, isSeparator, tokensOf, scanBoard, compileSchemes, idsFromCsv, idsFromNames, idsFromTexts, ownerOf, judge, idSet, counts };
