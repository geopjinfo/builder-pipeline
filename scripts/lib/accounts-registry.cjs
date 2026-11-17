'use strict';
/**
 * The account registry — `features.accounts` (plan M1, REQ-101 to REQ-106, D22, D32, D33, D36).
 *
 * WHY. The orchestrator placed work on two hard-coded seats (`primary`, `secondary`) and a separate `credit` lane.
 * An account generalises all three: a worker (which harness, or the orchestrating session itself), who pays, what
 * it may see, which roles it may hold, a note the rulebook quotes, and a budget in percent or USD. §16 holds names,
 * paths and command templates only — never a key (D2).
 *
 * SHAPE. `features.accounts.accounts.<name>`:
 *   worker          claude-code | codex | antigravity | session (the orchestrating session itself, never spawned; at most one)
 *   pays            subscription | gateway | free | api-key (one way of paying per account, never two)
 *   content         public | scratch | any | [path roots]            (M4 enforces it at launch)
 *   roles           subset of ROLES; [] or absent = every role
 *   family          anthropic | openai | google | other (the model family, for the cross-family rules)
 *   note            free text the rulebook quotes before a launch
 *   configDir       the worker's own config dir (CLAUDE_CONFIG_DIR / CODEX_HOME); null = <accounts home>/accounts/<name>
 *   baseUrl         a gateway's base URL; refused on a subscription account (E_BASEURL_SUB)
 *   command         the launch command template for a terminal worker ({brief}); null = headless adapter only
 *   budget          null, or { kind: percent | usd, soft, hard, period: null | { hard, renewDay, tzOffsetMinutes, reserve }, file, key }
 *   maxTurns        positive integer; required by a launch (REQ-305), not at load
 *   timeoutMinutes  number > 0; required by a launch (REQ-305), not at load
 *   usageCommand, readyCommand, smokeCommand, versionCommand   command templates, or null
 *   guards          headless job guards: { commands, forbidden, testRoots, seatCommands, guardDir, lapses, fallback }
 *                   (fallback: the plan accounts a refused api-key job may fall back to, in order; [] = none)
 *
 * LEGACY. `seats`, `limits`, `secondaryConfigDir` and `credit` left `features.orchestrator` in 2.0.0. A profile that
 * still carries them is refused while the orchestrator is active (the message names `npx builder accounts migrate`)
 * and loads with one warning otherwise (D33). `migrate()` rewrites them into accounts once. Placement reads the
 * account list itself (M3, orch-state.cjs); `legacyView()` still derives the 1.0 shape for the credit lane's headless
 * runner and the golden fixture, so every 1.0 placement decision is reproduced exactly (REQ-106).
 *
 * Pure over settings objects. No filesystem.
 */
const { NAME_RULE, RESERVED, nameProblem } = require('./account-paths.cjs');

/** The workers an account may name. Antigravity signs in through its own app, has no key mode and takes no 1.0 seat (D26, D53). */
const WORKERS = Object.freeze(['claude-code', 'codex', 'session', 'antigravity']);
const PAYS = Object.freeze(['subscription', 'gateway', 'free', 'api-key']);
const CONTENT = Object.freeze(['public', 'scratch', 'any']);
const FAMILIES = Object.freeze(['anthropic', 'openai', 'google', 'other']);
/** The roles the orchestrator knows: the nine personas and the orchestrator itself. */
const ROLES = Object.freeze([
  'orchestrator', 'module-planner', 'module-builder', 'module-tester', 'module-reviewer',
  'standards-auditor', 'invariant-auditor', 'security-auditor', 'vuln-auditor', 'docs-maintainer',
]);
const BUDGET_KINDS = Object.freeze(['percent', 'usd']);
/** The roles a headless job may hold; an account limited to these is never a lane seat (it runs no module-builder). */
const HEADLESS_ROLES = Object.freeze(['module-tester', 'module-reviewer', 'standards-auditor', 'invariant-auditor', 'security-auditor', 'vuln-auditor', 'docs-maintainer']);
/** An account that may hold a lane (the builder role): no roles listed, or module-builder among them. */
const placeable = (a) => !Array.isArray(a.roles) || a.roles.length === 0 || a.roles.includes('module-builder');
const LEGACY_KEYS = Object.freeze(['seats', 'limits', 'secondaryConfigDir', 'credit']);
const MIGRATE_HINT = 'npx builder accounts migrate';

