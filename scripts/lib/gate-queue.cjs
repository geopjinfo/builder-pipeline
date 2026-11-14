'use strict';
const { runHint } = require('./run-hint.cjs');
/**
 * The lite-split gate queue — `<boards>/_gate-queue.md` (feature `liteSplit`, skills
 * `build-module-lite` + `build-module-lite-gate-batch`).
 *
 * `build-module-lite` runs P1 plan → P2 build → P3 test → P3a free checks for one module and adds an
 * entry here. `build-module-lite-gate-batch` reads the entry to know what is still OWED and runs the rest
 * of the full pipeline over it. This file is how the batch knows what is checked.
 *
 * WHY A SHA ON EVERY DONE. A check proven on code that has since changed proves nothing. So a DONE carries
 * the sha it was proven at, and `owed()` re-opens it when a later commit touches the module (its base..tip
 * files, or anything under its module dir). Batch-wide checks re-open when any code moves at all.
 *
 * WHAT NEVER RE-OPENS ANYTHING — ledgers. The run's own bookkeeping (boards, run folders, handoffs, the
 * decision log, the deferred registry, logs, and whatever `features.liteSplit.ledgers` adds — typically the
 * changelog and the manifest's version file) is written by close-out; if it re-opened the proof it records,
 * a batch could never close. Ledgers are filtered for module phases AND batch checks.
 *
 * WHAT DOES NOT RE-OPEN A MODULE — docs (`features.liteSplit.docsOnly`, default: any README). The docs phase
 * writes them after the module's tests and audits are proven. They still re-open batch checks, because a gate
 * may read them. The match is exact: a code file in the same commit still re-opens the module.
 *
 * Pure functions over a plain object; `diff(from, to)` and the path config are injected, so the tests drive a
 * fake history (tests/gate-queue.test.mjs). The CLI is scripts/gate-queue.mjs.
 */

const LITE_PHASES = ['1', '2', '3', '3a'];
/** Per-module phases the gate batch owes: the four auditors, docs, the reviewer, the ledger audit + close-out. */
const GATE_PHASES = ['4', '5', '6', '7'];
/** Run once per batch at its tip — they cover the whole repository, so once is the same as once per module. */
const BATCH_CHECKS = ['3b', 'gates', 'integration', 'e2e', '6.5'];
/** A plan and a build are not re-proven by a later code change — FIX rows carry that work. */
const NEVER_STALE = new Set(['1', '2']);
const BATCH = 'batch';
const DEFAULT_CAP = 4;
const DEFAULT_TRIGGER = 3;

const PHASE_NAMES = {
  1: 'P1 plan', 2: 'P2 build', 3: 'P3 test', '3a': 'P3a free checks',
  4: 'P4 auditors ×4', 5: 'P5 docs', 6: 'P6 review', 7: 'P7 close-out',
  '3b': 'P3b drift', gates: 'gates tier', integration: 'integration tier', e2e: 'e2e tier', 6.5: 'P6.5 behavioural gate',
};

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const dirPattern = (d) => new RegExp(`^${escape(String(d).replace(/\\/g, '/').replace(/\/+$/, ''))}/`);
const filePattern = (f) => new RegExp(`^${escape(String(f).replace(/\\/g, '/'))}$`);

/**
 * The path rules from a loaded profile (`profile.load(root).settings`). Absent settings fall back to the
 * profile defaults, so the functions below also work in a repository with no profile at all.
 */
function config(settings = {}) {
  const paths = settings.paths ?? {};
  const f = settings.features?.liteSplit ?? {};
  const dirs = [paths.boards ?? 'tasks', paths.runs ?? '.pipeline', paths.handoffs ?? 'handoffs', paths.logs ?? 'logs'];
  const files = [paths.decisions ?? 'DECISIONS.md', paths.registry ?? 'DEFERRED_TASKS.md'];
  return {
    boards: paths.boards ?? 'tasks',
    cap: Number.isInteger(f.cap) && f.cap > 0 ? f.cap : DEFAULT_CAP,
    trigger: Number.isInteger(f.trigger) && f.trigger > 0 ? f.trigger : DEFAULT_TRIGGER,
    ledgers: [...dirs.map(dirPattern), ...files.map(filePattern), ...(f.ledgers ?? []).map((re) => new RegExp(re))],
    docsOnly: (f.docsOnly ?? ['(^|/)README\\.md$']).map((re) => new RegExp(re)),
  };
}

