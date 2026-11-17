/**
 * `npx builder-pipeline run board-render <moduleKey|path>` — render a task board as a live run board.
 * (folder layout: node scripts/board-render.mjs in place of npx builder-pipeline run board-render)
 *
 * WHAT IT PRODUCES. `tasks/<key>.html`: one self-contained page showing what is green, what is
 * blocking, what happened so far, which files were produced, which seat did it, on which model,
 * for how long, and at what cost. No stylesheet, no script, no font, no image is loaded from
 * anywhere — so it opens from `file://` on an offline, air-gapped host.
 *
 * WHAT IT IS NOT. Not a second ledger. The markdown board is the git truth and this is a projection
 * of it joined to two other sources; where they disagree the markdown wins and this renderer is the
 * defect. The page says so in its own footer, because a reader who only ever opens the pretty one
 * needs to know which file to trust.
 *
 *   S1  tasks/<key>.md                     rows, phases, deferred, todo  (board-parse.cjs)
 *   S2  .pipeline/<key>/run.jsonl          steps, gates, findings, files (run-log.cjs)
 *   S3  ~/.claude/projects/<slug>/*.jsonl  model, wall, tokens per seat  (transcript-usage.cjs)
 *
 * S2 and S3 are optional. A historical board with neither still renders — every accounting cell an
 * em-dash. THAT IS THE POINT: absence renders as absence. A zero would be a measurement nobody took.
 * S3 is Claude Code's transcript layout; on any other harness every seat renders as unmeasured.
 *
 *   npx builder-pipeline run board-render tasks/<key>.md           write tasks/<key>.html
 *   npx builder-pipeline run board-render <key> --open             …and open it
 *   npx builder-pipeline run board-render --all                    every board carrying a run log
 *   npx builder-pipeline run board-render <key> --json [--out <dir>] [--limit <bytes>]
 *                                                          one JSON document per section (see page-docs.cjs)
 *   --transcripts <dir>                                    read S3 from <dir> instead of the harness default
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { runHint } = require('./lib/run-hint.cjs');
const { parseBoard } = require('./lib/board-parse.cjs');
const { splitDocs, PAGE_DOC_LIMIT } = require('./lib/page-docs.cjs');
const runLog = require('./lib/run-log.cjs');
const transcript = require('./lib/transcript-usage.cjs');
const pricing = require('./lib/pricing.cjs');
const profile = require('./lib/profile.cjs');

const DASH = '—';

/**
 * How often an open board re-reads itself. Short enough that a run reads as live, long enough that
 * a page left open overnight is not a spin loop. The reload is local — the file on disk is what
 * changed, and `board-watch` is what changed it.
 */
const REFRESH_SECONDS = 20;

/* ── formatting ─────────────────────────────────────────────────────────────────────────────── */

/** Board content is DATA. It becomes text on the page, never markup. */
const esc = (v) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** An absent value is an em-dash. Never `0`, never `$0.00`, never an empty cell. */
const or = (v) => (v === null || v === undefined || v === '' ? DASH : esc(v));

const thousands = (n) => (typeof n === 'number' && n > 0 ? n.toLocaleString('en-US').replace(/,/g, ' ') : DASH);
const tokens = (n) => (typeof n === 'number' && n > 0 ? `${Math.round(n / 1000).toLocaleString('en-US')} k` : DASH);
const usd = (n) => (typeof n === 'number' ? `$${n.toFixed(2)}` : DASH);

const duration = (ms) => {
  if (typeof ms !== 'number' || ms <= 0) return DASH;
  const min = Math.round(ms / 60_000);
  return min >= 60 ? `${Math.floor(min / 60)} h ${min % 60} m` : `${min} m`;
};

const clock = (iso) => (typeof iso === 'string' && iso.length >= 16 ? esc(iso.slice(11, 16)) : DASH);

/** Status vocabulary → a class. Unknown statuses get the neutral chip, not a green one. */
const tag = (status) => {
  const s = String(status ?? '').toUpperCase();
  if (!s || s === DASH) return DASH;
  const family = /^(DONE|GREEN|PASS|FRESH|NONE|SHIPPED|MERGE-READY|COMPLETED)/.test(s)
    ? 'ok'
    : /^(IN-PROGRESS|RUNNING|NEXT|IN REVIEW|REVIEW)/.test(s)
      ? 'run'
      : /^(WARNING|PARTIAL|QUEUED|PLANNED|FLAKY|DEFERRED|NOT RUN|PROPOSED)/.test(s)
        ? 'warn'
        : /^(BLOCKER|BLOCKED|FAIL|RED|ESCALATED|CHANGES|HUMAN|DROPPED)/.test(s)
          ? 'bad'
          : 'dim';
  return `<span class="tag ${family}">${esc(s)}</span>`;
};

const table = (columns, rows, opts = {}) => {
  if (rows.length === 0 && opts.empty) return `<p class="empty">${esc(opts.empty)}</p>`;
  const head = columns.map((c) => `<th${c.num ? ' class="num"' : ''}>${esc(c.label ?? c)}</th>`).join('');
  const body = rows
    .map((r) => `<tr${r.tone ? ` class="${r.tone}"` : ''}>${r.cells.join('')}</tr>`)
    .join('\n');
  const foot = opts.foot ? `<tfoot><tr>${opts.foot.join('')}</tr></tfoot>` : '';
  return `<div class="scroll"><table><thead><tr>${head}</tr></thead><tbody>\n${body}\n</tbody>${foot}</table></div>`;
};

const td = (v, cls = '') => `<td${cls ? ` class="${cls}"` : ''}>${v}</td>`;

/* ── sources ────────────────────────────────────────────────────────────────────────────────── */

