'use strict';
/**
 * EXPERIMENTAL (`features.personas`) — one role profile per role column of a permission catalogue.
 * See EXPERIMENTS.md, role persona profiles.
 *
 * TWO HALVES, HELD APART ON PURPOSE.
 *   GENERATED  the keys the role holds (its catalogue column) and, where `personas.logins` records one, its
 *              seeded test login. Written between markers by `persona-gen.mjs`, never hand-edited: a
 *              hand-written grant is how an invented permission gets into a seat's head, and from there
 *              into a finding or a test that "confirms" it.
 *   DRAFTED    scope rules, separation-of-duties limits, abuse goals. Every bullet (numbered items included)
 *              must match `personas.citationPattern`; `--check` refuses an uncited one, because an uncited
 *              claim about who may do what is a rule nobody ratified.
 * A profile LOCATES; it never rules. The catalogue and the project's decision records win on any disagreement.
 *
 * WHY `--check` REFUSES ZERO ROLE COLUMNS. A generator over nothing writes nothing, and a check over nothing
 * passes. That pass would read as "every profile matches the catalogue" when no catalogue was read at all.
 *
 * Pure over text; `persona-gen.mjs` reads and writes the files.
 */

const DASH = '—';
const KEYS = ['<!-- generated:keys start -->', '<!-- generated:keys end -->'];
const LOGIN = ['<!-- generated:login start -->', '<!-- generated:login end -->'];
const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+/;
const KEYS_HEADING = /^## Keys held \(\d+\)[ \t]*(?=\r?$)/m;

const slugOf = (column) => String(column).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** A column given as a header name or a 0-based index; -1 when absent. */
function columnIndex(header, spec) {
  if (Number.isInteger(spec)) return spec >= 0 && spec < header.length ? spec : -1;
  return header.indexOf(String(spec));
}

/**
 * @param {string} csvText the catalogue
 * @param {{ csvCells: Function, keyColumn, labelColumn, roleColumns, grant }} opts
 * @returns {{ columns: string[], keysFor: Record<string, {key: string, label: string}[]>, errors: string[] }}
 */
function parseCatalogue(csvText, { csvCells, keyColumn = 0, labelColumn = 1, roleColumns = null, grant = '1' }) {
  const errors = [];
  const rows = String(csvText).replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim()).map((l) => csvCells(l));
  const header = rows[0] ?? [];
  const body = rows.slice(1);
  const keyAt = columnIndex(header, keyColumn);
  const labelAt = labelColumn === null ? -1 : columnIndex(header, labelColumn);
  if (keyAt === -1) errors.push(`keyColumn ${JSON.stringify(keyColumn)}: no such column (columns: ${header.join(', ')})`);
  if (labelColumn !== null && labelAt === -1) errors.push(`labelColumn ${JSON.stringify(labelColumn)}: no such column (columns: ${header.join(', ')})`);
  if (errors.length) return { columns: [], keysFor: {}, errors };

  let indices;
  if (roleColumns === null) {
    /* Inferred: a role column holds only the grant value or nothing, and holds it at least once. */
    indices = header
      .map((_, i) => i)
      .filter((i) => i !== keyAt && i !== labelAt)
      .filter((i) => {
        const cells = body.map((r) => r[i] ?? '').filter((c) => c !== '');
        return cells.length > 0 && cells.every((c) => c === grant);
      });
  } else {
    indices = [];
    for (const name of roleColumns) {
      const i = header.indexOf(name);
      if (i === -1) errors.push(`roleColumns: no column named ${JSON.stringify(name)}`);
      else indices.push(i);
    }
  }
  const columns = indices.map((i) => header[i]);
  const slugs = new Map();
  for (const c of columns) {
    const s = slugOf(c);
    if (!s) errors.push(`role column ${JSON.stringify(c)}: its name makes an empty file name`);
    else if (slugs.has(s)) errors.push(`role columns ${JSON.stringify(slugs.get(s))} and ${JSON.stringify(c)} share the profile file ${s}.md`);
    else slugs.set(s, c);
  }
  const keysFor = Object.fromEntries(columns.map((c) => [c, []]));
  for (const r of body) {
    const key = r[keyAt] ?? '';
    if (!key) continue;
    indices.forEach((i, n) => {
      if ((r[i] ?? '') === grant) keysFor[columns[n]].push({ key, label: labelAt === -1 ? '' : (r[labelAt] ?? '') });
    });
  }
  return { columns, keysFor, errors };
}

/** `logins` must be an object of one-line strings keyed by role column. Returns the problems. */
function checkLoginsShape(logins) {
  if (logins === null) return [];
  if (typeof logins !== 'object' || Array.isArray(logins)) return ['logins: must be a JSON object { "<role column>": "<one line>" }'];
  return Object.entries(logins)
    .filter(([, v]) => typeof v !== 'string' || !v.trim() || /[\r\n]/.test(v))
    .map(([k]) => `logins.${k}: must be a non-empty single line`);
}

