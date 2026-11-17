'use strict';
/**
 * Import another tool's task file as a kit build board — the pure half of `scripts/board-import.mjs`.
 *
 * WHY. A team that runs another orchestrator (a ralph loop, a Spec Kit feature) has a task file in that tool's
 * shape. The kit's gates read one shape: the build board (templates/task-board.md). The importer writes that shape
 * from theirs so `check-ledgers`, `board-progress` and the ledger audit run over their work without the pipeline.
 *
 * THE RULE (the same one `orch digest` follows). Keep what the source STATES. Mark what the importer INFERS with
 * `⚠ CONFIRM`. List every source line that became no row under `## Unmapped` with its line number. Never guess in
 * silence: a cell the source does not give stays empty — in particular a DONE row whose source names no test keeps an
 * empty evidence cell, so the ledger gate reports it (LG-5). That report is the audit finding, not a defect of the
 * import.
 *
 * Formats:
 *   ralph     — `prd.json`: { userStories: [{ id, title, description, acceptanceCriteria[], priority, passes, notes }] }
 *               (https://github.com/snarktank/ralph, prd.json.example). One row per story, in file order:
 *               `T<n>` · Task = title · Cites = the story id · Status = passes ? DONE : PLANNED · evidence `—` ·
 *               Notes = acceptance criteria joined by `;`, then the story's notes.
 *   spec-kit  — `tasks.md`: `- [ ] T012 [P] [US1] Create model in src/models/a.py` (https://github.com/github/spec-kit,
 *               templates/tasks-template.md). One row per task line: id as stated · Task = the description ·
 *               Cites = the `[P]` and `[US<n>]` markers · Status = `[x]` ? DONE : PLANNED · evidence `—`.
 *
 * Pure over text; the .mjs does the I/O.
 */

const FORMATS = ['ralph', 'spec-kit'];
const CONFIRM = '⚠ CONFIRM';
const HEADER = '| # | Task | Cites | Status | Test-seed / evidence | Notes |';
const SEPARATOR = '|---|---|---|---|---|---|';

/** One table cell: no newlines, pipes escaped, never empty (an empty cell reads as a missing one). */
const cell = (text) => {
  const t = String(text ?? '').replace(/\r?\n+/g, ' ').replace(/\|/g, '\\|').trim();
  return t === '' ? '—' : t;
};

/**
 * @returns {{ rows: Array<{id, task, cites, status, evidence, notes}>, unmapped: Array<{line, text}>, errors: string[],
 *             inferred: string[] }}
 */
function readRalph(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { rows: [], unmapped: [], inferred: [], errors: [`prd.json is not valid JSON: ${e.message}`] };
  }
  const stories = raw && Array.isArray(raw.userStories) ? raw.userStories : null;
  if (!stories) return { rows: [], unmapped: [], inferred: [], errors: ['prd.json has no "userStories" array — not a ralph PRD'] };
  const rows = [];
  const unmapped = [];
  const inferred = ['row numbers T1… follow the file order of userStories (ralph has no row id of this shape)'];
  stories.forEach((s, i) => {
    if (!s || typeof s !== 'object') {
      unmapped.push({ line: i + 1, text: `userStories[${i}] is not an object` });
      return;
    }
    const done = s.passes === true;
    const criteria = Array.isArray(s.acceptanceCriteria) ? s.acceptanceCriteria.map((c) => String(c)).join('; ') : '';
    const notes = [criteria, s.notes ? `notes: ${s.notes}` : '', done ? `${CONFIRM} evidence: the source says passes=true and names no test` : ''].filter(Boolean).join(' · ');
    rows.push({
      id: `T${i + 1}`,
      task: s.title || s.description || `${CONFIRM} story ${i + 1} has no title`,
      cites: s.id || `${CONFIRM} no id`,
      status: done ? 'DONE' : 'PLANNED',
      evidence: '—',
      notes,
      stated: { id: s.id ?? null, passes: s.passes ?? null, priority: s.priority ?? null },
    });
  });
  return { rows, unmapped, inferred, errors: [] };
}

const TASK_LINE = /^\s*[-*]\s+\[( |x|X)\]\s+(T\d+)\b\s*(.*)$/;
const MARKER = /^\[(P|US\d+)\]\s*/;

