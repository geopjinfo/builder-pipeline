'use strict';
/**
 * Credit lane — headless workers paid from an API credit balance, for credit jobs only (feature `orchestrator`,
 * sub-setting `credit`; off unless `credit.enabled`).
 *
 * WHY a separate lane. Plan accounts have usage limits; an API credit balance has money. Reading code, fixing
 * records, writing docs, sweeping, and the read-only auditor seats are bounded jobs that can run unattended on
 * credit while the plan accounts build. Building, planning, reviewing and orchestrating stay on the plan accounts —
 * the credit lane refuses them — because those seats make the judgements every other seat is checked against.
 *
 * Unattended means nobody watches the worker, so every guard is mechanical and fails closed:
 *   kinds      only CREDIT_KINDS run here; MAX_SEATS are refused by name.
 *   floor      a kind that writes or audits needs a model at or above its floor: `strong` = models.strong, `mid` =
 *              models.mid or models.strong (§16). Only code-reading may run on anything. An unset model is a refusal.
 *   allow list exact: read tools, Edit/Write on the job's write globs only (its scope + its records, or its records
 *              only for a read-only kind), and NAMED commands (`credit.commands` + `credit.seatCommands.<kind>`), no
 *              wildcards. Forbidden globs (profile `protected`, `credit.forbidden`, the harness's config, and the
 *              files git or the named commands EXECUTE) are denied whatever the scope says.
 *   key source the worker must start on the account it was meant for (the adapter reads the stream's first event);
 *              a plan-account fallback that would bill the credit is stopped before any model call.
 *   scope      after the run every changed file — tracked, untracked AND gitignored (created, touched or deleted) —
 *              must sit in the write globs and never under a forbidden glob, else FAILED-SCOPE.
 *   denials    any permission denial marks the job INCOMPLETE and lists what was denied.
 *   integrity  git config and every hook are hashed before and after; any change is FAILED-INTEGRITY.
 *   result     a run that does not end on `RESULT: PASS` is FAILED — the job's own verdict, never a fallback.
 *   review     a job that changed files is held REVIEW PENDING; `orch merge` refuses its lane until a reviewer
 *              signs it off (`orch credit-review`), or rejects it and its changes are reverted.
 *   caps       per job (`--budget`), per day (`credit.dailyCapUsd`, required) and per period (`credit.periodBudgetUsd`,
 *              optional; the period renews on `renewDay` in the `tzOffsetMinutes` clock). Spend is read from every
 *              finished job's own verdicts — verdict.json and every verdict a re-run moved aside — across every
 *              worktree of the repo, and a RUNNING credit job's budget is reserved until its verdict lands. The cap
 *              check and the reservation are one step under a machine-wide lock, so two runners never both pass on
 *              the same remaining allowance; the caps are hard across parallel runners.
 *   one job    per TARGET worktree at a time, whichever queue it came from (a lock in the machine's orch store); one
 *              runner per queue (`<queue>/runner.lock`, exclusive create, a dead holder taken over).
 *   re-run     `credit-run <run> <task> --rerun` moves the finished verdict aside (`verdict.prev-<stamp>.json`); the
 *              meter keeps it. Refused while its review is PENDING or REJECTED, and after FAILED-INTEGRITY or
 *              FAILED-SCOPE until someone clears the faulted state (`--cleared-by`). A finished job is never re-run
 *              without --rerun: its cost would drop out of the meter.
 *   order      a queue runs the read-only kinds first, the writing kinds last: a writer leaves its folder dirty
 *              until its diff is reviewed, and every later job there would be refused (the refusal names the job
 *              whose verdict left the files).
 *   fallback   a job the credit cannot run (over a cap, credit ran out, an API error, a 429, a key fault) runs on
 *              the next account in `credit.fallback` (secondary, then primary by default). Job faults (denials,
 *              scope, integrity, no RESULT: PASS) never fall back: another account would repeat them.
 *   switch     `orch set workers off` stops every credit start, checked before each job of a queue.
 *
 * Results go to the records (the board, `.pipeline/<key>/state.md` when a pipeline run owns it, else
 * `.pipeline/<key>/credit-lane.md`); `<checkout>/.pipeline/credit/` holds the job's temporary files (task, prompt,
 * settings, stream, verdict). This code never reads, prints or logs an API key: the worker inherits it.
 */
const fs = require('fs');
const { runHint } = require('./run-hint.cjs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawn, spawnSync } = require('child_process');
const { globRe, norm, isUnder } = require('./orch-plan.cjs');
const store = require('./orch-store.cjs');
const ratelimit = require('./orch-ratelimit.cjs');
const { integritySnapshot, integrityDiff } = require('./orch-integrity.cjs');

const WORKERS = { 'claude-code': () => require('./orch-worker-claude-code.cjs'), codex: () => require('./orch-worker-codex.cjs') };
const workerOf = (name) => {
  if (!WORKERS[name]) throw new Error(`refused: unknown credit worker ${JSON.stringify(name)} (known: ${Object.keys(WORKERS).join(', ')})`);
  return WORKERS[name]();
};

const CREDIT_KINDS = Object.freeze({
  'code-reading': { writes: false, floor: 'any' },
  'record-fixes': { writes: true, floor: 'mid' },
  docs: { writes: true, floor: 'mid' },
  sweeps: { writes: true, floor: 'mid' },
  'vuln-auditor': { writes: false, floor: 'mid' },
  'module-tester': { writes: true, floor: 'strong', testsOnly: true },
  'standards-auditor': { writes: false, floor: 'strong' },
  'security-auditor': { writes: false, floor: 'strong' },
  'invariant-auditor': { writes: false, floor: 'strong' },
});
const MAX_SEATS = Object.freeze(['builder', 'planner', 'reviewer', 'orchestrator', 'module-builder', 'module-planner', 'module-reviewer']);
const LIGHT_JOBS = Object.keys(CREDIT_KINDS).join(', ');
/** The P3 tester and the P4 auditor seats a lane's WAIT-P4 hands to credit (orch-credit-audit.cjs builds them). */
const SEAT_KINDS = Object.freeze(['module-tester', 'standards-auditor', 'security-auditor', 'invariant-auditor', 'vuln-auditor']);
/** The light kinds queued as FILL work when the spend lags; the tester and the strong auditor seats are queued per key. */
const FILL_KINDS = Object.freeze(['code-reading', 'record-fixes', 'docs', 'sweeps', 'vuln-auditor']);

/** Files git itself (or a package manager) EXECUTES or obeys: a write there runs worker-written code later. */
const EXECUTED = Object.freeze(['.git', '.git/**', 'node_modules/**', '**/.npmrc', '**/.gitattributes', '**/.gitmodules']);

const ACCOUNT_LABEL = Object.freeze({ credit: 'credit', secondary: 'secondary account', primary: 'primary account' });
const JOB_FAULTS = Object.freeze(['INCOMPLETE', 'FAILED-SCOPE', 'FAILED-INTEGRITY']);
const isJobFault = (v) => JOB_FAULTS.includes(v.status) || v.failure === 'result';
const EXIT = Object.freeze({ COMPLETE: 0, FAILED: 1, REFUSED: 3, INCOMPLETE: 8, 'FAILED-SCOPE': 9, 'REFUSED-KEY-SOURCE': 10, 'FAILED-INTEGRITY': 13 });
const BILLING_STOP_EXIT = 11;
const MAX_RATE_LIMIT_RETRIES = 5;
/** Texts that mean the API credit ran out. Check them against a real out-of-credit error when one is captured. */
const BILLING_PATTERNS = Object.freeze([/credit balance is too low/i, /insufficient credit/i, /\bbilling\b/i]);

const today = () => new Date().toISOString().slice(0, 10);
const matches = (file, globs) => globs.find((g) => globRe(norm(g)).test(norm(file)));

// --------------------------------------------------------------------------------------------- context
/**
 * Everything the lane needs from §16, with the pack defaults under it. `settings` is a loaded profile's settings;
 * tests pass a partial object.
 */
function creditContext(settings = {}) {
  // The api-key account's caps and guards, in the 1.0 credit shape (accounts-registry.cjs legacyView): the headless
  // runner still speaks credit/secondary/primary. The fallback ORDER is the account order of features.accounts (M3).
  const view = require('./accounts-registry.cjs').legacyView(settings);
  const credit = view.credit;
  return {
    credit,
    fallbackAccounts: fallbackOrder(settings),
    models: { strong: null, mid: null, ...(settings.models || {}) },
    paths: { boards: 'tasks', registry: 'DEFERRED_TASKS.md', decisions: 'DECISIONS.md', logs: 'logs', ...(settings.paths || {}) },
    protected: settings.protected || [],
    secondaryConfigDir: view.secondaryConfigDir || null,
  };
}

/**
 * The accounts a refused api-key job may fall back to, by name, in registry order (REQ-303, D46): the api-key account's
 * `guards.fallback` when set, else every plan account that is not the orchestrating session. [] without an api-key
 * account. `credit.fallback` (seat names) is this order mapped through the 1.0 view.
 */
function fallbackOrder(settings = {}) {
  const registry = require('./accounts-registry.cjs');
  if (!registry.accountsOn(settings)) return [];
  const list = registry.list(settings);
  const key = list.find((a) => a.pays === 'api-key');
  if (!key) return [];
  const names = key.guards && Array.isArray(key.guards.fallback) ? key.guards.fallback : list.filter((a) => a.pays !== 'api-key').map((a) => a.name);
  return names.filter((n) => list.some((a) => a.name === n));
}

/** The records a job always may write: its board, its run folder, the registry and the decision log. */
const recordGlobs = (key, paths) => [...new Set([`${paths.boards}/${key}.md`, `${paths.boards}/${key}.html`, `.pipeline/${key}/**`, paths.registry, paths.decisions])];

function forbiddenGlobs(ctx) {
  const worker = workerOf(ctx.credit.worker);
  return [...new Set([...ctx.protected, ...(ctx.credit.forbidden || []), ...EXECUTED, ...worker.CONFIG_GLOBS])];
}

const commandsFor = (kind, ctx) => [...new Set([...(ctx.credit.commands || []), ...(((ctx.credit.seatCommands || {})[kind]) || [])])];

const modelHas = (model, want) => !!want && String(model || '').toLowerCase().includes(String(want).toLowerCase());

/** A job's spec, checked. Throws `refused: …` on any guard. */
function validateTask(t, ctx = creditContext()) {
  if (MAX_SEATS.includes(t.kind)) throw new Error(`refused: ${t.kind} stays on a plan account — the credit lane takes ${LIGHT_JOBS} only`);
  const seat = CREDIT_KINDS[t.kind];
  if (!seat) throw new Error(`refused: unknown credit kind ${JSON.stringify(t.kind)} (${LIGHT_JOBS})`);
  if (seat.floor === 'strong') {
    if (!ctx.models.strong) throw new Error(`refused: ${t.kind} needs models.strong set in §16 — its floor cannot be checked`);
    if (!modelHas(t.model, ctx.models.strong)) throw new Error(`refused: ${t.kind} runs on the strong model (${ctx.models.strong}) — a seat keeps its tier; got ${JSON.stringify(t.model)}`);
  }
  if (seat.floor === 'mid') {
    if (!ctx.models.strong && !ctx.models.mid) throw new Error(`refused: ${t.kind} needs models.mid or models.strong set in §16 — its floor cannot be checked`);
    if (!modelHas(t.model, ctx.models.mid) && !modelHas(t.model, ctx.models.strong)) {
      throw new Error(`refused: ${t.kind} needs the mid model or better (${[ctx.models.mid, ctx.models.strong].filter(Boolean).join(' or ')}) — only code-reading may run below it; got ${JSON.stringify(t.model)}`);
    }
  }
  if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(t.key || '')) throw new Error(`refused: bad record key ${JSON.stringify(t.key)}`);
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(t.task || '')) throw new Error(`refused: bad task id ${JSON.stringify(t.task)}`);
  if (!Array.isArray(t.scope) || !t.scope.length) throw new Error('refused: a credit task needs --scope globs');
  if (seat.testsOnly) {
    const off = t.scope.filter((g) => !isUnder(g, ctx.credit.testRoots));
    if (off.length) throw new Error(`refused: ${t.kind} writes test files only — scope outside ${ctx.credit.testRoots.join(', ')}: ${off.join(', ')}`);
  }
  if (!t.worktree || !fs.existsSync(t.worktree)) throw new Error(`refused: worktree ${t.worktree} does not exist`);
  if (!(Number(t.budgetUsd) > 0)) throw new Error('refused: --budget <usd> must be > 0');
  return t;
}

