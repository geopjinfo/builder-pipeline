'use strict';
/**
 * The handoff pack — its checker, and the pure half of its generator.
 *
 * WHY. A run's handoff to the decision workspace used to be a table inside the chat report. In one adopting
 * project, over a third of the recent runs left no file naming the run at all, and the progress tracker
 * under-reported shipped work until a separate clean-up order caught it up. Chat scrolls away; a file does not.
 * So a pack is a FILE with six sections, one per run at `<paths.handoffs>/<date>-<key>-handoff.md`, and the run
 * cannot close until this checker passes it.
 *
 * Checks: §A–§F present and in order · a `RESPONSE REQUIRED:` line in every section · no `<fill>` placeholder left ·
 * §A names a commit, a version and a verdict · §B either says "No tracker flips — <reason>" or, when a tracker is
 * configured, uses the fixed header, names an allowed tracker file, says pre-merge or post-merge, carries evidence,
 * and every value in a listed column comes from the configured list vocabulary · every decision id cited in §C
 * exists in the decision workspace · every registry id cited in §D exists in the deferred registry · §F names the
 * tag (or says there is none).
 *
 * Pure over text and injected context; `scripts/handoff-check.mjs` and `scripts/handoff-pack.mjs` do the I/O.
 */
const { ROW_ID, stripAnnotation, normalizeStatus } = require('./board-rows.cjs');
const { csvCells } = require('./output-check.cjs');
const { runHint } = require('./run-hint.cjs');

const SECTIONS = [
  ['§A', 'progress'],
  ['§B', 'tracker flips'],
  ['§C', 'decisions'],
  ['§D', 'registry'],
  ['§E', 'docs'],
  ['§F', 'merge conditions'],
];
const TRACKER_HEADER = '| When | File | Row | Column | From | To | Evidence |';
const RESPONSE = /RESPONSE REQUIRED:\s*\**\s*(blocking|non-blocking|none needed)\b/i;
/** The decision-log template numbers its rows `D-1`, `D-2`, … — the default id shape. */
const DEFAULT_DECISION_ID = 'D-\\d+';
const DEFAULT_REGISTRY_ID = '[A-Z][A-Z0-9]{1,8}-D\\d+[a-z]?';
const NO_TRACKER = /No tracker flips\s*[—-]+\s*\S/i;

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const idRegex = (source, flags = 'g') => new RegExp(`(?<![\\w-])(?:${source})(?![\\w-])`, flags);

/** A lists CSV — one column per vocabulary, its header the vocabulary's name — as { name: Set(values) }. */
function parseLists(csvText) {
  const rows = String(csvText).replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (rows.length === 0) return {};
  const header = csvCells(rows[0]).map((c) => c.trim());
  const lists = {};
  header.forEach((name, i) => {
    if (!name) return;
    lists[name] = new Set(rows.slice(1).map((r) => (csvCells(r)[i] ?? '').trim()).filter(Boolean));
  });
  return lists;
}

/** Every id of a shape mentioned anywhere in a text. */
function idsIn(text, source) {
  return new Set([...String(text).matchAll(idRegex(source))].map((m) => m[0]));
}

/** The ids that key a registry row (first cell, struck through or not) — a mention in prose is not a row. */
function registryRowIds(text, source = DEFAULT_REGISTRY_ID) {
  const re = new RegExp(`^\\|\\s*~?~?(${source})~?~?\\s*\\|`, 'gm');
  return new Set([...String(text).matchAll(re)].map((m) => m[1]));
}

/**
 * @param {string} text
 * @param {{
 *   decisionIds: Set<string>, registryIds: Set<string>,
 *   decisionIdPattern?: string, registryIdPattern?: string,
 *   tracker: null | { files: string[], lists: Record<string, Set<string>>, columnLists?: Record<string, Record<string, string>> },
 * }} ctx
 * @returns {string[]} errors
 */