/** The 1.0 orchestrator keys and their defaults, kept here for `legacyView` and `migrate` only. */
const LEGACY_DEFAULTS = Object.freeze({
  seats: ['primary'],
  limits: { secondary: 80, primary: 60 },
  secondaryConfigDir: null,
  credit: {
    enabled: false,
    worker: 'claude-code',
    dailyCapUsd: null,
    periodBudgetUsd: null,
    renewDay: 1,
    tzOffsetMinutes: 0,
    reserveUsd: 0,
    lapses: false,
    fallback: ['secondary', 'primary'],
    commands: ['git status', 'git diff', 'git diff --stat', 'git log --oneline -20'],
    seatCommands: {},
    forbidden: ['**/package.json', '**/package-lock.json', '**/npm-shrinkwrap.json', '**/yarn.lock', '**/pnpm-lock.yaml'],
    testRoots: ['test/', 'tests/'],
    guardDir: null,
  },
});

const ACCOUNT_DEFAULTS = Object.freeze({
  worker: null, pays: null, content: 'any', roles: [], family: null, note: '', configDir: null, baseUrl: null, command: null,
  budget: null, maxTurns: null, timeoutMinutes: null, usageCommand: null, readyCommand: null, smokeCommand: null, versionCommand: null,
  guards: null,
});

const FEATURE_DEFAULTS = Object.freeze({
  state: 'off',
  accounts: {},
  softLimitPct: 80,
  usageStaleMinutes: 30,
  authMinMinutes: 120,
  smokeMaxAgeHours: 48,
  overloadRetries: 4,
  placement: 'on',
  worktree: { include: [] },
});

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const strList = (v) => Array.isArray(v) && v.every((s) => typeof s === 'string' && s);
const optStr = (v) => v === null || v === undefined || (typeof v === 'string' && v.trim());
const positive = (v, int = false) => typeof v === 'number' && Number.isFinite(v) && v > 0 && (!int || Number.isInteger(v));

/** Every string in a value with its path (for the secret-shape scan). */
function strings(value, at, out = []) {
  if (typeof value === 'string') out.push([at, value]);
  else if (Array.isArray(value)) value.forEach((v, i) => strings(v, `${at}[${i}]`, out));
  else if (isObject(value)) for (const [k, v] of Object.entries(value)) strings(v, `${at}.${k}`, out);
  return out;
}

/** One account merged over the defaults. */
const withDefaults = (a) => ({ ...ACCOUNT_DEFAULTS, ...(isObject(a) ? a : {}) });

/**
 * Validate `features.accounts` (shapes always; the registry's rules while the feature is active).
 * @param {object} settings  merged settings
 * @param {{ secretPatterns?: Array<[string, RegExp]> }} [opts]  the outbound guard's secret shapes (REQ-105)
 * @returns {string[]}
 */
