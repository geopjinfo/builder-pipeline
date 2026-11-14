'use strict';
/**
 * `builder.choices.json` — what a person decided about each kit item that clashes with one of the project's own.
 *
 * WHY A FILE. The overlap review (`builder-init`) asks a human, per item: keep the project's, use the kit's, or keep
 * both (the kit's renamed `builder-<name>`). An answer that lives only in a chat is gone at the next `upgrade`, and an
 * upgrade that re-installs what a person declined undoes their decision with the kit's authority. So every answer is
 * written here, and the installer reads it through applyChoices() on every run.
 *
 * WHY "UNDECIDED = SKIPPED". The ruling is that the project wins by default and nothing that could clash is installed
 * without a confirm. A clashing item with no recorded choice is therefore skipped and reported — never installed on a
 * guess, never silently dropped either.
 *
 * Shape (version 1):
 *   { "version": 1,
 *     "items": { "skill:code-review": { "decision": "keep", "decidedAt": "2026-01-01T00:00:00Z", "by": "<who>",
 *                                       "project": [".claude/skills/code-review/SKILL.md"], "note": "…" } } }
 *
 * Keys are `<kind>:<name>` of the KIT item, as `inventory --json` lists it under `clashes`.
 */

const fs = require('fs');
const path = require('path');

const FILE = 'builder.choices.json';
const VERSION = 1;
const DECISIONS = ['keep', 'kit', 'both'];
const KINDS = ['skill', 'agent', 'persona', 'playbook', 'hook'];
const PREFIX = 'builder-';
const KEY = new RegExp(`^(${KINDS.join('|')}):[A-Za-z0-9][\\w.-]*$`);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

const empty = () => ({ version: VERSION, items: {} });

/** Every problem with a choices object, as sentences. Empty array = valid. */
function validate(obj) {
  const errors = [];
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return ['choices: not a JSON object'];
  if (obj.version !== VERSION) errors.push(`version: expected ${VERSION}, found ${JSON.stringify(obj.version)}`);
  const allowed = new Set(['version', 'items']);
  for (const k of Object.keys(obj)) if (!allowed.has(k)) errors.push(`${k}: unknown top-level key`);
  if (!obj.items || typeof obj.items !== 'object' || Array.isArray(obj.items)) {
    errors.push('items: must be an object keyed by "<kind>:<name>"');
    return errors;
  }
  const fields = new Set(['decision', 'decidedAt', 'by', 'project', 'note']);
  for (const [key, c] of Object.entries(obj.items)) {
    if (!KEY.test(key)) errors.push(`${key}: key must be "<kind>:<name>" with kind one of ${KINDS.join(', ')}`);
    if (!c || typeof c !== 'object' || Array.isArray(c)) {
      errors.push(`${key}: must be an object`);
      continue;
    }
    for (const f of Object.keys(c)) if (!fields.has(f)) errors.push(`${key}.${f}: unknown field`);
    if (!DECISIONS.includes(c.decision)) errors.push(`${key}.decision: ${JSON.stringify(c.decision)} is not one of ${DECISIONS.join(', ')}`);
    if (typeof c.decidedAt !== 'string' || !ISO.test(c.decidedAt) || Number.isNaN(Date.parse(c.decidedAt))) errors.push(`${key}.decidedAt: must be an ISO-8601 UTC timestamp (…Z)`);
    if (typeof c.by !== 'string' || !c.by.trim()) errors.push(`${key}.by: must name who decided`);
    if (c.project !== undefined && !(Array.isArray(c.project) && c.project.every((p) => typeof p === 'string'))) errors.push(`${key}.project: must be a list of paths`);
    if (c.note !== undefined && typeof c.note !== 'string') errors.push(`${key}.note: must be a string`);
  }
  return errors;
}