function checkHandoff(text, ctx) {
  const errors = [];
  const lines = text.split(/\r?\n/);
  const starts = SECTIONS.map(([id]) => lines.findIndex((l) => new RegExp(`^## ${id}(?![\\w])`).test(l)));
  SECTIONS.forEach(([id, name], i) => {
    if (starts[i] === -1) errors.push(`missing section: ## ${id} ${name}`);
    else if (i > 0 && starts[i - 1] !== -1 && starts[i] < starts[i - 1]) errors.push(`section out of order: ## ${id}`);
  });
  const body = (i) => {
    if (starts[i] === -1) return '';
    const next = starts.filter((s) => s > starts[i]).sort((a, b) => a - b)[0] ?? lines.length;
    return lines.slice(starts[i], next).join('\n');
  };
  SECTIONS.forEach(([id], i) => {
    if (starts[i] !== -1 && !RESPONSE.test(body(i))) errors.push(`${id}: no "RESPONSE REQUIRED: blocking | non-blocking | none needed" line`);
  });
  lines.forEach((l, i) => {
    if (/<fill\b/i.test(l)) errors.push(`line ${i + 1}: unfilled placeholder — "${l.trim().slice(0, 80)}"`);
  });

  const a = body(0);
  if (a && !/\b[0-9a-f]{7,40}\b/.test(a)) errors.push('§A: no commit sha');
  if (a && !/\bv?\d+\.\d+\.\d+\b/.test(a)) errors.push('§A: no version');
  if (a && !/\b(MERGE-READY|CHANGES-REQUIRED)\b/.test(a)) errors.push('§A: no reviewer verdict');

  const bText = body(1);
  const b = bText.split(/\r?\n/);
  const headerAt = b.findIndex((l) => l.trim().replace(/\s+/g, ' ') === TRACKER_HEADER);
  if (bText && !ctx.tracker) {
    // No tracker is a legitimate project shape — but the section still says so in words, so an empty §B can never
    // be mistaken for "nothing needed flipping" on a project that does keep one.
    if (!NO_TRACKER.test(bText)) errors.push('§B: tracker: not configured — say "No tracker flips — <reason>"');
    if (headerAt !== -1) errors.push('§B: a tracker table, but no tracker is configured (features.handoffPack.tracker)');
  } else if (bText) {
    if (headerAt === -1 && !NO_TRACKER.test(bText)) errors.push(`§B: no tracker table with the header ${TRACKER_HEADER} (or a "No tracker flips — <reason>" line)`);
    const files = new Set(ctx.tracker.files ?? []);
    if (headerAt !== -1) {
      for (let i = headerAt + 1; i < b.length && b[i].trim().startsWith('|'); i += 1) {
        if (/^\s*\|\s*:?-{2,}/.test(b[i])) continue;
        const [when, file, row, column, from, to, evidence] = b[i].split('|').slice(1, -1).map((c) => c.trim().replace(/`/g, ''));
        const at = `§B row "${row ?? ''} · ${column ?? ''}"`;
        if (!['pre-merge', 'post-merge'].includes(when)) errors.push(`${at}: When must be pre-merge or post-merge`);
        if (!files.has(file)) errors.push(`${at}: File "${file}" is not a tracker file the pack may flip (${[...files].join(', ')})`);
        if (!row || !column || !from || !to) errors.push(`${at}: Row, Column, From and To are all required`);
        // A flip nobody can check is a claim, not a record: every row carries the evidence that earned it.
        if (!evidence) errors.push(`${at}: Evidence is required`);
        const listName = ctx.tracker.columnLists?.[file]?.[column];
        if (listName && to) {
          const allowed = ctx.tracker.lists?.[listName];
          if (!allowed) errors.push(`${at}: the list "${listName}" is not a column of the lists file`);
          else if (!allowed.has(to)) errors.push(`${at}: "${to}" is not a ${listName} value (${[...allowed].join(', ')})`);
        }
      }
    }
  }

  const decisionSource = ctx.decisionIdPattern || DEFAULT_DECISION_ID;
  for (const id of idsIn(body(2), decisionSource)) {
    if (!ctx.decisionIds.has(id)) errors.push(`§C: ${id} is not in the decision workspace`);
  }
  const registrySource = ctx.registryIdPattern || DEFAULT_REGISTRY_ID;
  for (const id of idsIn(body(3), registrySource)) {
    if (!ctx.registryIds.has(id)) errors.push(`§D: ${id} is not in the deferred registry`);
  }
  const f = body(5);
  if (f && !/\bv\d+\.\d+\.\d+\b|\bno tag\b/i.test(f)) errors.push('§F: name the tag (vX.Y.Z) or say "no tag"');
  return errors;
}

/** Board rows by how they ended. Open rows are counted, because a run cannot close with any. */
function summariseBoard(markdown) {
  const out = { done: 0, deferred: 0, dropped: 0, open: 0, deferredTo: [] };
  let statusCol = -1;
  for (const line of String(markdown).split(/\r?\n/)) {
    if (!line.startsWith('|')) {
      if (/^##\s/.test(line)) statusCol = -1;
      continue;
    }
    const cells = line.split(/(?<!\\)\|/).slice(1, -1).map((c) => c.trim());
    const h = cells.indexOf('Status');
    if (h !== -1) {
      statusCol = h;
      continue;
    }
    if (statusCol === -1 || !ROW_ID.test(stripAnnotation(cells[0] ?? '').replace(/[*`~]/g, ''))) continue;
    const s = normalizeStatus(cells[statusCol]);
    if (/^DONE/.test(s)) out.done += 1;
    else if (/^DEFERRED/.test(s)) {
      out.deferred += 1;
      const id = /DEFERRED→\s*([A-Za-z0-9-]+)/.exec(s)?.[1];
      if (id && !out.deferredTo.includes(id)) out.deferredTo.push(id);
    } else if (/^DROPPED/.test(s)) out.dropped += 1;
    else out.open += 1;
  }
  return out;
}