function validateAccounts(settings, opts = {}) {
  const errors = [];
  const f = settings.features && settings.features.accounts;
  if (!isObject(f)) return errors;
  const at = (k) => `features.accounts.${k}`;
  const active = ['on', 'unmeasured', 'experimental-on'].includes(f.state);
  if (f.accounts !== undefined && !isObject(f.accounts)) errors.push(`${at('accounts')}: an object of named accounts`);
  for (const k of ['softLimitPct']) if (f[k] !== undefined && !(typeof f[k] === 'number' && f[k] > 0 && f[k] <= 100)) errors.push(`${at(k)}: a percentage in (0, 100]`);
  for (const k of ['usageStaleMinutes', 'authMinMinutes', 'smokeMaxAgeHours']) if (f[k] !== undefined && !positive(f[k])) errors.push(`${at(k)}: a number > 0`);
  if (f.overloadRetries !== undefined && !(Number.isInteger(f.overloadRetries) && f.overloadRetries >= 0)) errors.push(`${at('overloadRetries')}: a whole number >= 0`);
  if (f.placement !== undefined && !['on', 'shadow'].includes(f.placement)) errors.push(`${at('placement')}: "on" or "shadow"`);
  if (f.worktree !== undefined && (!isObject(f.worktree) || (f.worktree.include !== undefined && !strList(f.worktree.include)))) errors.push(`${at('worktree')}: { "include": [ignored files to copy into a lane worktree] }`);
  const accounts = isObject(f.accounts) ? f.accounts : {};
  const patterns = opts.secretPatterns || [];
  let sessions = 0;
  for (const [name, raw] of Object.entries(accounts)) {
    const atA = (k) => `features.accounts.accounts.${name}${k ? `.${k}` : ''}`;
    const why = nameProblem(name);
    if (why) errors.push(`${atA()}: ${why}`);
    if (!isObject(raw)) {
      errors.push(`${atA()}: an object { worker, pays, … }`);
      continue;
    }
    const a = withDefaults(raw);
    for (const [k] of Object.entries(raw)) if (!(k in ACCOUNT_DEFAULTS)) errors.push(`${atA(k)}: unknown key — known: ${Object.keys(ACCOUNT_DEFAULTS).join(', ')}`);
    // REQ-105: a secret never lives in §16, whatever the key. The kind of match is named, never the text.
    for (const [p, v] of strings(raw, atA().replace(/\.$/, ''))) {
      const hit = patterns.find(([, re]) => re.test(v));
      if (hit) errors.push(`${p}: holds a secret-shaped value (${hit[0]}) — a key enters through \`npx builder accounts key ${name}\`, never the profile`);
    }
    if (!WORKERS.includes(a.worker)) errors.push(`${atA('worker')}: ${active || a.worker !== null ? `one of ${WORKERS.join(' | ')}` : 'required'} (got ${JSON.stringify(a.worker)})`);
    if (a.worker === 'session') sessions += 1;
    if (!PAYS.includes(a.pays)) errors.push(`${atA('pays')}: one of ${PAYS.join(' | ')} (got ${JSON.stringify(a.pays)})`);
    if (!(CONTENT.includes(a.content) || (Array.isArray(a.content) && a.content.length > 0 && strList(a.content)))) errors.push(`${atA('content')}: ${CONTENT.join(' | ')}, or a non-empty list of path roots`);
    if (!strList(a.roles) && !(Array.isArray(a.roles) && a.roles.length === 0)) errors.push(`${atA('roles')}: a list of roles`);
    else for (const r of a.roles) if (!ROLES.includes(r)) errors.push(`${atA('roles')}: unknown role "${r}" — known: ${ROLES.join(', ')}`);
    if (a.family !== null && !FAMILIES.includes(a.family)) errors.push(`${atA('family')}: null, or one of ${FAMILIES.join(' | ')}`);
    if (typeof a.note !== 'string') errors.push(`${atA('note')}: a string`);
    for (const k of ['configDir', 'baseUrl', 'command', 'usageCommand', 'readyCommand', 'smokeCommand', 'versionCommand']) if (!optStr(a[k])) errors.push(`${atA(k)}: null, or a non-empty string`);
    if (a.worker === 'session' && a.configDir) errors.push(`${atA('configDir')}: a session account runs in the orchestrating session's own config; leave it null`);
    if (a.baseUrl && a.pays === 'subscription') errors.push(`${atA('baseUrl')}: E_BASEURL_SUB — a subscription account never goes through a gateway (drop baseUrl, or set pays to "gateway")`);
    if (a.baseUrl && !/^https?:\/\/\S+$/i.test(a.baseUrl)) errors.push(`${atA('baseUrl')}: an http(s) URL`);
    if (a.pays === 'api-key' && a.worker === 'session') errors.push(`${atA('pays')}: the orchestrating session is a plan account; an api-key account needs a headless worker`);
    if (a.pays === 'api-key' && a.worker === 'antigravity') errors.push(`${atA('pays')}: Antigravity has no key mode (it signs in through its own app); pays subscription or free`);
    if (a.command && !a.command.includes('{brief}')) errors.push(`${atA('command')}: must contain {brief}`);
    if (a.maxTurns !== null && !positive(a.maxTurns, true)) errors.push(`${atA('maxTurns')}: null, or a positive integer`);
    if (a.timeoutMinutes !== null && !positive(a.timeoutMinutes)) errors.push(`${atA('timeoutMinutes')}: null, or a number > 0`);
    errors.push(...budgetProblems(a.budget, atA('budget')));
    errors.push(...guardsProblems(a.guards, atA('guards')));
  }
  if (sessions > 1) errors.push(`${at('accounts')}: at most one account has worker "session" (the orchestrating session itself); found ${sessions}`);
  return errors;
}