/**
 * Resolve a board argument to `{ boardPath, key, root }`. A bare key resolves against the repo's
 * boards directory — `paths.boards` from §16, `tasks/` with no profile. A path is used as given, and
 * its root is the nearest ancestor that holds a profile or a `.pipeline/`, so a fixture board in a
 * temporary directory finds its own `.pipeline/` and profile, and not this repo's; with neither in
 * sight the grandparent stands in, which is the installer's default layout.
 */
function resolveBoard(arg) {
  // Run from the package (`builder run`), the script's own parent is the package, not the project:
  // BUILDER_PROJECT_ROOT names the project then.
  // Run from inside node_modules with no BUILDER_PROJECT_ROOT, the parent folder is the package: use the cwd then.
  // fileURLToPath, not URL.pathname: the pathname keeps percent-escapes, so a project under a folder with a space
  // (`%20`) or a Windows short name (`RUNNER~1` -> `%7E`) was looked for at a path that does not exist.
  const self = dirname(fileURLToPath(import.meta.url));
  const repoRoot = process.env.BUILDER_PROJECT_ROOT
    ? resolve(process.env.BUILDER_PROJECT_ROOT)
    : /(^|[\\/])node_modules[\\/]/.test(self) ? resolve(process.cwd()) : resolve(self, '..');
  const boardPath = arg.endsWith('.md') ? resolve(arg) : join(repoRoot, boardsDirOf(repoRoot), `${arg}.md`);
  const key = basename(boardPath, '.md');
  return { boardPath, key, root: rootOf(dirname(boardPath)) };
}

/** `paths.boards` for a root — the one place the boards directory is decided. */
function boardsDirOf(root) {
  return settingsFor(root).paths?.boards || 'tasks';
}

const rootOf = profile.rootOf;

const seatOf = (step, usage) => step.seat ?? usage.get(step.agentId ?? '')?.agentType ?? null;

/** The profile's settings for a root, or the defaults when there is no profile to read. */
function settingsFor(root) {
  try {
    return profile.load(root).settings;
  } catch {
    return profile.DEFAULTS;
  }
}

/**
 * The model the project declares the orchestrator should run on, or `null` if it declares none.
 * Read-only: this only ever reads the declaration.
 *
 * WHERE THE DECLARATION LIVES. First `models.orchestrator` in `PIPELINE_PROFILE.md` — the one file
 * that makes the pipeline concrete, and the same on every harness. Only when the profile declares
 * nothing does it fall back to the Claude Code install of the pipeline SKILL, whose phase table
 * carries an `orchestrator (this session)` row naming a model.
 *
 * WHY READ A DECLARATION RATHER THAN HOLD A CONSTANT HERE. A second copy of the expectation is a
 * second thing to drift. The declaration is where a reader looks to answer "what runs this?", and
 * this is the check.
 *
 * No declaration means no warning. That is deliberate: a missing expectation is not evidence of a
 * wrong model, and inventing one would manufacture the alarm rather than report it. An unfilled
 * placeholder (`<model id>`) is no declaration either.
 */
export function declaredOrchestratorModel(root) {
  const declared = settingsFor(root)?.models?.orchestrator;
  if (typeof declared === 'string' && declared.trim() !== '' && !/^<.*>$/.test(declared.trim())) return declared.trim();
  try {
    const skill = readFileSync(join(root, '.claude', 'skills', 'build-module-pipeline', 'SKILL.md'), 'utf8');
    const row = skill.split('\n').find((l) => /^\|.*orchestrator \(this session\)/i.test(l));
    return row ? (row.match(/`(claude-[a-z0-9-]+)`/)?.[1] ?? null) : null;
  } catch {
    return null;
  }
}

/** Join the run log's steps to the harness's own accounting. Unjoined steps keep empty columns. */
function accounting(steps, usage, orchModel = null, orchUsage = null) {
  const bySeat = new Map();
  const blank = (seat) => ({
    seat,
    model: null,
    steps: [],
    durationMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    priced: true,
    measured: false,
    status: null,
    cost: null,
    unpriced: false,
  });
  for (const step of steps) {
    const seat = seatOf(step, usage) ?? 'orchestrator';
    const u = step.agentId ? usage.get(step.agentId) : null;
    const row = bySeat.get(seat) ?? blank(seat);
    row.steps.push(step.id ?? '');
    /* `unmeasured`: a background dispatch whose own transcript is not on this machine. Its result
     * carried no usage, so counting it as zero tokens would be a `$0.00` nobody measured. */
    if (u && !u.unmeasured) {
      row.measured = true;
      row.model = u.model ?? row.model;
      row.durationMs += u.durationMs;
      row.inputTokens += u.inputTokens;
      row.outputTokens += u.outputTokens;
      row.cacheReadTokens += u.cacheReadTokens;
      row.cacheWriteTokens += u.cacheWriteTokens;
      row.cacheWrite5mTokens += u.cacheWrite5mTokens ?? 0;
      row.cacheWrite1hTokens += u.cacheWrite1hTokens ?? 0;
      row.status = u.status ?? row.status;
      const c = pricing.cost(u.model, u);
      if (c === null) row.unpriced = true;
      else row.cost = (row.cost ?? 0) + c;
    }
    bySeat.set(seat, row);
  }

  /* The orchestrator is the session itself, not a dispatch, so `collect()` holds no record of it.
   * Its model cell was once a permanent em-dash — which is how a declared orchestrator model can go
   * many runs unnoticed — and its tokens stayed empty even after the model was filled. The
   * orchestrator is typically one of the largest seats of a run, so its own non-sidechain turns in
   * this run's sessions and window are summed and priced model by model. */
  if (orchUsage || orchModel) {
    const row = bySeat.get('orchestrator') ?? blank('orchestrator');
    if (orchUsage) {
      row.measured = true;
      row.model = orchUsage.model;
      row.durationMs = orchUsage.durationMs;
      for (const k of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'cacheWrite5mTokens', 'cacheWrite1hTokens']) row[k] = orchUsage[k];
      let c = 0;
      for (const m of orchUsage.perModel) {
        const mc = pricing.cost(m.model, m);
        if (mc === null) row.unpriced = true;
        else c += mc;
      }
      row.cost = c;
    } else if (!row.model) {
      row.model = orchModel;
    }
    if (row.steps.length > 0 || orchUsage) bySeat.set('orchestrator', row);
  }

  for (const row of bySeat.values()) if (row.unpriced) row.cost = null;
  return [...bySeat.values()];
}