/** Globs a job may CHANGE: its scope + records when it writes, records only when it reads. */
const writeGlobs = (t, ctx = creditContext()) => [...new Set(CREDIT_KINDS[t.kind].writes ? [...t.scope, ...recordGlobs(t.key, ctx.paths)] : recordGlobs(t.key, ctx.paths))];

function allowList(t, ctx = creditContext()) {
  return workerOf(ctx.credit.worker).allowEntries({ writeGlobs: writeGlobs(t, ctx), commands: commandsFor(t.kind, ctx) });
}

function prompt(t, brief) {
  return [
    `You are a credit-lane worker (kind: ${t.kind}) for task ${t.task} of run ${t.run}; record key ${t.key}.`,
    '',
    '## Brief',
    String(brief).trim(),
    '',
    '## Rules',
    `- You may change only: ${t.writeGlobs.join(', ')}.`,
    `- Never change: ${t.forbidden.join(', ')}. A change there fails the task.`,
    `- Results go to the records: the board for ${t.key}, .pipeline/${t.key}/state.md (append only if it already exists — never create it), the registry and the decision log — only as the brief says.`,
    `- Commands you may run, exactly: ${t.commands.join(' | ') || '(none)'}. Anything else is denied; if a denial blocks the task, stop and name what was denied.`,
    '- Do not commit, push or merge.',
    '',
    '## Evidence rules (every line you write is reviewed against them before it merges)',
    '- Every status or fact you write cites its proof: a `path:line` you read, or the exact command you ran and the output line it printed. No citation, no claim.',
    '- Never write DONE, closed, verified, fixed or passing on reasoning alone. If you did not measure it, write CARRIED (unmeasured) and say what would measure it.',
    '- Never invent a key, an ID, a registry row, a count, a version or a file path. Copy them from where you read them.',
    '- Quote a ruling or a doc; do not paraphrase it into something stronger. If two sources disagree, or none covers the case, write NEEDS-RULING with both citations and stop.',
    '- Change only what the brief asks. No drive-by edits, no reformatting, no rewording of lines you were not asked to touch.',
    '- If you are unsure, say so in the record and end with RESULT: FAIL rather than guess.',
    '',
    '- End with one line: RESULT: PASS <one line> or RESULT: FAIL <one line>. A missing or FAIL result line fails the task.',
    '',
  ].join('\n');
}

// ------------------------------------------------------------------------------------------- files
/** Every worktree of the repo at `cwd`, as resolved paths that still exist. */
function worktreePaths(cwd = process.cwd()) {
  return git(cwd, ['worktree', 'list', '--porcelain']).filter((l) => l.startsWith('worktree ')).map((l) => path.resolve(l.slice(9))).filter((p) => fs.existsSync(p));
}
const pathKey = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
const samePath = (a, b) => pathKey(a) === pathKey(b);
const creditDirOf = (checkout) => path.join(checkout, '.pipeline', 'credit');

function creditRoot(env = process.env, cwd = process.cwd()) {
  if (env.BUILDER_ORCH_CREDIT_DIR) return path.resolve(env.BUILDER_ORCH_CREDIT_DIR);
  return creditDirOf(git(cwd, ['rev-parse', '--show-toplevel'])[0]);
}
/** The task id rule of validateTask holds on EVERY path, so `../x` never reaches the file system. */
const TASK_ID = /^[a-z0-9][a-z0-9-]{1,40}$/;
const taskDir = (root, run, task) => {
  if (!TASK_ID.test(String(task))) throw new Error(`refused: bad task id ${JSON.stringify(task)}`);
  return path.join(store.runDir(root, run), task);
};

/** The checkout holding `cwd` (its toplevel), resolved. */
const checkoutOf = (cwd = process.cwd()) => path.resolve(git(cwd, ['rev-parse', '--show-toplevel'])[0]);

/**
 * `--queue <worktree>` = that checkout's own queue. It must be a worktree of THIS repository: the spend guard sums
 * verdicts over `git worktree list`, so a foreign checkout's queue would spend credit no other runner's cap check sees.
 */
function queueRootOf(worktree, cwd = process.cwd()) {
  const wt = path.resolve(String(worktree));
  if (!fs.existsSync(wt)) throw new Error(`refused: --queue ${worktree} does not exist`);
  const top = checkoutOf(wt);
  if (!worktreePaths(cwd).some((p) => samePath(p, top))) throw new Error(`refused: --queue ${worktree} is not a worktree of this repository (git worktree list) — its spend would be invisible to the cap guard`);
  return creditDirOf(top);
}

/** The command that starts a queue's runner: this checkout's orch, and `--queue` when the queue is another checkout's. */
function launcherCommand({ cwd = process.cwd(), queue } = {}) {
  const here = checkoutOf(cwd);
  const q = queue ? checkoutOf(path.resolve(String(queue))) : here;
  return `${runHint('orch')} credit-run --all-queued${samePath(q, here) ? '' : ` --queue ${q}`}  (from ${here}, in a shell that supplies the API key)`;
}

/**
 * Repo-relative files a brief cites (backticked or bare, a trailing `:line` stripped), whose first segment is a
 * top-level directory of `checkouts` (or `.pipeline`). Globs are skipped. A job runs in its own worktree, so a
 * gitignored file that exists only in the primary checkout is not there for it.
 */