function budgetProblems(b, at) {
  if (b === null || b === undefined) return [];
  if (!isObject(b)) return [`${at}: null, or { "kind": "percent" | "usd", "soft", "hard", "period", "file", "key" }`];
  const errors = [];
  if (!BUDGET_KINDS.includes(b.kind)) errors.push(`${at}.kind: one of ${BUDGET_KINDS.join(' | ')}`);
  const max = b.kind === 'percent' ? 100 : Infinity;
  for (const k of ['soft', 'hard']) {
    if (b[k] === null || b[k] === undefined) continue;
    if (!(typeof b[k] === 'number' && b[k] > 0 && b[k] <= max)) errors.push(`${at}.${k}: a number > 0${b.kind === 'percent' ? ' and <= 100' : ''}`);
  }
  if (typeof b.soft === 'number' && typeof b.hard === 'number' && b.soft > b.hard) errors.push(`${at}.soft: must not exceed hard (${b.soft} > ${b.hard})`);
  if (b.period !== null && b.period !== undefined) {
    if (!isObject(b.period)) errors.push(`${at}.period: null, or { "hard", "renewDay", "tzOffsetMinutes", "reserve" }`);
    else {
      if (b.period.hard !== null && b.period.hard !== undefined && !(typeof b.period.hard === 'number' && b.period.hard > 0)) errors.push(`${at}.period.hard: a number > 0`);
      if (b.period.renewDay !== undefined && !(Number.isInteger(b.period.renewDay) && b.period.renewDay >= 1 && b.period.renewDay <= 28)) errors.push(`${at}.period.renewDay: a whole day 1-28`);
      if (b.period.tzOffsetMinutes !== undefined && !(Number.isInteger(b.period.tzOffsetMinutes) && Math.abs(b.period.tzOffsetMinutes) <= 14 * 60)) errors.push(`${at}.period.tzOffsetMinutes: whole minutes within ±840`);
      if (b.period.reserve !== undefined && !(typeof b.period.reserve === 'number' && b.period.reserve >= 0)) errors.push(`${at}.period.reserve: a number >= 0`);
    }
  }
  for (const k of ['file', 'key']) if (!optStr(b[k])) errors.push(`${at}.${k}: null, or a non-empty string`);
  if (b.key && !b.file) errors.push(`${at}.key: needs ${at}.file (the usage snapshot it indexes)`);
  return errors;
}