const clone = (s) => JSON.parse(JSON.stringify(s));
const empty = (cap = DEFAULT_CAP) => ({ version: 1, cap, batch: { id: null, checks: {} }, modules: [] });

function add(state, { key, base, tip, files, moduleDir, branch = null, board = null, built = null, batchId = null }) {
  const s = clone(state);
  if (!s.batch.id) s.batch.id = batchId; // the first module names the batch; later ones join it
  if (!key || !base || !tip) throw new Error('add: key, base and tip are required');
  if (s.modules.some((m) => m.key === key)) throw new Error(`add: ${key} is already queued`);
  const open = s.modules.filter((m) => m.status === 'BUILT-UNGATED').length;
  if (open >= s.cap) throw new Error(`add: batch cap ${s.cap} reached (${open} BUILT-UNGATED) — run the gate batch first`);
  const phases = {};
  for (const p of [...LITE_PHASES, ...GATE_PHASES]) phases[p] = { status: 'OWED' };
  s.modules.push({ key, status: 'BUILT-UNGATED', branch, board, built, base, tip, moduleDir: moduleDir ?? null, files: [...(files ?? [])].sort(), phases });
  return s;
}

function mark(state, key, phase, { sha, evidence }) {
  const s = clone(state);
  if (!sha) throw new Error('mark: sha is required');
  if (!evidence || !String(evidence).trim()) throw new Error('mark: a DONE needs evidence — the command and the result line it printed');
  const entry = { status: 'DONE', sha, evidence: String(evidence).trim() };
  if (key === BATCH) {
    if (!BATCH_CHECKS.includes(phase)) throw new Error(`mark: ${phase} is not a batch check (${BATCH_CHECKS.join(', ')})`);
    s.batch.checks[phase] = entry;
    return s;
  }
  const m = s.modules.find((x) => x.key === key);
  if (!m) throw new Error(`mark: ${key} is not queued`);
  if (!(phase in m.phases)) throw new Error(`mark: ${phase} is not a module phase (${Object.keys(m.phases).join(', ')})`);
  m.phases[phase] = entry;
  return s;
}

/**
 * A FIX after `add` moves the code, and whatever reads the RECORDED tip (the credit auditors, the gate batch) would
 * audit the stale range until the JSON was edited by hand. `retip` re-records tip + base..tip files; the phase stamps
 * stay (each carries its own sha, and `owed()` re-opens what the new commits touched). Lanes merge, never rebase: a
 * new tip descends from the base and from the recorded tip (`ancestry`, computed by the CLI from git).
 */
function retip(state, key, { tip, files, ancestry }) {
  const s = clone(state);
  if (!tip) throw new Error('retip: --tip <sha> is required');
  const m = s.modules.find((x) => x.key === key);
  if (!m) throw new Error(`retip: ${key} is not queued`);
  if (m.status === 'GATED') throw new Error(`retip: ${key} is GATED — its range is history`);
  if (ancestry && !ancestry.fromBase) throw new Error(`retip: ${tip} does not descend from the base ${m.base} — not this key's history`);
  if (ancestry && !ancestry.fromTip) throw new Error(`retip: ${tip} does not descend from the recorded tip ${m.tip} — a rebased or side branch is not this key's history`);
  m.tip = tip;
  m.files = [...(files ?? [])].sort();
  return s;
}

const ORDER = [...LITE_PHASES, '3b', ...GATE_PHASES];
const order = (p) => (ORDER.includes(p) ? ORDER.indexOf(p) : 99);

