'use strict';
/**
 * Shrink-only ratchet lists — a bank of known gaps that may only move by MEASUREMENT.
 *
 * WHY. A list of known gaps (declared effects no scenario exercises, files not yet typed, routes without a
 * contract) is only worth keeping if it can shrink and never grow. Hand-editing is exactly how it grows: someone
 * adds their new item "just for now", and the list stops being evidence. So the list moves only by comparing it
 * with what the project's own runtime measurement reports, and only downward.
 *
 * THE BANK holds the list AND its ceiling in one file — `{ "items": [...], "count": N, "measuredAt"?: "..." }`.
 * Kept in two places, the list can shrink while the ceiling stays high, and that slack is room for a later entry
 * to slip in unnoticed. In one file they move in one motion or not at all; `count !== items.length` fails.
 *
 * THE MEASURED SET is written by the project's measurement run — `[...]` or `{ "items": [...], "measuredAt"? }`.
 * It is runtime-only: it cannot be derived from source, so a missing file is an error, never an empty set.
 *
 * THE ONE RULE. A measured item the bank does not hold is REFUSED. A newly uncovered item is not a bookkeeping
 * event — it is something that shipped without coverage, and the fix is coverage, not a line in the bank.
 *
 * Pure over parsed JSON and text; the script does the reading and writing.
 */

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStringList = (v) => Array.isArray(v) && v.every((s) => typeof s === 'string');
const dupes = (list) => [...new Set(list.filter((s, i) => list.indexOf(s) !== i))];
const sorted = (list) => [...list].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/** @returns {{ bank: { items: string[], count: number, measuredAt?: string } | null, errors: string[] }} */
function parseBank(value) {
  if (!isObject(value) || !isStringList(value.items) || !Number.isInteger(value.count)) {
    return { bank: null, errors: ['bank: expected { "items": [strings], "count": <integer>, "measuredAt"?: <string> }'] };
  }
  return { bank: value, errors: [] };
}

/** @returns {{ items: string[] | null, measuredAt: string | null, errors: string[] }} */
function parseMeasured(value) {
  const items = Array.isArray(value) ? value : isObject(value) ? value.items : null;
  if (!isStringList(items)) return { items: null, measuredAt: null, errors: ['measured: expected [strings] or { "items": [strings], "measuredAt"?: <string> }'] };
  return { items: [...new Set(items)], measuredAt: isObject(value) && typeof value.measuredAt === 'string' ? value.measuredAt : null, errors: [] };
}

/**
 * @param {{ items: string[], count: number }} bank
 * @param {string[]} measured
 * @returns {{ status: 'fail'|'refused'|'drain'|'unchanged', problems: string[], added: string[], drained: string[], next: string[] }}
 *   fail      the bank disagrees with itself (ceiling ≠ list length, or a duplicate item)
 *   refused   the measurement found items the bank does not hold
 *   drain     bank items no longer measured — `next` is the bank without them
 *   unchanged the bank already equals the measurement
 */
function plan(bank, measured) {
  const problems = [];
  if (bank.count !== bank.items.length) problems.push(`list and ceiling disagree — count ${bank.count}, items ${bank.items.length}`);
  for (const d of dupes(bank.items)) problems.push(`"${d}" is listed more than once — the ceiling cannot be trusted`);
  const empty = { added: [], drained: [], next: sorted(bank.items) };
  if (problems.length) return { status: 'fail', problems, ...empty };
  const banked = new Set(bank.items);
  const now = new Set(measured);
  const added = sorted(measured.filter((m) => !banked.has(m)));
  if (added.length) return { status: 'refused', problems, ...empty, added };
  const drained = sorted(bank.items.filter((b) => !now.has(b)));
  if (!drained.length) return { status: 'unchanged', problems, ...empty };
  return { status: 'drain', problems, added, drained, next: sorted(bank.items.filter((b) => now.has(b))) };
}

/**
 * The rewritten bank: every other key kept in place, `items` (sorted) + `count` + `measuredAt` moved together.
 * @returns {string} JSON text with a trailing newline
 */
function renderBank(bank, next, measuredAt) {
  return `${JSON.stringify({ ...bank, items: next, count: next.length, measuredAt }, null, 2)}\n`;
}

module.exports = { parseBank, parseMeasured, plan, renderBank };