function guardsProblems(g, at) {
  if (g === null || g === undefined) return [];
  if (!isObject(g)) return [`${at}: null, or { "commands", "forbidden", "testRoots", "seatCommands", "guardDir", "lapses" }`];
  const errors = [];
  for (const k of ['commands', 'forbidden', 'testRoots']) if (g[k] !== undefined && !strList(g[k]) && !(Array.isArray(g[k]) && g[k].length === 0)) errors.push(`${at}.${k}: an array of non-empty strings`);
  if (Array.isArray(g.commands) && g.commands.some((x) => /[*]/.test(x))) errors.push(`${at}.commands: whole named commands only — no wildcards`);
  if (g.seatCommands !== undefined && (!isObject(g.seatCommands) || Object.values(g.seatCommands).some((v) => !strList(v) || v.some((x) => /[*]/.test(x))))) errors.push(`${at}.seatCommands: { "<kind>": ["whole named command", …] }`);
  if (!optStr(g.guardDir)) errors.push(`${at}.guardDir: null, or a non-empty string`);
  if (g.lapses !== undefined && typeof g.lapses !== 'boolean') errors.push(`${at}.lapses: true or false`);
  if (g.fallback !== undefined && !(Array.isArray(g.fallback) && g.fallback.every((s) => typeof s === 'string' && s))) errors.push(`${at}.fallback: a list of account names ([] = no fallback)`);
  return errors;
}

/** The legacy keys a `features.orchestrator` object still carries. */
function legacyKeys(orchestrator) {
  if (!isObject(orchestrator)) return [];
  return LEGACY_KEYS.filter((k) => orchestrator[k] !== undefined);
}

const legacyMessage = (keys) => `features.orchestrator.${keys.join(', ')}: 1.0 seat keys — in 2.0 accounts replace seats and the credit lane; run \`${MIGRATE_HINT}\` (it rewrites §16 once, with a backup)`;

/** Accounts in registry order, each with its name and defaults. */
function list(settings) {
  const f = settings && settings.features && settings.features.accounts;
  if (!isObject(f) || !isObject(f.accounts)) return [];
  return Object.entries(f.accounts).map(([name, a]) => ({ name, ...withDefaults(a) }));
}

const accountsOn = (settings) => ['on', 'unmeasured', 'experimental-on'].includes(settings?.features?.accounts?.state);

/**
 * The 1.0 orchestrator view of the registry — `{ seats, limits, secondaryConfigDir, credit, launchCommand }` — so
 * the placement and credit code of 1.0 runs unchanged over accounts until M3 reads accounts directly.
 *   the session account        → seat `primary`, limits.primary = budget.hard (percent)
 *   the first plan account that is not the session → seat `secondary`, limits.secondary = budget.hard, its configDir
 *   the first api-key account  → the credit lane, caps from its budget, guards from `guards`
 * Seat order follows registry order. With the feature off, the 1.0 defaults.
 */
