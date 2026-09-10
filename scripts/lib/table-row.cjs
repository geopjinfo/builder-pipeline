'use strict';
/**
 * Read ONE row of a markdown ledger table — with its section and header — instead of the file.
 *
 * WHY. In one adopting project the builder opened the deferred registry dozens of times in a single run, and every
 * read of a file that size costs its whole length again on every later turn of the seat. A seat needs a row, the
 * header that says what its cells mean, and the section that says what state the row is in. Splitting a large
 * registry is a separate choice — gates and skills may parse it whole — so the row reader comes first.
 */

const SEPARATOR = /^\|\s*:?-{2,}/;

/** Cells of a table line, honouring `\|` inside a cell. */
function cells(line) {
  return line
    .split(/(?<!\\)\|/)
    .slice(1, -1)
    .map((c) => c.trim());
}

/** The row id as ledgers write it: plain, `~~struck through~~` when closed, `**bold**`, or `` `code` ``. */
const idOf = (cell) => String(cell ?? '').replace(/[~*`]/g, '').trim();

/**
 * @param {string} markdown
 * @param {string} id
 * @returns {{ section: string|null, header: string, line: number, row: string }[]}
 */
function findRows(markdown, id) {
  const lines = markdown.split(/\r?\n/);
  const hits = [];
  let section = null;
  let header = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^#{1,4}\s/.test(line)) {
      section = line.replace(/^#+\s*/, '').trim();
      header = null;
      continue;
    }
    if (!line.startsWith('|')) continue;
    // A header is the line directly above a `|---|` separator — never "the first pipe line after a break". The
    // first version took a DATA row as the header, because a registry table has rows the earlier rule mistook for
    // a fresh table start.
    if (SEPARATOR.test(line)) {
      header = lines[i - 1] ?? null;
      continue;
    }
    if (header !== null && line !== header && idOf(cells(line)[0]) === id) hits.push({ section, header, line: i + 1, row: line });
  }
  return hits;
}

module.exports = { findRows, cells, idOf };
