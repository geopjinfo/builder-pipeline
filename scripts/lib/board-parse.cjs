/**
 * Read a task board (`tasks/<key>.md`) into structure — header, phase:status block, counted
 * sections with their rows, the deferred list, and the same totals `board-progress.mjs` computes.
 *
 * WHY THIS EXISTS. The rendered run board (`tasks/<key>.html`) must be a projection of the markdown
 * board, not a second account of it. The moment the renderer carries its own idea of what a row is,
 * the two can disagree — and a rendered board that disagrees with the file it claims to show is
 * worse than no rendered board, because it looks authoritative. So there is exactly one reader of
 * the row vocabulary (`board-rows.cjs`), one definition of "settled", and this module.
 *
 * It parses; it does not judge. An unknown row id is REPORTED (`unrecognised`), never dropped —
 * the same rule `board-progress.mjs` learned on 2026-08-26, when rows filed under an id outside the
 * house set vanished from every count while the table still showed them.
 */
const { ROW_ID, stripAnnotation, isDecorativeCell, normalizeStatus } = require('./board-rows.cjs');

const SETTLED = /^(DONE|DROPPED|DEFERRED→)/;
const DOING = /^IN-PROGRESS/;

/** A `|` escaped as `\|` sits INSIDE a cell; it is not a boundary. Same rule as board-progress. */
const CELL = /(?<!\\)\|/;

const cells = (line) =>
  line
    .split(CELL)
    .slice(1, -1)
    .map((c) => c.trim().replace(/\\\|/g, '|'));

const isSeparator = (line) => /^\|[-: |]+\|$/.test(line.trim());

/**
 * The header facts a board declares in its first lines: title, started, track, branch.
 * Absent facts come back `null` — the renderer prints an em-dash, never an invented default.
 */
function parseHeader(lines) {
  const title = (lines.find((l) => l.startsWith('# ')) ?? '').replace(/^#\s+/, '').trim() || null;
  const meta = lines.slice(0, 12).join('\n');
  const pick = (re) => {
    const m = re.exec(meta);
    return m ? m[1].trim() : null;
  };
  return {
    title,
    started: pick(/_Started:\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/),
    track: pick(/Track:\s*\*\*([A-Z-]+)\*\*/),
    branch: pick(/Branch:\s*`([^`]+)`/),
    scope: pick(/\*\*Scope:\*\*\s*(.+?)\s*(?:·\s*\*\*|$)/m),
    unlock: pick(/\*\*Unlock:\*\*\s*(.+?)\s*$/m),
  };
}

/** The `phase:status` block, read as rows so the renderer never re-types a seat's verdict. */
function parsePhases(lines) {
  const start = lines.findIndex((l) => l.includes('phase:status start'));
  const end = lines.findIndex((l) => l.includes('phase:status end'));
  if (start === -1 || end === -1) return [];
  const rows = [];
  for (const line of lines.slice(start + 1, end)) {
    if (!line.startsWith('|') || isSeparator(line)) continue;
    const c = cells(line);
    if (c[0] === 'Phase') continue;
    rows.push({
      phase: c[0] ?? '',
      seat: c[1] ?? '',
      status: normalizeStatus(c[2] ?? ''),
      artifact: c[3] ?? '',
      verdict: c[4] ?? '',
    });
  }
  return rows;
}

/**
 * A counted section is `## B<n> — …` (a delivery board's batch) or `## P<n> — …` (a build board's
 * phase). Everything else is prose. Identical to `board-progress.mjs` by design — if this drifts,
 * the rendered board and the computed bar report different totals for the same file.
 */
function parseSections(lines) {
  const sections = [];
  const unrecognised = [];
  let current = null;
  let columns = null;
  let statusColumn = -1;

  for (const line of lines) {
    const heading = /^##\s+([BP]\d+)\s+—\s+(.+?)(?:\s+·.*)?$/.exec(line);
    if (heading) {
      current = { id: heading[1], title: heading[2].trim(), columns: [], rows: [] };
      sections.push(current);
      columns = null;
      statusColumn = -1;
      continue;
    }
    if (/^##\s/.test(line)) {
      current = null;
      continue;
    }
    if (!current || !line.startsWith('|') || isSeparator(line)) continue;

    const row = cells(line);
    const headerIndex = row.findIndex((c) => c === 'Status');
    if (headerIndex !== -1) {
      statusColumn = headerIndex;
      columns = row;
      current.columns = row;
      continue;
    }
    if (statusColumn === -1) continue;

    const id = stripAnnotation(row[0] ?? '');
    if (!ROW_ID.test(id)) {
      if (!isDecorativeCell(row[0])) unrecognised.push({ section: current.id, id: (row[0] ?? '').trim() });
      continue;
    }

    const status = normalizeStatus(row[statusColumn] ?? '');
    current.rows.push({
      id,
      cells: row,
      status,
      state: SETTLED.test(status) ? 'settled' : DOING.test(status) ? 'doing' : 'open',
    });
  }

  return { sections, unrecognised, columns };
}

/** `## Deferred this cycle` — bullet rows, each carrying the registry id that owns the deferral. */
function parseDeferred(lines) {
  const start = lines.findIndex((l) => /^##\s+Deferred this cycle/i.test(l));
  if (start === -1) return [];
  const out = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s/.test(line)) break;
    const m = /^-\s+([A-Za-z0-9_.-]+)\s+—\s+(.+)$/.exec(line.trim());
    if (m) out.push({ id: m[1], text: m[2].trim() });
  }
  return out;
}

/** Parse a board's markdown source. Pure — no filesystem, so the tests can hold a fixture. */
function parseBoard(source) {
  const lines = source.split(/\r?\n/);
  const { sections, unrecognised } = parseSections(lines);
  const totals = sections.reduce(
    (acc, s) => {
      for (const r of s.rows) {
        acc.total += 1;
        if (r.state === 'settled') acc.settled += 1;
        else if (r.state === 'doing') acc.doing += 1;
      }
      return acc;
    },
    { settled: 0, doing: 0, total: 0 },
  );

  return {
    header: parseHeader(lines),
    phases: parsePhases(lines),
    sections,
    deferred: parseDeferred(lines),
    unrecognised,
    totals,
    source,
  };
}

module.exports = { parseBoard };
