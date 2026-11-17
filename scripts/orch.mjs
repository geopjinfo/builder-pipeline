#!/usr/bin/env node
/**
 * orch — the batch orchestrator's fixed steps (feature `orchestrator`). Judgement lives in skills/orchestrator.md;
 * everything mechanical is here, so a killed orchestrating session resumes from the state file, not from memory.
 *
 *   npx builder run orch <command> …       (not through npm run: some shells' npm drops --flags)
 * (folder layout: node scripts/orch.mjs in place of npx builder run orch)
 *
 * Plan → lanes
 *   digest <artifact.md|.html> [--out plan.md] [--run R] [--title T]
 *                                     turn a free-form plan into the plan table; inferred cells are ⚠ CONFIRM, every
 *                                     unused line is listed under Unmapped. Exit 10 while any CONFIRM is open
 *   digest --check <plan.md>          list the open CONFIRMs (exit 10 while any is open)
 *   split <plan.md> [--out lanes.json] [--max-lanes N --measured <file>]
 *                                     risk → level → track → dispatch per row, disjoint lanes; refused while a
 *                                     CONFIRM is open. More lanes than features.orchestrator.maxLanes needs a file
 *                                     of measured runs. With features.orchestrator.capacity, --measured alone reads
 *                                     the cap from the file's last "<seat> <n>%" (under → laneCap, else
 *                                     defaultLanes); --max-lanes still wins (a whole number; above laneCap warns)
 *   init <run> --lanes <lanes.json> [--mode parallel|single] [--repo P]
 *   approve <run> --by <who>          the human approved the split and the levels
 * Lanes
 *   preflight [--run R]               the project's checks; exit 0 parallel, 6 single-lane only
 *   claim <run> <lane> | release <run> [lane] | claims
 *   gate-launch <run> <lane> [--resume]   the pre-launch gate: content policy, settings scan, worktree, --settings pin
 *   worktree <run> <lane>             create the lane worktree (fresh branch, include files copied, sparse on path roots)
 *                                     before a secondary-seat launch: refuses a lane `next` does not say to launch,
 *                                     or one placed on the primary seat; records the git config/hooks baseline;
 *                                     prints the lane's paths and the filled launchCommand. --resume also takes the
 *   gate-launch <run> <lane> [--resume] [--max-budget-usd N]
 *                                     before a terminal-worker launch: refuses a lane `next` does not say to launch,
 *                                     or one placed on the orchestrating session's own account; refuses an account
 *                                     with no maxTurns or timeoutMinutes, a cap raised in §16 without a decision-log
 *                                     line, or a failed smoke re-run; records the git config/hooks baseline; prints
 *                                     the lane's paths, the account, its caps and the filled launch command
 *                                     (--max-budget-usd is a backstop, never a cap). An api-key account's launch
 *                                     writes `account.paid` and a decision-log row. --resume also takes the
 *                                     WAIT-P4 lane `next` offers SELF-AUDIT for, when a lane slot is free. Refused
 *                                     while a linkDirs entry of the lane worktree is a link and the brief names a
 *                                     reinstall step (link-guard)
 *   link-guard <folder> [--brief <file>]
 *                                     0 no linked dir · 4 a linkDirs entry is a link (never reinstall there) ·
 *                                     3 a link + a brief naming any reinstall step (unlink it yourself first)
 *   launch-id <launch.log>            the session id a background-launch log names — the COPY id when a resume with
 *                                     flags started one (Claude Code); exit 1 while none is there yet
 *   set <run> <lane> key=value…       e.g. status=LAUNCHED seat=secondary sessionId=<id>
 *   notice <run> <lane> [--progress]  a worker's finish notice (finish without a result file = STALLED)
 *   watch <run> <lane> [--every 20] [--max-min N]
 *                                     the finish notice for a terminal worker: exits when its result is written or
 *                                     its session stops working (0 DONE · 7 stalled). Run it in the background
 *   usage <run> <account> <pct> | usage-read <run> [<account>|all]
 *   status [run] [--split] [--json] | next <run>
 *                                     every command refreshes the readiness assessment of features.accounts when it
 *                                     is older than usageStaleMinutes; status, next, claim and gate-launch always do
 *                                     next also prints ADD-LANES (capacity), SELF-AUDIT <lane> (a WAIT-P4 lane while
 *                                     the credit lane is busy with other work) and CREDIT-FILL (spend behind pace)
 *   wait <run> [--timeout 110] [--from N]   block until the run logs an event (exit 0) or the timeout (exit 9)
 *   lease <run> --holder <name> [--ttl 300]  take/renew the run lease; another holder's live lease → exit 3
 *     --holder <name> on claim|set|approve|enqueue|merge|notice: refused (exit 3) while another holder's lease is live
 *   pause | stop | resume              ALL runs: pause = no launches, no merges; stop = pause + stopCommand per live lane
 *   set tests [local|remote]           where the heavy tiers run (no value prints it)
 *   ratelimit [show|hit|clean] [--planned N] | snapshots [run]
 *   release-stale [--apply]            claims held by a paused run, a MERGED/FAILED lane or a missing run (they block new
 *                                     claims on the same files); --apply releases them once the new lane owns that work
 * Merge
 *   enqueue <run> <lane>
 *   merge <run> --slot-ok [--gates "<cmd>"] [--repo P] [--integration-wt D] [--direct]
 *                                     one lane at a time into features.orchestrator.target through the gates
 * Credit lane (only with features.orchestrator.credit.enabled)
 *   credit-prep <run> <task> --key K --kind <kind> --scope "g1,g2" --worktree P --brief <file> --model M [--budget 0.50] [--allow-missing]
 *               [--queue <worktree>]  the queue the job goes into (default: the job worktree's own)
 *   credit-run <run> <task> [--rerun [--queue-only] [--cleared-by <who>]] | credit-run --all-queued   [--queue <worktree>]
 *                                     run in a shell that supplies the API key; --queue = that worktree's queue (a
 *                                     worktree of this repo). A finished job runs again only with --rerun, which
 *                                     moves its verdict aside (the meter keeps it)
 *   credit                             the meter: period, spend across all worktrees, today against the daily cap
 *   credit-review <run> <task> --by W [--reject "<why>" | --reverted] [--verdict <file>] [--queue <worktree>]
 *   set workers [off|credit]           the workers switch (no value prints it)
 *   credit-audit <run> --key K --worktree W [--tester] [--seats a,b] [--budget 3] [--dry]
 *                                     the P4 auditor seats (and with --tester the P3 tester) of gate-queue key K as credit
 *                                     jobs, built from the queue's base..tip and changed files; models from models.strong/mid
 *
 * Off → "orchestrator: not configured", exit 0.
 * Exit codes: 0 ok · 1 error · 2 usage · 3 refused (claim overlap, lock busy, paused, lease) · 4 merge conflict or
 *   target moved → heads-up · 5 gates red · 6 preflight single-lane · 7 stall · 9 wait timeout · 10 open CONFIRMs ·
 *   12 merge needs the printed ff-only
 *   credit-run: 0 COMPLETE · 1 FAILED · 3 refused/skipped · 8 INCOMPLETE · 9 FAILED-SCOPE · 10 REFUSED-KEY-SOURCE ·
 *   11 queue stopped on billing · 13 FAILED-INTEGRITY
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { runHint } = require('./lib/run-hint.cjs');
const profile = require('./lib/profile.cjs');
const store = require('./lib/orch-store.cjs');
const planLib = require('./lib/orch-plan.cjs');
const digestLib = require('./lib/orch-digest.cjs');
const creditAudit = require('./lib/orch-credit-audit.cjs');
const claims = require('./lib/orch-claims.cjs');
const state = require('./lib/orch-state.cjs');
const merge = require('./lib/orch-merge.cjs');
const pre = require('./lib/orch-preflight.cjs');
const credit = require('./lib/orch-credit.cjs');
const snapshots = require('./lib/orch-snapshot.cjs');
const ratelimit = require('./lib/orch-ratelimit.cjs');
const lease = require('./lib/orch-lease.cjs');
const policy = require('./lib/account-policy.cjs');
const acct = require('./lib/orch-accounts.cjs');
const accountPaths = require('./lib/account-paths.cjs');

const LEASED_CMDS = ['claim', 'set', 'approve', 'enqueue', 'merge', 'notice'];
const PLACING_CMDS = new Set(['status', 'next', 'claim', 'gate-launch']);
const BOOLEAN_FLAGS = new Set(['check', 'json', 'split', 'direct', 'slot-ok', 'all-queued', 'allow-missing', 'progress', 'reverted', 'resume', 'apply', 'tester', 'dry', 'rerun', 'queue-only']);
const argv = process.argv.slice(2);
const cmd = argv.shift();
const flags = {};
const pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const k = a.slice(2);
    const nx = argv[i + 1];
    if (BOOLEAN_FLAGS.has(k) || nx === undefined || nx.startsWith('--')) flags[k] = true;
    else {
      flags[k] = nx;
      i++;
    }
  } else pos.push(a);
}
const die = (code, msg) => {
  console.error(msg);
  process.exit(code);
};
const out = (v) => console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
const USAGE = `usage: ${runHint('orch')} <digest|split|init|approve|preflight|claim|release|claims|gate-launch|worktree|link-guard|launch-id|set|notice|watch|usage|usage-read|status|next|wait|lease|pause|stop|resume|ratelimit|snapshots|enqueue|merge|credit|credit-prep|credit-run|credit-review|credit-audit|release-stale> … (header of scripts/orch.mjs)`;
if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
  console.log(USAGE);
  process.exit(cmd ? 0 : 2);
}

const loaded = profile.load(process.cwd());
if (loaded.errors.length > 0) {
  console.error(`orch: PIPELINE_PROFILE.md is invalid — run ${runHint('features')}`);
  for (const e of loaded.errors) console.error(`  ${e}`);
  process.exit(2);
}
const feature = profile.feature(loaded.settings, 'orchestrator');
if (!feature.enabled) {
  console.log(feature.line);
  process.exit(0);
}
const cfg = feature.config;
const settings = loaded.settings;
// The 1.0 seat view of features.accounts (secondaryConfigDir, credit): the credit lane still reads it; placement reads
// the account list itself (M3).
const legacy = profile.accounts.legacyView(settings);
const accountsOn = profile.accounts.accountsOn(settings);
const acfg = { ...profile.accounts.FEATURE_DEFAULTS, ...((settings.features && settings.features.accounts) || {}) };
const accountList = () => (accountsOn ? profile.accounts.list(settings) : []);
const tierCmd = settings.commands && settings.commands.tier;

let rootCache = null;
const root = () => (rootCache = rootCache || store.orchRoot());
const repoOf = () => path.resolve(flags.repo || store.primaryRoot());
// Run directories only: a stray file under runs/ (a note, an editor backup) is not a run, and `pause`/`resume`/
// `status` would otherwise try to load it as one.
const runIds = () => {
  try {
    return fs
      .readdirSync(path.join(root(), 'runs'), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
};
const testsModeNow = () => pre.testsMode(root(), cfg.tests.mode);
const testsLine = () => pre.testsLine(testsModeNow(), cfg.tests, tierCmd);
const creditCtx = () => credit.creditContext(settings);
const creditOn = () => legacy.credit && legacy.credit.enabled === true;
const creditOff = () => {
  console.log('orchestrator credit lane: not configured (features.orchestrator.credit.enabled is false)');
  process.exit(0);
};
const gatesCmd = () => flags.gates || cfg.gates || (tierCmd && (settings.commands.tiers || []).includes('gates') ? tierCmd.split('{tier}').join('gates') : null);
// `--queue <worktree>` names the queue a credit command reads or writes (a worktree of this repo)
const queueFlag = () => (flags.queue && flags.queue !== true ? flags.queue : undefined);
const creditQueueRoot = (fallback = () => credit.creditRoot()) => (queueFlag() ? credit.queueRootOf(queueFlag()) : fallback());

/** The link guard over a folder: { lines, code } — 0 nothing linked · 4 a link (warn) · 3 a link + a brief naming a reinstall. */
function linkGuardOf(folder, briefText = '') {
  const found = pre.linkGuard(folder, cfg.linkDirs || []).filter((g) => g.linked);
  if (!found.length) return { code: 0, lines: [] };
  const names = found.map((g) => g.name);
  if (briefText && pre.briefAsksReinstall(briefText, names)) {
    return { code: 3, lines: found.map((g) => `REFUSED: the brief names a reinstall step in ${path.resolve(folder)}, whose ${g.name} is a link to ${g.target || '(dangling)'} — a reinstall there deletes THROUGH it; unlink it yourself before the launch (${pre.unlinkCommand(g.link)}), then launch again — no brief wording exempts`) };
  }
  return { code: 4, lines: found.map((g) => `WARN: ${g.link} is a link to ${g.target || '(dangling)'} — never reinstall there (unlink first: ${pre.unlinkCommand(g.link)})`) };
}

