'use strict';
/**
 * Cite a catalogue row by KEY, never by LINE.
 *
 * WHY THIS IS A GATE. In one adopting project the rule was stated three times in one cycle and held nowhere. Then it
 * was measured: 120 of 120 key-adjacent line citations of its permission catalogue pointed at the WRONG row — not one
 * was correct. A key cited as row 135 in six places sat at row 141. Every one of those sentences read as verification
 * ("key verified in the catalogue at line 135") while naming a different row, which is strictly worse than no
 * citation: it launders a guess as a check. Six rows inserted above them were enough to rot the lot, and nothing
 * noticed for a whole cycle. A line number rots the moment a row is inserted above it; a key does not.
 *
 * WHAT IS JUDGED. An occurrence `<name>.<ext>:<N>` whose `<name>.<ext>` is the basename of a configured catalogue
 * (case-insensitive) is an OFFENDER — e.g. `roles.csv:40` when `roles.csv` is a catalogue. So is the bare form
 * `<ext>:<N>` with no file name at all, when `<ext>` is a catalogue's extension: it names no file, so it can only be
 * read as the catalogue, and the same project found it in the wild (`(csv:137)` inside a decorator's reason string).
 * Every other `<name>.<ext>:<N>` — a source file, a test, a tracker row that also names its own id — is left alone,
 * and is counted: that population is the fallback POSITIVE CONTROL.
 *
 * THE POSITIVE CONTROL RUNS FIRST AND IS FATAL. A scan that matches nothing reads exactly like a clean repo, and that
 * failure mode shipped in the adopting project's own guards more than once — including this one: its walk read only
 * one file type for a whole cycle while the records (READMEs, digests, boards) sat outside it holding thirty more of
 * these citations. So the walk must reach at least `minFiles` files, and must see either a `control` match or at least
 * one other line citation, before zero offenders is trusted. A scanner that skips the file type a repo keeps its
 * records in is not narrow, it is blind.
 *
 * THE ROSTER IS SHRINK-ONLY. A gate that goes red a hundred times on the day it lands is a gate somebody disables, so
 * pre-existing offenders may be named in a roster while they are swept. Every rostered file must STILL be an offender
 * (a cleaned file is a dead entry, and a dead entry fails until it is deleted — the list deletes itself by
 * construction rather than surviving as a stale exemption), and the rostered count must EQUAL its total. A count above
 * the total is a new offender; a count below it is slack — room for a new offender to slip in unnoticed — so the list
 * and its ceiling move together, and both directions fail.
 *
 * SELF-EXCLUSION IS BY NAME. The check's own files quote the very form they bar, so they are excluded — by their
 * exact paths, never by a pattern. An exclusion that silently follows a rename, or matches a neighbour, is a hole.
 *
 * Two jobs: the GATE (every offender, target zero outside the roster) and `--stale`, a MEASUREMENT that pairs each
 * offender with the catalogue key preceding it on the line and reports the cited line against the real one — kept so
 * the evidence that motivates the rule stays reproducible.
 *
 * Pure over text; `scripts/line-citations-check.mjs` walks the tree.
 */
const { csvCells } = require('./output-check.cjs');

/**
 * `<name>.<ext>:<N>` or the bare `<ext>:<N>`. The look-behind pins a match to the start of a file-name-shaped run, so
 * a path prefix (`data/roles.csv:4`) yields the basename and `roles.csv:4` never also yields a bare `csv:4`.
 */
const OCCURRENCE = /(?<![A-Za-z0-9_.-])(?:([A-Za-z0-9_][A-Za-z0-9_.-]*)\.)?([A-Za-z][A-Za-z0-9]{0,9}):(\d+)/g;

const lower = (s) => String(s).toLowerCase();
const baseName = (p) => String(p).replace(/\\/g, '/').split('/').pop();
const extOf = (name) => (name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '');

/** The lookup a scan classifies against: catalogue basenames and their extensions, lower-cased. */
function catalogueIndex(catalogues) {
  const names = new Set(catalogues.map((c) => lower(baseName(c))));
  const exts = new Set([...names].map(extOf).filter(Boolean));
  return { names, exts };
}

/**
 * Every line citation on one line, classified.
 * @returns {{ name: string|null, ext: string, cited: number, at: number, cite: string, kind: 'catalogue'|'other' }[]}
 */
function occurrences(line, index) {
  if (!line.includes(':')) return [];
  const out = [];
  for (const m of line.matchAll(OCCURRENCE)) {
    const [cite, stem, ext, n] = m;
    const at = m.index ?? 0;
    if (stem === undefined) {
      if (index.exts.has(lower(ext))) out.push({ name: null, ext, cited: Number(n), at, cite, kind: 'catalogue' });
      continue; // `host:8080`, `step:2` — not a file citation of any kind
    }
    const file = `${stem}.${ext}`;
    out.push({ name: file, ext, cited: Number(n), at, cite, kind: index.names.has(lower(file)) ? 'catalogue' : 'other' });
  }
  return out;
}

/**
 * Scan one file's text. Scanned LINE BY LINE, and only on lines that contain `:`.
 *
 * The adopting project's first stale-pairing scan used one regex with a lazy gap between the key and the citation.
 * It backtracked catastrophically in V8 and ran for over five minutes without finishing, on input an equivalent
 * scan in another language cleared in seconds. The gap is what costs; a line filter removes the need for one, so
 * never reintroduce a key-to-citation gap regex here.
 *
 * @param {RegExp|null} control  counted per line on every line (a control need not contain `:`)
 */