const loginBlock = (line) => (line ? `- ${line.trim()}` : `- ${DASH} no seeded login recorded`);
const keysBlock = (keys) => (keys.length === 0 ? `- ${DASH} this column holds no key` : keys.map((k) => (k.label ? `- \`${k.key}\` ${DASH} ${k.label}` : `- \`${k.key}\``)).join('\n'));

const between = (text, [start, end]) => {
  const a = text.indexOf(start);
  const b = text.indexOf(end);
  return a === -1 || b === -1 || b < a ? null : text.slice(a + start.length, b).trim();
};
const replaceBetween = (text, [start, end], body, eol) => {
  const a = text.indexOf(start);
  const b = text.indexOf(end);
  return `${text.slice(0, a + start.length)}${eol}${body.split('\n').join(eol)}${eol}${text.slice(b)}`;
};

const NOT_DRAFTED = `_Not drafted yet. Draft only for a role a run touches; every bullet here must cite its source._`;

/**
 * A profile for one column. An existing file keeps everything outside the generated blocks; only the blocks
 * and the `## Keys held (N)` count change. Returns null when an existing file has lost a marker pair — the
 * generator cannot tell where the generated text ends, and overwriting would destroy drafted work.
 */
function renderProfile({ column, keys, login = null, catalogue = 'the permission catalogue', existing = null }) {
  if (existing !== null) {
    if (between(existing, KEYS) === null || between(existing, LOGIN) === null) return null;
    const eol = existing.includes('\r\n') ? '\r\n' : '\n';
    return replaceBetween(replaceBetween(existing, KEYS, keysBlock(keys), eol), LOGIN, loginBlock(login), eol).replace(KEYS_HEADING, `## Keys held (${keys.length})`);
  }
  return `# ${column} ${DASH} role profile

_The generated blocks come from the \`${column}\` column of \`${catalogue}\` and the seeded-login map, and are
rewritten by \`node scripts/experimental/persona-gen.mjs\` ${DASH} never edit them by hand. The drafted sections are
checked by \`persona-gen.mjs --check\`. A profile locates; it never rules: the catalogue and the project's
decision records win on any disagreement._

## Seeded login

${LOGIN[0]}
${loginBlock(login)}
${LOGIN[1]}

## Keys held (${keys.length})

${KEYS[0]}
${keysBlock(keys)}
${KEYS[1]}

## Scope rules

${NOT_DRAFTED}

## Separation-of-duties limits

${NOT_DRAFTED}

## Abuse goals ${DASH} hunting prompts, never rulings

${NOT_DRAFTED}
`;
}

/** Problems with one profile: generated blocks out of step with their sources, or a drafted bullet without a citation. */
function checkProfile(rawText, { keys, login = null, citation }) {
  const text = String(rawText).replace(/\r\n/g, '\n');
  const problems = [];
  const held = between(text, KEYS);
  if (held === null) problems.push('keys block missing — its markers were removed; restore them and re-run persona-gen');
  else if (held !== keysBlock(keys)) {
    const listed = new Set(held.split('\n').map((l) => /^\s*[-*]\s+`([^`]+)`/.exec(l)?.[1]).filter(Boolean));
    const want = new Set(keys.map((k) => k.key));
    const before = problems.length;
    for (const k of want) if (!listed.has(k)) problems.push(`key held by the catalogue column but not listed: ${k}`);
    for (const k of listed) if (!want.has(k)) problems.push(`key listed but not held by the catalogue column: ${k}`);
    if (problems.length === before) problems.push('keys block differs from the generated text (labels, order or wording) — run persona-gen');
  }
  const count = /^## Keys held \((\d+)\)/m.exec(text);
  if (held !== null && count && Number(count[1]) !== keys.length) problems.push(`"Keys held (${count[1]})" — the column holds ${keys.length}`);

  const loginText = between(text, LOGIN);
  if (loginText === null) problems.push('login block missing — its markers were removed; restore them and re-run persona-gen');
  else if (loginText !== loginBlock(login)) problems.push('login block differs from the seeded-login map — run persona-gen');

  let outside = text;
  for (const [start, end] of [KEYS, LOGIN]) {
    const a = outside.indexOf(start);
    const b = outside.indexOf(end);
    if (a !== -1 && b > a) outside = outside.slice(0, a) + outside.slice(b + end.length);
  }
  const cite = citation instanceof RegExp ? new RegExp(citation.source, citation.flags.replace('g', '')) : new RegExp(String(citation));
  for (const line of outside.split('\n')) {
    if (BULLET.test(line) && !cite.test(line)) problems.push(`uncited line: ${line.trim().slice(0, 100)}`);
  }
  return problems;
}

module.exports = { parseCatalogue, checkLoginsShape, renderProfile, checkProfile, slugOf, columnIndex, keysBlock, loginBlock, KEYS, LOGIN };