function briefCitedFiles(brief, checkouts = []) {
  const roots = new Set(['.pipeline']);
  for (const c of checkouts) {
    try {
      for (const e of fs.readdirSync(c, { withFileTypes: true })) if (e.isDirectory() && e.name !== '.git' && e.name !== 'node_modules') roots.add(e.name);
    } catch (_) {
      /* gone */
    }
  }
  const out = new Set();
  for (const raw of String(brief).split(/[\s`'"()<>[\]{},;|]+/)) {
    const tok = raw.replace(/\\/g, '/').replace(/^\.\//, '').replace(/#.*$/, '').replace(/[.:!?]+$/, '').replace(/:\d+(?:-\d+)?$/, '').replace(/[.:!?]+$/, '');
    if (!tok || tok.includes('*') || !/^[\w.-]+(?:\/[\w.@-]+)+\.[a-z0-9]+$/i.test(tok)) continue;
    if (roots.has(tok.split('/')[0])) out.add(tok);
  }
  return [...out];
}

/** Cited files absent from the worktree — except a file the job is meant to CREATE (a write glob, never forbidden). */
function briefMissingFiles(brief, worktree, outputs = [], forbidden = [], checkouts = [worktree]) {
  return briefCitedFiles(brief, checkouts).filter((f) => !(matches(f, outputs) && !matches(f, forbidden)) && !fs.existsSync(path.join(worktree, f)));
}

/** Write task.json, prompt.md and settings.json under <credit root>/runs/<run>/<task>/; return the run command. */
function prepare(spec, { root = creditRoot(), brief, allowMissing = false, ctx = creditContext() } = {}) {
  const t = validateTask({ date: today(), ...spec, worktree: path.resolve(spec.worktree) }, ctx);
  const worker = workerOf(ctx.credit.worker);
  t.worker = worker.NAME;
  t.writeGlobs = writeGlobs(t, ctx);
  t.forbidden = forbiddenGlobs(ctx);
  t.commands = commandsFor(t.kind, ctx);
  t.skip = ['node_modules', ctx.paths.logs, '.pipeline/credit'];
  t.review = CREDIT_KINDS[t.kind].writes ? 'on-change' : 'none';
  t.secondaryConfigDir = ctx.secondaryConfigDir;
  t.guardDir = ctx.credit.guardDir || worker.DEFAULT_GUARD_DIR;
  if (!allowMissing) {
    let primary = null;
    try {
      primary = store.primaryRoot(t.worktree);
    } catch (_) {
      /* not a git checkout: the worktree alone */
    }
    const missing = briefMissingFiles(brief, t.worktree, t.writeGlobs, t.forbidden, [t.worktree, primary].filter(Boolean));
    if (missing.length) {
      throw new Error([
        ...missing.map((f) => `refused: brief cites ${f}, which is not in ${t.worktree} (gitignored files must be copied in first)`),
        '  copy each into the job folder, or re-run credit-prep with --allow-missing',
      ].join('\n'));
    }
  }
  const dir = taskDir(root, t.run, t.task);
  fs.mkdirSync(dir, { recursive: true });
  const files = { task: path.join(dir, 'task.json'), prompt: path.join(dir, 'prompt.md'), settings: path.join(dir, 'settings.json') };
  fs.writeFileSync(files.task, JSON.stringify(t, null, 2) + '\n');
  fs.writeFileSync(files.prompt, prompt(t, brief));
  fs.writeFileSync(files.settings, JSON.stringify(worker.settings({ allow: worker.allowEntries({ writeGlobs: t.writeGlobs, commands: t.commands }), deny: worker.denyEntries({ forbidden: t.forbidden }) }), null, 2) + '\n');
  return { dir, files, command: `${runHint('orch')} credit-run ${t.run} ${t.task}` };
}

// ------------------------------------------------------------------------------------------- scope
/** An executable on an ABSOLUTE PATH entry only (a cwd-first lookup would run a worker-written git). */
function whichAbs(name, env = process.env) {
  const exts = process.platform === 'win32' ? ['.exe', '.com'] : [''];
  for (const d of String(env.PATH || env.Path || '').split(path.delimiter).filter((p) => p && path.isAbsolute(p))) {
    for (const x of exts) {
      const f = path.join(d, name + x);
      if (fs.existsSync(f)) return f;
    }
  }
  return null;
}
let gitBin = null;
function git(cwd, args) {
  gitBin = gitBin || whichAbs('git');
  if (!gitBin) throw new Error('refused: no git executable on an absolute PATH entry');
  const r = spawnSync(gitBin, args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${(r.stderr || '').trim()}`);
  return r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

/** Every gitignored file (bar `skip`) with its mtime — git diff cannot see them. */
function ignoredSnapshot(worktree, skip = []) {
  const snap = {};
  const pathspec = ['.', ...skip.filter(Boolean).map((d) => `:(exclude)${d}`)];
  for (const f of git(worktree, ['ls-files', '--others', '--ignored', '--exclude-standard', '--', ...pathspec])) {
    try {
      snap[norm(f)] = fs.statSync(path.join(worktree, f)).mtimeMs;
    } catch (_) {
      /* raced */
    }
  }
  return snap;
}

/** Every file changed since `base`: tracked diffs, untracked files, and ignored files created, touched or deleted. */
function changedFiles(worktree, base, before = {}, skip = []) {
  const after = ignoredSnapshot(worktree, skip);
  const files = new Set([
    ...git(worktree, ['diff', '--name-only', base]),
    ...git(worktree, ['ls-files', '--others', '--exclude-standard']),
    ...Object.keys(after).filter((f) => before[f] !== after[f]),
    ...Object.keys(before).filter((f) => !(f in after)),
  ]);
  return [...files].map(norm).sort();
}

/** Forbidden wins over any scope; anything else must sit in the job's write globs. */
function scopeFaults(files, allowed, forbidden) {
  const faults = [];
  for (const f of files) {
    const bad = matches(f, forbidden);
    if (bad) faults.push(`${f}: forbidden path (${bad})`);
    else if (!matches(f, allowed)) faults.push(`${f}: outside the task scope`);
  }
  return faults;
}

function statusOf({ keyFault, integrity = [], scope, denied, succeeded, resultLine }) {
  if (keyFault) return 'REFUSED-KEY-SOURCE';
  if (integrity.length) return 'FAILED-INTEGRITY';
  if (scope.length) return 'FAILED-SCOPE';
  if (denied.length) return 'INCOMPLETE';
  if (!succeeded) return 'FAILED';
  if (!/^RESULT: PASS\b/.test(resultLine || '')) return 'FAILED';
  return 'COMPLETE';
}

/**
 * Why a finished job failed: 'result' | 'rate-limit' | 'billing' | 'other', or null when COMPLETE. Only an API
 * failure is read (a failed run's error texts plus stderr) — a model's own answer that mentions billing is not an
 * API error. A 429 is never billing; anything unknown is 'other', never billing.
 */
function classifyFailure(status, { succeeded = false, resultLine, errorTexts = [], stderrText = '' } = {}) {
  if (status === 'COMPLETE') return null;
  if (status !== 'FAILED') return 'other';
  if (succeeded && !/^RESULT: PASS\b/.test(resultLine || '')) return 'result';
  const texts = [stderrText, ...errorTexts];
  if (texts.some((x) => ratelimit.isRateLimit(x))) return 'rate-limit';
  return texts.some((x) => BILLING_PATTERNS.some((re) => re.test(x))) ? 'billing' : 'other';
}

function appendRecord(t, v) {
  // append to state.md only when a pipeline run already owns it; a key with no run gets its own credit-lane.md
  const stateMd = path.join(t.worktree, '.pipeline', t.key, 'state.md');
  const file = fs.existsSync(stateMd) ? stateMd : path.join(path.dirname(stateMd), 'credit-lane.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fb = v.account && v.account !== 'credit';
  const lines = [
    '', `## credit-lane ${t.run}/${t.task} — ${v.finishedAt} — ${v.status}${fb ? ` (fallback: ${ACCOUNT_LABEL[v.account]})` : ''}`,
    `- kind ${t.kind} · model ${t.model} · budget $${t.budgetUsd} · cost ${v.costUsd == null ? 'unreported' : `$${v.costUsd}`}${fb ? ' (plan account, not credit)' : ''} · base ${v.base.slice(0, 8)}`,
    ...(v.review === 'PENDING' ? ['- review: PENDING — it changed files; `orch credit-review` must sign it off before its lane merges'] : []),
    `- worker result: ${v.resultLine || '(none)'}`,
    ...(v.startError ? [`- worker did not start: ${v.startError}`] : []),
    ...(v.failure ? [`- failure: ${v.failure}${v.billingStop ? ' — billing stop: the credit queue halts here' : ''}`] : []),
    ...(v.keyFault ? [`- key source: ${v.keyFault}`] : []),
    ...(v.integrity && v.integrity.length ? [`- git config/hooks changed (${v.integrity.length}): ${v.integrity.join(' · ')}`] : []),
    ...(v.denied.length ? [`- denied (${v.denied.length}): ${v.denied.join(' · ')}`] : []),
    ...(v.scope.length ? [`- scope faults (${v.scope.length}): ${v.scope.join(' · ')}`] : []),
    `- changed: ${v.changed.join(', ') || 'none'}`,
  ];
  fs.appendFileSync(file, lines.join('\n') + '\n');
  return file;
}

// ---------------------------------------------------------------------------------- workers switch
const WORKER_MODES = Object.freeze(['off', 'credit']);
const workersFile = (root) => path.join(root, 'workers.json');
/** No file = 'credit' (as the profile enables it); an unreadable switch fails closed ('off'). */
function workersMode(root) {
  try {
    const m = JSON.parse(fs.readFileSync(workersFile(root), 'utf8')).mode;
    return WORKER_MODES.includes(m) ? m : 'off';
  } catch (e) {
    return e.code === 'ENOENT' ? 'credit' : 'off';
  }
}
const workersIsDefault = (root) => !fs.existsSync(workersFile(root));
function setWorkers(root, mode) {
  if (!WORKER_MODES.includes(mode)) throw new Error(`usage: set workers ${WORKER_MODES.join('|')}`);
  fs.mkdirSync(root, { recursive: true });
  store.writeJsonAtomic(workersFile(root), { mode, at: new Date().toISOString() });
  return mode;
}
const refuseWhenOff = (root) => {
  if (workersMode(root) === 'off') throw new Error('refused: workers are off (orch set workers credit to turn them on)');
};

/**
 * Who left a worktree dirty. A writing job's edits refuse every later job in its folder until its diff is reviewed,
 * and the refusal used to not say why. The porcelain paths are matched against the `changed` list of every credit
 * verdict for that worktree (any queue, moved-aside verdicts too); the match names the job and its review state. ''
 * when no credit job left them.
 */
function dirtLeftBy(root, worktree, porcelain) {
  const files = new Set(porcelain.map((l) => norm(l.replace(/^\S+\s+/, '').replace(/^.* -> /, '').replace(/^"|"$/g, ''))));
  const hits = [];
  let roots = [root];
  try {
    roots = allCreditRoots({ root, cwd: worktree });
  } catch (_) {
    /* this queue only */
  }
  for (const r of roots) {
    for (const { run, task, dir } of taskDirs(r)) {
      let wt = null;
      try {
        wt = JSON.parse(fs.readFileSync(path.join(dir, 'task.json'), 'utf8')).worktree;
      } catch (_) {
        /* none */
      }
      if (!wt || !samePath(wt, worktree)) continue;
      for (const vf of verdictFiles(dir)) {
        let v;
        try {
          v = JSON.parse(fs.readFileSync(vf.file, 'utf8'));
        } catch (_) {
          continue;
        }
        const mine = (v.changed || []).map(norm).filter((c) => files.has(c));
        if (mine.length) hits.push(`${run}/${task}${vf.live ? '' : ` [${path.basename(vf.file)}]`} (review ${v.review || 'not recorded'}: ${mine.join(', ')})`);
      }
    }
  }
  return hits.length ? ` — left by credit job ${hits.join(', ')}` : '';
}

const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

/**
 * One credit job per TARGET worktree at a time, whichever queue it came from: two runners in one worktree would each
 * absorb the other's edits into their `changed` list (and review hold). The lock lives in the machine's orch store,
 * never in the target (where it would be a change of its own); read → dead holder? → unlink → create is one step
 * under a guard lock, so a second taker that read the same dead holder finds the fresh lock instead of deleting it.
 */
const targetLockFile = (env, worktree) => path.join(store.orchRoot(env), 'credit-targets', `${require('crypto').createHash('sha1').update(pathKey(worktree)).digest('hex').slice(0, 16)}.lock`);
function takeTargetLock(env, worktree, job) {
  const f = targetLockFile(env, worktree);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  return store.withLock(`${f}.guard`, () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        fs.writeFileSync(f, JSON.stringify({ pid: process.pid, job, worktree, at: new Date().toISOString() }), { flag: 'wx' });
        return f;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
      let held = {};
      try {
        held = JSON.parse(fs.readFileSync(f, 'utf8'));
      } catch (_) {
        /* torn: treat as stale */
      }
      if (Number.isInteger(held.pid) && pidAlive(held.pid)) throw new Error(`refused: another credit job (${held.job || '?'}, pid ${held.pid}) is running in ${worktree} — one job per worktree at a time`);
      try {
        fs.unlinkSync(f);
      } catch (_) {
        /* gone */
      }
    }
    throw new Error(`refused: could not take the worktree lock for ${worktree}`);
  }, { waitMs: 15000, staleMs: 60000 });
}

const reservationFile = (root, run, task) => path.join(taskDir(root, run, task), 'running.json');
const writeReservation = (file, budgetUsd, flag = 'w') => fs.writeFileSync(file, JSON.stringify({ pid: process.pid, budgetUsd: Number(budgetUsd), account: 'credit', startedAt: new Date().toISOString() }), { flag });
const dropReservation = (file) => {
  try {
    fs.unlinkSync(file);
  } catch (_) {
    /* gone */
  }
};

// --------------------------------------------------------------------------------------------- run
/**
 * Start one job on one account, guard it, judge it. Resolves the verdict (also written to verdict.json). The job file
 * is validated again here (it may have been edited since credit-prep), the target worktree is locked for the run, and
 * a credit attempt keeps its budget reserved (`running.json`) until its verdict lands — only credit reserves: a plan
 * account never bills the credit.
 */
async function runTask(opts) {
  const { root = creditRoot(), run, task, env = process.env, account = 'credit', ctx = creditContext() } = opts;
  refuseWhenOff(root);
  if (!ACCOUNT_LABEL[account]) throw new Error(`refused: unknown account ${JSON.stringify(account)}`);
  const dir = taskDir(root, run, task);
  const t = validateTask(JSON.parse(fs.readFileSync(path.join(dir, 'task.json'), 'utf8')), ctx);
  const lock = takeTargetLock(env, t.worktree, `${run}/${task}`);
  const reservation = path.join(dir, 'running.json');
  try {
    if (account === 'credit') {
      try {
        writeReservation(reservation, t.budgetUsd, 'wx'); // the locked cap check (runWithFallback) normally wrote it already
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
    } else dropReservation(reservation);
    return await runTaskLocked({ ...opts, root, env, account }, dir, t);
  } finally {
    dropReservation(reservation);
    try {
      fs.unlinkSync(lock);
    } catch (_) {
      /* gone */
    }
  }
}

async function runTaskLocked({ root, run, task, env, account, priorAttempts = [] }, dir, t) {
  const worker = workerOf(t.worker);
  const home = env.USERPROFILE || env.HOME || os.homedir();
  if (account === 'credit') {
    const guard = path.join(home, t.guardDir || worker.DEFAULT_GUARD_DIR);
    fs.mkdirSync(guard, { recursive: true });
    const gf = worker.guardDirFaults(guard);
    if (gf.length) throw new Error(`refused: guard config dir is not clean — ${gf.join('; ')}`);
  }
  const childEnv = worker.env(env, home, account, { guardDir: t.guardDir, secondaryConfigDir: t.secondaryConfigDir });
  const sfx = account === 'credit' ? '' : `-${account}`; // a fallback attempt never overwrites the credit attempt's files
  const dirty = git(t.worktree, ['status', '--porcelain', '--untracked-files=all']); // every file, not a new dir's name: dirtLeftBy matches them
  if (dirty.length) throw new Error(`refused: worktree ${t.worktree} is dirty${dirtLeftBy(root, t.worktree, dirty)} — a credit task starts clean so every change is its own`);
  const base = git(t.worktree, ['rev-parse', 'HEAD'])[0];
  const before = ignoredSnapshot(t.worktree, t.skip);
  const integrityBefore = integritySnapshot(t.worktree, { gitBin: gitBin || whichAbs('git') });

  const bin = worker.resolveBin(env);
  const argv = worker.args(t, path.join(dir, 'settings.json'));
  const [cmd, args] = /\.(c|m)?js$/.test(bin) ? [process.execPath, [bin, ...argv]] : [bin, argv];
  const streamFile = path.join(dir, `stream${sfx}.jsonl`);
  fs.writeFileSync(streamFile, '');
  const child = spawn(cmd, args, { cwd: t.worktree, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  fs.createReadStream(path.join(dir, 'prompt.md')).pipe(child.stdin);
  const stderrFile = path.join(dir, `stderr${sfx}.log`);
  const stderrOut = fs.createWriteStream(stderrFile);
  const stderrDone = new Promise((res) => {
    stderrOut.on('close', res);
    stderrOut.on('error', res);
  });
  child.stderr.pipe(stderrOut);

  const expected = worker.KEY_SOURCE[account];
  const events = [];
  let keyState = null;
  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    fs.appendFileSync(streamFile, line + '\n');
    let ev;
    try {
      ev = JSON.parse(line);
    } catch (_) {
      return;
    }
    events.push(ev);
    if (keyState === null) {
      keyState = worker.keySourceVerdict(events, expected);
      if (keyState && keyState !== 'ok') child.kill();
    }
  });
  let spawnError = null;
  child.on('error', (e) => {
    spawnError = e.message;
  });
  const exitCode = await new Promise((res) => child.on('close', (code) => res(code)));
  await stderrDone;
  if (keyState === null) keyState = worker.keySourceVerdict(events, expected) || 'stream ended before its first event — no key source seen';

  const keyFault = keyState === 'ok' ? null : keyState;
  const result = worker.resultOf(events);
  let changed = [];
  let scope;
  try {
    changed = changedFiles(t.worktree, base, before, t.skip);
    scope = scopeFaults(changed, t.writeGlobs, t.forbidden);
  } catch (e) {
    scope = [`scope check could not run — ${e.message}`]; // fail closed: never a pass, never a missing verdict
  }
  let integrity;
  try {
    integrity = integrityDiff(integrityBefore, integritySnapshot(t.worktree, { gitBin: gitBin || whichAbs('git') }));
  } catch (e) {
    integrity = [`integrity check could not run — ${e.message}`];
  }
  const succeeded = worker.runSucceeded(result, exitCode);
  const v = {
    run, task, key: t.key, account, base, exitCode, keyFault, startError: spawnError, integrity,
    denied: worker.denials(events), scope, changed,
    costUsd: worker.streamCost(events, keyFault),
    resultLine: worker.resultLine(result),
    finishedAt: new Date().toISOString(),
  };
  v.status = statusOf({ ...v, succeeded });
  v.exit = EXIT[v.status];
  let stderrText = '';
  try {
    stderrText = fs.readFileSync(stderrFile, 'utf8');
  } catch (_) {
    /* none */
  }
  v.failure = classifyFailure(v.status, { succeeded, resultLine: v.resultLine, errorTexts: worker.errorTexts(result), stderrText });
  v.billingStop = account === 'credit' && v.failure === 'billing';
  v.review = t.review === 'on-change' && v.changed.length ? 'PENDING' : 'NOT-NEEDED';
  if (priorAttempts.length) v.attempts = priorAttempts;
  fs.writeFileSync(path.join(dir, 'verdict.json'), JSON.stringify(v, null, 2) + '\n');
  v.record = appendRecord(t, v);
  return v;
}

// ------------------------------------------------------------------------------------------ spend
const DAY_MS = 86400000;
const round6 = (x) => Math.round(x * 1e6) / 1e6;
const round2 = (x) => Math.round(x * 100) / 100;
const usd2 = (x) => `$${Number(x).toFixed(2)}`;
const LAST_WEEK_DAYS = 7;
const UNDERUSE_MARGIN_USD = 10;

/** The period holding `date` in the configured clock: [renewDay 00:00, next renewDay 00:00) as UTC ISO. */
function periodBounds(date, { renewDay = 1, tzOffsetMinutes = 0 } = {}) {
  const tz = tzOffsetMinutes * 60000;
  const local = new Date(new Date(date).getTime() + tz);
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth() - (local.getUTCDate() < renewDay ? 1 : 0);
  return { start: new Date(Date.UTC(y, m, renewDay) - tz).toISOString(), end: new Date(Date.UTC(y, m + 1, renewDay) - tz).toISOString() };
}
function periodLabel(p, { tzOffsetMinutes = 0 } = {}) {
  const tz = tzOffsetMinutes * 60000;
  const day = (ms) => new Date(ms + tz).toISOString().slice(0, 10);
  return { first: day(Date.parse(p.start)), last: day(Date.parse(p.end) - DAY_MS) };
}
const daysLeftIn = (p, date, { tzOffsetMinutes = 0 } = {}) => {
  const tz = tzOffsetMinutes * 60000;
  return Math.floor((Date.parse(p.end) + tz) / DAY_MS) - Math.floor((new Date(date).getTime() + tz) / DAY_MS);
};
/** The calendar day holding `date` in the configured clock. */
function dayBounds(date, { tzOffsetMinutes = 0 } = {}) {
  const tz = tzOffsetMinutes * 60000;
  const startMs = Math.floor((new Date(date).getTime() + tz) / DAY_MS) * DAY_MS - tz;
  return { start: new Date(startMs).toISOString(), end: new Date(startMs + DAY_MS).toISOString() };
}

/** The money settings, checked. A value that is not a number is refused, never guessed. */
function creditConfig(c) {
  const num = (name, v, { min = 0, allowNull = false } = {}) => {
    if (v === null || v === undefined) {
      if (allowNull) return null;
      throw new Error(`refused: features.orchestrator.credit.${name} is not set`);
    }
    const n = Number(v);
    if (!Number.isFinite(n) || n < min) throw new Error(`refused: features.orchestrator.credit.${name} is not a number >= ${min}`);
    return n;
  };
  const renewDay = num('renewDay', c.renewDay ?? 1, { min: 1 });
  if (!Number.isInteger(renewDay) || renewDay > 28) throw new Error('refused: features.orchestrator.credit.renewDay must be a whole day 1-28');
  const dailyCapUsd = num('dailyCapUsd', c.dailyCapUsd);
  if (!(dailyCapUsd > 0)) throw new Error('refused: features.orchestrator.credit.dailyCapUsd must be > 0'); // 0 would read as "no cap" to one reader and "spend nothing" to another
  return {
    dailyCapUsd,
    periodBudgetUsd: num('periodBudgetUsd', c.periodBudgetUsd, { allowNull: true }),
    reserveUsd: num('reserveUsd', c.reserveUsd ?? 0),
    renewDay,
    tzOffsetMinutes: Number(c.tzOffsetMinutes) || 0,
    lapses: !!c.lapses,
  };
}

/**
 * What a verdict cost the CREDIT: its credit attempts only. A verdict with no `account` is credit. Plan-account
 * attempts report a notional cost that is never billed to the credit. null = a credit attempt's cost is unknown.
 */
function creditCost(dir, v) {
  let sum = 0;
  // >= 0: a negative cost in a worktree's verdict file would lower the spend and raise the allowance
  const valid = (c) => c !== null && c !== undefined && c !== '' && Number.isFinite(Number(c)) && Number(c) >= 0;
  for (const a of v.attempts || []) if ((a.account || 'credit') === 'credit' && valid(a.costUsd)) sum += Number(a.costUsd);
  if ((v.account || 'credit') !== 'credit') return sum;
  if (valid(v.costUsd)) return sum + Number(v.costUsd);
  return sum || null;
}

/**
 * Every verdict a job dir holds: the live `verdict.json` and the ones `--rerun` moved aside (`verdict.prev-<stamp>.json`,
 * or `verdict.pass<n>.json` renamed by hand). The meter counts them all — moving a verdict aside must never drop its
 * cost — and a moved verdict still PENDING or REJECTED still holds its lane.
 */
const VERDICT_FILE = /^verdict(?:\.(prev-[0-9A-Za-z-]+|pass\d+))?\.json$/;
function verdictFiles(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch (_) {
    return [];
  }
  return names.map((n) => VERDICT_FILE.exec(n)).filter(Boolean).map((m) => ({ file: path.join(dir, m[0]), live: !m[1] }));
}

/** `--rerun` stamp: verdict.prev-20261015T061500Z.json. */
const prevStamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

/** verdict.json + its stream/stderr files → *.prev-<stamp>.*: the job is queued again, the meter keeps counting it. */
function moveVerdictAside(dir, now = new Date()) {
  const stamp = prevStamp(now);
  const moved = [];
  for (const n of fs.readdirSync(dir)) {
    if (!(n === 'verdict.json' || /^stream(-[a-z]+)?\.jsonl$/.test(n) || /^stderr(-[a-z]+)?\.log$/.test(n))) continue;
    const to = n.replace(/(\.[^.]+)$/, `.prev-${stamp}$1`);
    fs.renameSync(path.join(dir, n), path.join(dir, to));
    moved.push(`${n} → ${to}`);
  }
  return { stamp, moved, verdictTo: `verdict.prev-${stamp}.json` };
}

/**
 * `credit-run <run> <task> --rerun`: move the finished job's verdict aside so the task is queued again. Refused while
 * its review is PENDING or REJECTED (a rename must never launder the review hold), and after FAILED-INTEGRITY or
 * FAILED-SCOPE until `clearedBy` names who restored git config/hooks and removed the stray files — the next run would
 * otherwise take the faulted state as its clean baseline.
 */
function requeue({ root = creditRoot(), run, task, now = new Date(), clearedBy }) {
  const dir = taskDir(root, run, task);
  if (!fs.existsSync(path.join(dir, 'task.json'))) throw new Error(`refused: no credit task ${run}/${task} in ${root}`);
  const f = path.join(dir, 'verdict.json');
  let v;
  try {
    v = JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (_) {
    throw new Error(`refused: ${run}/${task} has no verdict to move aside — it is already queued`);
  }
  if (v.review === 'PENDING') throw new Error(`refused: ${run}/${task} review is PENDING — sign it off (orch credit-review) before it runs again`);
  if (v.review === 'REJECTED') throw new Error(`refused: ${run}/${task} review is REJECTED — revert its changes and record it (orch credit-review --reverted) before it runs again`);
  if ((v.status === 'FAILED-INTEGRITY' || v.status === 'FAILED-SCOPE') && !clearedBy) {
    throw new Error(`refused: ${run}/${task} ended ${v.status} — restore git config/hooks and remove the stray files, then --rerun --cleared-by <who> (the next run would take the faulted state as its baseline)`);
  }
  if (clearedBy) {
    v.clearedBy = String(clearedBy);
    v.clearedAt = now.toISOString();
    fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n');
  }
  return { dir, ...moveVerdictAside(dir, now) };
}

/**
 * The budgets of RUNNING credit jobs (their `running.json`, removed with the verdict): a parallel runner's allowance
 * counts them. A reservation whose pid is gone is ignored (the runner died; its verdict, if any, is counted as spend).
 */
function reservedUsd({ root, cwd = process.cwd(), alive = pidAlive }) {
  let sum = 0;
  for (const r of allCreditRoots({ root, cwd })) {
    for (const { dir } of taskDirs(r)) {
      let res;
      try {
        res = JSON.parse(fs.readFileSync(path.join(dir, 'running.json'), 'utf8'));
      } catch (_) {
        continue;
      }
      if ((res.account || 'credit') !== 'credit') continue;
      if (Number.isInteger(res.pid) && alive(res.pid) && Number(res.budgetUsd) > 0) sum += Number(res.budgetUsd);
    }
  }
  return round6(sum);
}

/** Every task dir under root/runs/<run>/<task>, with its task.json mtime (0 when there is none). */
function taskDirs(root) {
  const out = [];
  const runsDir = path.join(root, 'runs');
  let runs = [];
  try {
    runs = fs.readdirSync(runsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (_) {
    return out;
  }
  for (const r of runs) {
    let tasks = [];
    try {
      tasks = fs.readdirSync(path.join(runsDir, r), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch (_) {
      continue;
    }
    for (const task of tasks) {
      const dir = path.join(runsDir, r, task);
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(path.join(dir, 'task.json')).mtimeMs;
      } catch (_) {
        /* no task.json */
      }
      out.push({ run: r, task, dir, mtimeMs });
    }
  }
  return out;
}

/** `root` plus every worktree's credit dir (jobs live in lane worktrees), de-duplicated. */
function allCreditRoots({ root, cwd = process.cwd() }) {
  let wts = [];
  try {
    wts = worktreePaths(cwd);
  } catch (_) {
    /* not a git checkout */
  }
  const seen = new Map();
  for (const r of [root, ...wts.map(creditDirOf)]) if (r && !seen.has(pathKey(r))) seen.set(pathKey(r), r);
  return [...seen.values()];
}

/** Spend inside `period` across ALL worktrees: each verdict (live or moved aside) counted once (by real path). */
function periodSpend({ root, cwd = process.cwd(), period }) {
  const lo = Date.parse(period.start);
  const hi = Date.parse(period.end);
  const seen = new Set();
  const out = { spent: 0, jobs: 0, unreported: [] };
  for (const r of allCreditRoots({ root, cwd })) {
    for (const { dir } of taskDirs(r)) {
      for (const { file: f } of verdictFiles(dir)) {
        let real;
        try {
          real = pathKey(fs.realpathSync.native(f));
        } catch (_) {
          continue;
        }
        if (seen.has(real)) continue;
        seen.add(real);
        let v;
        try {
          v = JSON.parse(fs.readFileSync(f, 'utf8'));
        } catch (_) {
          continue;
        }
        const at = Date.parse(v.finishedAt);
        if (!(at >= lo && at < hi)) continue;
        out.jobs++;
        const cost = creditCost(dir, v);
        if (cost === null) out.unreported.push(f);
        else out.spent += cost;
      }
    }
  }
  out.spent = round6(out.spent);
  return out;
}

/** The guard's view at `date`: today's spend against the daily cap, the period's against its budget, and the allowance. */
function spendDown(root, date, cfgIn, cwd = process.cwd()) {
  const cfg = creditConfig(cfgIn);
  const period = periodBounds(date, cfg);
  const s = periodSpend({ root, cwd, period });
  const reserve = daysLeftIn(period, date, cfg) <= LAST_WEEK_DAYS ? 0 : cfg.reserveUsd;
  const periodAllowance = cfg.periodBudgetUsd === null ? Infinity : Math.max(0, round6(cfg.periodBudgetUsd - s.spent - reserve));
  const todaySpent = periodSpend({ root, cwd, period: dayBounds(date, cfg) }).spent;
  const dailyLeft = Math.max(0, round6(cfg.dailyCapUsd - todaySpent));
  const reserved = reservedUsd({ root, cwd }); // running credit jobs hold their budgets
  return {
    period, budget: cfg.periodBudgetUsd, ...s, reserve, periodAllowance, dailyCap: cfg.dailyCapUsd, todaySpent, dailyLeft, reserved,
    allowance: Math.max(0, round6(Math.min(periodAllowance, dailyLeft) - reserved)), limitedBy: dailyLeft < periodAllowance ? 'day' : 'period', cfg,
  };
}

/** `orch credit` — the status block and the pressure line. */
function creditStatus({ root, cwd = process.cwd(), date = new Date(), credit }) {
  const d = spendDown(root, date, credit, cwd);
  const daysLeft = daysLeftIn(d.period, date, d.cfg);
  const left = d.budget === null ? null : round2(Math.max(0, d.budget - d.spent));
  const span = Date.parse(d.period.end) - Date.parse(d.period.start);
  return {
    ...d, left, daysLeft, label: periodLabel(d.period, d.cfg),
    elapsed: Math.min(1, Math.max(0, (new Date(date).getTime() - Date.parse(d.period.start)) / span)),
    pace: left === null ? null : daysLeft > 0 ? round2(left / daysLeft) : left,
    queuedHere: queuedTasks(root).length,
    fillCandidates: (() => {
      try {
        return fillCandidates({ cwd });
      } catch (_) {
        return [];
      }
    })(),
  };
}

const DEFAULT_FILL = Object.freeze(['a ledger-audit batch over the boards (sweeps)', 'record fixes on the deferred registry (record-fixes)', 'docs owed by queued keys (docs)']);

/**
 * Concrete light jobs to queue now, read from the repo at `cwd`: the lite-split gate queue's BUILT-UNGATED keys (in
 * every worktree) whose P5 docs are still owed, then the standing fill work. Unreadable sources drop out; nothing here
 * prepares or runs a job.
 */
function fillCandidates({ cwd = process.cwd(), settings = null } = {}) {
  const out = [];
  let top = cwd;
  try {
    top = checkoutOf(cwd);
  } catch (_) {
    /* not a checkout */
  }
  let boards = 'tasks';
  try {
    boards = ((settings || require('./profile.cjs').load(top).settings).paths || {}).boards || boards;
  } catch (_) {
    /* defaults */
  }
  const keys = [];
  let wts = [top];
  try {
    wts = worktreePaths(top);
  } catch (_) {
    /* this checkout only */
  }
  for (const wt of wts) {
    let q;
    try {
      q = require('./gate-queue.cjs').parse(fs.readFileSync(path.join(wt, boards, '_gate-queue.md'), 'utf8'));
    } catch (_) {
      continue;
    }
    for (const m of q.modules || []) if (m.status === 'BUILT-UNGATED' && !(m.phases && m.phases['5'] && m.phases['5'].status === 'DONE') && !keys.includes(m.key)) keys.push(m.key);
  }
  if (keys.length) out.push(`P5 docs of ${keys.join(', ')} (docs)`);
  return [...out, ...DEFAULT_FILL.filter((d) => !(keys.length && d.startsWith('docs owed')))];
}

/**
 * Is the credit lane busy for a lane in `laneWorktree`? Null (not busy) whenever the lane already has a SEAT job
 * (SEAT_KINDS) of its own in any queue — unfinished, or prepared since `since` (its WAIT-P4 result) even if finished:
 * its seats are on credit, and a SELF-AUDIT would run them twice; a docs or sweeps job runs no seat. Otherwise busy
 * while a live runner (`<queue>/runner.lock`) holds unfinished jobs for another worktree, or while jobs for another
 * worktree are queued. Returns the reason, or null. `alive` is injected by the tests.
 */
function creditBusy({ cwd = process.cwd(), laneWorktree, since, alive = pidAlive } = {}) {
  let wts = [];
  try {
    wts = worktreePaths(cwd);
  } catch (_) {
    return null;
  }
  const task = (dir) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, 'task.json'), 'utf8'));
    } catch (_) {
      return null;
    }
  };
  const foreign = (dir) => {
    const w = (task(dir) || {}).worktree;
    return !(w && laneWorktree && samePath(w, laneWorktree));
  };
  const seatJob = (dir) => SEAT_KINDS.includes((task(dir) || {}).kind);
  const unfinished = (wt) => taskDirs(creditDirOf(wt)).filter((d) => d.mtimeMs && !fs.existsSync(path.join(d.dir, 'verdict.json')));
  if (laneWorktree && wts.some((wt) => unfinished(wt).some((d) => !foreign(d.dir) && seatJob(d.dir)))) return null;
  const sinceMs = since ? Date.parse(since) : NaN;
  if (laneWorktree && Number.isFinite(sinceMs) && wts.some((wt) => taskDirs(creditDirOf(wt)).some((d) => d.mtimeMs >= sinceMs && !foreign(d.dir) && seatJob(d.dir)))) return null;
  for (const wt of wts) {
    let pid = null;
    try {
      pid = Number(JSON.parse(fs.readFileSync(path.join(creditDirOf(wt), 'runner.lock'), 'utf8')).pid);
    } catch (_) {
      continue;
    }
    if (!(Number.isInteger(pid) && pid > 0 && alive(pid))) continue;
    const n = unfinished(wt).filter((d) => foreign(d.dir)).length;
    if (n) return `runner pid ${pid} live for the queue in ${wt} (${n} job(s) for another worktree)`;
  }
  const others = new Map();
  for (const wt of wts) {
    for (const q of queuedTasks(creditDirOf(wt))) {
      if (!foreign(q.dir)) continue;
      const k = (task(q.dir) || {}).worktree || '(unknown worktree)';
      others.set(k, (others.get(k) || 0) + 1);
    }
  }
  if (!others.size) return null;
  const n = [...others.values()].reduce((a, b) => a + b, 0);
  return `${n} job(s) queued for another worktree (${[...others.keys()].join(', ')})`;
}

const statusLine = (st) =>
  `credit period ${st.label.first}…${st.label.last} · budget ${st.budget === null ? 'none (daily cap only)' : usd2(st.budget)} · spent ${usd2(st.spent)} (${st.jobs} job${st.jobs === 1 ? '' : 's'})`
  + `${st.left === null ? '' : ` · left ${usd2(st.left)} · ${st.daysLeft} day(s) to renewal · pace needed ${usd2(st.pace)}/day`}`
  + ` · today ${usd2(st.todaySpent)} of ${usd2(st.dailyCap)} · queued here ${st.queuedHere}`;

/** Only for a budget that LAPSES (`credit.lapses`): spending too little is then the failure, so status nags. */
function pressureLine(st) {
  if (!st.cfg.lapses || st.left === null) return null;
  if (st.daysLeft <= LAST_WEEK_DAYS && st.left > UNDERUSE_MARGIN_USD) {
    return `CREDIT-LAST-WEEK: ${usd2(st.left)} left, ${st.daysLeft} day(s) to renewal — unspent credit lapses on ${st.label.last}: queue eligible jobs (${LIGHT_JOBS}) now`;
  }
  if (st.spent < round6(st.budget * st.elapsed - UNDERUSE_MARGIN_USD)) {
    // say how far behind and WHAT to queue, not only that something should be
    const behind = round2(st.budget * st.elapsed - st.spent);
    const cands = (st.fillCandidates && st.fillCandidates.length ? st.fillCandidates : DEFAULT_FILL).join(' · ');
    return `CREDIT-FILL: queue light jobs (${FILL_KINDS.join(', ')}) — ${usd2(behind)} behind pace (${usd2(st.left)} left, ${st.daysLeft} day(s) to renewal): ${cands}`;
  }
  return null;
}

// --------------------------------------------------------------------------------------- the queue
/** QUEUED tasks (task.json present, no verdict.json), oldest task.json first (path breaks ties). */
function queuedTasks(root) {
  return taskDirs(root)
    .filter((q) => q.mtimeMs && !fs.existsSync(path.join(q.dir, 'verdict.json')))
    .sort((a, b) => a.mtimeMs - b.mtimeMs || a.dir.localeCompare(b.dir));
}
const otherCreditRoots = (root, cwd) => worktreePaths(cwd).map((wt) => ({ worktree: wt, root: creditDirOf(wt) })).filter((o) => !samePath(o.root, root));

/** Read-only kinds first, writing kinds last; stable inside each group. An unknown kind counts as read-only. */
function runOrder(queued) {
  const writes = (q) => {
    try {
      const k = JSON.parse(fs.readFileSync(path.join(q.dir, 'task.json'), 'utf8')).kind;
      return !!(CREDIT_KINDS[k] && CREDIT_KINDS[k].writes);
    } catch (_) {
      return false;
    }
  };
  const tagged = queued.map((q) => ({ q, w: writes(q) }));
  return [...tagged.filter((x) => !x.w), ...tagged.filter((x) => x.w)].map((x) => x.q);
}

/**
 * One runner per queue: `<queue>/runner.lock` holds the runner's pid, taken by exclusive create; a holder whose pid is
 * gone is taken over. The stale check, its removal and the create run under a guard lock, so a runner that read the
 * same dead pid never deletes the lock another has just created. Returns the release function.
 */
function takeRunnerLock(root) {
  fs.mkdirSync(root, { recursive: true });
  const f = path.join(root, 'runner.lock');
  store.withLock(`${f}.guard`, () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        fs.writeFileSync(f, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: 'wx' });
        return;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
      let held = {};
      try {
        held = JSON.parse(fs.readFileSync(f, 'utf8'));
      } catch (_) {
        /* torn: stale */
      }
      if (Number.isInteger(held.pid) && pidAlive(held.pid)) throw new Error(`refused: a credit runner (pid ${held.pid}) is already running the queue in ${root}`);
      try {
        fs.unlinkSync(f);
      } catch (_) {
        /* gone */
      }
    }
    throw new Error(`refused: could not take the runner lock in ${root}`);
  }, { waitMs: 15000, staleMs: 60000 });
  return () => {
    try {
      if (JSON.parse(fs.readFileSync(f, 'utf8')).pid === process.pid) fs.unlinkSync(f);
    } catch (_) {
      /* gone */
    }
  };
}

