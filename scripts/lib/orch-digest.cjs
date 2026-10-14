'use strict';
/**
 * Plan intake — digest a plan artifact a person hands over (markdown or HTML, any shape) into the plan table that
 * `orch split` reads (templates/orchestrator-plan.md).
 *
 * WHY. People write plans as boards, bullet lists, tables with their own headers, or pages. Asking for the template
 * shape first moves work onto the person; guessing the missing cells silently moves risk onto the run — a row
 * mis-levelled from Full to Standard skips the auditors it needed. So the digest keeps what the artifact STATES and
 * marks everything it INFERS, and the split refuses until every inference is resolved.
 *
 * It never guesses silently:
 *   - a row is a table row (under a header with an id or title column), an id-prefixed bullet anywhere, or a plain
 *     bullet under a task-like heading (Tasks, Work, Rows, Items, Scope, Deliverables, Backlog, Steps, Actions);
 *   - what the artifact STATES (an id, a path, a kind or flags column, "after X") is kept as written;
 *   - what digest INFERS (a kind from the wording, files from a module name, a flag from a keyword) is recorded in
 *     the row's confirm cell as ⚠ CONFIRM, and a row naming no file gets files ⚠ CONFIRM;
 *   - a row whose stated status says it is finished (DONE, DROPPED, MERGED, …) is not work and is listed unmapped;
 *   - every non-blank artifact line that did not become a row is listed under "## Unmapped" with its line number.
 * `orch split` refuses a plan while any row is still ⚠ CONFIRM (orch-plan.cjs). The orchestrator resolves each one
 * (search the project's sources → decide → record), asks the human only what no source settles, and gets the
 * human's OK on the split before `orch init`.
 *
 * Pure: the caller hands in the text, the path roots, the module list and an exists() probe.
 */