/**
 * Sum of seat costs, or `null` when there is no figure to give: no seat measured, or a measured seat
 * unpriced (it has tokens and no rate — that total is withheld).
 *
 * `unmeasured` counts the seats whose cost is NOT in `usd` — a background dispatch with no transcript
 * on this machine, or a step no dispatch record joins. The sum over the rest is a floor, and an
 * unmarked floor beneath a row that shows an em-dash reads as complete. Print it with `floorText`.
 */
function sumCost(seats) {
  const measured = seats.filter((s) => s.measured);
  if (measured.length === 0 || measured.some((s) => s.cost === null)) return null;
  return { usd: measured.reduce((a, s) => a + s.cost, 0), unmeasured: seats.length - measured.length };
}

/** `$12.34` when every seat is measured; `≥ $12.34 · 1 seat unmeasured` when some are not. */
const floorText = (sum) =>
  sum.unmeasured === 0 ? usd(sum.usd) : `≥ ${usd(sum.usd)} · ${sum.unmeasured} ${sum.unmeasured === 1 ? 'seat' : 'seats'} unmeasured`;

/** A per-seat sum (wall, tokens) over measured seats only is a floor too when any seat is unmeasured. */
const floor = (seats, text) => (text !== DASH && seats.some((s) => !s.measured) ? `≥ ${text}` : text);

/* ── sections ───────────────────────────────────────────────────────────────────────────────── */

function renderRun(board, log, seats, orch = null, declared = null) {
  const spend = sumCost(seats);
  const wall = seats.reduce((a, s) => a + s.durationMs, 0);
  const t = board.totals;
  const open = t.total - t.settled - t.doing;
  const pairs = [
    ['STATUS', log.end ? tag(log.end.verdict ?? 'DONE') : log.run ? tag('RUNNING') : DASH],
    ['SPEND', spend === null ? DASH : `${floorText(spend)} <span class="hint">derived · rates ${pricing.version}</span>`],
    ['TRACK', or(board.header.track ?? log.run?.track)],
    ['WALL CLOCK', wall > 0 ? floor(seats, duration(wall)) : DASH],
    ['BRANCH', or(board.header.branch ?? log.run?.branch)],
    ['BASE', or(log.run?.base)],
    ['SCOPE', or(board.header.scope)],
    ['UNLOCK', or(board.header.unlock)],
    ['ROWS', `${t.settled} settled · ${t.doing} in flight · ${open} open · ${t.total} total`],
    ['DEFERRALS', board.deferred.length > 0 ? board.deferred.map((d) => esc(d.id)).join(', ') : DASH],
    /* WARNS, never fails. A project may choose a session-level model deliberately, so a run on
     * another model is a fact to report, not an error to refuse — but it must be REPORTED, because
     * an unreported divergence is exactly what goes unnoticed run after run. No declaration or no
     * transcript ⇒ an em-dash, not an alarm. */
    [
      'ORCHESTRATOR',
      orch?.dominant
        ? declared && declared !== orch.dominant
          ? `<span class="tag warn">${esc(orch.dominant)}</span> <span class="hint">declared ${esc(declared)} — this run diverged</span>`
          : `${esc(orch.dominant)}${declared ? ' <span class="hint">as declared</span>' : ' <span class="hint">no declaration to check against</span>'}`
        : DASH,
    ],
  ];
  const rows = [];
  for (let i = 0; i < pairs.length; i += 2) {
    const [k1, v1] = pairs[i];
    const [k2, v2] = pairs[i + 1] ?? ['', ''];
    rows.push({ cells: [td(k1, 'key'), td(v1), td(k2, 'key'), td(v2)] });
  }
  return `<h2 id="run">Run<span>${Math.round((t.settled / Math.max(t.total, 1)) * 100)}% · ${t.settled} / ${t.total} rows</span></h2>
<div class="scroll"><table><tbody>${rows.map((r) => `<tr>${r.cells.join('')}</tr>`).join('')}</tbody></table></div>`;
}

/**
 * The ceiling section renders even when empty, and says so in words. Silence must not read as
 * "nothing was out of reach" — a run whose reachable total dropped and never said so is exactly the
 * claim this section exists to prevent.
 */
function renderCeiling(log) {
  const rows = log.ceiling.map((c) => ({
    tone: 'stop',
    cells: [
      td(esc(c.item ?? DASH), 'mono'),
      td(or(c.claim)),
      td(or(c.reality)),
      td(or(c.disposition)),
      td(or(c.owner)),
    ],
  }));
  return `<h2 id="ceiling">Ceiling — what this run will not reach<span>${rows.length || 'none'} declared</span></h2>
${table(['Item', 'Claim if unchecked', 'Reality', 'Disposition', 'Owner'], rows, { empty: 'No ceiling declared — every planned row is still reported as reachable.' })}`;
}

function renderGates(log) {
  const rows = (log.gatesLatest ?? []).map((g) => ({
    tone: /^(RED|FAIL)/i.test(g.result ?? '') ? 'stop' : '',
    cells: [
      td(esc(g.gate ?? DASH), 'mono'),
      td(tag(g.result)),
      td(or(g.figure), 'num'),
      td(or(g.detail)),
      td(clock(g.ts), 'num'),
      td(or(g.log), 'mono sub'),
    ],
  }));
  return `<h2 id="gates">Gates<span>${rows.length > 0 ? 'last result per gate' : 'none recorded'}</span></h2>
${table(['Gate', 'Result', { label: 'Figure', num: true }, 'Detail', { label: 'Ran', num: true }, 'Log'], rows, { empty: 'No gate run recorded for this board.' })}`;
}