function creditLines() {
  if (!creditOn()) return null;
  const lines = [];
  try {
    const croot = credit.creditRoot();
    const st = credit.creditStatus({ root: croot, credit: legacy.credit });
    lines.push(credit.pressureLine(st));
    lines.push(credit.reviewLine(credit.pendingReviewsAll({ root: croot })));
  } catch (e) {
    return `credit: status unavailable (${e.message.split(/\r?\n/)[0]})`;
  }
  return lines.filter(Boolean).join('\n') || null;
}

const cc = () => require('./lib/orch-worker-claude-code.cjs');
const accountsCfg = () => profile.feature(settings, 'accounts').config;
/** The registry account a terminal-worker lane runs on (the 1.0 secondary seat through legacyView), or null = no policy. */
function laneAccount() {
  const name = legacy.accounts && legacy.accounts.secondary;
  if (!name) return null;
  return profile.accounts.list(settings).find((a) => a.name === name) || null;
}
const readText = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};
/** Create the lane worktree when it is absent; an existing one is checked against the roots (REQ-402, REQ-405). */
function laneWorktree(s, l, roots) {
  if (fs.existsSync(l.worktree)) {
    if (roots) {
      const have = pre.sparseRoots(l.worktree);
      const same = have && have.length === roots.length && roots.every((r) => have.includes(r));
      if (!same) die(3, `E_PATH_ROOTS: worktree ${l.worktree} is not a sparse checkout of the roots ${roots.join(', ')} — remove it (or re-create it with orch worktree) before the launch`);
    }
    return { worktree: l.worktree, branch: l.branch, created: false, sparse: roots };
  }
  const include = (accountsCfg().worktree || {}).include || [];
  try {
    return { ...pre.createLaneWorktree({ repo: s.repo, worktree: l.worktree, branch: l.branch, base: s.target || 'HEAD', roots, include }), created: true };
  } catch (e) {
    die(3, e.message);
  }
  return null;
}
/**
 * The pre-launch gate of a lane (REQ-401 to REQ-404, REQ-703): exits 3 with the check lines on any fault; else creates
 * the worktree when absent, writes the --settings pin (0600) and returns { pinFile, roots }. No account = no policy.
 */
