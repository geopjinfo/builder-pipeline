'use strict';
/**
 * Section documents for a published pipeline page — what `board-render --json` writes.
 *
 * WHY DOCUMENTS AND NOT ONE PAGE. A hosted page that reads its data from a document store is bound by
 * that store's per-document size cap, and a run's step log outgrows any sensible cap. So
 * `board-render --json` emits one plain document per section, and a section over the cap is SPLIT
 * into parts — `steps~1`, `steps~2`, each carrying `part` / `parts`.
 *
 * THE LIMIT IS A PARAMETER. `PAGE_DOC_LIMIT` (256 KiB, serialized) is the per-document cap of one
 * hosted artifact store the pack has been used with — a default, not a law. A store with a different
 * cap passes its own `limit`; nothing else here depends on the number.
 *
 * WHY SPLIT, NEVER TRUNCATE. A truncated section reads as a complete one: the page would show the
 * first 400 steps of a 900-step run under a heading that says "Step log". A part the page never
 * received can be reported as missing, because every part says how many there are. A single row that
 * alone exceeds the cap cannot be split without cutting it, so that is an error, not a silent trim.
 */
const PAGE_DOC_LIMIT = 256 * 1024;

const bytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');

/**
 * @param {{id:string, order:number, title:string, subtitle?:string, columns:string[], rows:string[][]}[]} docs
 * @param {number} [limit] bytes per serialized document — defaults to one hosted store's cap
 * @returns the same documents, oversized ones replaced by their parts
 */
function splitDocs(docs, limit = PAGE_DOC_LIMIT) {
  const out = [];
  for (const doc of docs) {
    if (bytes(doc) <= limit) {
      out.push(doc);
      continue;
    }
    /* The envelope of a part at its widest (`~9999`, `part`/`parts` fields) plus each row and its comma. */
    const envelope = bytes({ ...doc, id: `${doc.id}~9999`, rows: [], part: 9999, parts: 9999 });
    /* Over the cap before any row — its title, subtitle and columns alone. With no rows it would yield
     * zero parts and vanish from the output (a truncation to nothing, the one outcome this file
     * refuses); with rows, every row would be blamed for an envelope that no split can fix. */
    if (envelope > limit) {
      throw new Error(
        `page-docs: section "${doc.id}" is over ${limit} bytes before any row (${doc.rows.length} rows) — its title, subtitle and columns alone; refusing to truncate or drop it`,
      );
    }
    const parts = [];
    let rows = [];
    let used = envelope;
    doc.rows.forEach((row, i) => {
      const cost = bytes(row) + 1;
      if (envelope + cost > limit) {
        throw new Error(`page-docs: section "${doc.id}" row ${i + 1} alone is over ${limit} bytes — refusing to truncate it`);
      }
      if (used + cost > limit && rows.length > 0) {
        parts.push(rows);
        rows = [];
        used = envelope;
      }
      rows.push(row);
      used += cost;
    });
    if (rows.length > 0) parts.push(rows);
    parts.forEach((partRows, i) => out.push({ ...doc, id: `${doc.id}~${i + 1}`, rows: partRows, part: i + 1, parts: parts.length }));
  }
  return out;
}

module.exports = { PAGE_DOC_LIMIT, splitDocs, bytes };
