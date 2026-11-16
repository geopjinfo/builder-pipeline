'use strict';
/**
 * The spec authoring stage — its checker and the pure half of what it feeds forward.
 *
 * WHY. The pipeline starts at Phase 1 from a brief, and the brief points at "the requirements oracle (profile §3)".
 * In a project that has none, the planner reads intent out of a chat message and invents the rows, the criteria
 * and the routes as it goes; the reviewer's requirements-alignment audit then compares code against a plan the same
 * run wrote. Nothing upstream was ever ratified by a person. The spec stage puts one ratified file ahead of the
 * run — `<paths.spec.dir>/<key>.spec.md` — holding the intent, the requirement rows, the acceptance criteria and
 * the API contract, and refuses to let Phase 1 start on a draft.
 *
 * Checks: the fixed sections in order · `Module:` and `Status: draft | ratified` lines · the verbatim table headers ·
 * requirement ids of the configured shape, unique, each with a Kind from the closed set and a non-empty Source ·
 * at least one refusal (a spec that only says what succeeds proves routing) · every requirement has a criterion;
 * every criterion names a requirement row · criterion verbs from the closed set (the run adds `skipped`); `by-design`
 * cites a decision the workspace holds; `gap` cites a deferred-registry row · the API contract is an OpenAPI 3
 * document (the contract oracle reads it) whose every operation lists `x-req` ids that exist and declares a 4xx;
 * every non-constraint requirement is reached by an operation (or the spec says "No API contract — <reason>") ·
 * amendments carry `pending` / `accepted <decision>` / `dropped — <reason>` · before ratification: no `<…>`
 * placeholder in prose, no pending amendment, no unanswered question, a named ratifier.
 *
 * Pure over text and injected context; `scripts/spec-check.mjs` does the I/O.
 */
const openapi3 = require('../../oracles/openapi3.cjs');

const SECTIONS = ['Intent', 'Scope', 'Actors', 'Requirements', 'Acceptance criteria', 'API contract', 'Oracle amendments', 'Open questions'];
const REQ_HEADER = '| Id | Requirement | Actor | Kind | Source |';
const AC_HEADER = '| Id | Req | Verb | Given | When | Then |';
const AMEND_HEADER = '| Oracle | Entry | Why | Decision |';
const QUESTION_HEADER = '| Id | Question | Blocks | Answer |';
const KINDS = ['behaviour', 'refusal', 'effect', 'constraint'];
const VERBS = ['assert', 'by-design', 'gap'];
const DEFAULT_ID = 'REQ-\\d+';
const DEFAULT_DECISION_ID = 'D-\\d+';
const DEFAULT_REGISTRY_ID = '[A-Z][A-Z0-9]{1,8}-D\\d+[a-z]?';
const NO_CONTRACT = /^No API contract\s*[—-]+\s*\S/m;
const CONTRACT_BLOCK = /```json api-contract\r?\n([\s\S]*?)\r?\n```/;

const idRegex = (source, flags = 'g') => new RegExp(`(?<![\\w-])(?:${source})(?![\\w-])`, flags);
const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
const isSeparator = (line) => /^\|?\s*:?-{3,}/.test(line.trim());

