'use strict';
/**
 * Fixed seat output formats: the plan, the auditors' findings and the reviewer's review each have ONE shape, and a
 * malformed one fails before the next seat reads it.
 *
 * WHY. Measured in one adopting project: plans varied from a handful of sections to several times that, and
 * reviews likewise, so every consumer re-derived where things were — and the records that went missing (a lost run
 * log, dropped probe results, a blocker nobody carried forward, a count that drifted between passes) went missing
 * in the variation. The pipeline already said "validate before you pass" for findings; nothing validated.
 *
 * WHAT IS PROJECT-SHAPED AND WHAT IS NOT. A plan's sections and its fixed table headers depend on the stack (a web
 * service has routes, a library has none), so they come from the profile (`features.planSchema`). The three
 * blocker classes, the findings schema and the review sections are the pipeline's own vocabulary and are fixed
 * here: every seat that consumes them is shipped with the pack.
 *
 * Pure over text and injected context; `scripts/output-check.mjs` does the I/O.
 */

const BLOCKER_CLASSES = ['DECIDED-FROM-DOCS', 'NEEDS-RULING', 'BLOCKING'];
const DEFAULT_TASK_COLUMNS = ['Task', 'Cites', 'Test-seed'];

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const cellsOf = (line) => line.split(/(?<!\\)\|/).slice(1, -1).map((c) => c.trim());
const norm = (header) => cellsOf(header).join(' | ');
const isTableLine = (l) => l.trim().startsWith('|');
const isSeparator = (l) => /^\s*\|\s*:?-{2,}/.test(l);

/** A section heading: `## Name`, `### 3. Name`, `## 0a. Name` — the name must end at a non-word character. */
const sectionPattern = (name) => new RegExp(`^#{2,3}\\s*(?:\\d+[a-z]?\\.\\s*)?${escape(name)}(?!\\w)`, 'im');

/**
 * @param {string} text
 * @param {{
 *   sections?: string[],                       required section names, any order
 *   tables?: Record<string, string>,           { name: "| A | B |" } — each fixed header must appear verbatim (cell-normalised)
 *   taskColumns?: string[],                    columns the Tasks table must carry (checked when "Tasks" is a required section)
 *   oracle?: { table: string, column: string } | null,
 *   oracleKeys?: Set<string>,                  the key column of the oracle's source, loaded by the caller
 * }} schema
 * @returns {string[]} errors
 */