function renderFindings(log) {
  const rows = log.findings.map((f) => ({
    tone: f.closedBy ? '' : /BLOCKER/i.test(f.sev ?? '') ? 'stop' : '',
    cells: [
      td(esc(f.id ?? DASH), 'mono'),
      td(tag(f.sev)),
      td(or(f.finding)),
      td(or(f.mechanism), 'sub'),
      td(f.closedBy ? esc(f.closedBy) : '<span class="tag warn">OPEN</span>'),
      td(clock(f.ts), 'num'),
    ],
  }));
  const open = log.findings.filter((f) => !f.closedBy).length;
  return `<h2 id="findings">Findings<span>${rows.length} total · ${open} open</span></h2>
${table(['ID', 'Sev', 'Finding', 'Mechanism', 'Closed by', { label: 'Raised', num: true }], rows, { empty: 'No finding recorded for this board.' })}`;
}

function renderPhases(board, log, usage) {
  const wallFor = (seat) => {
    let ms = 0;
    for (const step of log.steps) {
      if (seatOf(step, usage) !== seat) continue;
      ms += usage.get(step.agentId ?? '')?.durationMs ?? 0;
    }
    return ms;
  };
  const rows = board.phases.map((p) => ({
    tone: /^IN-PROGRESS/.test(p.status) ? 'hot' : '',
    cells: [
      td(esc(p.phase), 'mono'),
      td(esc(p.seat)),
      td(tag(p.status)),
      td(or(p.artifact), 'mono'),
      td(or(p.verdict)),
      td(duration(wallFor(p.seat)), 'num'),
    ],
  }));
  return `<h2 id="phases">Phases<span>from the board's phase:status block</span></h2>
${table(['Phase', 'Seat', 'Status', 'Artifact', 'Verdict', { label: 'Wall', num: true }], rows, { empty: 'This board declares no phase:status block.' })}`;
}

function renderSections(board) {
  return board.sections
    .map((section) => {
      const settled = section.rows.filter((r) => r.state === 'settled').length;
      const rows = section.rows.map((r) => ({
        tone: r.state === 'doing' ? 'hot' : /^(BLOCKED|DROPPED)/.test(r.status) ? 'stop' : '',
        cells: section.columns.map((_, i) =>
          i === 0
            ? td(esc(r.cells[0] ?? ''), 'mono')
            : /^Status$/i.test(section.columns[i])
              ? td(tag(r.cells[i]))
              : td(or(r.cells[i]), i === section.columns.length - 1 ? 'sub' : ''),
        ),
      }));
      return `<h2 id="rows-${esc(section.id)}">Board rows — ${esc(section.id)} ${esc(section.title)}<span>${settled} / ${section.rows.length}</span></h2>
${table(section.columns, rows, { empty: 'No rows in this section.' })}`;
    })
    .join('\n');
}

function renderDeferred(board) {
  const rows = board.deferred.map((d) => ({
    cells: [td(esc(d.id), 'mono'), td(esc(d.text))],
  }));
  return `<h2 id="deferred">Deferred this cycle<span>${rows.length} rows</span></h2>
${table(['Registry ID', 'Row · why · mirrored where'], rows, { empty: 'Nothing deferred this cycle.' })}`;
}

/* Todo, definition of done, modules & endpoints (board sections) and decisions (run log). Each
 * renders even when absent, in words: a page silent about decisions reads as "none were taken". */
function renderTodo(board) {
  const rows = board.todo.map((x) => ({ tone: x.done ? '' : 'hot', cells: [td(x.done ? tag('DONE') : tag('OPEN')), td(esc(x.text))] }));
  return `<h2 id="todo">Todo<span>${board.todo.filter((x) => !x.done).length} open · ${board.todo.length} total</span></h2>
${table(['State', 'Item'], rows, { empty: 'This board declares no ## Todo list.' })}`;
}

function renderNamedTable(id, title, parsed, empty) {
  const rows = (parsed?.rows ?? []).map((r) => ({ cells: (parsed?.columns ?? []).map((_, i) => td(or(r[i]), i === 0 ? 'mono' : '')) }));
  return `<h2 id="${id}">${esc(title)}<span>${rows.length} rows</span></h2>
${table(parsed?.columns ?? [], rows, { empty })}`;
}

function renderDecisions(log) {
  const rows = log.decisions.map((d) => ({
    cells: [td(esc(d.id ?? DASH), 'mono'), td(or(d.what)), td(or(d.why), 'sub'), td(or(d.by)), td(or(d.reversal)), td(clock(d.ts), 'num')],
  }));
  return `<h2 id="decisions">Decisions this run<span>${rows.length} logged</span></h2>
${table(['ID', 'What', 'Why', 'By', 'Reversal', { label: 'When', num: true }], rows, { empty: 'No decision event in the run log.' })}`;
}

function renderSteps(log, usage) {
  const rows = [...log.steps].reverse().map((step) => {
    const u = step.agentId ? usage.get(step.agentId) : null;
    const chips = (step.files ?? [])
      .map(
        (f) =>
          `<span class="chip"><s>${f.act === 'EDIT' ? '~' : '+'}</s> ${esc(f.path)}${f.count > 1 ? ` (${f.count})` : ''}</span>`,
      )
      .join('');
    return {
      tone: /^(RUNNING|IN-PROGRESS)/i.test(step.status ?? '')
        ? 'hot'
        : /^(ESCALATED|BLOCKED|CHANGES)/i.test(step.status ?? '')
          ? 'stop'
          : '',
      cells: [
        td(esc(step.id ?? DASH), 'mono'),
        td(or(seatOf(step, usage))),
        td(`${esc(step.title ?? '')}${step.detail ? `<div class="sub">${esc(step.detail)}</div>` : ''}`),
        td(tag(step.status)),
        td(chips || DASH),
        td(clock(step.startedAt ?? step.ts), 'num'),
        td(u ? duration(u.durationMs) : DASH, 'num'),
        td(u && !u.unmeasured ? usd(pricing.cost(u.model, u)) : DASH, 'num'),
      ],
    };
  });
  return `<h2 id="steps">Step log — newest first<span>${rows.length} steps</span></h2>
${table(['Step', 'Seat', 'What happened', 'Status', 'Files', { label: 'Start', num: true }, { label: 'Dur', num: true }, { label: 'Cost', num: true }], rows, { empty: 'No step recorded — this board predates the run log, or the run has not started.' })}`;
}