/** credit-run from the wrong folder: is the task here, and which other worktrees hold it. */
function locateTask({ run, task, root, cwd = process.cwd() }) {
  const here = fs.existsSync(path.join(taskDir(root, run, task), 'task.json'));
  let checkout = cwd;
  let elsewhere = [];
  try {
    checkout = path.resolve(git(cwd, ['rev-parse', '--show-toplevel'])[0]);
    if (!here) elsewhere = otherCreditRoots(root, cwd).filter((o) => fs.existsSync(path.join(taskDir(o.root, run, task), 'task.json'))).map((o) => o.worktree);
  } catch (_) {
    /* not a git checkout */
  }
  return { here, checkout, elsewhere };
}
const queuedElsewhere = ({ root, cwd = process.cwd() }) => otherCreditRoots(root, cwd).map((o) => ({ worktree: o.worktree, count: queuedTasks(o.root).length })).filter((o) => o.count);

/** The account chain: credit, then the configured fallbacks. */
const accountChain = (credit) => ['credit', ...((credit && credit.fallback) || []).filter((a) => a === 'secondary' || a === 'primary')];

/**
 * One task down the account chain. Credit is passed over when the task's budget exceeds what the period or today's
 * cap still allows, or when the credit ran out earlier in this queue. An attempt that fails for an ACCOUNT reason
 * (billing, an API error, a 429, a key-source or login fault) hands the task to the next account; a job fault never
 * does. A 429 moves on at once while a next account exists (the global record still learns of it); the last
 * account waits out the back-off and retries. A secondary account that failed is passed over for later tasks.
 * Returns { v, attempts } | { skipped: true } | { refused: true }.
 */