/** The body of `## <name>` up to the next `## ` heading, as lines. */
function sectionLines(lines, name) {
  const start = lines.findIndex((l) => l.trim() === `## ${name}`);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (/^## /.test(lines[i])) { end = i; break; }
  return lines.slice(start + 1, end);
}

/** The first table in a section: its header line and its data rows (as cell arrays). */
function table(sectionBody) {
  if (!sectionBody) return { header: null, rows: [] };
  const at = sectionBody.findIndex((l) => l.trim().startsWith('|'));
  if (at === -1) return { header: null, rows: [] };
  const header = sectionBody[at].trim();
  const rows = [];
  for (let i = at + 1; i < sectionBody.length; i++) {
    const l = sectionBody[i];
    if (!l.trim().startsWith('|')) break;
    if (isSeparator(l)) continue;
    rows.push(cells(l));
  }
  return { header, rows };
}

/** Parse a spec into its parts. Never throws; a malformed part is null and the checker reports it. */
function parseSpec(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const line = (re) => (lines.map((l) => l.match(re)).find(Boolean) || [])[1];
  const title = line(/^# Spec\s*[—-]+\s*[^:]+:\s*(.+)$/) || line(/^# (.+)$/) || '';
  const module = line(/^Module:\s*(\S+)/);
  const status = line(/^Status:\s*(\S+)/);
  const ratifiedBy = line(/^Ratified-by:\s*(.*)$/);
  const sections = Object.fromEntries(SECTIONS.map((s) => [s, sectionLines(lines, s)]));
  const req = table(sections.Requirements);
  const ac = table(sections['Acceptance criteria']);
  const amendments = table(sections['Oracle amendments']);
  const questions = table(sections['Open questions']);
  const contractSection = (sections['API contract'] || []).join('\n');
  const m = contractSection.match(CONTRACT_BLOCK);
  let contract = null;
  let contractError = null;
  if (m) {
    try { contract = JSON.parse(m[1]); } catch (e) { contractError = e.message; }
  }
  const noContract = NO_CONTRACT.test(contractSection);
  return { lines, title: title.trim(), module, status, ratifiedBy, sections, req, ac, amendments, questions, contract, contractRaw: m ? m[1] : null, contractError, noContract };
}

/** `METHOD /template` → the operation objects, in document order. */
function operationsOf(contract) {
  const ops = [];
  for (const [template, item] of Object.entries(contract?.paths ?? {})) {
    if (!item || typeof item !== 'object') continue;
    for (const method of ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']) {
      if (item[method] && typeof item[method] === 'object') ops.push({ method: method.toUpperCase(), template, op: item[method] });
    }
  }
  return ops;
}

/**
 * @param {string} text
 * @param {{ idPattern?: string, decisionIds: Set<string>, registryIds: Set<string>, decisionIdPattern?: string,
 *           registryIdPattern?: string, requireRatified?: boolean, lenient?: boolean }} ctx
 *   `lenient`: the shipped template is checked with it — a placeholder id (`REQ-00n`) or decision is not an error.
 * @returns {{ errors: string[], pending: string[], status: string|undefined, module: string|undefined }}
 */
function checkSpec(text, ctx) {
  const errors = [];
  const pending = [];
  const p = parseSpec(text);
  const idPattern = ctx.idPattern || DEFAULT_ID;
  const decisionIdPattern = ctx.decisionIdPattern || DEFAULT_DECISION_ID;
  const registryIdPattern = ctx.registryIdPattern || DEFAULT_REGISTRY_ID;
  const decisionIds = ctx.decisionIds || new Set();
  const registryIds = ctx.registryIds || new Set();
  const lenient = Boolean(ctx.lenient);
  const isPlaceholder = (s) => /<[^>]*>/.test(s);

  if (!p.module) errors.push('missing line: Module: <module key>');
  if (!['draft', 'ratified'].includes(p.status)) errors.push(`missing or invalid line: Status: draft or ratified (got ${JSON.stringify(p.status ?? null)})`);

  // Sections present and in order.
  const starts = SECTIONS.map((s) => p.lines.findIndex((l) => l.trim() === `## ${s}`));
  SECTIONS.forEach((s, i) => { if (starts[i] === -1) errors.push(`missing section: ## ${s}`); });
  let last = -1;
  SECTIONS.forEach((s, i) => {
    if (starts[i] === -1) return;
    if (starts[i] < last) errors.push(`section out of order: ## ${s}`);
    last = Math.max(last, starts[i]);
  });

  // Requirements.
  const reqIds = new Set();
  const reqs = [];
  if (p.sections.Requirements) {
    if (p.req.header !== REQ_HEADER) errors.push(`## Requirements: header must be ${REQ_HEADER} (got ${p.req.header ?? 'no table'})`);
    else {
      for (const r of p.req.rows) {
        const [id, requirement, actor, kind, source] = r;
        if (!id) continue;
        const idOk = idRegex(idPattern, '').test(id) && new RegExp(`^(?:${idPattern})$`).test(id);
        if (!idOk && !(lenient && isPlaceholder(id))) errors.push(`${id}: id does not match ${idPattern}`);
        if (reqIds.has(id)) errors.push(`${id}: duplicate requirement id`);
        reqIds.add(id);
        if (!KINDS.includes(kind) && !(lenient && isPlaceholder(kind))) errors.push(`${id}: Kind must be one of ${KINDS.join(' | ')} (got ${JSON.stringify(kind ?? '')})`);
        if (!source) errors.push(`${id}: Source is empty — name the intent, a decision or a question`);
        reqs.push({ id, requirement, actor, kind, source });
      }
      if (reqs.length > 0 && !reqs.some((r) => r.kind === 'refusal') && !lenient) {
        errors.push('no refusal requirement — a spec that only says what succeeds proves routing, not a rule');
      }
    }
  }

  // Acceptance criteria.
  const covered = new Set();
  const acIds = new Set();
  const acs = [];
  if (p.sections['Acceptance criteria']) {
    if (p.ac.header !== AC_HEADER) errors.push(`## Acceptance criteria: header must be ${AC_HEADER} (got ${p.ac.header ?? 'no table'})`);
    else {
      for (const r of p.ac.rows) {
        const [id, req, verb, given, when, then] = r;
        if (!id) continue;
        if (acIds.has(id)) errors.push(`${id}: duplicate criterion id`);
        acIds.add(id);
        if (!reqIds.has(req)) errors.push(`${id}: ${req} is not a requirement row`);
        else covered.add(req);
        if (!VERBS.includes(verb) && !(lenient && isPlaceholder(verb))) errors.push(`${id}: Verb must be one of ${VERBS.join(' | ')} (got ${JSON.stringify(verb ?? '')})`);
        if (!given || !when || !then) errors.push(`${id}: Given, When and Then are all required`);
        const thenText = then || '';
        if (verb === 'by-design') {
          const cited = [...thenText.matchAll(idRegex(decisionIdPattern))].map((m) => m[0]);
          if (cited.length === 0) errors.push(`${id}: by-design must cite the decision it follows`);
          for (const d of cited) if (!decisionIds.has(d) && !lenient) errors.push(`${id}: ${d} is not in the decision workspace`);
        }
        if (verb === 'gap') {
          const cited = [...thenText.matchAll(idRegex(registryIdPattern))].map((m) => m[0]);
          if (cited.length === 0) errors.push(`${id}: gap must cite the deferred-registry row that knows it`);
          for (const d of cited) if (!registryIds.has(d) && !lenient) errors.push(`${id}: ${d} is not a deferred-registry row`);
        }
        acs.push({ id, req, verb, given, when, then });
      }
      for (const r of reqs) if (!covered.has(r.id)) errors.push(`${r.id}: no acceptance criterion`);
    }
  }

  // API contract.
  const reached = new Set();
  if (p.sections['API contract']) {
    if (!p.contractRaw && !p.noContract) {
      errors.push('## API contract: one ```json api-contract block, or the line "No API contract — <reason>"');
    } else if (p.contractRaw && p.contractError) {
      errors.push(`## API contract: not JSON — ${p.contractError}`);
    } else if (p.contract) {
      if (!/^3\./.test(String(p.contract.openapi ?? ''))) errors.push('## API contract: "openapi" must be 3.x (the contract oracle reads OpenAPI 3)');
      const ops = operationsOf(p.contract);
      if (ops.length === 0 && !lenient) errors.push('## API contract: no operations under "paths"');
      for (const { method, template, op } of ops) {
        const name = `${method} ${template}`;
        const xreq = Array.isArray(op['x-req']) ? op['x-req'] : [];
        if (xreq.length === 0) errors.push(`${name}: x-req must list the requirement ids it serves`);
        for (const id of xreq) {
          if (!reqIds.has(id)) errors.push(`${name}: x-req names ${id}, which is not a requirement row`);
          else reached.add(id);
        }
        const statuses = Object.keys(op.responses ?? {});
        if (!statuses.some((s) => /^4(\d\d|XX)$/i.test(s))) errors.push(`${name}: declares no 4xx response — every operation can be refused`);
      }
      for (const r of reqs) {
        if (r.kind !== 'constraint' && !reached.has(r.id) && !(lenient && isPlaceholder(r.id))) {
          errors.push(`${r.id}: no operation in the contract lists it in x-req (only a constraint may stand outside the contract)`);
        }
      }
    }
  }

  // Oracle amendments.
  if (p.sections['Oracle amendments'] && p.amendments.header !== null) {
    if (p.amendments.header !== AMEND_HEADER) errors.push(`## Oracle amendments: header must be ${AMEND_HEADER}`);
    else {
      for (const [, entry, , decision] of p.amendments.rows) {
        if (!entry) continue;
        const d = (decision || '').trim();
        if (/^pending$/i.test(d)) pending.push(`${entry}: amendment still pending`);
        else if (/^accepted\s+\S/.test(d)) {
          const id = d.replace(/^accepted\s+/, '').trim();
          if (!decisionIds.has(id) && !lenient) errors.push(`${entry}: ${id} is not in the decision workspace`);
        } else if (/^dropped\s*[—-]+\s*\S/.test(d)) { /* fine */ } else if (!(lenient && isPlaceholder(d))) {
          errors.push(`${entry}: Decision must be pending, accepted <decision id> or dropped — <reason> (got ${JSON.stringify(d)})`);
        }
      }
    }
  }

  // Open questions.
  if (p.sections['Open questions'] && p.questions.header !== null) {
    if (p.questions.header !== QUESTION_HEADER) errors.push(`## Open questions: header must be ${QUESTION_HEADER}`);
    else for (const [id, , , answer] of p.questions.rows) if (id && !(answer || '').trim()) pending.push(`${id}: unanswered`);
  }

  // Ratification: prose placeholders (outside the contract block) and the ratifier.
  const prose = String(text).replace(CONTRACT_BLOCK, '');
  const placeholders = new Set();
  for (const m of prose.matchAll(/<[^<>\n]{1,60}>/g)) placeholders.add(m[0]);
  for (const ph of placeholders) pending.push(`placeholder left: ${ph}`);
  if (!p.ratifiedBy || /^[—-]*$/.test(p.ratifiedBy.trim()) || isPlaceholder(p.ratifiedBy)) pending.push('Ratified-by: name the person who ratified it');

  if (p.status === 'ratified') errors.push(...pending);
  if (ctx.requireRatified && p.status === 'draft') errors.push('Status is draft — a person ratifies the spec before Phase 1');

  return { errors, pending: p.status === 'ratified' ? [] : pending, status: p.status, module: p.module, parsed: p, reqs, acs };
}

/** The contract as the contract oracle sees it: the document and its compiled operations. */
function contractOf(text) {
  const p = parseSpec(text);
  if (!p.contract) return { document: null, operations: [] };
  return { document: p.contract, operations: openapi3.compileOperations(p.contract) };
}

/** The requirement-pack skeleton (templates/requirement-pack.md shape), one step per criterion. */
function packSkeleton(text) {
  const p = parseSpec(text);
  const reqs = new Map(p.req.rows.filter((r) => r[0]).map((r) => [r[0], { kind: r[3] }]));
  const steps = p.ac.rows.filter((r) => r[0] && r[1]).map(([id, req, verb, given, when, then]) => ({ id, req, verb, given, when, then, kind: reqs.get(req)?.kind }));
  const label = (s) => {
    const cite = (re) => (String(s.then).match(re) || [])[0];
    if (s.verb === 'by-design') return `${s.req} [by-design ${cite(idRegex(DEFAULT_DECISION_ID, '')) || '<decision>'}]: ${s.then}`;
    if (s.verb === 'gap') return `${s.req} [known-gap ${cite(idRegex(DEFAULT_REGISTRY_ID, '')) || '<registry row>'}]: ${s.then}`;
    return `${s.req}: ${s.then}`;
  };
  const line = (s) => `    ${s.verb.padEnd(9)} ${label(s)}\n      # ${s.id} · given ${s.given} · when ${s.when}`;
  const group = (title, list) => (list.length ? [`    ── ${title} ${'─'.repeat(Math.max(4, 44 - title.length))}`, ...list.map(line)] : []);
  const happy = steps.filter((s) => s.kind === 'behaviour');
  const refusals = steps.filter((s) => s.kind === 'refusal' || s.kind === 'constraint');
  const effects = steps.filter((s) => s.kind === 'effect');
  const other = steps.filter((s) => !happy.includes(s) && !refusals.includes(s) && !effects.includes(s));
  return [
    `pack ${p.module || '<module>'}:`,
    `  journey "${p.title || '<business flow>'}":`,
    ...group('happy path', happy),
    ...group('refusals (the point)', refusals),
    ...group('effects (a 2xx proves routing, not behaviour)', effects),
    ...group('other', other),
    '',
  ].join('\n');
}

const csvCell = (s) => (/[",\n]/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : String(s));

/** One CSV row per requirement — the tracker rows the profile's §3 "requirements tracker" oracle can hold. */
function rowsCsv(text, specPath = '') {
  const p = parseSpec(text);
  const criteria = new Map();
  for (const [id, req] of p.ac.rows) if (id && req) criteria.set(req, [...(criteria.get(req) || []), id]);
  const ops = new Map();
  for (const { method, template, op } of operationsOf(p.contract)) {
    for (const id of Array.isArray(op['x-req']) ? op['x-req'] : []) ops.set(id, [...(ops.get(id) || []), `${method} ${template}`]);
  }
  const out = ['id,requirement,actor,kind,source,criteria,operations,spec'];
  for (const [id, requirement, actor, kind, source] of p.req.rows) {
    if (!id) continue;
    out.push([id, requirement, actor, kind, source, (criteria.get(id) || []).join(' '), (ops.get(id) || []).join(' '), specPath].map(csvCell).join(','));
  }
  return out.join('\n') + '\n';
}

module.exports = {
  SECTIONS, REQ_HEADER, AC_HEADER, AMEND_HEADER, QUESTION_HEADER, KINDS, VERBS, DEFAULT_ID,
  parseSpec, checkSpec, contractOf, packSkeleton, rowsCsv,
};