function readSpecKit(text) {
  const rows = [];
  const unmapped = [];
  const inferred = [];
  const lines = String(text).split(/\r?\n/);
  let heading = null;
  lines.forEach((line, i) => {
    const n = i + 1;
    if (line.trim() === '') return;
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    if (h) {
      heading = h[1].trim();
      return;
    }
    const m = TASK_LINE.exec(line);
    if (!m) {
      unmapped.push({ line: n, text: line.trim() });
      return;
    }
    const [, box, id] = m;
    let rest = m[3].trim();
    const markers = [];
    let mk;
    while ((mk = MARKER.exec(rest))) {
      markers.push(`[${mk[1]}]`);
      rest = rest.slice(mk[0].length);
    }
    if (/\bTXXX\b/.test(id)) {
      unmapped.push({ line: n, text: line.trim() });
      return;
    }
    const hasPath = /[\w./-]+\.[A-Za-z]{1,8}\b|\b\w+\/\w+/.test(rest);
    const notes = [heading ? `under: ${heading}` : '', hasPath ? '' : `${CONFIRM} files: the line names no path`].filter(Boolean).join(' · ');
    if (!hasPath) inferred.push(`${id}: no file path on the line`);
    rows.push({
      id,
      task: rest || `${CONFIRM} task ${id} has no description`,
      cites: markers.join(' ') || '—',
      status: /x/i.test(box) ? 'DONE' : 'PLANNED',
      evidence: '—',
      notes,
      stated: { id, checked: /x/i.test(box) },
    });
  });
  if (rows.length === 0) return { rows, unmapped, inferred, errors: ['no task line of the shape "- [ ] T001 …" found — not a Spec Kit tasks.md'] };
  return { rows, unmapped, inferred, errors: [] };
}

function read(format, text) {
  if (format === 'ralph') return readRalph(text);
  if (format === 'spec-kit') return readSpecKit(text);
  return { rows: [], unmapped: [], inferred: [], errors: [`unknown format "${format}" — one of ${FORMATS.join(', ')}`] };
}

/** The board text. `key` is the board's module key (the output file's base name); `source` the path shown in the header. */
function render({ key, format, source, date }, result) {
  const out = [];
  out.push(`# ${key} — build board`);
  out.push('');
  out.push(`_Started: ${date} ${CONFIRM} (import date, not the run's) · Track: **IMPORTED** · Brief: imported from ${format} ${source} · Plan: — · State: —_`);
  out.push('');
  out.push('<!-- progress:auto start -->');
  out.push('(computed by the board-progress script — never hand-edited)');
  out.push('<!-- progress:auto end -->');
  out.push('');
  out.push(`## P0 — Imported from ${format}`);
  out.push('');
  out.push(HEADER);
  out.push(SEPARATOR);
  for (const r of result.rows) out.push(`| ${cell(r.id)} | ${cell(r.task)} | ${cell(r.cites)} | ${cell(r.status)} | ${cell(r.evidence)} | ${cell(r.notes)} |`);
  out.push('');
  out.push('## Inferred');
  out.push('');
  if (result.inferred.length === 0) out.push('- none: every cell above is as the source states it');
  for (const i of result.inferred) out.push(`- ${CONFIRM} ${i}`);
  out.push('');
  out.push('## Unmapped');
  out.push('');
  if (result.unmapped.length === 0) out.push('- none: every source line became a row');
  for (const u of result.unmapped) out.push(`- line ${u.line}: ${u.text.replace(/\r?\n/g, ' ')}`);
  out.push('');
  return out.join('\n');
}

/** The one-line summary the command prints. */
function summary(result) {
  const done = result.rows.filter((r) => r.status === 'DONE');
  const noEvidence = done.filter((r) => r.evidence === '—');
  return `${result.rows.length} row(s) · ${done.length} DONE · ${noEvidence.length} DONE with no test named (check-ledgers reports each under LG-5) · ${result.unmapped.length} unmapped line(s) · ${result.inferred.length} inferred`;
}

module.exports = { FORMATS, CONFIRM, HEADER, read, readRalph, readSpecKit, render, summary };