async function runWithFallback({ root, cwd, env, now, report, runOne, rateRoot, sleep, jitter, q, t, out, credit, secondaryConfigDir = null, maxRetries = MAX_RATE_LIMIT_RETRIES, ctx }) {
  const id = `${q.run}/${q.task}`;
  // The cap check and the reservation are ONE step under a machine-wide lock in the orch store, run before the first
  // credit attempt and again before every retry, so two runners cannot both pass on the same remaining allowance.
  const reservation = reservationFile(root, q.run, q.task);
  const reserveCredit = () => store.withLock(path.join(rateRoot || store.orchRoot(env), 'credit-budget.lock'), () => {
    const d = spendDown(root, now(), credit, cwd);
    if (Number(t.budgetUsd) > d.allowance) {
      const lb = periodLabel(d.period, d.cfg);
      return {
        ok: false,
        limitedBy: d.limitedBy,
        why: d.limitedBy === 'day'
          ? `budget $${t.budgetUsd} exceeds the ${usd2(d.allowance)} left today under the ${usd2(d.dailyCap)} daily cap${d.reserved ? ` (${usd2(d.reserved)} reserved by running jobs)` : ''}`
          : `budget $${t.budgetUsd} exceeds the ${usd2(d.allowance)} left this credit period (${lb.first}…${lb.last})${d.reserved ? ` (${usd2(d.reserved)} reserved by running jobs)` : ''}`,
      };
    }
    writeReservation(reservation, t.budgetUsd);
    return { ok: true };
  }, { waitMs: 30000, staleMs: 60000 });
  const chain = accountChain(credit).filter((a) => {
    if (a === 'secondary' && !secondaryConfigDir) {
      report(`NOTE ${id}: secondary fallback skipped — features.orchestrator.secondaryConfigDir is not set`);
      return false;
    }
    return true;
  });
  const attempts = [];
  let v = null;
  for (let ai = 0; ai < chain.length; ai++) {
    const account = chain[ai];
    const next = chain[ai + 1];
    const to = next ? ` → ${ACCOUNT_LABEL[next]}` : '';
    if (account === 'credit') {
      if (out.creditOut && next) {
        report(`FALLBACK ${id}: the credit ran out earlier in this queue${to}`);
        continue;
      }
      const fit = reserveCredit();
      if (!fit.ok) {
        if (next) {
          report(`FALLBACK ${id}: ${fit.why}${to}`);
          continue;
        }
        report(`SKIPPED ${id}: ${fit.why}${fit.limitedBy === 'day' ? ' — it stays queued for tomorrow' : ''}`);
        return { skipped: true };
      }
    }
    if (account === 'secondary' && out.secondaryOut && next) {
      report(`FALLBACK ${id}: the secondary account failed earlier in this queue${to}`);
      continue;
    }
    for (let retry = 1; ; retry++) {
      try {
        v = await runOne({ root, run: q.run, task: q.task, env, account, priorAttempts: attempts.slice(), ...(ctx ? { ctx } : {}) });
      } catch (e) {
        if (account === 'credit') dropReservation(reservation);
        if (!/^refused/.test(e.message)) throw e;
        report(`REFUSED ${id}: ${e.message}`);
        return { refused: true, attempts, reason: e.message };
      }
      if (account === 'credit') dropReservation(reservation);
      if (v.failure !== 'rate-limit') break;
      const hitAt = now().getTime();
      const rl = ratelimit.record429(rateRoot, { now: hitAt, jitter });
      if (next || retry > maxRetries) break;
      const wait = Math.max(0, Date.parse(rl.until) - hitAt);
      out.rateLimitRetries++;
      report(`RATE-LIMIT ${id}: 429 — global back-off ${Math.round(wait / 1000)} s, lanes now ${rl.lanes}; retrying the same task`);
      await sleep(wait);
      if (account === 'credit') {
        // the back-off freed the reservation: re-check the cap under the lock before the retry
        const again = reserveCredit();
        if (!again.ok) {
          // the rate-limited attempt wrote verdict.json, and a job with a verdict is never queued again — move it aside
          // (its cost stays in the meter) so "it stays queued" is true
          const vdir = taskDir(root, q.run, q.task);
          if (fs.existsSync(path.join(vdir, 'verdict.json'))) moveVerdictAside(vdir, now());
          report(`SKIPPED ${id}: ${again.why}${again.limitedBy === 'day' ? ' — it stays queued for tomorrow' : ''}`);
          return { skipped: true };
        }
      }
    }
    if (v.status === 'COMPLETE' || isJobFault(v) || !next) return { v, attempts };
    attempts.push({ account, status: v.status, failure: v.failure || null, keyFault: v.keyFault || null, costUsd: v.costUsd ?? null, finishedAt: v.finishedAt, resultLine: v.resultLine || null });
    if (account === 'credit' && v.billingStop) out.creditOut = true;
    if (account === 'secondary' && (v.status === 'REFUSED-KEY-SOURCE' || v.failure === 'rate-limit')) out.secondaryOut = true;
    report(`FALLBACK ${id}: ${ACCOUNT_LABEL[account]} ${v.status}${v.failure ? ` (${v.failure})` : ''}${v.keyFault ? ` — ${v.keyFault}` : ''}${to}`);
  }
  return { v, attempts };
}