function renderFiles(log) {
  const rows = log.files.map((f) => ({
    cells: [
      td(esc(f.path ?? DASH), 'mono'),
      td(or(f.kind)),
      td(tag(f.act ?? 'NEW')),
      td(or(f.by)),
      td(or(f.step), 'mono sub'),
      td(f.count ? String(f.count) : '1', 'num'),
      td(clock(f.at), 'num'),
      td(or(f.note), 'sub'),
    ],
  }));
  return `<h2 id="files">Files this run<span>${rows.length} entries</span></h2>
${table(['Path', 'Kind', 'Act', 'By', 'Step', { label: 'Files', num: true }, { label: 'When', num: true }, 'Note'], rows, { empty: 'No file recorded against this run.' })}`;
}

function renderAgents(seats) {
  const rows = seats.map((s) => ({
    tone: s.status === 'running' ? 'hot' : '',
    cells: [
      td(esc(s.seat)),
      td(or(s.model), 'mono'),
      td(s.steps.filter(Boolean).join(', ') || DASH, 'sub'),
      td(s.measured ? duration(s.durationMs) : DASH, 'num'),
      td(s.measured ? tokens(s.inputTokens) : DASH, 'num'),
      td(s.measured ? tokens(s.outputTokens) : DASH, 'num'),
      td(s.measured ? tokens(s.cacheReadTokens) : DASH, 'num'),
      td(s.cost === null ? DASH : usd(s.cost), 'num'),
    ],
  }));
  const measured = seats.filter((s) => s.measured);
  const sum = sumCost(seats);
  const foot =
    rows.length > 0
      ? [
          td(`${seats.length} seats`, ''),
          td('', ''),
          td('', ''),
          td(measured.length > 0 ? floor(seats, duration(measured.reduce((a, s) => a + s.durationMs, 0))) : DASH, 'num'),
          td(measured.length > 0 ? floor(seats, tokens(measured.reduce((a, s) => a + s.inputTokens, 0))) : DASH, 'num'),
          td(measured.length > 0 ? floor(seats, tokens(measured.reduce((a, s) => a + s.outputTokens, 0))) : DASH, 'num'),
          td(measured.length > 0 ? floor(seats, tokens(measured.reduce((a, s) => a + s.cacheReadTokens, 0))) : DASH, 'num'),
          td(sum === null ? DASH : floorText(sum), 'num'),
        ]
      : null;
  return `<h2 id="agents">Agents · cost · time<span>harness-recorded · cost derived, rates ${pricing.version}</span></h2>
${table(['Seat', 'Model', 'Steps', { label: 'Wall', num: true }, { label: 'In', num: true }, { label: 'Out', num: true }, { label: 'Cached', num: true }, { label: 'Cost', num: true }], rows, { foot, empty: 'No agent dispatch recorded — accounting is unavailable for this board, which is not the same as zero.' })}`;
}

function renderSource(board, boardPath) {
  return `<h2 id="source">Board source</h2>
<details><summary>${esc(boardPath)} — raw markdown (git truth)</summary><pre>${esc(board.source)}</pre></details>
<p class="foot">Rendered from the markdown board. <b>The markdown wins</b> on any disagreement — if a
figure here contradicts <code>${esc(basename(boardPath))}</code>, this page is the defect. Accounting
comes from the harness's own dispatch records; an em-dash means unmeasured, never zero.</p>`;
}

/* ── page ───────────────────────────────────────────────────────────────────────────────────── */

