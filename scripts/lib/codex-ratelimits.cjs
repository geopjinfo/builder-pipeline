'use strict';
/**
 * The Codex session `rate_limits` reader — a measured usage reading for a Codex account (plan M2a, REQ-203, REQ-212;
 * D43, D51).
 *
 * WHY. No headless Codex surface prints a usage percentage (`codex login status` prints no plan tier, D43). But every
 * Codex session writes a rollout under `<CODEX_HOME>/sessions/YYYY/MM/DD/*.jsonl`, and each `token_count` event in it
 * carries the account's `rate_limits`: the windows the service enforces, with `used_percent` and a reset. The last
 * such record of the newest session is the freshest fact the kit can have about the account, so it is the reading,
 * labelled `measured` with the record's own timestamp.
 *
 * WHICH WINDOW. A record carries a `primary` (short, hours) and a `secondary` (long, a week) window. The window
 * closest to its limit is the one that stops the next job, so its `used_percent` is the reading and its reset is
 * `until`. Both windows come back under `windows` for a report that wants to show them.
 *
 * NOTHING READABLE IS `null`. No sessions dir, no `.jsonl`, no `token_count` record, no numeric `used_percent`: the
 * reader returns `null` and the assessment renders `unmeasured`, never `0 %` (INVARIANTS, D3).
 *
 * Reads only. `scripts/lib/codex-usage.cjs` (the transcript cost reader) is a different file on purpose: this one
 * reads rate limits, that one prices tokens.
 */
const fs = require('node:fs');
const path = require('node:path');

const READER = 'codex-ratelimits';
const WINDOWS = Object.freeze(['primary', 'secondary']);

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** An ISO time from a unix-seconds number, a milliseconds number or an ISO string; null otherwise. */
function toIso(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v < 1e11 ? v * 1000 : v).toISOString();
  if (typeof v === 'string' && Number.isFinite(Date.parse(v))) return new Date(Date.parse(v)).toISOString();
  return null;
}

/** Every `*.jsonl` under `dir` (depth-first), or [] when the dir is missing or unreadable. */
function jsonlFiles(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) jsonlFiles(p, out);
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

/** The newest session rollout under `<codexHome>/sessions/**` by mtime (then name), or null. */
function newestSession(codexHome) {
  if (typeof codexHome !== 'string' || !codexHome) return null;
  const files = jsonlFiles(path.join(codexHome, 'sessions'));
  let best = null;
  for (const f of files) {
    let m;
    try { m = fs.statSync(f).mtimeMs; } catch { continue; }
    if (!best || m > best.m || (m === best.m && f > best.f)) best = { f, m };
  }
  return best ? best.f : null;
}

/** One window normalised: `{ used_percent, window_minutes, until }`, or null without a numeric percent. */
function window(w, at) {
  if (!isObject(w)) return null;
  const used = num(w.used_percent);
  if (used === null) return null;
  let until = toIso(w.resets_at);
  if (!until && num(w.resets_in_seconds) !== null && at) until = new Date(Date.parse(at) + w.resets_in_seconds * 1000).toISOString();
  return { used_percent: used, window_minutes: num(w.window_minutes), until };
}

/**
 * Parse a rollout's text: the last `token_count` record with `rate_limits` becomes the reading.
 * @returns {{ percent, until, at, source: 'measured', reader, windows } | null}
 */
function parseRateLimits(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    const payload = isObject(rec) && isObject(rec.payload) ? rec.payload : null;
    if (!payload || payload.type !== 'token_count' || !isObject(payload.rate_limits)) continue;
    const at = toIso(rec.timestamp) || toIso(payload.timestamp);
    const windows = {};
    for (const k of WINDOWS) {
      const w = window(payload.rate_limits[k], at);
      if (w) windows[k] = w;
    }
    const names = Object.keys(windows);
    if (names.length === 0) return null;
    const binding = names.reduce((a, b) => (windows[b].used_percent > windows[a].used_percent ? b : a));
    return { percent: windows[binding].used_percent, until: windows[binding].until, at, source: 'measured', reader: READER, windows, binding };
  }
  return null;
}

/** The reading for a Codex home, or null (unmeasured). */
function read(codexHome) {
  const file = newestSession(codexHome);
  if (!file) return null;
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const r = parseRateLimits(text);
  return r ? { ...r, file } : null;
}

module.exports = { READER, WINDOWS, read, parseRateLimits, newestSession };