function policyGate(s, run, lane, l) {
  const account = laneAccount();
  if (!account) return { pinFile: null, roots: null };
  const home = accountPaths.home();
  const ap = accountPaths.paths(home, account.name, account);
  const checks = pre.launchChecks({ account, paths: ap, homeExists: fs.existsSync(home) });
  if (checks.length) {
    for (const c of checks) console.log(`CHECK ${c.check}: ${c.message}`);
    state.event(root(), run, 'launch.refused', { lane, account: account.name, checks: checks.map((c) => c.check) });
    process.exit(3);
  }
  const projectDir = s.repo || process.cwd();
  const roots = policy.pathRoots(account);
  const lockFiles = (() => {
    try {
      return Object.keys(JSON.parse(fs.readFileSync(path.join(projectDir, 'builder.lock.json'), 'utf8')).files || {});
    } catch {
      return [];
    }
  })();
  const entries = [
    { file: path.join(projectDir, '.claude', 'settings.json'), role: 'project' },
    { file: path.join(projectDir, '.claude', 'settings.local.json'), role: 'project' },
    ...(l.worktree && fs.existsSync(l.worktree) ? [{ file: path.join(l.worktree, '.claude', 'settings.json'), role: 'worktree' }, { file: path.join(l.worktree, '.claude', 'settings.local.json'), role: 'worktree' }] : []),
    { file: ap.settingsFile, role: 'account' },
  ];
  const faults = policy.check(
    account,
    { visibility: settings.visibility, decisionIdPattern: profile.feature(settings, 'handoffPack').config.decisionIdPattern, decisionsPath: settings.paths.decisions, lockFiles, canDeny: account.worker === 'claude-code' },
    [...(l.ownedFiles || []), ...(l.hotFiles || [])],
    readText(path.join(projectDir, settings.paths.decisions)),
    policy.readSettingsFiles(entries),
  );
  if (faults.length) {
    for (const f of faults) console.error(`REFUSED launch ${run}/${lane}: ${f.message}`);
    state.event(root(), run, 'launch.refused', { lane, account: account.name, checks: faults.map((f) => f.code) });
    process.exit(3);
  }
  let denyPaths = [];
  if (l.worktree && s.repo) {
    laneWorktree(s, l, roots);
    if (roots) denyPaths = policy.denyPathsFor(pre.trackedFiles(s.repo, s.target || 'HEAD'), roots);
  } else if (roots) die(3, `E_PATH_ROOTS: account ${account.name} has path roots (${roots.join(', ')}) and run ${run} records no repo or worktree for ${lane} — a path-root account launches only in a sparse worktree`);
  // the worktree's own settings files exist only now: scan them too before the pin is written
  if (l.worktree && fs.existsSync(l.worktree) && !entries.some((e) => e.role === 'worktree')) {
    const late = policy.check(account, { lockFiles, canDeny: true, visibility: 'public' }, [], null, policy.readSettingsFiles([{ file: path.join(l.worktree, '.claude', 'settings.json'), role: 'worktree' }, { file: path.join(l.worktree, '.claude', 'settings.local.json'), role: 'worktree' }]));
    if (late.length) {
      for (const f of late) console.error(`REFUSED launch ${run}/${lane}: ${f.message}`);
      state.event(root(), run, 'launch.refused', { lane, account: account.name, checks: late.map((f) => f.code) });
      process.exit(3);
    }
  }
  let accountSettings = null;
  try {
    accountSettings = JSON.parse(fs.readFileSync(ap.settingsFile, 'utf8'));
  } catch {
    /* none: the scan above already judged an unreadable one */
  }
  const pinFile = path.join(store.runDir(root(), run), 'pins', `${lane}.settings.json`);
  cc().writePin(pinFile, cc().pin({ account, configDir: ap.configDir, accountSettings, denyPaths }));
  return { pinFile, roots };
/**
 * The readiness assessment (REQ-307, REQ-309): every probe and usage reader of every account, written to the
 * accounts-readiness record. Forced before a placement; otherwise only when the last assessment is stale. A fault in
 * the assessment never stops the command: it is printed, and the accounts stay as last assessed.
 */
function assessAccounts(force) {
  if (!accountsOn) return null;
  try {
    return acct.refresh(root(), settings, { force });
  } catch (e) {
    console.error(`accounts: assessment skipped — ${e.message.split(/\r?\n/)[0]}`);
    return null;
  }
}

/** The freshest reading for an account in this run: the run's own (`orch usage`) or the assessment's (REQ-309). */
const readingOf = (s, name) => state.readingFor(s, acct.load(root()).accounts, name);

/** The account lines for status: `<name>  <state>  <usage (time)>  v <version>` plus the budget warning (REQ-313). */
function accountLines(s) {
  if (!accountsOn) return [];
  const rec = acct.load(root()).accounts;
  const accounts = require('./lib/accounts.cjs');
  return accountList().map((a) => {
    const e = rec[a.name] || {};
    const u = readingOf(s, a.name);
    const usage = u ? accounts.renderUsage({ percent: u.pct ?? null, usd: u.usd ?? null, source: u.source || 'recorded', at: u.at, unpriced: !!u.unpriced }) : 'unmeasured';
    const line = e.assessment ? `${a.name}  ${accounts.renderState(e.assessment)}  ${usage}  v ${e.assessment.version}` : `${a.name}  unmeasured (not assessed yet)  ${usage}  v unmeasured`;
    const warn = acct.budgetWarn(u, a.budget, acfg.softLimitPct);
    const err = acct.errorHolds(e.error) ? `${e.error.kind} until ${e.error.until || 'the next sign-in'}` : null;
    return `  ${accounts.redact(line)}${warn ? `  ${warn}` : ''}${err ? `  ${err}` : ''}`;
  });
}

/** The budget warning for a lane's account (REQ-313), or ''. */
function laneWarn(s, name) {
  if (!accountsOn || !name) return '';
  const a = accountList().find((x) => x.name === name);
  const w = a ? acct.budgetWarn(readingOf(s, name), a.budget, acfg.softLimitPct) : null;
  return w ? ` (${w})` : '';
}

function printStatus(runId, { split = false } = {}) {
  const s = state.load(root(), runId);
  const age = (t) => (t ? `${Math.round((Date.now() - Date.parse(t)) / 60000)}m` : '-');
  console.log(`run ${s.runId} · target ${s.target} · preflight ${s.preflightMode} · lanes ≤${s.maxLanes} · seats ${(s.seats || []).join(' → ')} · approved ${s.approved ? `yes (${s.approvedBy})` : 'NO'} · paused ${s.paused || fs.existsSync(state.pauseFile(root())) ? 'YES' : 'no'}`);
  console.log(`usage ${Object.entries(s.usage).map(([a, u]) => `${a}=${typeof u.pct === 'number' ? `${u.pct}%` : `$${u.usd}`} (${age(u.at)} ago)`).join(' ') || 'unmeasured'} · merge queue [${s.mergeQueue.join(', ')}]`);
  const al = accountLines(s);
  if (al.length) console.log(`accounts:\n${al.join('\n')}`);
  console.log(testsLine());
  console.log('lane | status | level/track | dispatch | rows | seat | session | since-notice | branch');
  for (const [k, l] of Object.entries(s.lanes)) {
    console.log(`${k} | ${l.status} | ${l.level}/${l.track} | ${l.dispatch} | ${l.rows.join(',')} | ${l.seat ? `${l.seat}${laneWarn(s, l.seat)}` : '-'} | ${l.sessionId || '-'} | ${age(l.timings.lastNoticeAt || l.timings.launchedAt)} | ${l.branch}`);
  }
  if (split) {
    console.log('\nrow | lane | risk | level/track | dispatch | reason | hot files (queued)');
    for (const r of s.rows) console.log(`${r.id} | ${r.lane} | ${r.risk} (${r.riskReason}) | ${r.level}/${r.track} | ${r.dispatch} | ${r.reason} | ${r.hotFiles.join(', ') || '-'}`);
  }
  let ev = [];
  try {
    ev = fs.readFileSync(path.join(store.runDir(root(), runId), 'events.jsonl'), 'utf8').trim().split('\n').slice(-5);
  } catch {
    /* none */
  }
  console.log('\nlast events:');
  for (const e of ev) console.log(`  ${e}`);
  console.log('\nnext:');
  for (const a of state.nextActions(root(), s)) console.log(`  ${a}`);
}

function stopSessions() {
  const stopped = [];
  for (const id of runIds()) {
    let s;
    try {
      s = state.load(root(), id);
    } catch {
      continue;
    }
    state.setPaused(root(), id, true);
    for (const [k, l] of Object.entries(s.lanes)) {
      if (!state.ACTIVE.includes(l.status) || !l.sessionId) continue;
      if (!cfg.stopCommand) {
        stopped.push(`${id}/${k} ${l.sessionId} — no stopCommand configured: stop it by hand`);
        continue;
      }
      const r = pre.run(pre.fill(cfg.stopCommand, { session: l.sessionId }));
      state.setLane(root(), id, k, { status: 'PAUSED', stopExit: r.code });
      stopped.push(`${id}/${k} ${l.sessionId} exit ${r.code}`);
    }
  }
  return stopped;
}

try {
  if (LEASED_CMDS.includes(cmd) && flags.holder !== undefined && !(cmd === 'set' && ['workers', 'tests'].includes(pos[0]))) {
    if (flags.holder === true) die(2, `usage: ${cmd} … --holder <name>`);
    lease.check(root(), pos[0], flags.holder);
  }
  if (!['digest', 'split', 'link-guard', 'launch-id', 'help'].includes(cmd)) assessAccounts(PLACING_CMDS.has(cmd));
  switch (cmd) {
    case 'release-stale': {
      // A claim held by a PAUSED run, by a lane already MERGED or FAILED, or by a run that no longer exists blocks new
      // claims on the same files. List them; release only with --apply. A live run's claim is never stale.
      const stale = [];
      for (const c of claims.list(root())) {
        let why = null;
        try {
          const s = state.load(root(), c.runId);
          const l = s.lanes[c.lane];
          if (s.paused) why = 'run paused';
          else if (!l) why = 'lane not in its run';
          else if (['MERGED', 'FAILED'].includes(l.status)) why = `lane ${l.status}`;
        } catch {
          why = 'run not found';
        }
        if (why) stale.push({ ...c, why });
      }
      for (const c of stale) console.log(`STALE ${c.runId}/${c.lane} ${c.pattern}${c.hot ? ' (hot)' : ''} — ${c.why}`);
      if (!flags.apply) {
        console.log(`${stale.length} stale claim(s) · dry run (add --apply to release, once the new lane owns the same work)`);
        break;
      }
      let n = 0;
      for (const k of [...new Set(stale.map((c) => `${c.runId}\t${c.lane}`))]) {
        const [runId, lane] = k.split('\t');
        n += claims.release(root(), { runId, lane });
      }
      console.log(`released ${n} stale claim(s)`);
      break;
    }
    case 'credit-audit': {
      // The P4 auditor seats (and with --tester the P3 tester) of one gate-queue key, prepared as credit jobs.
      if (!creditOn()) creditOff();
      const [run] = pos;
      if (!run || !flags.key || flags.key === true || !flags.worktree || flags.worktree === true) {
        die(2, 'usage: credit-audit <run> --key <gate-queue key> --worktree <lane worktree> [--queue <worktree>] [--tester] [--seats a,b] [--budget USD] [--dry]');
      }
      const qRoot = creditQueueRoot(() => credit.creditRoot(process.env, path.resolve(flags.worktree)));
      const jobs = creditAudit.plan(path.resolve(flags.worktree), flags.key, { tester: !!flags.tester, settings, ...(flags.seats ? { seats: String(flags.seats).split(',').map((s) => s.trim()).filter(Boolean) } : {}) });
      for (const j of jobs) {
        if (flags.dry) {
          console.log(`DRY ${run}/${j.task} · ${j.kind} · ${j.model} · scope ${j.scope.join(', ')}`);
          continue;
        }
        const r = credit.prepare(
          { run, task: j.task, key: flags.key, kind: j.kind, scope: j.scope, worktree: flags.worktree, model: j.model, budgetUsd: Number(flags.budget || 3) },
          { root: qRoot, brief: j.brief, ctx: creditCtx() },
        );
        console.log(`PREPARED ${run}/${j.task} · ${j.kind} · ${j.model} in ${r.dir}`);
      }
      if (!flags.dry) console.log(`start the queue: ${credit.launcherCommand({ queue: queueFlag() || path.resolve(flags.worktree) })}`);
      break;
    }
    case 'digest': {
      if (!pos[0]) die(2, 'usage: digest <artifact.md|.html> [--out plan.md] [--run R] [--title T]  ·  digest --check <plan.md>');
      if (flags.check) {
        const r = digestLib.check(fs.readFileSync(pos[0], 'utf8'));
        console.log(`${pos[0]}: ${r.rows} row(s) · ${r.open} still ⚠ CONFIRM`);
        for (const it of r.items) console.log(`  ${it.id}: ${it.confirm}`);
        process.exit(r.open ? 10 : 0);
      }
      let repo = process.cwd();
      try {
        repo = repoOf();
      } catch {
        /* not a git checkout: paths resolve against cwd */
      }
      const top = (() => {
        try {
          return fs.readdirSync(repo, { withFileTypes: true }).filter((e) => !e.name.startsWith('.git') && e.name !== 'node_modules');
        } catch {
          return [];
        }
      })();
      let modules = [];
      if (cfg.modulesDir) {
        try {
          modules = fs.readdirSync(path.join(repo, cfg.modulesDir), { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('_')).map((d) => d.name);
        } catch {
          /* no modules dir */
        }
      }
      const res = digestLib.digest(fs.readFileSync(pos[0], 'utf8'), {
        source: path.basename(pos[0]), run: flags.run || '', title: flags.title || '',
        roots: top.filter((e) => e.isDirectory()).map((e) => e.name), rootFiles: top.filter((e) => e.isFile()).map((e) => e.name),
        sourceRoots: cfg.sourceRoots, modules, modulesDir: cfg.modulesDir, exists: (p) => fs.existsSync(path.join(repo, p)),
      });
      const dest = path.resolve(flags.out || path.join(root(), 'plans', `${path.basename(pos[0]).replace(/\.[^.]+$/, '')}.plan.md`));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, res.markdown);
      const open = res.rows.filter((r) => r.confirm.length).length;
      console.log(`wrote ${dest} · ${res.rows.length} row(s) · ${open} ⚠ CONFIRM · ${res.unmapped.length} unmapped line(s)`);
      if (open) console.log(`next: resolve each ⚠ CONFIRM (orch digest --check ${dest}), read ## Unmapped, then orch split ${dest} for the human's OK`);
      process.exit(open ? 10 : 0);
    }
    case 'split': {
      if (!pos[0]) die(2, 'usage: split <plan.md> [--out lanes.json] [--max-lanes N --measured <file>]');
      let maxLanes = cfg.maxLanes;
      const capacity = state.capacityOf(cfg.capacity);
      if (flags['max-lanes']) {
        if (!flags.measured || !fs.existsSync(flags.measured)) die(3, `refused: more lanes than ${cfg.maxLanes} needs --measured <file> holding measured runs (test host + account usage) that carried the load`);
        maxLanes = Number(flags['max-lanes']);
        if (!Number.isInteger(maxLanes) || maxLanes < 1) die(2, `refused: --max-lanes must be a whole number ≥ 1, got ${JSON.stringify(flags['max-lanes'])}`);
        if (capacity && maxLanes > capacity.laneCap) console.error(`WARN: ${maxLanes} lanes is above the capacity lane cap of ${capacity.laneCap} (features.orchestrator.capacity)`);
      } else if (flags.measured && capacity) {
        // the standing capacity policy, read from the measured file's last reading for the capacity seat
        if (!fs.existsSync(flags.measured)) die(3, `refused: --measured ${flags.measured} does not exist`);
        const m = state.measuredLanes(fs.readFileSync(flags.measured, 'utf8'), cfg.capacity, cfg.maxLanes);
        maxLanes = m.maxLanes;
        console.error(m.pct === null ? `lanes ≤${maxLanes}: no "${m.seat} <n>%" figure in ${flags.measured}` : `lanes ≤${maxLanes}: measured ${m.seat} ${m.pct}% ${m.pct < capacity.underPct ? '<' : '≥'} ${capacity.underPct}% (${flags.measured})`);
      }
      const hot = [...cfg.hot, settings.paths.registry, `${settings.paths.boards}/_gate-queue.md`];
      const res = planLib.split(fs.readFileSync(pos[0], 'utf8'), { ...cfg, hot, maxLanes });
      res.plan = { ...res.plan, file: path.resolve(pos[0]) }; // init keeps it; ADD-LANES names it
      const bad = planLib.laneOverlaps(res.lanes);
      if (bad.length) die(3, `internal: lanes overlap: ${bad.join('; ')}`);
      if (flags.out) {
        fs.mkdirSync(path.dirname(path.resolve(flags.out)), { recursive: true });
        fs.writeFileSync(flags.out, JSON.stringify(res, null, 2) + '\n');
      }
      if (flags.json || !flags.out) out(res);
      else {
        for (const l of res.lanes) console.log(`${l.name} | ${l.level}/${l.track} | ${l.dispatch} | rows ${l.rows.join(' → ')} | owned ${l.ownedFiles.length} | hot ${l.hotFiles.join(', ') || '-'}`);
        console.log(`wrote ${flags.out} · ${res.rows.length} rows · ${res.lanes.length} lanes · hot files queued: ${res.hotFilesQueued.length}`);
      }
      break;
    }
    case 'init': {
      const [run] = pos;
      if (!run || !flags.lanes) die(2, 'usage: init <run> --lanes <lanes.json> [--mode parallel|single] [--repo P]');
      const res = JSON.parse(fs.readFileSync(flags.lanes, 'utf8'));
      const repo = repoOf();
      const s = state.init(root(), run, res, {
        repo, target: cfg.target, worktreeBase: path.dirname(repo), worktreePrefix: cfg.worktreePrefix || `${path.basename(repo)}-wt-`, branchPrefix: cfg.branchPrefix,
        preflightMode: flags.mode === 'parallel' ? 'parallel' : 'single', stallMinutes: cfg.stallMinutes,
        ...(accountsOn
          ? { accounts: accountList(), softLimitPct: acfg.softLimitPct, placement: acfg.placement, usageStaleMinutes: acfg.usageStaleMinutes }
          : { seats: legacy.seats, limits: legacy.limits, usageStaleMinutes: cfg.usageStaleMinutes }),
        capacity: cfg.capacity, credit: creditOn(),
      });
      console.log(`run ${run}: ${Object.keys(s.lanes).length} lanes, state ${path.join(store.runDir(root(), run), 'state.json')}`);
      break;
    }
    case 'approve':
      if (!pos[0] || !flags.by || flags.by === true) die(2, 'usage: approve <run> --by <who>');
      state.approve(root(), pos[0], flags.by);
      console.log(`approved ${pos[0]} by ${flags.by}`);
      break;
    case 'preflight': {
      let cwd = process.cwd();
      try {
        cwd = repoOf();
      } catch {
        /* not a git checkout */
      }
      const r = pre.preflight({ checks: cfg.preflight, testsMode: testsModeNow(), cwd });
      for (const c of r.checks) console.log(c.skipped ? `SKIP ${c.name}: ${c.detail}` : `${c.ok ? 'PASS' : 'FAIL'} ${c.name}: ${c.detail}`);
      if (r.none) console.log('preflight: no checks configured (features.orchestrator.preflight) — nothing was verified, so one lane only');
      console.log(testsLine());
      console.log(`MODE ${r.mode}${r.mode === 'single' ? ' — parallel lanes refused until every check passes' : ''}`);
      if (flags.run) {
        state.update(root(), flags.run, (s) => {
          s.preflightMode = r.mode;
          s.maxLanes = r.mode === 'parallel' ? s.plannedMaxLanes : 1;
        }, { type: 'preflight', data: { mode: r.mode, failed: r.checks.filter((c) => !c.ok).map((c) => c.name) } });
      }
      process.exit(r.mode === 'parallel' ? 0 : 6);
    }
    case 'claim': {
      const [run, lane] = pos;
      const l = state.load(root(), run).lanes[lane];
      if (!l) die(2, `no lane ${lane}`);
      const r = claims.claim(root(), { runId: run, lane, owned: l.ownedFiles, hot: l.hotFiles });
      if (!r.ok) {
        state.event(root(), run, 'claim.refused', { lane, conflicts: r.conflicts });
        die(3, `REFUSED ${lane}: ${r.conflicts.map((c) => `${c.file} held by ${c.heldBy}`).join('; ')}`);
      }
      state.setLane(root(), run, lane, { status: 'CLAIMED' });
      console.log(`CLAIMED ${run}/${lane}: ${l.ownedFiles.length} owned, ${l.hotFiles.length} hot (shared, merge-queued)`);
      break;
    }
    case 'release':
      console.log(`released ${claims.release(root(), { runId: pos[0], lane: pos[1] })} claim(s)`);
      break;
    case 'claims':
      out(claims.list(root()));
      break;
    case 'gate-launch': {
      const [run, lane] = pos;
      const s = state.load(root(), run);
      const l = s.lanes[lane];
      if (!l) die(2, `no lane ${lane}`);
      const acts = state.nextActions(root(), s);
      const resume = !!flags.resume;
      const ok = resume
        ? (['PAUSED', 'STALLED', 'LAUNCHED'].includes(l.status) || state.isWaitP4(l)) && !acts[0].startsWith('PAUSED') && s.approved
        : l.status === 'CLAIMED' && acts.some((a) => a.startsWith(`LAUNCH ${lane}:`));
      if (!ok) die(3, `REFUSED launch ${run}/${lane} (status ${l.status}): ${acts.join(' | ')}`);
      if (resume && l.status === 'DONE') {
        // only the lane `next` actually offers SELF-AUDIT for (else its seats would run twice), and the resumed lane
        // takes a slot — counted the way `next` counts them: no resume under a 429 hold, the cap is the 429-halved one,
        // and a lane waiting to launch already holds a slot
        if (!acts.some((a) => a.startsWith(`SELF-AUDIT ${lane}:`))) die(3, `REFUSED launch ${run}/${lane} (status DONE, WAIT-P4): next offers no SELF-AUDIT for it — ${acts.join(' | ')}`);
        const rl = ratelimit.laneCap(ratelimit.load(root()), Date.now());
        if (rl && rl.holdUntil) die(3, `REFUSED launch ${run}/${lane}: 429 back-off until ${rl.holdUntil} — no new sessions`);
        const capLanes = rl ? Math.min(s.maxLanes, rl.lanes) : s.maxLanes;
        const live = Object.values(s.lanes).filter((x) => ['LAUNCHED', 'STALLED', 'PAUSED', 'PLANNED', 'CLAIMED'].includes(x.status)).length;
        if (live >= capLanes) die(3, `REFUSED launch ${run}/${lane}: no free lane slot (${live} of ${capLanes} live)`);
      }
      // a linked dependency dir in the lane worktree + a brief naming a reinstall: the reinstall would delete THROUGH it
      if (l.worktree && fs.existsSync(l.worktree)) {
        let briefText = '';
        try {
          briefText = fs.readFileSync(l.brief, 'utf8');
        } catch {
          /* no brief yet */
        }
        const g = linkGuardOf(l.worktree, briefText);
        for (const line of g.lines) console.error(line);
        if (g.code === 3) process.exit(3);
      }
      if (!resume && acts.some((a) => a.startsWith(`LAUNCH ${lane}:`) && / on primary \(/.test(a))) die(3, `REFUSED launch ${run}/${lane}: placed on the primary seat — start it on the primary account (a sub-agent for a solo lane, its own session for a pipeline lane), not with the secondary launcher`);
      // M4: the account's content policy, the settings scan and the --settings pin (REQ-401 to REQ-404, REQ-703).
      const gate = policyGate(s, run, lane, l);
      if (!l.integrity) state.integrityBaseline(root(), run, lane); // a resume keeps the first baseline: a change from an earlier attempt is never laundered
      const vars = { run, lane, brief: l.brief, worktree: l.worktree, result: l.result, branch: l.branch, settings: gate.pinFile };
      const template = cfg.launchCommand || legacy.launchCommand;
      let launch = template ? pre.fill(template, vars) : null;
      if (launch && gate.pinFile && !String(template).includes('{settings}')) launch = cc().withSettings(launch, gate.pinFile);
      out({ name: l.name, worktree: l.worktree, branch: l.branch, brief: l.brief, result: l.result, settings: gate.pinFile, sparse: gate.roots, launch });
      break;
    }
    case 'worktree': {
      // create a lane's worktree the hygienic way (REQ-405): a fresh branch, the include files copied, sparse on a path-root account
      const [run, lane] = pos;
      const s = state.load(root(), run);
      const l = s.lanes[lane];
      if (!l) die(2, `no lane ${lane}`);
      if (!l.worktree || !s.repo) die(3, `refused: run ${run} records no repo or worktree path for ${lane} — re-init with --repo`);
      const account = laneAccount();
      const r = laneWorktree(s, l, account ? policy.pathRoots(account) : null);
      console.log(`${r.created ? 'created' : 'exists'} ${r.worktree} on ${r.branch}${r.fresh === false ? ' (branch existed, no worktree held it)' : ''}${r.sparse ? ` · sparse: ${r.sparse.join(', ')}` : ''}${r.copied && r.copied.length ? ` · copied: ${r.copied.join(', ')}` : ''}${r.missing && r.missing.length ? ` · not found: ${r.missing.join(', ')}` : ''}`);
      // the account the lane goes to: the placement `next` made (a resume keeps the lane's own)
      const placed = resume && l.seat ? l.seat : state.placementNow(root(), s).seat;
      const acc = state.accountOf(s, placed);
      if (!resume && acc && acc.worker === 'session') die(3, `REFUSED launch ${run}/${lane}: placed on the ${placed} seat — start it on the ${placed} account (the orchestrating session itself: a sub-agent for a solo lane, its own session for a pipeline lane), not with the terminal launcher`);
      const reg = accountList().find((a) => a.name === placed) || null; // the live §16 row (caps, smoke, maxTurns)
      if (reg && !state.isLegacyState(s)) {
        // REQ-313: a hard cap or soft limit raised in §16 since init needs a decision-log row with both values
        const decisionsFile = path.join(s.repo || process.cwd(), settings.paths.decisions);
        let decisions = '';
        try {
          decisions = fs.readFileSync(decisionsFile, 'utf8');
        } catch {
          /* no log yet */
        }
        for (const r of acct.raisedCaps(s.accounts, accountList())) {
          if (!acct.decisionCovers(decisions, r)) die(3, `REFUSED launch ${run}/${lane}: features.accounts.accounts.${r.name}.budget.${r.field} raised ${r.from} → ${r.to} without a decision-log line — add a row to ${settings.paths.decisions} that carries "${acct.raiseEntry(r.name, r.field, r.from, r.to)}", then launch again`);
        }
        const raised = acct.raisedCaps(s.accounts, accountList());
        if (raised.length) state.update(root(), run, (st) => { st.accounts = accountList().map(state.slimAccount); }, { type: 'accounts.caps', data: { raised } });
      }
      // REQ-305: every launch carries a turn cap and a timeout from the account
      const caps = reg || (acc && !acc.legacy ? acc : null);
      if (caps) {
        for (const field of ['maxTurns', 'timeoutMinutes']) {
          if (!(typeof caps[field] === 'number' && caps[field] > 0)) die(3, `REFUSED launch ${run}/${lane}: account ${placed} has no ${field} — set features.accounts.accounts.${placed}.${field} (every launch carries maxTurns and timeoutMinutes; --max-budget-usd is only a backstop)`);
        }
      }
      // REQ-308: a stale smoke pass re-runs before the account's first launch in this run; a failure refuses
      if (reg && reg.smokeCommand && !Object.values(s.lanes).some((x) => x.seat === placed && !['PLANNED', 'CLAIMED'].includes(x.status))) {
        const ap = accountPaths.paths(accountPaths.home(process.env), reg.name, reg);
        const last = require('./lib/account-probes.cjs').smokeRecord(ap);
        if (pre.smokeDue(last, Date.now(), acfg.usageStaleMinutes)) {
          const sm = pre.runSmoke(reg, ap, { cwd: s.repo || process.cwd() });
          state.event(root(), run, 'account.smoke', { lane, account: placed, ok: sm.ok, exit: sm.exit });
          if (!sm.ok) {
            acct.record(root(), placed, { state: 'not ready', reason: `smoke failed (exit ${sm.exit})`, until: null, assessedAt: sm.at });
            die(3, `REFUSED launch ${run}/${lane}: smoke failed on account ${placed} (exit ${sm.exit}) — the account is not ready; fix it (${reg.smokeCommand}), then launch again`);
          }
          console.error(`smoke ${placed}: passed at ${sm.at}`);
        }
      }
      if (!l.integrity) state.integrityBaseline(root(), run, lane); // a resume keeps the first baseline: a change from an earlier attempt is never laundered
      // REQ-303: a launch on a pays-per-use account is written down twice — the run's events and the project's decision log
      if (!resume && acc && acc.pays === 'api-key') {
        const decisionsFile = path.join(s.repo || process.cwd(), settings.paths.decisions);
        acct.appendDecision(decisionsFile, { id: `D-orch-${run}-${lane}`, decision: `lane ${lane} of run ${run} launched on api-key account ${placed}`, why: 'every plan account was full, not ready or excluded; the account pays per use (REQ-303)' });
        state.event(root(), run, 'account.paid', { lane, account: placed, decisions: settings.paths.decisions });
      }
      const model = (settings.models && (settings.models.strong || settings.models.mid)) || null;
      const pricing = require('./lib/pricing.cjs');
      const priced = model ? pricing.cost(model, { input_tokens: 1 }) !== null : false;
      const backstop = flags['max-budget-usd'] && flags['max-budget-usd'] !== true ? Number(flags['max-budget-usd']) : null;
      const vars = { run, lane, brief: l.brief, worktree: l.worktree, result: l.result, branch: l.branch, account: placed || '', maxTurns: caps ? caps.maxTurns : '', timeoutMinutes: caps ? caps.timeoutMinutes : '' };
      const template = (reg && reg.command) || (acc && acc.command) || cfg.launchCommand || null;
      out({
        name: l.name, worktree: l.worktree, branch: l.branch, brief: l.brief, result: l.result,
        account: placed, worker: acc ? acc.worker : null, pays: acc ? acc.pays : null, maxTurns: caps ? caps.maxTurns : null, timeoutMinutes: caps ? caps.timeoutMinutes : null,
        model, price: model ? (priced ? `pinned (pricing ${pricing.VERSION})` : 'unpriced') : 'no model', maxBudgetUsd: backstop, maxBudgetUsdRole: 'backstop only — never a cap',
        launch: template ? pre.fill(template, vars) : null,
      });
      break;
    }
    case 'set': {
      if (pos[0] === 'workers') {
        if (!creditOn()) creditOff();
        const croot = credit.creditRoot();
        if (pos[1] === undefined) {
          console.log(`workers: ${credit.workersMode(croot)}${credit.workersIsDefault(croot) ? ' (default, no switch file)' : ''}`);
          break;
        }
        if (!credit.WORKER_MODES.includes(pos[1])) die(2, `usage: set workers ${credit.WORKER_MODES.join('|')}`);
        console.log(`workers: ${credit.setWorkers(croot, pos[1])}`);
        break;
      }
      if (pos[0] === 'tests') {
        if (pos[1] === undefined) {
          if (pre.testsIsDefault(root())) console.log(`tests: ${testsModeNow()} (profile default, no switch file)`);
          console.log(testsLine());
          break;
        }
        if (!pre.TEST_MODES.includes(pos[1])) die(2, `usage: set tests ${pre.TEST_MODES.join('|')}`);
        pre.setTests(root(), pos[1], cfg.tests);
        console.log(testsLine());
        break;
      }
      const [run, lane, ...kv] = pos;
      const patch = {};
      for (const p of kv) {
        const i = p.indexOf('=');
        if (i < 1) die(2, `bad key=value ${p}`);
        const v = p.slice(i + 1);
        patch[p.slice(0, i)] = /^\d+$/.test(v) ? Number(v) : v;
      }
      out(state.setLane(root(), run, lane, patch));
      break;
    }
    case 'link-guard': {
      // reads only: exit 0 no linked dir (or none configured) · 4 a link (WARN) · 3 a link + a brief naming a reinstall
      if (!pos[0]) die(2, 'usage: link-guard <folder> [--brief <file>]');
      if (!(cfg.linkDirs || []).length) {
        console.log('link-guard: no linkDirs configured (features.orchestrator.linkDirs) — nothing to check');
        break;
      }
      const g = linkGuardOf(pos[0], flags.brief && flags.brief !== true ? fs.readFileSync(flags.brief, 'utf8') : '');
      if (!g.code) console.log(`OK: no linked ${cfg.linkDirs.join(', ')} in ${path.resolve(pos[0])}`);
      for (const line of g.lines) console.log(line);
      process.exit(g.code);
    }
    case 'launch-id': {
      // the id a background-launch log names — the copy's when a resume with flags started one (Claude Code adapter)
      if (!pos[0]) die(2, 'usage: launch-id <launch.log>');
      const cc = require('./lib/orch-worker-claude-code.cjs');
      let id = null;
      try {
        id = cc.launchSessionId(cc.readLaunchLog(pos[0]));
      } catch {
        /* not written yet */
      }
      if (!id) process.exit(1);
      console.log(id);
      break;
    }
    case 'notice': {
      const r = state.notice(root(), pos[0], pos[1], flags.progress ? 'progress' : 'finish');
      console.log(`${pos[1]} → ${r.status}${r.resultLine ? ` · ${r.resultLine}` : ''}`);
      break;
    }
    case 'usage': {
      if (pos.length < 3) die(2, 'usage: usage <run> <account> <pct | $usd>');
      const seat = String(pos[1]).toLowerCase(); // a name in any case is that account, never another one
      const usd = /^\$/.test(String(pos[2]));
      state.recordUsage(root(), pos[0], seat, usd ? { usd: String(pos[2]).slice(1) } : pos[2]);
      console.log(`usage ${seat}=${usd ? pos[2] : `${pos[2]}%`}`);
      break;
    }
    case 'usage-read': {
      const s = state.load(root(), pos[0]);
      const want = String(pos[1] || 'all').toLowerCase();
      const names = state.seatNames(s);
      const seats = want === 'all' ? names : [want];
      // an unknown account is refused BEFORE anything is read — it must never be read as another one and recorded
      for (const seat of seats) if (!names.includes(seat)) die(2, `refused: unknown seat ${JSON.stringify(pos[1])} — the run's accounts: ${names.join('|')}|all`);
      for (const seat of seats) {
        const a = accountList().find((x) => x.name === seat);
        if (a && a.usageCommand && !cfg.usageCommand) {
          // the account's own reader ("$X of $Y"), through the assessment's gatherer
          const r = require('./lib/account-probes.cjs').collect(a, accountPaths.paths(accountPaths.home(process.env), a.name, a), {});
          const reading = require('./lib/accounts.cjs').pickReading(r.usage);
          if (!reading) {
            state.recordUsageUnknown(root(), pos[0], seat, [`${a.usageCommand}: no "$X of $Y" line`]);
            console.log(`usage ${seat}=unknown — ${a.usageCommand} printed no "$X of $Y" line`);
            continue;
          }
          state.recordUsage(root(), pos[0], seat, { pct: reading.percent, usd: reading.usd, source: reading.source, at: reading.at });
          console.log(`usage ${seat}=${typeof reading.percent === 'number' ? `${reading.percent}%` : `$${reading.usd}`} (${reading.source} ${reading.at})`);
          continue;
        }
        const u = pre.readUsage(seat, cfg.usageCommand);
        if (u.pct === null) {
          state.recordUsageUnknown(root(), pos[0], seat, u.lines);
          console.log(`usage ${seat}=unknown — no "N% used" line in the usage output: ${u.lines.join(' | ')}`);
          continue;
        }
        state.recordUsage(root(), pos[0], seat, u.pct);
        console.log(`usage ${seat}=${u.pct}% · ${u.lines.join(' | ')}`);
      }
      break;
    }
    case 'watch': {
      const [run, lane] = pos;
      const every = Number(flags.every || 20) * 1000;
      const l0 = state.load(root(), run).lanes[lane];
      if (!l0) die(2, `no lane ${lane}`);
      const deadline = Date.now() + (Number(flags['max-min']) || l0.stallMinutes) * 60000;
      const wrote = () => {
        try {
          return /^RESULT: (PASS|FAIL)/.test(fs.readFileSync(l0.result, 'utf8'));
        } catch {
          return false;
        }
      };
      const finish = (why) => {
        const r = state.notice(root(), run, lane, 'finish');
        console.log(`NOTICE ${run}/${lane}: ${why} → ${r.status}${r.resultLine ? ` · ${r.resultLine}` : ''}`);
        process.exit(r.status === 'DONE' ? 0 : 7);
      };
      for (;;) {
        if (wrote()) finish('result written');
        if (l0.sessionId && cfg.stateCommand) {
          const st = pre.sessionState(l0.sessionId, cfg.stateCommand);
          if (st.state !== 'working' && st.state !== 'unknown') {
            if (['done', 'idle'].includes(st.state)) finish(`session ${st.state}`);
            state.setLane(root(), run, lane, { status: 'STALLED', stallReason: `session ${st.state}${st.state === 'blocked' ? ' (waiting on a prompt nobody can answer)' : ''}` });
            console.log(`STALL ${run}/${lane}: session ${l0.sessionId} is ${st.state}`);
            process.exit(7);
          }
        }
        if (Date.now() > deadline) {
          state.setLane(root(), run, lane, { status: 'STALLED', stallReason: `no result within ${Number(flags['max-min']) || l0.stallMinutes} min` });
          console.log(`STALL ${run}/${lane}: no finish in time`);
          process.exit(7);
        }
        await new Promise((res) => setTimeout(res, every));
      }
    }
    case 'status': {
      const ids = pos[0] ? [pos[0]] : runIds();
      if (!ids.length) {
        console.log(`no runs under ${root()}`);
        const c = creditLines();
        if (c) console.log(c);
        break;
      }
      if (flags.json) {
        out(ids.map((id) => ({ ...state.load(root(), id), next: state.nextActions(root(), state.load(root(), id)) })));
        break;
      }
      for (const id of ids) {
        printStatus(id, { split: !!flags.split });
        console.log('');
      }
      const c = creditLines();
      if (c) console.log(c);
      break;
    }
    case 'next': {
      if (!pos[0]) die(2, 'usage: next <run>');
      for (const a of state.nextActions(root(), state.load(root(), pos[0]))) console.log(a);
      console.log(testsLine());
      const c = creditLines();
      if (c) console.log(c);
      break;
    }
    case 'wait': {
      const [run] = pos;
      if (!run) die(2, 'usage: wait <run> [--timeout 110] [--from <offset>]');
      const r = await lease.waitForEvents(root(), run, { timeout: flags.timeout, from: flags.from === undefined ? undefined : Number(flags.from) });
      if (r.timedOut) {
        console.log(`TIMEOUT ${run} after ${r.seconds} s — no new event (offset ${r.offset})`);
        process.exit(9);
      }
      for (const l of r.lines) console.log(l);
      console.log(`offset ${r.offset}`);
      process.exit(0);
    }
    case 'lease': {
      const [run] = pos;
      if (!run || !flags.holder || flags.holder === true) die(2, 'usage: lease <run> --holder <name> [--ttl 300]');
      const r = lease.take(root(), run, flags.holder, { ttlSec: flags.ttl === undefined ? lease.DEFAULT_TTL_S : Number(flags.ttl) });
      console.log(`LEASE ${r.kind} ${run} → ${r.lease.holder} until ${r.lease.expiresAt}${r.kind === 'takeover' ? ` (expired lease of ${r.previous.holder} taken over)` : ''}`);
      break;
    }
    case 'enqueue':
      out(merge.enqueue(root(), pos[0], pos[1]));
      break;
    case 'merge': {
      if (!pos[0]) die(2, 'usage: merge <run> --slot-ok [--gates "<cmd>"] [--repo P] [--integration-wt D] [--direct]');
      const r = merge.mergeNext(root(), pos[0], {
        repo: flags.repo, slotOk: !!flags['slot-ok'], gatesCmd: gatesCmd(), integration: flags.direct ? false : cfg.integration !== false,
        integrationWorktree: flags['integration-wt'] ? path.resolve(flags['integration-wt']) : undefined, linkDirs: cfg.linkDirs, linkGuard: cfg.linkGuard,
        mechanical: cfg.mechanical,
      });
      for (const d of r.deps || []) console.log(d);
      if (r.ok) {
        console.log(r.lane ? `MERGED ${r.lane} @ ${r.sha} (gates log ${r.log})` : r.note);
        break;
      }
      if (r.stage === 'gates') die(5, `GATES RED ${r.lane} exit ${r.exit} — log ${r.log}`);
      if (r.stage === 'ff-needed') {
        console.log(`FF-NEEDED ${r.lane}: run  ${r.command}\n  gates green on ${r.sha}; ${r.worktree} has the target checked out, so its ref is not moved under it — then orch merge again`);
        process.exit(12);
      }
      die(4, `HEADS-UP: ${r.headsUp}\nSTOPPED ${r.lane} at ${r.stage}: ${r.files.join(', ')}`);
      break;
    }
    case 'ratelimit': {
      const what = pos[0] || 'show';
      if (!['show', 'hit', 'clean'].includes(what)) die(2, 'usage: ratelimit [show|hit|clean] [--planned N]');
      const planned = flags.planned ? Number(flags.planned) : undefined;
      const r = what === 'hit' ? ratelimit.record429(root(), { plannedMax: planned }) : what === 'clean' ? ratelimit.recordCleanFinish(root(), { plannedMax: planned }) : ratelimit.load(root());
      console.log(r ? `RATE-LIMIT lanes ${r.lanes}/${r.plannedMax} · consecutive 429s ${r.consecutive429} · back-off until ${r.until || '-'}` : 'RATE-LIMIT none recorded');
      break;
    }
    case 'snapshots': {
      const repo = pos[0] ? state.load(root(), pos[0]).repo || repoOf() : repoOf();
      const refs = snapshots.list(repo, pos[0]);
      if (!refs.length) console.log(`no snapshots${pos[0] ? ` for ${pos[0]}` : ''} in ${repo}`);
      for (const r of refs) console.log(`${r.ref} ${r.sha}`);
      break;
    }
    case 'pause':
      fs.mkdirSync(root(), { recursive: true });
      fs.writeFileSync(state.pauseFile(root()), new Date().toISOString() + '\n');
      for (const id of runIds()) state.setPaused(root(), id, true);
      console.log(`PAUSED all runs (${runIds().length}) — no new launches, no merges`);
      break;
    case 'stop': {
      fs.mkdirSync(root(), { recursive: true });
      fs.writeFileSync(state.pauseFile(root()), new Date().toISOString() + '\n');
      const s = stopSessions();
      console.log(`STOPPED: ${s.length} worker(s)${s.length ? `\n  ${s.join('\n  ')}` : ''} — all runs paused; resume, then status shows the RELAUNCH lines`);
      break;
    }
    case 'resume':
      try {
        fs.unlinkSync(state.pauseFile(root()));
      } catch {
        /* not paused */
      }
      for (const id of runIds()) state.setPaused(root(), id, false);
      console.log('RESUMED — run `status` for relaunch actions');
      break;
    case 'credit': {
      if (!creditOn()) creditOff();
      const croot = credit.creditRoot();
      const st = credit.creditStatus({ root: croot, credit: legacy.credit });
      console.log(credit.statusLine(st));
      if (st.reserve) console.log(`  reserve held back: $${st.reserve.toFixed(2)} — released in the final 7 days`);
      for (const f of st.unreported) console.log(`  unreported cost (counted $0): ${f}`);
      console.log(`  fallback: ${credit.accountChain(legacy.credit).map((a) => credit.ACCOUNT_LABEL[a]).join(' → ')}${accountsOn ? ` (accounts, registry order: ${[legacy.accounts.credit, ...creditCtx().fallbackAccounts].filter(Boolean).join(' → ')})` : ''}`);
      const p = credit.pressureLine(st);
      if (p) console.log(p);
      const rv = credit.reviewLine(credit.pendingReviewsAll({ root: croot }));
      if (rv) console.log(rv);
      break;
    }
    case 'credit-prep': {
      if (!creditOn()) creditOff();
      const [run, task] = pos;
      if (!run || !task || !flags.key || !flags.kind || !flags.scope || !flags.worktree || !flags.brief || !flags.model) {
        die(2, 'usage: credit-prep <run> <task> --key K --kind <kind> --scope "g1,g2" --worktree P --brief <file> --model M [--budget USD] [--allow-missing] [--queue <worktree>]');
      }
      const qRoot = creditQueueRoot(() => credit.creditRoot(process.env, path.resolve(flags.worktree)));
      const r = credit.prepare(
        { run, task, key: flags.key, kind: flags.kind, scope: String(flags.scope).split(',').map((s) => s.trim()).filter(Boolean), worktree: flags.worktree, model: flags.model, budgetUsd: Number(flags.budget || 0.5) },
        { root: qRoot, brief: fs.readFileSync(flags.brief, 'utf8'), allowMissing: !!flags['allow-missing'], ctx: creditCtx() },
      );
      // the launcher of the queue the job IS in
      const q = queueFlag() || path.resolve(flags.worktree);
      console.log(`PREPARED ${run}/${task} in ${r.dir}\n  start the queue: ${credit.launcherCommand({ queue: q })}\n  (or this job alone: ${r.command} --queue ${q})`);
      break;
    }
    case 'credit-run': {
      if (!creditOn()) creditOff();
      const croot = creditQueueRoot();
      const common = { root: croot, cwd: process.cwd(), env: process.env, rateRoot: root(), credit: legacy.credit, secondaryConfigDir: legacy.secondaryConfigDir, ctx: creditCtx() };
      if (flags['all-queued']) {
        const noneHere = credit.queuedTasks(croot).length === 0;
        const q = await credit.runQueue({ ...common, report: (line) => console.log(line) });
        console.log(q.summary);
        if (noneHere) {
          const other = credit.queuedElsewhere({ root: croot });
          if (other.length) console.log(`QUEUE: 0 here; queued in ${other.map((o) => `${o.worktree} (${o.count})`).join(', ')} — credit-run --all-queued --queue <worktree>`);
        }
        process.exit(q.exit);
      }
      const [run, task] = pos;
      if (!run || !task) die(2, 'usage: credit-run <run> <task> [--rerun [--queue-only] [--cleared-by <who>]] [--queue <worktree>] | credit-run --all-queued [--queue <worktree>]');
      const loc = credit.locateTask({ run, task, root: croot });
      if (!loc.here) die(2, `no credit task ${run}/${task} in ${queueFlag() ? `the queue of ${path.resolve(queueFlag())}` : loc.checkout}; queued in: ${loc.elsewhere.length ? loc.elsewhere.join(', ') : 'no other worktree'}`);
      const vFile = path.join(credit.taskDir(croot, run, task), 'verdict.json');
      if (flags.rerun) {
        // the old verdict moves aside; the meter keeps counting it
        const rq = credit.requeue({ root: croot, run, task, ...(flags['cleared-by'] && flags['cleared-by'] !== true ? { clearedBy: flags['cleared-by'] } : {}) });
        console.log(`RERUN ${run}/${task}: verdict.json → ${rq.verdictTo}${rq.moved.length > 1 ? ` (+${rq.moved.length - 1} run file(s) moved beside it)` : ''}`);
        if (flags['queue-only']) {
          console.log(`  queued again — start the queue: ${credit.launcherCommand({ queue: queueFlag() })}`);
          break;
        }
      } else if (fs.existsSync(vFile)) {
        // running over a verdict would drop its cost from the meter
        let st = '?';
        try {
          st = JSON.parse(fs.readFileSync(vFile, 'utf8')).status;
        } catch {
          /* unreadable */
        }
        die(3, `refused: ${run}/${task} already has a verdict (${st}) — credit-run ${run} ${task} --rerun to run it again`);
      }
      const t = JSON.parse(fs.readFileSync(path.join(credit.taskDir(croot, run, task), 'task.json'), 'utf8'));
      const fb = { rateLimitRetries: 0, creditOut: false, secondaryOut: false };
      const r = await credit.runWithFallback({
        ...common, now: () => new Date(), runOne: credit.runTask,
        report: (line) => (/^REFUSED /.test(line) ? console.error(line.replace(/^REFUSED [^:]+: /, '')) : console.log(line)),
        sleep: (ms) => new Promise((res) => setTimeout(res, ms)), jitter: Math.random, q: { run, task }, t, out: fb, maxRetries: 0,
      });
      if (r.skipped || r.refused) process.exit(3);
      const v = r.v;
      console.log(credit.verdictLine(`${run}/${task}`, v));
      if (v.billingStop) console.log('  BILLING STOP: the API credit ran out — start no further credit task');
      if (v.keyFault) console.log(`  key source: ${v.keyFault}`);
      for (const d of v.denied) console.log(`  denied: ${d}`);
      for (const s of v.scope) console.log(`  scope: ${s}`);
      console.log(`  record: ${v.record}`);
      process.exit(v.exit);
    }
    case 'credit-review': {
      if (!creditOn()) creditOff();
      const [run, task] = pos;
      if (!run || !task) die(2, 'usage: credit-review <run> <task> --by <who> [--reject "<why>" | --reverted] [--verdict <file>] [--queue <worktree>]');
      const v = credit.signReview({
        root: creditQueueRoot(), run, task, by: flags.by === true ? undefined : flags.by, reject: flags.reject, reverted: !!flags.reverted,
        ...(flags.verdict && flags.verdict !== true ? { verdict: flags.verdict } : {}), // a moved verdict file that still holds the lane
      });
      if (v.review === 'REVERTED') console.log(`REVERTED ${run}/${task} by ${v.revertedBy} — its changes are gone; the lane may merge`);
      else console.log(`${v.review} ${run}/${task} by ${v.reviewedBy}${v.rejectReason ? ` — ${v.rejectReason}; revert its changes (${(v.changed || []).join(', ')}), then --reverted, before the lane merges` : ''}`);
      break;
    }
    default:
      die(2, USAGE);
  }
} catch (e) {
  if (e.code === 'LOCK_BUSY' || /^refused/.test(e.message)) die(3, e.message);
  die(1, e.stack || e.message);
}