const verdictLine = (id, v) => {
  const fb = v.account && v.account !== 'credit';
  return `${v.status} ${id}${fb ? ` [${ACCOUNT_LABEL[v.account]}]` : ''} · cost ${v.costUsd == null ? 'unreported' : `$${v.costUsd}`}${fb ? ' (plan account)' : ''} · ${v.resultLine || 'no RESULT line'}${v.billingStop ? ' · billing stop' : ''}${v.review === 'PENDING' ? ' · REVIEW PENDING' : ''}`;
};

/**
 * `credit-run --all-queued`: every queued task, one at a time, each down its account chain. With no fallback
 * configured, a billing stop halts the queue and the rest are reported not started (exit 11), and a task over the
 * allowance is skipped. A refused task (exit 3) is reported and the queue moves on; the summary lists every refusal
 * with its reason, and a refused task is not counted as run. Order: read-only kinds first, then the writing kinds
 * (runOrder). One runner per queue (takeRunnerLock): a second one is refused before anything runs.
 * Exit: 0 when every task that ran was COMPLETE and none was refused, 11 on a credit-only billing stop, else the
 * first non-zero exit (3 for a refusal).
 */
async function runQueue(opts) {
  const release = takeRunnerLock(opts.root);
  try {
    return await runQueueLocked(opts);
  } finally {
    release();
  }
}