function scanText(text, file, index, control = null) {
  const offenders = [];
  let other = 0;
  let controlHits = 0;
  String(text)
    .split(/\r?\n/)
    .forEach((line, i) => {
      if (control && control.test(line)) controlHits += 1;
      for (const o of occurrences(line, index)) {
        if (o.kind === 'other') other += 1;
        else offenders.push({ file, line: i + 1, cited: o.cited, cite: o.cite, name: o.name, ext: o.ext });
      }
    });
  return { offenders, other, controlHits };
}

/**
 * The positive control. Null when it holds; otherwise the reason zero offenders proves nothing.
 * @param {{ files: number, minFiles: number, control: string|null, controlHits: number, other: number }} s
 */
function positiveControl(s) {
  const reached = s.files >= s.minFiles;
  const matched = s.control ? s.controlHits > 0 : s.other > 0;
  if (reached && matched) return null;
  const seen = s.control ? `${s.controlHits} line(s) matching control ${s.control}` : `${s.other} other line citation(s)`;
  return `positive control failed — walked ${s.files} file(s) (minFiles ${s.minFiles}) and saw ${seen}; the scan found nothing to check, so zero offenders proves nothing. Fix the roots, extensions or control before trusting this gate`;
}

/** Problems with a parsed roster file. */
function rosterErrors(roster) {
  const errors = [];
  if (!roster || typeof roster !== 'object' || Array.isArray(roster)) return ['must be a JSON object { "files": [...], "total": N }'];
  if (!Array.isArray(roster.files) || roster.files.some((f) => typeof f !== 'string' || !f)) errors.push('files: an array of project-relative paths');
  if (!Number.isInteger(roster.total) || roster.total < 0) errors.push('total: a non-negative integer — the offender count the roster was measured at');
  return errors;
}

/**
 * Judge offenders against an optional roster. Paths compare with forward slashes.
 * @returns {{ unrostered: object[], rostered: object[], dead: string[], total: number|null, over: boolean, under: boolean }}
 */
function judgeRoster(offenders, roster) {
  const files = new Set((roster?.files ?? []).map((f) => f.replace(/\\/g, '/').replace(/^\.\//, '')));
  const rostered = offenders.filter((o) => files.has(o.file));
  const unrostered = offenders.filter((o) => !files.has(o.file));
  const offending = new Set(offenders.map((o) => o.file));
  const dead = [...files].filter((f) => !offending.has(f));
  const total = roster ? roster.total : null;
  return { unrostered, rostered, dead, total, over: total !== null && rostered.length > total, under: total !== null && rostered.length < total };
}

/* ── the stale measurement ───────────────────────────────────────────────────────────────────────────────────── */

/** Cells of one catalogue line, by the catalogue's own format. */
function rowCells(line, ext) {
  const e = lower(ext);
  if (e === 'csv') return csvCells(line);
  if (e === 'tsv') return line.split('\t').map((c) => c.trim());
  if (e === 'md') return line.trim().startsWith('|') && !/^\s*\|[\s:|-]+\|\s*$/.test(line) ? line.split(/(?<!\\)\|/).slice(1, -1).map((c) => c.trim().replace(/`/g, '')) : [];
  return line.trim().split(/\s+/);
}

/** Key → its 1-based line in the catalogue. First occurrence wins; the first line is a header and is never a key. */
function loadKeyLines(text, name, keyColumn = 0) {
  const keyLine = new Map();
  String(text)
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .forEach((line, i) => {
      if (i === 0 || !line.trim()) return;
      const key = (rowCells(line, extOf(name))[keyColumn] ?? '').trim();
      if (key && !keyLine.has(key)) keyLine.set(key, i + 1);
    });
  return keyLine;
}

/** Key-shaped tokens: word characters, joined by `.` `-` or `_`, never ending in punctuation. */
const KEY = /[A-Za-z0-9_](?:[A-Za-z0-9_.-]*[A-Za-z0-9_])?/g;

/**
 * Pair each catalogue citation on a line with the nearest key PRECEDING it that is a real key of that catalogue.
 * A bare `<ext>:<N>` pairs against every catalogue with that extension, in configured order.
 * @param {Map<string, Map<string, number>>} keysByCatalogue  lower-cased basename → key → line
 * @returns {{ key: string|null, catalogue: string|null, cited: number, actual: number|null, cite: string }[]}
 */
function pairOn(line, index, keysByCatalogue) {
  const found = occurrences(line, index).filter((o) => o.kind === 'catalogue');
  if (found.length === 0) return [];
  const tokens = [...line.matchAll(KEY)].map((m) => ({ key: m[0], at: m.index ?? 0 }));
  return found.map((o) => {
    const candidates = o.name ? [lower(o.name)] : [...keysByCatalogue.keys()].filter((n) => extOf(n) === lower(o.ext));
    const before = tokens.filter((t) => t.at < o.at).reverse();
    for (const t of before) {
      for (const c of candidates) {
        const actual = keysByCatalogue.get(c)?.get(t.key);
        if (actual !== undefined) return { key: t.key, catalogue: c, cited: o.cited, actual, cite: o.cite };
      }
    }
    return { key: null, catalogue: null, cited: o.cited, actual: null, cite: o.cite };
  });
}

module.exports = { OCCURRENCE, catalogueIndex, occurrences, scanText, positiveControl, rosterErrors, judgeRoster, loadKeyLines, pairOn, baseName };