const CONFIRM = '⚠ CONFIRM';
const FINISHED = /^\W*(done|dropped|merged|closed|cancel+ed|superseded|withdrawn)\b/i;
const TASK_HEADING = /\b(tasks?|rows?|work|items?|scope|deliverables?|backlog|to-?dos?|steps?|actions?)\b/i;
const ID = '[A-Za-z][A-Za-z0-9]*-\\d+[a-z]?|[A-Z]{1,3}\\d+[a-z]?';
const ID_BULLET = new RegExp(`^\\*{0,2}\\s*(${ID})\\s*\\*{0,2}\\s*(?:[:.)]|—|–|-)\\s*(.+)$`);
const BULLET = /^(\s*)(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/;
const DEP_RE = new RegExp(`\\b(?:after|depends on|blocked by|needs)\\s+((?:${ID})(?:\\s*(?:,|and)\\s*(?:${ID}))*)`, 'gi');
const DEFAULT_ROOTS = ['src', 'lib', 'app', 'test', 'tests', 'docs', 'scripts', 'specs', 'tasks'];
const DEFAULT_ROOT_FILES = ['CHANGELOG.md', 'README.md', 'package.json'];

const KIND_WORDS = [
  ['fix', /\b(fix(es|ed)?|bug|broken|defect|regression|wrong)\b/i],
  ['rulings', /\b(ruling|rule on|decide|escalate)\b/i],
  ['record', /\b(record|ledger|registry|changelog|board|docs?|readme|wiki)\b/i],
];
const FLAG_WORDS = [
  ['money', /\b(money|payments?|refunds?|amounts?|currenc(y|ies)|budgets?|invoices?|billing|prices?)\b/i],
  ['workflow', /\b(transitions?|approv\w*|reject\w*|workflow|state machine|submit\w*)\b/i],
  ['migration', /\b(migrations?|schema|columns?)\b/i],
  ['permission', /\b(permissions?|grants?|rbac|roles?)\b/i],
  ['platform', /\b(platform|shared kernel|foundation)\b/i],
];

// ------------------------------------------------------------------------------------------------- html
function decode(s) {
  return s.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&');
}
const isHtml = (t) => /<\/?(html|body|ul|ol|li|h[1-6]|p|table|tr|td|div)\b/i.test(t);
function htmlToText(t) {
  return decode(
    t
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
      .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n, x) => `\n${'#'.repeat(Number(n))} ${x}\n`)
      .replace(/<li\b[^>]*>/gi, '\n- ')
      .replace(/<\/li>/gi, '\n')
      .replace(/<tr\b[^>]*>/gi, '\n|')
      .replace(/<\/t[dh]>/gi, ' |')
      .replace(/<t[dh]\b[^>]*>/gi, ' ')
      .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, '`$1`')
      .replace(/<br\s*\/?>|<\/?(p|div|ul|ol|table|thead|tbody|section|article)\b[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

// ------------------------------------------------------------------------------------------------ parse
const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
const isSep = (line) => /^\|?\s*:?-{2,}/.test(line.trim());
const listCell = (c) =>
  (c || '')
    .split(/[;,]/)
    .map((s) => s.trim().replace(/^`|`$/g, ''))
    .filter((s) => s && s !== '-' && s !== '—');
const COLS = {
  id: /^(id|#|key|ref|task id|no\.?)$/,
  title: /^(title|task|item|what|description|summary|name)$/,
  files: /(files?|paths?|scope|touches)/,
  dependsOn: /(depend|after|blocked|needs)/,
  source: /^(source|req|requirement|ticket|origin)/,
  kind: /^(kind|type)$/,
  flags: /^flags?$/,
  level: /^(level|track|pipeline)$/,
  status: /^(status|state)$/,
};

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function pathMatcher(roots, rootFiles) {
  const dirs = (roots && roots.length ? roots : DEFAULT_ROOTS).map(esc).join('|');
  const files = (rootFiles && rootFiles.length ? rootFiles : DEFAULT_ROOT_FILES).map(esc).join('|');
  return new RegExp(`(?:^|[\\s\`(;,'"])((?:${dirs})\\/[\\w.\\/*{}-]*[\\w*}]|(?:${files})(?![\\w.]))`, 'g');
}
function pathsIn(text, re) {
  const out = [];
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(text))) out.push(m[1].replace(/[.,;:)]+$/, ''));
  return [...new Set(out)];
}
function cleanTitle(t, re) {
  return t
    .replace(/\*\*/g, '')
    .replace(/`[^`]*`/g, (x) => (pathsIn(x, re).length ? '' : x.replace(/`/g, '')))
    .replace(/\(\s*\)/g, '')
    .replace(/,?\s*\b(after|depends on|blocked by)\s+[A-Za-z0-9 ,-]+$/i, '')
    .replace(/\s+/g, ' ')
    .replace(/[\s:;,—–-]+$/, '')
    .trim();
}