async function runQueueLocked({
  root, cwd = process.cwd(), env = process.env, now = () => new Date(), report = () => {}, runOne = runTask,
  rateRoot, sleep = (ms) => new Promise((res) => setTimeout(res, ms)), jitter = Math.random, credit, secondaryConfigDir = null, ctx,
}) {
  const queued = runOrder(queuedTasks(root));
  const out = { ran: [], refused: [], skipped: [], notStarted: [], stoppedOnBilling: false, rateLimitRetries: 0, fellBack: 0, creditOut: false, secondaryOut: false, exit: 0 };
  const firstFail = (code) => {
    if (!out.exit && code) out.exit = code;
  };
  const creditOnly = accountChain(credit).length === 1;
  for (let i = 0; i < queued.length; i++) {
    const q = queued[i];
    if (workersMode(root) === 'off') {
      out.notStarted = queued.slice(i).map((n) => `${n.run}/${n.task}`);
      for (const n of out.notStarted) report(`NOT STARTED ${n}: workers are off`);
      out.workersOff = true;
      out.exit = EXIT.REFUSED;
      break;
    }
    const id = `${q.run}/${q.task}`;
    const t = JSON.parse(fs.readFileSync(path.join(q.dir, 'task.json'), 'utf8'));
    const r = await runWithFallback({ root, cwd, env, now, report, runOne, rateRoot, sleep, jitter, q, t, out, credit, secondaryConfigDir, ctx });
    if (r.skipped) {
      out.skipped.push(id);
      continue;
    }
    if (r.refused) {
      out.refused.push({ id, reason: r.reason });
      firstFail(EXIT.REFUSED);
      continue;
    }
    const v = r.v;
    if (v.status === 'COMPLETE') ratelimit.recordCleanFinish(rateRoot);
    if (v.account && v.account !== 'credit') out.fellBack++;
    out.ran.push({ id, status: v.status, exit: v.exit, account: v.account || 'credit' });
    report(verdictLine(id, v));
    if (v.billingStop && creditOnly) {
      out.stoppedOnBilling = true;
      out.notStarted = queued.slice(i + 1).map((n) => `${n.run}/${n.task}`);
      for (const n of out.notStarted) report(`NOT STARTED ${n}: the queue stopped on billing`);
      out.exit = BILLING_STOP_EXIT;
      break;
    }
    firstFail(v.exit);
  }
  const complete = out.ran.filter((r) => r.status === 'COMPLETE').length;
  out.summary = `QUEUE: ${out.ran.length} run, ${complete} COMPLETE, ${out.skipped.length} skipped, ${out.notStarted.length} not started`
    + `${out.fellBack ? ` · ${out.fellBack} on a fallback account` : ''}`
    + `${out.rateLimitRetries ? ` · ${out.rateLimitRetries} rate-limit retr${out.rateLimitRetries === 1 ? 'y' : 'ies'}` : ''}`
    + `${out.refused.length ? ` · ${out.refused.length} refused` : ''}`
    + `${out.stoppedOnBilling ? ' — STOPPED ON BILLING' : ''}${out.creditOut ? ' — CREDIT RAN OUT: the rest went to the fallback' : ''}${out.workersOff ? ' — WORKERS OFF' : ''}`
    + out.refused.map((x) => `\n  REFUSED ${x.id}: ${x.reason}`).join('');
  return out;
}