/** Registry rows a `git diff` added, changed or removed. */
function registryChanges(diffText, source = DEFAULT_REGISTRY_ID) {
  const re = new RegExp(`^([+-])\\|\\s*~?~?(${source})~?~?\\s*\\|`);
  const seen = new Map();
  for (const line of String(diffText).split(/\r?\n/)) {
    const m = re.exec(line);
    if (!m) continue;
    const prev = seen.get(m[2]);
    seen.set(m[2], prev && prev !== m[1] ? '±' : m[1]);
  }
  return [...seen].map(([id, sign]) => ({ id, change: sign === '+' ? 'added' : sign === '-' ? 'removed' : 'changed' }));
}

/** The version from the top versioned CHANGELOG heading, else a package manifest, else null. */
function versionFrom({ changelog, manifests = [] } = {}) {
  if (changelog) {
    for (const line of String(changelog).split(/\r?\n/)) {
      const m = /^#{1,3}\s.*?\bv?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\b/.exec(line);
      if (m) return m[1];
    }
  }
  for (const { name, text } of manifests) {
    try {
      if (name === 'package.json') {
        const v = JSON.parse(text).version;
        if (v) return v;
      } else {
        const m = /^\s*version\s*=\s*["']([^"']+)["']/m.exec(text);
        if (m) return m[1];
      }
    } catch {
      /* an unreadable manifest yields no version, never a crash */
    }
  }
  return null;
}

/**
 * The pack skeleton. Everything a script cannot know is left as `<fill …>`, so the checker refuses the pack until
 * a person or seat has filled it.
 */
function renderPack(p) {
  const sha = p.sha || '<fill: commit sha>';
  const version = p.version ? `v${p.version}` : '<fill version>';
  const board = p.board ?? { done: 0, deferred: 0, dropped: 0, open: 0, deferredTo: [] };
  const gates = p.gates ?? [];
  const tracker = p.trackerFiles
    ? [
        TRACKER_HEADER,
        '|---|---|---|---|---|---|---|',
        `| post-merge | ${p.trackerFiles[0] ?? '<fill: tracker file>'} | <fill: row id> | <fill: column> | <fill: current value> | <fill: new value> | <fill: evidence> |`,
      ].join('\n')
    : 'No tracker flips — tracker: not configured';
  const registry =
    p.registryChanges === null || p.registryChanges === undefined
      ? `- Registry diff against \`${p.base}\`: not computed — <fill: the registry rows this run added, changed or closed, or "none">`
      : p.registryChanges.length
        ? p.registryChanges.map((r) => `- ${r.change} \`${r.id}\``).join('\n')
        : '- No registry row changed against the base.';
  return `# ${p.key} — handoff pack

**From:** \`${sha}\` · ${version} · base \`${p.base}\` · generated ${p.date} by \`${runHint('handoff-pack')}\`

## §A progress

RESPONSE REQUIRED: none needed

- Commit \`${sha}\`, version ${version}, reviewer verdict **${p.verdict ?? '<fill: MERGE-READY | CHANGES-REQUIRED>'}**.
- Board rows: ${board.done} DONE · ${board.deferred} DEFERRED · ${board.dropped} DROPPED · ${board.open} still open${board.open ? ' — <fill: a run cannot close with open rows>' : ''}.
- Tiers (last result per gate from the run log): ${gates.length ? gates.map((g) => `${g.gate} ${g.result}${g.figure ? ` (${g.figure})` : ''}`).join(' · ') : '<fill: tier results>'}.
- Behavioural QA: <fill: the result, or "QA: skipped" and why>.

## §B tracker flips

RESPONSE REQUIRED: non-blocking

${tracker}

## §C decisions

RESPONSE REQUIRED: non-blocking

${p.decisions?.length ? p.decisions.map((d) => `- \`${d}\` — <fill: one line: what was decided, and from which source>`).join('\n') : '- No decision id cited on the board.'}
- In-session rulings to record: <fill: each with its decision id, or "none">.
- \`NEEDS-RULING\` items: <fill: each with its decision-workspace request file, or "none">.

## §D registry

RESPONSE REQUIRED: none needed

${registry}
${board.deferredTo.length ? `- Board deferrals point at: ${board.deferredTo.map((id) => `\`${id}\``).join(', ')}.\n` : ''}
## §E docs

RESPONSE REQUIRED: non-blocking

- Interface / contract change: <fill: what changed for a consumer, or "none">.
- Decision records warranted: <fill: each with what it records, or "none">.

## §F merge conditions

RESPONSE REQUIRED: none needed <fill: or "blocking" when any merge condition is open>

- Merge conditions: <fill: each, or "none">.
- Tag: ${p.version ? `v${p.version} (annotated, at merge)` : '<fill: the tag vX.Y.Z, or "no tag">'}.
`;
}

module.exports = {
  checkHandoff,
  parseLists,
  idsIn,
  registryRowIds,
  summariseBoard,
  registryChanges,
  versionFrom,
  renderPack,
  SECTIONS,
  TRACKER_HEADER,
  DEFAULT_DECISION_ID,
  DEFAULT_REGISTRY_ID,
  escape,
};