/** What is still owed at `head`: per open module, its OWED or stale phases; per batch, the OWED or stale checks. */
function owed(state, diff, head, cfg = config()) {
  const isLedger = (f) => cfg.ledgers.some((re) => re.test(f));
  const isDocs = (f) => cfg.docsOnly.some((re) => re.test(f));
  const inModule = (m, f) => m.files.includes(f) || (m.moduleDir && (f === m.moduleDir || f.startsWith(`${m.moduleDir.replace(/\/$/, '')}/`)));
  const touches = (m, changed) => changed.some((f) => !isLedger(f) && !isDocs(f) && inModule(m, f));

  const cache = new Map();
  const changedSince = (sha) => {
    if (sha === head) return [];
    if (!cache.has(sha)) cache.set(sha, diff(sha, head));
    return cache.get(sha);
  };
  const modules = {};
  for (const m of state.modules) {
    if (m.status === 'GATED') continue;
    modules[m.key] = Object.entries(m.phases)
      .filter(([p, e]) => e.status !== 'DONE' || (!NEVER_STALE.has(p) && touches(m, changedSince(e.sha))))
      .map(([p]) => p)
      .sort((a, b) => order(a) - order(b));
  }
  const batch = BATCH_CHECKS.filter((c) => {
    const e = state.batch.checks[c];
    return !e || changedSince(e.sha).some((f) => !isLedger(f));
  });
  return { modules, batch };
}

/** Every DONE with its sha, per open module and for the batch — `status` prints the ones still valid. */
function done(state) {
  const pick = (entries) => entries.filter(([, e]) => e?.status === 'DONE').map(([phase, e]) => ({ phase, sha: e.sha }));
  const modules = {};
  for (const m of state.modules) {
    if (m.status === 'GATED') continue;
    modules[m.key] = pick(Object.entries(m.phases)).sort((a, b) => order(a.phase) - order(b.phase));
  }
  return { modules, batch: pick(BATCH_CHECKS.map((c) => [c, state.batch.checks[c]])) };
}

function close(state, key, diff, head, cfg = config()) {
  const o = owed(state, diff, head, cfg);
  const mine = o.modules[key];
  if (mine === undefined) throw new Error(`close: ${key} is not an open queue entry`);
  if (mine.length || o.batch.length) throw new Error(`close: ${key} still OWED — module [${mine.join(', ')}], batch [${o.batch.join(', ')}]`);
  const s = clone(state);
  s.modules.find((m) => m.key === key).status = 'GATED';
  return s;
}

/** Every module GATED → an empty queue for the next batch. The closed batch lives on in version control. */
function reset(state) {
  const open = state.modules.filter((m) => m.status !== 'GATED').map((m) => m.key);
  if (open.length) throw new Error(`reset: ${open.join(', ')} still open — close them first`);
  return empty(state.cap);
}

/* ---------- the batch board: generated from the queue, never hand-typed ---------- */

const MODULE_ROWS = [
  ['P4 standards-auditor', "findings check PASS on the module's base..tip"],
  ['P4 security-auditor', 'findings check PASS'],
  ['P4 vuln-auditor', 'findings check PASS'],
  ['P4 invariant-auditor', 'findings check PASS; rulings routed'],
  ['P5 docs-maintainer', 'docs written; claims check clean'],
  ['P7a ledger audit', 'every DONE earned, before the reviewer'],
  ['P6 module-reviewer', 'review check → MERGE-READY'],
  ['P7 close-out', 'handoff pack checked · gate-queue close'],
];
const BATCH_ROWS = [
  ['P3b drift', 'drift oracles green, no re-baseline'],
  ['gates tier', 'the gates tier, own exit 0'],
  ['integration tier', 'the integration tier, own exit 0'],
  ['e2e tier', 'the e2e tier, own exit 0 (or "not configured")'],
  ['P6.5 behavioural gate', 'the behavioural gate at the batch tip (or "not configured")'],
];