// ------------------------------------------------------------------------------------------- review
/** Every verdict file of every job under `root` — a verdict moved aside while PENDING or REJECTED still holds its lane. */
function reviewStates(root) {
  const out = [];
  for (const { run, task, dir } of taskDirs(root)) {
    for (const vf of verdictFiles(dir)) {
      let v;
      try {
        v = JSON.parse(fs.readFileSync(vf.file, 'utf8'));
      } catch (_) {
        continue;
      }
      out.push({ run, task, dir, verdict: path.basename(vf.file), live: vf.live, v });
    }
  }
  return out;
}

/** Every credit verdict under `root` whose job changed files and is not yet signed off. */
function pendingReviews(root) {
  return reviewStates(root).filter((x) => x.v.review === 'PENDING').map(({ run, task, dir, verdict, v }) => ({ run, task, dir, verdict, changed: v.changed || [], status: v.status }));
}
const pendingReviewsAll = ({ root, cwd = process.cwd() }) => allCreditRoots({ root, cwd }).flatMap((r) => pendingReviews(r));

/**
 * `orch credit-review <run> <task> --by <who> [--reject "<why>" | --reverted]`: sign a PENDING job off (PASSED) or
 * turn it down (REJECTED — its changes must be reverted, then marked --reverted, before the lane merges). `verdict`
 * names a moved-aside verdict file that still holds the lane (verdict.prev-<stamp>.json / verdict.pass<n>.json).
 */
function signReview({ root, run, task, by, reject, reverted, verdict = 'verdict.json' }) {
  if (!by) throw new Error('refused: credit-review needs --by <who reviewed the diff>');
  if (!VERDICT_FILE.test(String(verdict))) throw new Error(`refused: bad verdict file ${JSON.stringify(verdict)} (verdict.json, verdict.prev-<stamp>.json or verdict.pass<n>.json)`);
  const f = path.join(taskDir(root, run, task), verdict);
  const v = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (reverted) {
    if (v.review !== 'REJECTED') throw new Error(`refused: ${run}/${task} review is ${v.review || 'not recorded'}, not REJECTED`);
    const wt = JSON.parse(fs.readFileSync(path.join(taskDir(root, run, task), 'task.json'), 'utf8')).worktree;
    const left = (v.changed || []).filter((c) => git(wt, ['status', '--porcelain', '--ignored', '--', c]).length);
    if (left.length) throw new Error(`refused: ${run}/${task} changes are still in ${wt}: ${left.join(', ')}`);
    Object.assign(v, { review: 'REVERTED', revertedBy: by, revertedAt: new Date().toISOString() });
    fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n');
    return v;
  }
  if (v.review !== 'PENDING') throw new Error(`refused: ${run}/${task} review is ${v.review || 'not recorded'}, not PENDING`);
  v.review = reject ? 'REJECTED' : 'PASSED';
  v.reviewedBy = by;
  v.reviewedAt = new Date().toISOString();
  if (reject) v.rejectReason = String(reject);
  fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n');
  return v;
}

/**
 * Credit jobs that hold a lane back from merging: PENDING review, or REJECTED — in the lane worktree's own queue, and
 * in every other queue of the repo for jobs whose task targets this lane (a job for the lane may be prepared from
 * another checkout). `cwd` = the repo, so the other queues are found even when the lane folder is gone. An explicit
 * `root` reads that queue only.
 */
function mergeBlockers(worktree, root, cwd = worktree) {
  const own = root || creditDirOf(worktree);
  let roots = [own];
  if (!root) {
    try {
      roots = allCreditRoots({ root: own, cwd: fs.existsSync(cwd) ? cwd : worktree });
    } catch (_) {
      /* not a checkout: the own queue only */
    }
  }
  const forLane = (dir, r) => {
    if (samePath(r, own)) return true;
    try {
      const w = JSON.parse(fs.readFileSync(path.join(dir, 'task.json'), 'utf8')).worktree;
      return !!w && samePath(w, worktree);
    } catch (_) {
      return false;
    }
  };
  return roots
    .flatMap((r) => reviewStates(r).filter((x) => forLane(x.dir, r)))
    .filter((x) => x.v.review === 'PENDING' || x.v.review === 'REJECTED')
    .map((x) => `${x.run}/${x.task} review ${x.v.review}${x.live ? '' : ` (${x.verdict})`}`);
}

const reviewLine = (pending) =>
  pending.length
    ? `CREDIT-REVIEW: ${pending.length} credit job(s) changed files and wait for review — read each diff, then orch credit-review <run> <task> --by <you> [--reject "<why>"] [--verdict <file>]: ${pending.map((p) => `${p.run}/${p.task}${p.verdict && p.verdict !== 'verdict.json' ? ` (${p.verdict})` : ''}`).join(', ')}`
    : null;

module.exports = {
  CREDIT_KINDS, MAX_SEATS, LIGHT_JOBS, SEAT_KINDS, FILL_KINDS, EXECUTED, ACCOUNT_LABEL, JOB_FAULTS, EXIT, BILLING_STOP_EXIT, BILLING_PATTERNS, MAX_RATE_LIMIT_RETRIES, WORKER_MODES,
  creditContext, fallbackOrder, recordGlobs, forbiddenGlobs, commandsFor, validateTask, writeGlobs, allowList, prompt, isJobFault, workerOf,
  creditRoot, creditDirOf, taskDir, checkoutOf, queueRootOf, launcherCommand, briefCitedFiles, briefMissingFiles, prepare, whichAbs, ignoredSnapshot, changedFiles, scopeFaults, statusOf, classifyFailure,
  workersMode, workersIsDefault, setWorkers, runTask, dirtLeftBy, targetLockFile, takeTargetLock,
  periodBounds, periodLabel, dayBounds, creditConfig, creditCost, verdictFiles, moveVerdictAside, requeue, reservedUsd, taskDirs, allCreditRoots, periodSpend, spendDown, creditStatus, statusLine, pressureLine,
  fillCandidates, creditBusy,
  queuedTasks, runOrder, takeRunnerLock, locateTask, queuedElsewhere, worktreePaths, accountChain, runWithFallback, verdictLine, runQueue,
  reviewStates, pendingReviews, pendingReviewsAll, signReview, mergeBlockers, reviewLine,
};