/** Collect candidate rows + unmapped lines from normalised text. */
function collect(text) {
  const lines = text.split(/\r?\n/);
  const rows = [];
  const unmapped = [];
  let heading = '';
  let inFence = false;
  let last = null; // the last bullet row, for indented sub-bullets
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const l = raw.trim();
    const n = i + 1;
    if (/^```/.test(l)) {
      inFence = !inFence;
      continue;
    }
    if (!l) continue;
    if (inFence) {
      unmapped.push({ line: n, text: l });
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(l);
    if (h) {
      heading = h[2];
      last = null;
      continue;
    }
    if (l.startsWith('|')) {
      const block = [];
      let j = i;
      while (j < lines.length && lines[j].trim().startsWith('|')) {
        block.push({ line: j + 1, text: lines[j].trim() });
        j++;
      }
      i = j - 1;
      last = null;
      const head = cells(block[0].text).map((c) => c.toLowerCase());
      const col = {};
      for (const [k, re] of Object.entries(COLS)) {
        const x = head.findIndex((c) => re.test(c));
        if (x !== -1 && !Object.values(col).includes(x)) col[k] = x;
      }
      if (col.id === undefined && col.title === undefined) {
        for (const b of block) unmapped.push(b);
        continue;
      }
      for (const b of block.slice(1)) {
        if (isSep(b.text)) continue;
        const c = cells(b.text);
        const get = (k) => (col[k] === undefined ? undefined : c[col[k]] || '');
        const title = get('title') ?? '';
        if (!title.trim() && !(get('id') || '').trim()) {
          unmapped.push(b);
          continue;
        }
        if (FINISHED.test(get('status') || '')) {
          unmapped.push({ ...b, text: `(status ${(get('status') || '').trim()}) ${b.text}` });
          continue;
        }
        rows.push({
          line: b.line,
          id: (get('id') || '').replace(/\*\*/g, '').trim(),
          text: title || c.join(' '),
          stated: { kind: get('kind'), files: get('files'), dependsOn: get('dependsOn'), source: get('source'), flags: get('flags'), level: get('level') },
        });
      }
      continue;
    }
    const b = BULLET.exec(raw);
    if (b) {
      const indent = b[1].length;
      const body = b[2].trim();
      if (last && indent >= 2 && indent > last.indent) {
        last.text += ` ${body}`;
        last.lines.push(n);
        continue;
      }
      const m = ID_BULLET.exec(body);
      if (m) {
        last = { line: n, id: m[1], text: m[2], stated: {}, indent, lines: [n] };
        rows.push(last);
        continue;
      }
      if (TASK_HEADING.test(heading)) {
        last = { line: n, id: '', text: body, stated: {}, indent, lines: [n] };
        rows.push(last);
        continue;
      }
      last = null;
      unmapped.push({ line: n, text: l });
      continue;
    }
    if (/^[a-z][a-z-]*:\s/.test(l) && !rows.length) continue; // a plan's own `key: value` header lines
    last = null;
    unmapped.push({ line: n, text: l });
  }
  return { rows, unmapped };
}

// ------------------------------------------------------------------------------------------------ infer
/**
 * @param {string} input  the artifact (markdown or HTML)
 * @param {object} o
 *   source      the artifact's name, for row provenance
 *   run, title  header lines for the rendered plan
 *   roots       top-level directories a path may start with (the CLI passes the repo's own)
 *   rootFiles   top-level files a bare name may refer to
 *   sourceRoots production-source roots (features.orchestrator.sourceRoots): a record row there is not record-only
 *   modules     module names whose mention infers files (with modulesDir)
 *   modulesDir  the directory holding one folder per module (e.g. "src/modules"); null = no module inference
 *   exists(p)   does a repo-relative path exist (a named path that does not is a CONFIRM)
 */
function digest(input, { source = '', run = '', title = '', roots, rootFiles, sourceRoots = ['src/'], modules = [], modulesDir = null, exists = () => true } = {}) {
  const { isUnder } = require('./orch-plan.cjs');
  const inSrc = (list) => list.some((f) => isUnder(f, sourceRoots));
  const text = isHtml(input) ? htmlToText(input) : input;
  const re = pathMatcher(roots, rootFiles);
  const { rows: cand, unmapped } = collect(text);
  const docTitle = title || ((/^#\s+(.+)$/m.exec(text) || [])[1] || '').trim();
  let gen = 0;
  const taken = new Set(cand.map((r) => r.id).filter(Boolean));
  const rows = cand.map((c) => {
    let id = c.id;
    if (!id) {
      do {
        gen++;
        id = `D${gen}`;
      } while (taken.has(id));
      taken.add(id);
    }
    const all = c.text;
    const confirm = [];
    let files;
    if (c.stated.files !== undefined && listCell(c.stated.files).length) files = listCell(c.stated.files).map((p) => p.replace(/\\/g, '/'));
    else files = pathsIn(all, re);
    if (!files.length && modulesDir) {
      const hit = modules.filter((m) => new RegExp(`\\b${esc(m).replace(/-/g, '[- ]?')}\\b`, 'i').test(all));
      for (const m of hit) {
        const p = `${modulesDir.replace(/\/+$/, '')}/${m}/**`;
        files.push(p);
        confirm.push(`files: ${p} inferred from "${m}"`);
      }
    }
    if (!files.length) {
      files = [CONFIRM];
      confirm.push('files: none named in the artifact — name the files this row touches');
    }
    for (const f of files) if (f !== CONFIRM && !/[*?{]/.test(f) && !exists(f)) confirm.push(`files: ${f} does not exist — a new file, or a typo?`);
    let kind = (c.stated.kind || '').trim().toLowerCase();
    if (!kind) {
      const k = KIND_WORDS.find(([name, kre]) => kre.test(all) && !(name === 'record' && inSrc(files)));
      kind = k ? k[0] : 'build';
      confirm.push(`kind: ${kind} inferred from the wording`);
    }
    if (!['build', 'fix', 'rulings', 'record'].includes(kind)) {
      confirm.push(`kind: "${kind}" is not build|fix|rulings|record`);
      kind = 'build';
    }
    let flags;
    if (c.stated.flags !== undefined) flags = listCell(c.stated.flags).map((f) => f.toLowerCase());
    else {
      flags = [];
      for (const [name, fre] of FLAG_WORDS) {
        const m = fre.exec(all);
        if (m) {
          flags.push(name);
          confirm.push(`flags: ${name} inferred from "${m[0]}"`);
        }
      }
      if (kind === 'record' && !inSrc(files)) flags.push('record-only');
    }
    const deps = [];
    if (c.stated.dependsOn !== undefined) deps.push(...listCell(c.stated.dependsOn));
    else {
      let m;
      DEP_RE.lastIndex = 0;
      while ((m = DEP_RE.exec(all))) deps.push(...m[1].split(/\s*(?:,|and)\s*/).filter(Boolean));
    }
    return {
      id,
      title: cleanTitle(c.text, re) || id,
      source: (c.stated.source || '').trim() || `${source}:L${c.line}`,
      kind,
      files,
      dependsOn: [...new Set(deps)],
      flags: [...new Set(flags)],
      level: (c.stated.level || '').trim(),
      confirm,
    };
  });
  const ids = new Set(rows.map((r) => r.id));
  for (const r of rows) {
    const bad = r.dependsOn.filter((d) => !ids.has(d));
    if (bad.length) {
      r.confirm.push(`depends-on: ${bad.join(', ')} is not a row of this plan`);
      r.dependsOn = r.dependsOn.filter((d) => ids.has(d));
    }
  }
  const res = { title: docTitle, run, source, rows, unmapped };
  res.markdown = render(res);
  return res;
}

