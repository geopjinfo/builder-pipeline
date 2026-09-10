'use strict';
/**
 * Structural rule hits for one area of the code, each NEW or BASELINED — the rules RUNNER INTERFACE.
 *
 * WHY THE AUDITOR GETS THIS. A pattern-hunting auditor searches by text, and a text search misses the
 * syntactic variants a syntax tree does not (a regex test-block splitter in one adopting project was blind
 * to a whole family of test blocks). Handing the auditor the rule hits for the area under audit turns a
 * search it may not run into an input it has to account for, line by line.
 *
 * THE INTERFACE (runner-agnostic). `features.rules.scan` is a command that prints a JSON stream — one
 * object per line — with at least `{ ruleId, file, text, range: { start: { line } } }` (0-based line, as
 * ast-grep's `--json=stream` prints it). Any runner that can emit that shape fits: ast-grep, Semgrep through
 * a small `jq`/node mapping, a custom linter.
 *
 * THE KEY IS rule id + file + whitespace-collapsed snippet (first 160 chars), NEVER A LINE NUMBER. A hit
 * that moves because code above it changed is the same hit; a hit whose code changed is a new one.
 *
 * `ratcheted` lists the rule ids that count. Census rules (inventories, not defects) stay out of it. An
 * EMPTY list means every rule counts — an empty list silently counting nothing would disable the check.
 * The baseline is a JSON array of `{ ruleId, file, snippet, why }` (or `{ entries: [...] }`).
 */

const snippetOf = (text) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
const keyOf = (ruleId, file, snippet) => `${ruleId} | ${file} | ${snippet}`;
const fileOf = (file) => String(file ?? '').split('\\').join('/').replace(/^\.\//, '');

/** JSON-stream text → hit objects; a malformed line throws with its line number (a scan that half-parsed did not run). */
function parseStream(stdout) {
  const out = [];
  String(stdout ?? '')
    .split(/\r?\n/)
    .forEach((line, i) => {
      if (line.trim() === '') return;
      try {
        out.push(JSON.parse(line));
      } catch (e) {
        throw new Error(`scan output line ${i + 1} is not JSON: ${e.message}`);
      }
    });
  return out;
}

/** Accept the baseline as a bare array or as `{ entries: [...] }`. */
function baselineEntries(baseline) {
  if (Array.isArray(baseline)) return baseline;
  if (baseline && Array.isArray(baseline.entries)) return baseline.entries;
  return [];
}

/**
 * @param {string} stdout  the scan's JSON stream
 * @param {{ruleId:string, file:string, snippet:string, why:string}[] | { entries: object[] }} baseline
 * @param {string[]} [ratcheted]  rule ids that count; empty or absent = every rule
 * @returns {{ ruleId, file, line, snippet, status: 'NEW'|'BASELINED', why: string|null }[]}
 */
function classify(stdout, baseline, ratcheted = []) {
  const why = new Map(baselineEntries(baseline).map((e) => [keyOf(e.ruleId, fileOf(e.file), snippetOf(e.snippet)), e.why ?? '']));
  const counts = Array.isArray(ratcheted) && ratcheted.length > 0 ? new Set(ratcheted) : null;
  return parseStream(stdout)
    .filter((m) => !counts || counts.has(m.ruleId))
    .map((m) => {
      const file = fileOf(m.file);
      const snippet = snippetOf(m.text);
      const key = keyOf(m.ruleId, file, snippet);
      const line = Number.isInteger(m.range?.start?.line) ? m.range.start.line + 1 : null;
      return { ruleId: m.ruleId, file, line, snippet, status: why.has(key) ? 'BASELINED' : 'NEW', why: why.has(key) ? why.get(key) : null };
    });
}

/** The report lines a step writes to `<runs>/<key>/rules.txt`. */
function report(hits, { target = null, baselinePath = null } = {}) {
  const fresh = hits.filter((h) => h.status === 'NEW');
  const lines = [
    `rules${target ? ` ${target}` : ''} — ${hits.length} hit(s): ${fresh.length} NEW, ${hits.length - fresh.length} BASELINED${baselinePath ? ` (baseline: ${baselinePath})` : ''}`,
  ];
  for (const h of fresh) lines.push(`NEW        ${h.ruleId}  ${h.file}:${h.line ?? '?'}  ${h.snippet}`);
  for (const h of hits.filter((x) => x.status === 'BASELINED')) lines.push(`BASELINED  ${h.ruleId}  ${h.file}:${h.line ?? '?'} — ${h.why}`);
  return lines;
}

module.exports = { classify, parseStream, snippetOf, keyOf, baselineEntries, report };