const STYLE = `:root{--bg:#fff;--panel:#fff;--line:#e3e6ea;--fg:#14181d;--dim:#6a7480;--ok:#1a7f45;--warn:#9a6400;--bad:#b3261e;--blue:#2f5bd0;--mono:ui-monospace,"SF Mono",Consolas,monospace}
@media (prefers-color-scheme: dark){:root{--bg:#0f1216;--panel:#151a20;--line:#262d36;--fg:#e6edf3;--dim:#8b949e;--ok:#3fb950;--warn:#d29922;--bad:#f85149;--blue:#6a9bff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14.5px/1.5 ui-sans-serif,system-ui,"Segoe UI",sans-serif}
.wrap{max-width:1180px;margin:0 auto;padding:30px 20px 80px}
.mono,code{font-family:var(--mono);font-size:.86em}
.status{font-family:var(--mono);font-size:12px;letter-spacing:2px;color:var(--dim);margin-bottom:12px}
h1{font-size:30px;line-height:1.15;margin:0 0 10px;font-weight:700}
.lede{color:var(--dim);font-size:16px;margin:0 0 18px;max-width:78ch}
.meter{height:8px;border-radius:99px;background:var(--line);overflow:hidden;margin:16px 0 8px}.meter i{display:block;height:100%;background:var(--ok)}
h2{font-family:var(--mono);font-size:11.5px;letter-spacing:2px;color:var(--dim);font-weight:600;text-transform:uppercase;margin:34px 0 10px;padding-bottom:7px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;gap:12px}
h2 span{color:var(--fg);letter-spacing:0;font-family:inherit;text-transform:none;font-size:12px;font-weight:400}
.scroll{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:13px;border:1px solid var(--line);border-radius:10px;overflow:hidden}
th{font-family:var(--mono);font-size:10.5px;letter-spacing:1px;text-transform:uppercase;color:var(--dim);text-align:left;padding:10px 11px;border-bottom:1px solid var(--line);font-weight:600;white-space:nowrap}
td{padding:10px 11px;border-bottom:1px solid var(--line);vertical-align:top}tr:last-child td{border-bottom:0}
td.sub,.sub{color:var(--dim);font-size:12.2px}
.num{font-family:var(--mono);text-align:right;white-space:nowrap}
.key{font-family:var(--mono);font-size:11.5px;color:var(--dim);white-space:nowrap;width:150px}
tfoot td{font-weight:700;background:var(--panel);border-top:1px solid var(--line)}
tr.hot{background:rgba(47,91,208,.07)}tr.stop{background:rgba(179,38,30,.07)}
.tag{font-family:var(--mono);font-size:10px;letter-spacing:.8px;font-weight:700;padding:2px 6px;border-radius:4px;white-space:nowrap}
.tag.ok{color:var(--ok);background:rgba(26,127,69,.12)}.tag.run{color:var(--blue);background:rgba(47,91,208,.12)}
.tag.warn{color:var(--warn);background:rgba(154,100,0,.14)}.tag.bad{color:var(--bad);background:rgba(179,38,30,.12)}
.tag.dim{color:var(--dim);background:rgba(106,116,128,.14)}
.chip{font-family:var(--mono);font-size:11px;border:1px solid var(--line);border-radius:5px;padding:1px 6px;margin:0 4px 4px 0;display:inline-block}
.chip s{text-decoration:none;color:var(--ok);font-weight:700}
.hint{color:var(--dim);font-size:11px;font-family:var(--mono)}
.empty{color:var(--dim);font-size:13px;border:1px dashed var(--line);border-radius:10px;padding:14px}
details{border:1px solid var(--line);border-radius:10px;padding:12px 14px;background:var(--panel)}
summary{cursor:pointer;font-family:var(--mono);font-size:12px;color:var(--dim);letter-spacing:1px}
pre{margin:12px 0 0;overflow-x:auto;font-family:var(--mono);font-size:12px;line-height:1.5;white-space:pre}
.foot{color:var(--dim);font-size:12.5px;margin-top:14px;max-width:78ch}
.age{color:var(--ok)}.age.stale{color:var(--warn)}`;

function renderPage({ board, log, usage, boardPath, key, orch = null, declared = null, orchUsage = null }) {
  const seats = accounting(log.steps, usage, orch?.dominant ?? null, orchUsage);
  const t = board.totals;
  const pct = Math.round((t.settled / Math.max(t.total, 1)) * 100);
  const runningPhase = board.phases.find((p) => /^IN-PROGRESS/.test(p.status));
  const state = log.end ? `RUN ${String(log.end.verdict ?? 'CLOSED').toUpperCase()}` : log.run ? 'RUN ACTIVE' : 'BOARD';
  const open = log.findings.filter((f) => !f.closedBy);

  const lede = [
    `${t.total} rows across ${board.sections.length} section${board.sections.length === 1 ? '' : 's'}.`,
    `${t.settled} settled, ${t.doing} in flight, ${t.total - t.settled - t.doing} open.`,
    runningPhase ? `Running: ${runningPhase.phase} — ${runningPhase.seat}.` : '',
    open.length > 0 ? `${open.length} finding${open.length === 1 ? '' : 's'} still open.` : '',
    log.corrupt > 0 ? `${log.corrupt} unparseable run-log line(s) — the log is incomplete.` : '',
  ]
    .filter(Boolean)
    .join(' ');

  const unrecognised =
    board.unrecognised.length > 0
      ? `<p class="empty"><b>${board.unrecognised.length} board row(s) carry an id the board format does not know</b> — counted nowhere: ${board.unrecognised
          .map((u) => `${esc(u.section)}: "${esc(u.id)}"`)
          .join(', ')}.</p>`
      : '';
  // rows under a non-counted `##` heading — named, never counted (the same rule board-progress reports)
  const uncounted =
    (board.uncounted || []).length > 0
      ? `<p class="empty uncounted"><b>${board.uncounted.length} board row(s) sit under a non-counted "##" heading</b> — counted nowhere, so the figures above are a lower bound: ${board.uncounted
          .map((u) => `${esc(u.heading)}: "${esc(u.id)}"`)
          .join(', ')}.</p>`
      : '';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(key)} — run board</title>
<!-- The page reloads itself so an open window follows the run. board-watch re-renders the file
     underneath it; this only re-reads what is already on disk, and reaches nothing off the page. -->
<meta http-equiv="refresh" content="${REFRESH_SECONDS}">
<style>${STYLE}</style></head>
<body><div class="wrap">
<div class="status">${esc(state)} &nbsp;${esc(key.toUpperCase())} &nbsp;${esc(board.header.branch ?? '')} &nbsp;RENDERED ${esc(new Date().toISOString().slice(0, 16).replace('T', ' '))} UTC &nbsp;<span id="age" class="age"></span></div>
<h1>${esc(board.header.title ?? key)}</h1>
<p class="lede">${esc(lede)}</p>
<div class="meter"><i style="width:${pct}%"></i></div>
${unrecognised}
${uncounted}
${renderRun(board, log, seats, orch, declared)}
${renderCeiling(log)}
${renderGates(log)}
${renderFindings(log)}
${renderPhases(board, log, usage)}
${renderSections(board)}
${renderDeferred(board)}
${renderTodo(board)}
${renderNamedTable('dod', 'Definition of Done', board.dod, 'This board declares no ## Definition of Done table.')}
${renderNamedTable('modules', 'Modules & endpoints', board.modules, 'This board declares no ## Modules & endpoints table.')}
${renderDecisions(log)}
${renderSteps(log, usage)}
${renderFiles(log)}
${renderAgents(seats)}
${renderSource(board, boardPath)}
</div>
<script>
/* The age of what you are looking at, counted from the render. A page that only says WHEN it was
   rendered lets a dead watcher pass for a quiet run — a number that keeps climbing does not. */