/** `{ found, path, choices, errors }`. No file → found false, empty choices, no errors. Bad JSON → an error, never a throw. */
function read(projectRoot) {
  const abs = path.join(projectRoot, FILE);
  if (!fs.existsSync(abs)) return { found: false, path: abs, choices: empty(), errors: [] };
  let obj;
  try {
    obj = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (e) {
    return { found: true, path: abs, choices: empty(), errors: [`${FILE}: not valid JSON — ${e.message}`] };
  }
  const errors = validate(obj);
  return { found: true, path: abs, choices: errors.length ? empty() : obj, errors };
}

/** Writes a VALID choices object (keys sorted, so diffs stay small). Throws with every problem on an invalid one. */
function write(projectRoot, choices) {
  const errors = validate(choices);
  if (errors.length) throw new Error(`refusing to write ${FILE}:\n  ${errors.join('\n  ')}`);
  const items = {};
  for (const k of Object.keys(choices.items).sort()) items[k] = choices.items[k];
  const abs = path.join(projectRoot, FILE);
  fs.writeFileSync(abs, `${JSON.stringify({ version: VERSION, items }, null, 2)}\n`);
  return abs;
}

/** A new choices object with one decision recorded (pure). `now` is injectable for tests. */
function set(choices, key, decision, by, { project, note, now = new Date() } = {}) {
  const entry = { decision, decidedAt: now.toISOString().replace(/\.\d{3}Z$/, 'Z'), by };
  if (project && project.length) entry.project = [...project];
  if (note) entry.note = note;
  const next = { version: VERSION, items: { ...(choices?.items || {}), [key]: entry } };
  const errors = validate(next);
  if (errors.length) throw new Error(errors.join('; '));
  return next;
}

/** A new choices object without one key (pure) — how a decision is reopened for the next review. */
function unset(choices, key) {
  const items = { ...(choices?.items || {}) };
  delete items[key];
  return { version: VERSION, items };
}

/** The renamed destination for "keep both": the path segment carrying the name becomes `builder-<name>`. */
function renamedDst(dst, name) {
  const parts = dst.split(/[\\/]/);
  for (let i = parts.length - 1; i >= 0; i--) {
    const seg = parts[i];
    if (seg === name) {
      parts[i] = PREFIX + name;
      return parts.join('/');
    }
    if (seg.startsWith(`${name}.`)) {
      parts[i] = PREFIX + seg;
      return parts.join('/');
    }
  }
  return null;
}

/** Rewrites a frontmatter `name:` line to the renamed name (installer helper for "keep both"). */
function renameFrontmatter(text, newName) {
  if (!text.startsWith('---')) return text;
  const end = text.indexOf('\n---', 3);
  if (end === -1) return text;
  return text.slice(0, end).replace(/^name:.*$/m, `name: ${newName}`) + text.slice(end);
}

/**
 * Decides what the installer does with each planned kit item. Pure: no filesystem.
 *
 *   plan    [{ key: '<kind>:<name>', kind, name, dst, clash: boolean, with?: [project paths] }]
 *   choices the object from read()
 *
 * Returns { install, skip, report }:
 *   install  entries to write — unchanged; `replace: true` for "kit" (installer backs up, then overwrites a same-path
 *            project file); for "both", `dst` and `name` renamed with the builder- prefix and `rename` set.
 *   skip     [{ entry, reason: 'kept-project' | 'undecided-clash' | 'rename-impossible' }]
 *   report   one line per entry that was not a plain install, for the installer to print.
 *
 * A non-clashing entry installs whatever the file says (a stale choice for it is harmless). A clashing entry with no
 * recorded choice is SKIPPED — the project wins until a person decides.
 */
function applyChoices(plan, choices) {
  const items = (choices && choices.items) || {};
  const install = [];
  const skip = [];
  const report = [];
  for (const entry of plan) {
    const key = entry.key || `${entry.kind}:${entry.name}`;
    if (!entry.clash) {
      install.push(entry);
      continue;
    }
    const c = items[key];
    if (!c) {
      skip.push({ entry, reason: 'undecided-clash' });
      report.push(`skipped (undecided clash): ${key} -> ${entry.dst}${entry.with?.length ? ` clashes with ${entry.with.join(', ')}` : ''} — run builder-init to decide`);
    } else if (c.decision === 'keep') {
      skip.push({ entry, reason: 'kept-project' });
      report.push(`kept project's (${c.by}, ${c.decidedAt}): ${key} not installed`);
    } else if (c.decision === 'kit') {
      install.push({ ...entry, replace: true });
      report.push(`kit's chosen (${c.by}, ${c.decidedAt}): ${key} -> ${entry.dst}`);
    } else {
      const dst = renamedDst(entry.dst, entry.name);
      if (!dst) {
        skip.push({ entry, reason: 'rename-impossible' });
        report.push(`skipped: ${key} — "both" chosen but ${entry.dst} does not carry the name "${entry.name}" to rename`);
        continue;
      }
      install.push({ ...entry, dst, name: PREFIX + entry.name, rename: PREFIX + entry.name });
      report.push(`both kept (${c.by}, ${c.decidedAt}): ${key} -> ${dst}`);
    }
  }
  return { install, skip, report };
}

module.exports = { FILE, VERSION, DECISIONS, KINDS, PREFIX, validate, read, write, set, unset, applyChoices, renamedDst, renameFrontmatter, empty };