function legacyView(settings) {
  const legacy = JSON.parse(JSON.stringify(LEGACY_DEFAULTS));
  if (!accountsOn(settings)) return { ...legacy, launchCommand: null, accounts: {} };
  const accounts = list(settings);
  const seats = [];
  const limits = { ...legacy.limits };
  const map = {}; // seat → account name
  let secondaryConfigDir = null;
  let launchCommand = null;
  let credit = legacy.credit;
  for (const a of accounts) {
    // An Antigravity account runs as a wrapper only in 2.0.0 (D26): it is never a 1.0 seat or the credit lane.
    if (a.worker === 'antigravity') continue;
    if (a.worker === 'session' && !map.primary) {
      seats.push('primary');
      map.primary = a.name;
      if (a.budget && a.budget.kind === 'percent' && typeof a.budget.hard === 'number') limits.primary = a.budget.hard;
    } else if (a.pays !== 'api-key' && a.worker !== 'session' && !map.secondary) {
      // A plan account with the builder role is the secondary seat; one limited to headless roles is only the
      // fallback account of the credit lane (its config dir), never a lane seat.
      if (placeable(a)) {
        seats.push('secondary');
        map.secondary = a.name;
        if (a.budget && a.budget.kind === 'percent' && typeof a.budget.hard === 'number') limits.secondary = a.budget.hard;
        launchCommand = a.command;
        secondaryConfigDir = a.configDir;
      } else if (!secondaryConfigDir) {
        map.secondaryFallback = a.name;
        secondaryConfigDir = a.configDir;
      }
    } else if (a.pays === 'api-key' && credit.enabled === false) {
      const g = a.guards || {};
      const period = (a.budget && a.budget.period) || {};
      credit = {
        ...legacy.credit,
        enabled: true,
        worker: a.worker,
        dailyCapUsd: a.budget && a.budget.kind === 'usd' ? a.budget.hard : null,
        periodBudgetUsd: period.hard ?? null,
        renewDay: period.renewDay ?? 1,
        tzOffsetMinutes: period.tzOffsetMinutes ?? 0,
        reserveUsd: period.reserve ?? 0,
        lapses: g.lapses ?? false,
        fallback: [],
        ...(g.commands ? { commands: g.commands } : {}),
        ...(g.seatCommands ? { seatCommands: g.seatCommands } : {}),
        ...(g.forbidden ? { forbidden: g.forbidden } : {}),
        ...(g.testRoots ? { testRoots: g.testRoots } : {}),
        guardDir: g.guardDir ?? null,
      };
      map.credit = a.name;
    }
  }
  if (credit.enabled) {
    const g = (accounts.find((a) => a.name === map.credit) || {}).guards || {};
    const bySeat = Object.fromEntries(Object.entries(map).map(([seat, name]) => [name, seat === 'secondaryFallback' ? 'secondary' : seat]));
    credit.fallback = Array.isArray(g.fallback) ? g.fallback.map((n) => bySeat[n]).filter((s) => s === 'secondary' || s === 'primary') : seats.filter((s) => s === 'secondary' || s === 'primary');
  }
  return { seats: seats.length ? seats : legacy.seats, limits, secondaryConfigDir, credit, launchCommand, accounts: map };
}

/**
 * Rewrite a raw §16 object (as parsed from the profile, not merged) from the 1.0 seat keys to accounts. Pure and
 * idempotent: an object without legacy keys comes back unchanged (`changed: false`). Names are derived from the 1.0
 * seats (`primary`, `secondary`, `credit`), as D9 allows.
 * @returns {{ changed: boolean, settings: object, notes: string[] }}
 */