function checkPlan(text, schema = {}) {
  const errors = [];
  const lines = text.split(/\r?\n/);
  const sections = schema.sections ?? [];
  for (const name of sections) if (!sectionPattern(name).test(text)) errors.push(`missing section: ${name}`);

  const headers = lines.filter(isTableLine).map(norm);
  for (const [name, header] of Object.entries(schema.tables ?? {})) {
    if (!headers.includes(norm(header))) errors.push(`no ${name} table with the fixed header ${header}`);
  }

  if (schema.oracle) {
    const { table, column } = schema.oracle;
    const header = schema.tables?.[table];
    if (!header) errors.push(`oracle: features.planSchema.tables has no "${table}" table to read the ${column} column from`);
    else {
      const col = cellsOf(header).indexOf(column);
      const at = lines.findIndex((l) => isTableLine(l) && norm(l) === norm(header));
      if (col === -1) errors.push(`oracle: the ${table} header ${header} has no "${column}" column`);
      else if (at !== -1 && schema.oracleKeys) {
        for (let i = at + 1; i < lines.length && isTableLine(lines[i]); i += 1) {
          if (isSeparator(lines[i])) continue;
          const key = (cellsOf(lines[i])[col] ?? '').replace(/`/g, '').trim();
          if (!key) errors.push(`${table} row ${i + 1}: no ${column}`);
          else if (!schema.oracleKeys.has(key)) errors.push(`${table} row ${i + 1}: ${column} "${key}" is not in the oracle — never invent a key`);
        }
      }
    }
  }

  // Every task row is worked test-first, and every row answers to a source — so the Tasks table must carry both
  // columns, whatever else a project's plan contains. A project can require more: adding "Files" to taskColumns
  // makes each row name the files it edits, which the reviewer holds the diff to.
  const taskColumns = schema.taskColumns ?? DEFAULT_TASK_COLUMNS;
  if (sections.includes('Tasks') && taskColumns.length > 0) {
    const found = lines.some((l) => isTableLine(l) && taskColumns.every((c) => cellsOf(l).includes(c)));
    if (!found) {
      const near = lines.find((l) => isTableLine(l) && cellsOf(l).includes('Task'));
      const missing = near ? taskColumns.filter((c) => !cellsOf(near).includes(c)) : [];
      errors.push(`no Tasks table with columns ${taskColumns.join(', ')}${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`);
    }
  }

  for (const cls of BLOCKER_CLASSES) if (!text.includes(cls)) errors.push(`BLOCKERS does not name the ${cls} class (write "none" under it when empty)`);
  return errors;
}

const SEVERITIES = new Set(['blocker', 'warning', 'nit']);
const VERDICTS = new Set(['PASS', 'CHANGES-REQUIRED', 'PASS-WITH-RULINGS']);
// any extension, digits too (.ps1, .mp4), and dotfiles (.gitignore); a path, never prose (no spaces)
const LOCATION = /^(?:[\w.@+-]+\/)*[\w@+-]*\.[\w.-]+:\d+(?:-\d+)?$/;

/**
 * @param {unknown} data  a parsed findings JSON file
 * @param {{ exists?(p:string):boolean, diffFiles?: Set<string> }} ctx
 * @returns {string[]} errors
 */
function checkFindings(data, ctx = {}) {
  const errors = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) return ['not a JSON object'];
  if (typeof data.seat !== 'string' || !data.seat) errors.push('seat: required');
  if (!VERDICTS.has(data.verdict)) errors.push(`verdict: one of ${[...VERDICTS].join(' | ')}`);
  if (!Array.isArray(data.findings)) return [...errors, 'findings: required array'];
  const ids = new Set();
  data.findings.forEach((f, i) => {
    const at = `findings[${i}]${f?.id ? ` (${f.id})` : ''}`;
    for (const field of ['id', 'severity', 'location', 'cite', 'claim', 'evidence']) {
      if (typeof f?.[field] !== 'string' || f[field].trim() === '') errors.push(`${at}.${field}: required, non-empty`);
    }
    if (f?.id && ids.has(f.id)) errors.push(`${at}.id: duplicate`);
    ids.add(f?.id);
    if (f?.severity && !SEVERITIES.has(f.severity)) errors.push(`${at}.severity: one of blocker | warning | nit`);
    if (f?.location && (!LOCATION.test(f.location) || /(^|\/)\.\.(\/|$)/.test(f.location))) errors.push(`${at}.location: must be file:line, got "${f.location}"`);
    else if (f?.location && ctx.exists && !ctx.exists(f.location.replace(/:\d+(?:-\d+)?$/, ''))) errors.push(`${at}.location: ${f.location} — the file does not exist`);
  });
  // PASS-WITH-RULINGS is a pass (the reviewer persona says so) — a blocker under it is the same contradiction
  if ((data.verdict === 'PASS' || data.verdict === 'PASS-WITH-RULINGS') && data.findings.some((f) => f?.severity === 'blocker')) errors.push(`verdict ${data.verdict} with a blocker finding`);
  if (data.filesTouched !== undefined) {
    if (!Array.isArray(data.filesTouched)) errors.push('filesTouched: array');
    else if (ctx.diffFiles) {
      for (const p of data.filesTouched) if (!ctx.diffFiles.has(String(p).replace(/\\/g, '/'))) errors.push(`filesTouched: "${p}" is not in the git diff — a claimed change nobody can see`);
    }
  }
  if (data.commands !== undefined && (!Array.isArray(data.commands) || data.commands.some((c) => typeof c?.cmd !== 'string' || typeof c?.result !== 'string'))) {
    errors.push('commands: array of { cmd, result } — the command and the result line it printed');
  }
  return errors;
}

const REVIEW_SECTIONS = ['Verdict', 'Readiness', 'Requirement traceability', 'Invariant candidates', 'Findings (ranked)', 'Loop-back list', 'Merge conditions'];

/** @param {string} text  @returns {string[]} errors */
function checkReview(text) {
  const errors = [];
  const src = text.replace(/\r\n/g, '\n');
  if (!/^# .+ — review pass \d+\s*$/m.test(src)) errors.push('title: "# <moduleKey> — review pass <n>"');
  const headings = src.split('\n').filter((l) => /^## /.test(l)).map((l) => l.replace(/^## /, '').trim());
  let last = -1;
  for (const s of REVIEW_SECTIONS) {
    const at = headings.findIndex((h) => h === s);
    if (at === -1) errors.push(`missing section: ## ${s}`);
    else if (at < last) errors.push(`section out of order: ## ${s}`);
    else last = at;
  }
  const verdict = /^## Verdict[ \t]*\n+\*\*(MERGE-READY|CHANGES-REQUIRED)\*\*/m.exec(src);
  if (!verdict) errors.push('## Verdict must open with **MERGE-READY** or **CHANGES-REQUIRED**');
  const findings = src.split(/^## Findings \(ranked\)[ \t]*$/m)[1]?.split(/^## /m)[0] ?? '';
  findings
    .split('\n')
    .filter((l) => /^###\s/.test(l))
    .forEach((l) => {
      if (!/\b(BLOCKER|WARNING|NIT)\b/.test(l) || !/[\w./-]+\.[\w-]+:\d+/.test(l)) errors.push(`finding heading needs a severity and a file:line — "${l.trim().slice(0, 100)}"`);
    });
  if (verdict?.[1] === 'MERGE-READY' && /^###\s.*\bBLOCKER\b/m.test(findings)) errors.push('MERGE-READY with a BLOCKER finding');
  return errors;
}

/** Split one CSV line, honouring double-quoted cells. */
function csvCells(line) {
  const out = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"' && quoted && line[i + 1] === '"') {
      cell += '"';
      i += 1;
    } else if (ch === '"') quoted = !quoted;
    else if (ch === ',' && !quoted) {
      out.push(cell);
      cell = '';
    } else cell += ch;
  }
  out.push(cell);
  return out.map((c) => c.trim());
}

/** The values of one named column of a CSV — the oracle's key set. Throws when the column is absent. */
function csvColumn(csvText, column) {
  const rows = String(csvText).replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  const header = csvCells(rows[0] ?? '');
  const at = header.indexOf(column);
  if (at === -1) throw new Error(`the CSV has no "${column}" column (columns: ${header.join(', ')})`);
  return new Set(rows.slice(1).map((r) => csvCells(r)[at] ?? '').filter(Boolean));
}

module.exports = { checkPlan, checkFindings, checkReview, csvCells, csvColumn, REVIEW_SECTIONS, BLOCKER_CLASSES, DEFAULT_TASK_COLUMNS };