function board(state, { boards = 'tasks', batchId = state.batch.id } = {}) {
  let n = 0;
  const row = ([what, doneWhen]) => `| T${++n} | ${what} | ${doneWhen} | PLANNED | — | |`;
  const head = '| # | Task | Done when | Status | Evidence | Notes |\n|---|---|---|---|---|---|';
  const open = state.modules.filter((m) => m.status === 'BUILT-UNGATED');
  return [
    `# gate-batch-${batchId} — gate batch board`,
    '',
    `_Skill: build-module-lite-gate-batch · Queue: ${boards}/_gate-queue.md · Modules in build order: ${open.map((m) => m.key).join(' → ')}_`,
    '',
    '<!-- progress:auto start -->',
    '<!-- progress:auto end -->',
    '',
    '## B0 — batch checks',
    '',
    head,
    ...BATCH_ROWS.map(row),
    '',
    ...open.flatMap((m, i) => [`## B${i + 1} — ${m.key}`, '', `_${m.board ?? `${boards}/${m.key}.md`} · ${String(m.base).slice(0, 8)}..${String(m.tip).slice(0, 8)}_`, '', head, ...MODULE_ROWS.map(row), '']),
    '## Todo',
    '- [ ] FIX-n rows are appended under the module they fix',
    '',
  ].join('\n');
}

/* ---------- file format: generated tables for people, one JSON block for the script ---------- */

const BEGIN = '<!-- gate-queue:data start -->';
const END = '<!-- gate-queue:data end -->';

function serialize(state, { trigger = DEFAULT_TRIGGER } = {}) {
  const open = state.modules.filter((m) => m.status === 'BUILT-UNGATED');
  const cell = (e) => (e?.status === 'DONE' ? `DONE @${String(e.sha).slice(0, 8)}` : 'OWED');
  const phases = [...LITE_PHASES, ...GATE_PHASES];
  return [
    '# Gate queue — modules built lite, waiting for their gate batch',
    '',
    `_Written by \`${runHint('gate-queue')}\` only — never by hand. The JSON block at the bottom is the record;`,
    `the tables are generated from it. \`${runHint('gate-queue')} status\` recomputes what is stale._`,
    '',
    `Open: **${open.length}** of cap ${state.cap} · trigger the gate batch at ${trigger}.`,
    '',
    '## Modules',
    '',
    `| Module | Status | Base..tip | ${phases.map((p) => PHASE_NAMES[p]).join(' | ')} |`,
    `|---|---|---|${phases.map(() => '---').join('|')}|`,
    ...state.modules.map((m) => `| ${m.key} | ${m.status} | ${String(m.base).slice(0, 8)}..${String(m.tip).slice(0, 8)} | ${phases.map((p) => cell(m.phases[p])).join(' | ')} |`),
    '',
    '## Batch checks (run once at the batch tip)',
    '',
    '| Check | State | Evidence |',
    '|---|---|---|',
    ...BATCH_CHECKS.map((c) => `| ${PHASE_NAMES[c]} | ${cell(state.batch.checks[c])} | ${state.batch.checks[c]?.evidence ?? '—'} |`),
    '',
    '## Record',
    '',
    BEGIN,
    '```json',
    JSON.stringify(state, null, 2),
    '```',
    END,
    '',
  ].join('\n');
}

function parse(text) {
  const a = text.indexOf(BEGIN);
  const b = text.indexOf(END);
  if (a === -1 || b === -1) throw new Error('gate queue: no data block — the file was edited by hand or truncated');
  return JSON.parse(text.slice(a + BEGIN.length, b).replace(/```json|```/g, '').trim());
}

module.exports = {
  LITE_PHASES, GATE_PHASES, BATCH_CHECKS, BATCH, DEFAULT_CAP, DEFAULT_TRIGGER, PHASE_NAMES,
  config, empty, add, retip, mark, owed, done, close, reset, board, serialize, parse,
};