function migrate(raw) {
  const out = JSON.parse(JSON.stringify(raw));
  const o = out.features && out.features.orchestrator;
  const keys = legacyKeys(o);
  if (keys.length === 0) return { changed: false, settings: out, notes: ['no 1.0 seat keys found — nothing to migrate'] };
  const notes = [];
  const seats = Array.isArray(o.seats) && o.seats.length ? o.seats : LEGACY_DEFAULTS.seats;
  const limits = { ...LEGACY_DEFAULTS.limits, ...(isObject(o.limits) ? o.limits : {}) };
  const credit = { ...LEGACY_DEFAULTS.credit, ...(isObject(o.credit) ? o.credit : {}) };
  const existing = (out.features.accounts && isObject(out.features.accounts.accounts)) ? out.features.accounts.accounts : {};
  const accounts = {};
  // A 1.0 secondary that was only the credit lane's fallback (a config dir, not a seat) becomes a plan account limited
  // to the headless roles: the credit jobs may still fall back to it, and no lane is placed on it (as in 1.0).
  const fallbackOnly = !seats.includes('secondary') && credit.enabled === true && (Array.isArray(credit.fallback) ? credit.fallback : LEGACY_DEFAULTS.credit.fallback).includes('secondary') && o.secondaryConfigDir;
  if (fallbackOnly) {
    accounts.secondary = { worker: 'claude-code', pays: 'subscription', content: 'any', roles: [...HEADLESS_ROLES], family: 'anthropic', note: 'migrated from the 1.0 secondaryConfigDir: a fallback account for headless jobs, never a lane seat', configDir: o.secondaryConfigDir, budget: { kind: 'percent', soft: null, hard: limits.secondary } };
    notes.push(`secondaryConfigDir → account "secondary" limited to the headless roles (fallback only, as in 1.0)`);
  }
  for (const seat of seats) {
    if (seat === 'primary') {
      accounts.primary = { worker: 'session', pays: 'subscription', content: 'any', roles: [], family: 'anthropic', note: 'migrated from the 1.0 primary seat: the orchestrating session itself', budget: { kind: 'percent', soft: null, hard: limits.primary } };
      notes.push(`primary seat → account "primary" (worker session, hard ${limits.primary} %)`);
    } else if (seat === 'secondary') {
      accounts.secondary = { worker: 'claude-code', pays: 'subscription', content: 'any', roles: [], family: 'anthropic', note: 'migrated from the 1.0 secondary seat', configDir: o.secondaryConfigDir || null, command: o.launchCommand || null, budget: { kind: 'percent', soft: null, hard: limits.secondary } };
      notes.push(`secondary seat → account "secondary" (worker claude-code, hard ${limits.secondary} %${o.secondaryConfigDir ? `, configDir ${o.secondaryConfigDir}` : ''})`);
    }
  }
  if (credit.enabled === true) {
    const guards = {};
    for (const k of ['commands', 'seatCommands', 'forbidden', 'testRoots', 'guardDir', 'lapses']) if (credit[k] !== undefined && JSON.stringify(credit[k]) !== JSON.stringify(LEGACY_DEFAULTS.credit[k])) guards[k] = credit[k];
    const fallback = (Array.isArray(credit.fallback) ? credit.fallback : LEGACY_DEFAULTS.credit.fallback).filter((s) => accounts[s]);
    const implied = [...seats, ...(fallbackOnly ? ['secondary'] : [])].filter((s) => accounts[s]);
    if (JSON.stringify(fallback) !== JSON.stringify(implied)) guards.fallback = fallback;
    accounts.credit = {
      worker: credit.worker || 'claude-code', pays: 'api-key', content: 'any', roles: [], family: 'anthropic', note: 'migrated from the 1.0 credit lane',
      budget: {
        kind: 'usd', soft: null, hard: credit.dailyCapUsd ?? null,
        period: credit.periodBudgetUsd != null || credit.reserveUsd ? { hard: credit.periodBudgetUsd ?? null, renewDay: credit.renewDay ?? 1, tzOffsetMinutes: credit.tzOffsetMinutes ?? 0, reserve: credit.reserveUsd ?? 0 } : null,
      },
      ...(Object.keys(guards).length ? { guards } : {}),
    };
    notes.push(`credit lane → account "credit" (worker ${credit.worker || 'claude-code'}, api-key, hard ${credit.dailyCapUsd} USD per day)`);
  } else notes.push('credit lane disabled — no api-key account written');
  for (const k of LEGACY_KEYS) delete o[k];
  if (accounts.secondary && o.launchCommand) notes.push('launchCommand kept on features.orchestrator and copied to the secondary account\'s command');
  out.features.accounts = { ...(isObject(out.features.accounts) ? out.features.accounts : {}), state: 'on', accounts: { ...accounts, ...existing } };
  notes.push(`features.accounts: on, ${Object.keys(out.features.accounts.accounts).length} account(s)`);
  return { changed: true, settings: out, notes };
}

module.exports = {
  WORKERS, PAYS, CONTENT, FAMILIES, ROLES, HEADLESS_ROLES, BUDGET_KINDS, placeable, LEGACY_KEYS, LEGACY_DEFAULTS, ACCOUNT_DEFAULTS, FEATURE_DEFAULTS, MIGRATE_HINT, NAME_RULE, RESERVED,
  validateAccounts, legacyKeys, legacyMessage, list, accountsOn, legacyView, migrate, withDefaults,
};
