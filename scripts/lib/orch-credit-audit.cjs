'use strict';
/**
 * credit-audit — turn the P4 auditor seats (and, with `tester`, the P3 tester seat) of ONE gate-queue key into
 * credit-lane jobs, built from the queue's own record: base..tip, the changed files, the module dir. The
 * orchestrator then prepares each (orch-credit.cjs `prepare`) and starts the credit queue; the lane worker, whose
 * brief says these seats run on credit, stops at P4 with `RESULT: PASS WAIT-P4 <key> @ <sha>` and is resumed once
 * the orchestrator has validated the findings and marked P4.
 *
 * WHY a generator. A credit worker may run only exact named commands — never `git diff <range>` — so every seat's
 * brief has to LIST the files to read. Hand-writing that per seat per module is slow and drifts from the queue's own
 * range. Seat models follow the persona tiers: the standards, security and invariant auditors and the tester on
 * `models.strong`, the vuln auditor on `models.mid` (§16) — the credit lane's floor refuses anything lower.
 *
 * Pure apart from reading `<worktree>/<boards>/_gate-queue.md`.
 */
const fs = require('fs');
const path = require('path');
const queue = require('./gate-queue.cjs');

const SEATS = Object.freeze([
  { kind: 'standards-auditor', tier: 'strong' },
  { kind: 'security-auditor', tier: 'strong' },
  { kind: 'invariant-auditor', tier: 'strong' },
  { kind: 'vuln-auditor', tier: 'mid' },
]);

const short = (sha) => String(sha).slice(0, 8);

/** The queue entry for `key` in the worktree's gate queue. Throws `refused: …` when it cannot be used. */
function entry(worktree, key, settings = {}) {
  const boards = (settings.paths && settings.paths.boards) || 'tasks';
  const file = path.join(worktree, boards, '_gate-queue.md');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (_) {
    throw new Error(`refused: no gate queue at ${file.replace(/\\/g, '/')} — credit-audit runs on a lite module the gate queue holds`);
  }
  const q = queue.parse(text);
  const m = (q.modules || []).find((x) => x.key === key);
  if (!m) throw new Error(`refused: no key "${key}" in ${file.replace(/\\/g, '/')}`);
  if (!m.base || !m.tip) throw new Error(`refused: "${key}" has no base/tip in the gate queue — the lite run never recorded its range`);
  return m;
}

function auditorBrief(m, seat, code, ledgers, runs) {
  return [
    `# P4 audit — seat ${seat} — gate-queue key ${m.key} (read-only, credit lane)`,
    '',
    `You are the **${seat}** seat of the build-module-pipeline P4 step. First read your persona file (the installed`,
    `\`${seat}\` persona) and \`PIPELINE_PROFILE.md\`, and follow them. You make NO code edits.`,
    '',
    '## What to audit',
    `DIFF-RANGE: ${short(m.base)}..${short(m.tip)} (branch ${m.branch || 'the lane branch'}).`,
    'You cannot run `git diff` with a range; read each changed file in full:',
    ...code.map((f) => `- ${f}`),
    ...(m.moduleDir ? [`Module directory: ${m.moduleDir} (read its README and the files above in context).`] : []),
    ...(ledgers.length ? ['Ledger files of the run, for context only (not audited as code):', ...ledgers.map((f) => `- ${f}`)] : []),
    '',
    '## Output — write exactly one file',
    `\`${runs}/${m.key}/findings-${seat}.json\`, in the findings schema your persona names (seat, verdict, findings[] each`,
    `citing a real path:line you read, rulings, notes). Put \`DIFF-RANGE ${short(m.base)}..${short(m.tip)}\` and \`FILES-TOUCHED: none (read-only)\` in its notes.`,
    '',
  ].join('\n');
}

function testerBrief(m, code, runs, boards) {
  return [
    `# P3 test — seat module-tester — gate-queue key ${m.key} (credit lane)`,
    '',
    'You are the **module-tester** seat. First read your persona file (the installed `module-tester` persona) and',
    '`PIPELINE_PROFILE.md`, and follow them. You may write ONLY test files under the scope you were given; report any',
    'production-source defect in your result, never fix it.',
    `Range under test: ${short(m.base)}..${short(m.tip)}; changed files:`,
    ...code.map((f) => `- ${f}`),
    'Run only the commands your allow list names. Record what you ran, with its digest line, in',
    `\`${runs}/${m.key}/state.md\` (append only if it exists) and on the board \`${boards}/${m.key}.md\`.`,
    '',
  ].join('\n');
}

/**
 * The jobs for one key: [{ task, kind, model, scope, brief }].
 * @param {string} worktree  the lane worktree holding the gate queue
 * @param {string} key       the gate-queue key
 * @param {object} o         { tester, seats, settings } — settings = the loaded §16 settings
 */
function plan(worktree, key, { tester = false, seats = SEATS.map((s) => s.kind), settings = {} } = {}) {
  const models = settings.models || {};
  const credit = require('./accounts-registry.cjs').legacyView(settings).credit;
  const testRoots = credit.testRoots || ['test/', 'tests/'];
  const runs = (settings.paths && settings.paths.runs) || '.pipeline';
  const boards = (settings.paths && settings.paths.boards) || 'tasks';
  const unknown = seats.filter((s) => !SEATS.some((x) => x.kind === s));
  if (unknown.length) throw new Error(`refused: unknown seat(s) ${unknown.join(', ')} — P4 seats are ${SEATS.map((s) => s.kind).join(', ')}`);
  const modelOf = (tier) => {
    const m = tier === 'strong' ? models.strong : models.mid || models.strong;
    if (!m) throw new Error(`refused: models.${tier === 'strong' ? 'strong' : 'mid'} is not set in §16 — a seat keeps its tier, and the tier names no model`);
    return m;
  };
  const m = entry(worktree, key, settings);
  const ledgerRes = queue.config(settings).ledgers;
  const files = m.files || [];
  const isLedger = (f) => ledgerRes.some((re) => re.test(f));
  const code = files.filter((f) => !isLedger(f));
  const ledgers = files.filter(isLedger);
  const scope = code.length ? code : [m.moduleDir ? `${m.moduleDir.replace(/\/$/, '')}/**` : '**'];
  const jobs = SEATS.filter((s) => seats.includes(s.kind)).map((s) => ({
    task: `p4-${key}-${s.kind}`, kind: s.kind, model: modelOf(s.tier), scope, brief: auditorBrief(m, s.kind, scope, ledgers, runs),
  }));
  if (tester) {
    const roots = testRoots.map((r) => r.replace(/\/*$/, '/'));
    const testDirs = [...new Set(code.filter((f) => roots.some((r) => f.startsWith(r))).map((f) => `${path.posix.dirname(f)}/**`))];
    jobs.push({
      task: `p3-${key}-module-tester`, kind: 'module-tester', model: modelOf('strong'),
      scope: [...new Set([...testDirs, ...roots.map((r) => `${r}**`)])].sort(), brief: testerBrief(m, scope, runs, boards),
    });
  }
  return jobs;
}

module.exports = { plan, entry, SEATS };