(function () {
  var rendered = ${Date.now()};
  var el = document.getElementById('age');
  function tick() {
    var s = Math.max(0, Math.round((Date.now() - rendered) / 1000));
    el.textContent = s < 60 ? 'UPDATED ' + s + 'S AGO' : 'UPDATED ' + Math.round(s / 60) + 'M AGO';
    el.className = s > ${REFRESH_SECONDS * 3} ? 'age stale' : 'age';
  }
  tick();
  setInterval(tick, 1000);
})();
</script>
</body></html>
`;
}

/* ── section documents ──────────────────────────────────────────────────────────────────────── */

const plain = (v) => (v === null || v === undefined || v === '' ? DASH : String(v));
const hhmm = (iso) => (typeof iso === 'string' && iso.length >= 16 ? iso.slice(11, 16) : DASH);

/**
 * The same projection as the page, as plain documents — text cells only, never markup, so whatever
 * page consumes them escapes everything it shows. Ordered as the local page orders its sections.
 */
export function sectionDocs({ board, log, seats, key }) {
  const t = board.totals;
  const spend = sumCost(seats);
  const docs = [];
  const add = (id, title, subtitle, columns, rows) =>
    docs.push({ id, order: docs.length, title, subtitle: plain(subtitle), columns, rows: rows.map((r) => columns.map((_, i) => plain(r[i]))) });

  add('run', board.header.title ?? key, `${Math.round((t.settled / Math.max(t.total, 1)) * 100)}% · ${t.settled} / ${t.total} rows`, ['Fact', 'Value'], [
    ['Status', log.end ? String(log.end.verdict ?? 'DONE') : log.run ? 'RUNNING' : null],
    ['Spend', spend === null ? null : `${floorText(spend)} (derived · rates ${pricing.version})`],
    ['Track', board.header.track ?? log.run?.track],
    ['Branch', board.header.branch ?? log.run?.branch],
    ['Rows', `${t.settled} settled · ${t.doing} in flight · ${t.total - t.settled - t.doing} open · ${t.total} total`],
  ]);
  add('ceiling', 'Ceiling — what this run will not reach', `${log.ceiling.length} declared`, ['Item', 'Claim if unchecked', 'Reality', 'Disposition', 'Owner'], log.ceiling.map((c) => [c.item, c.claim, c.reality, c.disposition, c.owner]));
  add('gates', 'Gates', 'last result per gate', ['Gate', 'Result', 'Figure', 'Detail', 'Ran'], (log.gatesLatest ?? []).map((g) => [g.gate, g.result, g.figure, g.detail, hhmm(g.ts)]));
  add('findings', 'Findings', `${log.findings.filter((f) => !f.closedBy).length} open`, ['ID', 'Sev', 'Finding', 'Closed by'], log.findings.map((f) => [f.id, f.sev, f.finding, f.closedBy ?? 'OPEN']));
  add('phases', 'Phases', 'from the board', ['Phase', 'Seat', 'Status', 'Artifact', 'Verdict'], board.phases.map((p) => [p.phase, p.seat, p.status, p.artifact, p.verdict]));
  for (const s of board.sections) {
    add(`rows-${s.id}`, `${s.id} — ${s.title}`, `${s.rows.filter((r) => r.state === 'settled').length} / ${s.rows.length}`, s.columns, s.rows.map((r) => r.cells));
  }
  add('deferred', 'Deferred this cycle', `${board.deferred.length} rows`, ['Registry ID', 'Row'], board.deferred.map((d) => [d.id, d.text]));
  add('todo', 'Todo', `${board.todo.filter((x) => !x.done).length} open`, ['State', 'Item'], board.todo.map((x) => [x.done ? 'DONE' : 'OPEN', x.text]));
  add('dod', 'Definition of Done', `${board.dod?.rows.length ?? 0} rows`, board.dod?.columns ?? ['Batch', 'Done when'], board.dod?.rows ?? []);
  add('modules', 'Modules & endpoints', `${board.modules?.rows.length ?? 0} rows`, board.modules?.columns ?? ['Module', 'Endpoints'], board.modules?.rows ?? []);
  add('decisions', 'Decisions this run', `${log.decisions.length} logged`, ['ID', 'What', 'Why', 'By', 'Reversal', 'When'], log.decisions.map((d) => [d.id, d.what, d.why, d.by, d.reversal, hhmm(d.ts)]));
  add('steps', 'Step log — newest first', `${log.steps.length} steps`, ['Step', 'Seat', 'What happened', 'Status', 'Start'], [...log.steps].reverse().map((s) => [s.id, s.seat, s.title, s.status, hhmm(s.startedAt ?? s.ts)]));
  add('agents', 'Agents · cost · time', `cost derived, rates ${pricing.version}`, ['Seat', 'Model', 'Wall', 'In', 'Out', 'Cached', 'Cost'], seats.map((s) => [
    s.seat,
    s.model,
    s.measured ? duration(s.durationMs) : null,
    s.measured ? tokens(s.inputTokens) : null,
    s.measured ? tokens(s.outputTokens) : null,
    s.measured ? tokens(s.cacheReadTokens) : null,
    s.cost === null ? null : usd(s.cost),
  ]));
  return docs;
}

/**
 * Board, run log and the harness accounting for one board — shared by both output modes.
 * `transcripts` overrides the harness's default transcript directory (another operator's layout,
 * or a fixture); omitted, the Claude Code per-project directory for the current working directory.
 */
function loadSources(boardPath, key, root, transcripts = null) {
  const dir = transcripts ? resolve(transcripts) : transcript.transcriptDir();
  const board = parseBoard(readFileSync(boardPath, 'utf8'));
  const log = runLog.read(join(root, '.pipeline', key, 'run.jsonl'));
  const usage = log.steps.some((s) => s.agentId) ? transcript.collect(dir) : new Map();

  /* Scoped to this run's own window, so a board reports the model ITS run used rather than whatever
   * the session is set to today. No window (no `run.start`) means no claim. */
  const orch = log.run?.ts ? transcript.orchestratorModel(dir, log.run.ts) : null;

  /* The orchestrator's tokens come from the sessions that dispatched THIS run's seats (other lanes
   * share the transcript directory), inside the run window. No dispatched seat on this machine ⇒ no
   * session to attribute ⇒ no claim. */
  const sessions = [...new Set(log.steps.map((s) => usage.get(s.agentId ?? '')?.sessionId).filter(Boolean))];
  const orchUsage = log.run?.ts ? transcript.orchestratorUsage(sessions, log.run.ts, log.end?.ts ?? null, dir) : null;
  return { board, log, usage, orch, orchUsage };
}

/**
 * Write one JSON document per section — split, never truncated, at `limit` bytes (default: one hosted
 * store's per-document cap, see page-docs.cjs) — into `<paths.runs>/<key>/page/` or `outDir`.
 * `paths.runs` comes from the profile and defaults to `.pipeline`. Earlier `*.json` there are removed
 * first, so a section that shrank from three parts to two leaves no orphan part behind for the page
 * to merge.
 */
export function renderJson(arg, { outDir = null, limit = PAGE_DOC_LIMIT, transcripts = null } = {}) {
  const { boardPath, key, root } = resolveBoard(arg);
  if (!existsSync(boardPath)) throw new Error(`board-render: no such board — ${boardPath}`);
  const { board, log, usage, orch, orchUsage } = loadSources(boardPath, key, root, transcripts);
  const seats = accounting(log.steps, usage, orch?.dominant ?? null, orchUsage);
  const docs = splitDocs(sectionDocs({ board, log, seats, key }), limit);
  const runs = settingsFor(root)?.paths?.runs ?? '.pipeline';
  const dir = outDir ? resolve(outDir) : join(root, runs, key, 'page');
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(dir)) if (f.endsWith('.json')) unlinkSync(join(dir, f));
  for (const d of docs) writeFileSync(join(dir, `${d.id}.json`), JSON.stringify(d), 'utf8');
  return { dir, ids: docs.map((d) => d.id) };
}

/** Render one board. Returns the written path. */
export function renderBoard(arg, { open = false, transcripts = null } = {}) {
  const { boardPath, key, root } = resolveBoard(arg);
  if (!existsSync(boardPath)) throw new Error(`board-render: no such board — ${boardPath}`);
  const { board, log, usage, orch, orchUsage } = loadSources(boardPath, key, root, transcripts);

  const out = boardPath.replace(/\.md$/, '.html');
  writeFileSync(out, renderPage({ board, log, usage, boardPath, key, orch, orchUsage, declared: declaredOrchestratorModel(root) }), 'utf8');
  if (open) {
    try {
      execFileSync(process.platform === 'win32' ? 'cmd' : 'open', process.platform === 'win32' ? ['/c', 'start', '', out] : [out], { stdio: 'ignore' });
    } catch {
      /* opening is a convenience; a headless host must not fail the render over it */
    }
  }
  return out;
}

/* ── cli ────────────────────────────────────────────────────────────────────────────────────── */

const invokedDirectly = process.argv[1] && resolve(process.argv[1]).endsWith('board-render.mjs');
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const open = args.includes('--open');
  const VALUE_FLAGS = ['--out', '--transcripts', '--limit'];
  const valueOf = (flag) => {
    const at = args.indexOf(flag);
    return at === -1 ? null : (args[at + 1] ?? null);
  };
  const valueIndexes = new Set(VALUE_FLAGS.map((f) => args.indexOf(f)).filter((i) => i !== -1).map((i) => i + 1));
  const targets = args.filter((a, i) => !a.startsWith('--') && !valueIndexes.has(i));
  const outDir = valueOf('--out');
  const transcripts = valueOf('--transcripts');
  const limitArg = valueOf('--limit');
  const limit = limitArg === null ? PAGE_DOC_LIMIT : Number(limitArg);
  if (!Number.isInteger(limit) || limit <= 0) {
    console.error(`board-render: --limit must be a positive whole number of bytes, got ${JSON.stringify(limitArg)}.`);
    process.exit(1);
  }

  if (args.includes('--json')) {
    if (targets.length !== 1) {
      console.error(`board-render --json: name exactly one board — \`${runHint('board-render')} <key> --json [--out <dir>] [--limit <bytes>]\`.`);
      process.exit(1);
    }
    const { dir, ids } = renderJson(targets[0], { outDir, limit, transcripts });
    console.log(`board-render --json: ${ids.length} document(s) → ${dir}`);
  } else if (args.includes('--all')) {
    const { root } = resolveBoard('x');
    const pipelineRoot = join(root, '.pipeline');
    const keys = existsSync(pipelineRoot)
      ? readdirSync(pipelineRoot).filter((k) => existsSync(join(pipelineRoot, k, 'run.jsonl')))
      : [];
    if (keys.length === 0) console.log('board-render: no board carries a run log yet.');
    for (const key of keys) {
      if (!existsSync(join(root, boardsDirOf(root), `${key}.md`))) continue;
      console.log(`board-render: ${renderBoard(key, { transcripts })}`);
    }
  } else if (targets.length === 0) {
    console.error(`board-render: name a board — \`${runHint('board-render')} tasks/<key>.md\` or \`<key>\`.`);
    process.exit(1);
  } else {
    for (const target of targets) console.log(`board-render: ${renderBoard(target, { open, transcripts })}`);
  }
}