// ----------------------------------------------------------------------------------------------- render
const cell = (s) => String(s).replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
function render({ title, run, source, rows, unmapped }) {
  const open = rows.filter((r) => r.confirm.length);
  const out = [
    `# Plan: ${title || source}`,
    `plan: ${title || source}`,
    ...(run ? [`run: ${run}`] : []),
    `source: ${source}`,
    `digest: orch digest ${new Date().toISOString().slice(0, 10)} — ${rows.length} row(s), ${open.length} with ⚠ CONFIRM, ${unmapped.length} unmapped line(s)`,
    '',
    '## Rows',
    '| id | title | source | kind | files | depends-on | flags | level | confirm |',
    '|---|---|---|---|---|---|---|---|---|',
    ...rows.map(
      (r) =>
        `| ${[
          r.id,
          cell(r.title),
          cell(r.source),
          r.kind,
          r.files.join('; '),
          r.dependsOn.join('; ') || '-',
          r.flags.join('; ') || '-',
          r.level,
          r.confirm.length ? `${CONFIRM}: ${cell(r.confirm.join(' · '))}` : '',
        ].join(' | ')} |`,
    ),
    '',
    '## Confirm',
    "Each item below was INFERRED, not stated. Resolve it (search the project's sources, decide, record), clear the row's confirm cell, then get the human's OK on `orch split`.",
    ...(open.length ? open.flatMap((r) => r.confirm.map((c) => `- ${r.id} · ${c}`)) : ['- none']),
    '',
    '## Unmapped',
    'Artifact lines that did not become a row — read each: a missed task becomes a row, background stays here.',
    ...(unmapped.length ? unmapped.map((u) => `- L${u.line}: ${u.text}`) : ['- none']),
    '',
  ];
  return out.join('\n');
}

const openRow = (r) => (r.confirm && r.confirm.includes('⚠')) || r.files.includes(CONFIRM);

/** Open CONFIRMs in a plan file (a digest output, possibly hand-edited). */
function check(text) {
  const { rows } = require('./orch-plan.cjs').parsePlan(text);
  const items = rows.filter(openRow).map((r) => ({ id: r.id, confirm: r.confirm || (r.files.includes(CONFIRM) ? 'files' : '') }));
  return { rows: rows.length, open: items.length, items };
}

module.exports = { digest, check, render, htmlToText, collect, openRow, CONFIRM, DEFAULT_ROOTS };
