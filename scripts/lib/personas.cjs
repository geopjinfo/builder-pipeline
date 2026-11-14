'use strict';
/**
 * The persona roster: the one machine-readable block in personas/INDEX.md, and what may be done with it.
 * Pure — no file system, no clock. The CLI (scripts/personas-check.mjs) does the reading and writing.
 *
 * WHY. A persona is a thinking tool, never evidence, and nothing becomes an agent before a human confirms it.
 * Those two rules are prose in skills/persona-detect.md; here they are code: an unconfirmed persona cannot be
 * rendered, a confirmed one is never overwritten by a refresh, and a rendered agent is read-only.
 *
 * Roster shape (the fenced ```json block in INDEX.md):
 *   { "personas": [ { id, name, set, confirmed, routes, file?, render?, tier? } ] }
 *     id         lower-case slug, unique — the agent name becomes `persona-<id>`
 *     name       display name
 *     set        product | delivery | governance
 *     confirmed  boolean — true only after the human confirmed it
 *     routes     string[] — task kinds it takes or rules on (lower-case slugs)
 *     file       profile path relative to personas/ (default `<set>/<id>.md`)
 *     render     boolean (default false) — ask the lead to render it as an agent; confirmed only
 *     tier       strong | mid | low (default mid)
 */

const SETS = Object.freeze(['product', 'delivery', 'governance']);
const TIERS = Object.freeze(['strong', 'mid', 'low']);
const SLUG = /^[a-z][a-z0-9-]{0,62}$/;
const FENCE = /^```json[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/gm;

/** The profile path of an entry, relative to personas/. */
function fileOf(entry) {
  return entry && typeof entry.file === 'string' && entry.file.length > 0 ? entry.file : `${entry.set}/${entry.id}.md`;
}

/**
 * The roster from INDEX.md text. Throws a plain message when there is no roster block, more than one, or the
 * block is not JSON — a roster that cannot be read is never read as an empty one.
 */
function parseRoster(indexMd) {
  if (typeof indexMd !== 'string') throw new Error('INDEX.md text is required');
  const blocks = [];
  for (const m of indexMd.matchAll(FENCE)) {
    let value;
    try {
      value = JSON.parse(m[1]);
    } catch (e) {
      if (/"personas"\s*:/.test(m[1])) throw new Error(`the roster block is not valid JSON: ${e.message}`);
      continue;
    }
    if (value && typeof value === 'object' && !Array.isArray(value) && 'personas' in value) blocks.push(value);
  }
  if (blocks.length === 0) throw new Error('no roster block — INDEX.md needs one fenced json block {"personas":[...]}');
  if (blocks.length > 1) throw new Error(`${blocks.length} roster blocks — INDEX.md must carry exactly one`);
  return blocks[0];
}

/**
 * Every problem with a roster, as plain lines; [] means it holds.
 * opts.fileExists(relPath) → boolean, when given, checks each profile file (relative to personas/).
 */
function validate(roster, opts = {}) {
  const problems = [];
  if (!roster || typeof roster !== 'object' || !Array.isArray(roster.personas)) {
    return ['the roster has no "personas" array'];
  }
  const seen = new Map();
  roster.personas.forEach((p, i) => {
    const at = `personas[${i}]${p && typeof p.id === 'string' ? ` (${p.id})` : ''}`;
    if (!p || typeof p !== 'object' || Array.isArray(p)) {
      problems.push(`${at}: not an object`);
      return;
    }
    for (const field of ['id', 'name', 'set', 'confirmed', 'routes']) {
      if (p[field] === undefined || p[field] === null || p[field] === '') problems.push(`${at}: missing field "${field}"`);
    }
    if (p.id !== undefined && (typeof p.id !== 'string' || !SLUG.test(p.id))) problems.push(`${at}: id must be a lower-case slug`);
    if (typeof p.id === 'string') {
      if (seen.has(p.id)) problems.push(`${at}: duplicate id "${p.id}" (first at personas[${seen.get(p.id)}])`);
      else seen.set(p.id, i);
    }
    if (p.name !== undefined && typeof p.name !== 'string') problems.push(`${at}: name must be a string`);
    if (p.set !== undefined && p.set !== '' && !SETS.includes(p.set)) problems.push(`${at}: set must be one of ${SETS.join(', ')}`);
    if (p.confirmed !== undefined && typeof p.confirmed !== 'boolean') problems.push(`${at}: confirmed must be true or false`);
    if (p.routes !== undefined && p.routes !== null) {
      if (!Array.isArray(p.routes) || p.routes.some((r) => typeof r !== 'string' || !SLUG.test(r))) {
        problems.push(`${at}: routes must be a list of lower-case slugs`);
      }
    }
    if (p.render !== undefined && typeof p.render !== 'boolean') problems.push(`${at}: render must be true or false`);
    if (p.render === true && p.confirmed !== true) problems.push(`${at}: marked to render but not confirmed — nothing becomes an agent before the human confirms it`);
    if (p.render === true && Array.isArray(p.routes) && p.routes.length === 0) problems.push(`${at}: marked to render with no routes — nothing would ever route to it`);
    if (p.tier !== undefined && !TIERS.includes(p.tier)) problems.push(`${at}: tier must be one of ${TIERS.join(', ')}`);
    if (p.file !== undefined && (typeof p.file !== 'string' || /^([a-zA-Z]:)?[\\/]/.test(p.file) || p.file.split(/[\\/]/).includes('..'))) {
      problems.push(`${at}: file must be a path inside personas/`);
    } else if (typeof opts.fileExists === 'function' && typeof p.id === 'string' && SETS.includes(p.set) && !opts.fileExists(fileOf(p))) {
      problems.push(`${at}: profile file missing — ${fileOf(p)}`);
    }
  });
  return problems;
}

/** The text under a `## <heading>` up to the next `## ` heading, or ''. */
function section(md, heading) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => l.trim().toLowerCase() === `## ${heading}`.toLowerCase());
  if (start === -1) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^## /.test(l));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

const oneLine = (s) => s.replace(/\s+/g, ' ').replace(/-{3,}/g, '-').trim();

/**
 * A neutral agent file (agents/*.md shape: name, description, capabilities, tier) from a confirmed persona's
 * profile. Throws when the entry is not confirmed or the profile has no Agent seed block.
 */
function toNeutralAgent(personaMd, rosterEntry) {
  const e = rosterEntry || {};
  if (e.confirmed !== true) throw new Error(`persona "${e.id}" is not confirmed — nothing becomes an agent before the human confirms it`);
  if (typeof personaMd !== 'string') throw new Error(`persona "${e.id}": profile text is required`);
  const seedSection = section(personaMd, 'Agent seed');
  const seed = /```[^\n]*\n([\s\S]*?)\n```/.exec(seedSection);
  if (!seed || seed[1].trim() === '') throw new Error(`persona "${e.id}": the profile has no Agent seed block`);
  const mandate = oneLine(section(personaMd, 'Role and mandate') || section(personaMd, 'Mandate')).replace(/^<.*>$/, '');
  const routes = Array.isArray(e.routes) && e.routes.length > 0 ? e.routes.join(', ') : 'a task its owner names';
  const description = oneLine(
    `Use when a task is one of: ${routes}. Persona "${e.name}" (${e.set})${mandate ? ` - ${mandate}` : ''}. ` +
      'A thinking tool: returns opinions and questions, never evidence or a ruling.',
  );
  const tier = TIERS.includes(e.tier) ? e.tier : 'mid';
  return [
    '---',
    `name: persona-${e.id}`,
    `description: ${description}`,
    'capabilities: read-only',
    `tier: ${tier}`,
    '---',
    '',
    `<!-- Rendered from personas/${fileOf(e)} by scripts/personas-check.mjs. Edit the profile, not this file. -->`,
    '',
    seed[1].trim(),
    '',
    'Standing rule: nothing you assert about this project is a finding until it traces to a source. Return',
    'opinions and questions. When a question is outside what you know, say so and name who would know.',
    '',
  ].join('\n');
}

/**
 * Refresh: fold a newly proposed roster into the existing one without overwriting any confirmed persona.
 *   roster          the merged roster to write — confirmed entries verbatim, unconfirmed ones replaced by the proposal
 *   added           ids new in this proposal (written unconfirmed, not rendered)
 *   changes         [{ id, field, from, to }] proposed for confirmed personas — NOT applied; for the human
 *   kept            ids of confirmed personas carried over untouched
 */
function mergeProposal(existing, proposed) {
  const old = (existing && Array.isArray(existing.personas) ? existing.personas : []).filter((p) => p && typeof p.id === 'string');
  const next = (proposed && Array.isArray(proposed.personas) ? proposed.personas : []).filter((p) => p && typeof p.id === 'string');
  const byId = new Map(next.map((p) => [p.id, p]));
  const out = [];
  const changes = [];
  const kept = [];
  const added = [];
  for (const p of old) {
    const n = byId.get(p.id);
    if (p.confirmed === true) {
      out.push(p);
      kept.push(p.id);
      if (n) {
        for (const field of ['name', 'set', 'routes', 'file', 'tier']) {
          if (n[field] !== undefined && JSON.stringify(n[field]) !== JSON.stringify(p[field])) changes.push({ id: p.id, field, from: p[field], to: n[field] });
        }
      }
    } else if (n) {
      out.push({ ...n, confirmed: false, render: false });
    } else {
      out.push(p);
    }
    byId.delete(p.id);
  }
  for (const n of byId.values()) {
    out.push({ ...n, confirmed: false, render: false });
    added.push(n.id);
  }
  return { roster: { personas: out }, added, changes, kept };
}

module.exports = { SETS, TIERS, fileOf, parseRoster, validate, toNeutralAgent, mergeProposal };
