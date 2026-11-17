'use strict';
/*
 * `builder accounts [<subcommand>]` — the accounts command (plan M1, M10 and M2b; REQ-108, REQ-1001 to REQ-1006,
 * REQ-106, REQ-204, REQ-205).
 *
 *   (none) [--json]              the readiness report, modelled on `gh auth status`: one block per account from the
 *                                probes and the assessment; exit 1 when any account is not ready, 0 with --json;
 *                                `accounts: not configured` (exit 0) with the feature off or no account (REQ-204, REQ-205)
 *   migrate [--dry-run]          rewrite the 1.0 seat keys (`seats`, `limits`, `secondaryConfigDir`, `credit`) into
 *                                `features.accounts` (REQ-103, REQ-104, REQ-106; D33)
 *   add <name> --worker --pays … write one account into §16 and create its dir (REQ-1001)
 *   note <name> <text…>          replace the account's note
 *   key <name> [--remove]        enter (hidden) or remove the account's API key (REQ-1002, REQ-1003, REQ-1004)
 *   remove <name>                delete the wrappers, the key and the §16 entry; keep the folder (REQ-1004)
 *   list [--json]                one line per account: key present or absent, lease state, key file mode (REQ-1005)
 *
 * WHY. §16 of PIPELINE_PROFILE.md is project-owned prose around one JSON block. Every subcommand that changes it
 * rewrites the `pipeline-settings` block only — every byte outside it stays — and writes temp + rename, so a reader
 * never meets a half-written profile. Refusals carry a named code (E_ACCOUNT_NAME, E_ACCOUNT_EXISTS, E_PAYS_TWICE,
 * E_BASEURL_SUB, E_ACCOUNT_UNKNOWN, E_LEASE_HELD, …) as the first word after `error:`, and never a value. A key
 * never appears in the profile, in argv, in the environment or in any line this file prints (D2): the entry path is
 * scripts/lib/account-secrets.cjs, the storage is the account's own folder under the accounts home.
 *
 * A live lease (a worker running on the account, scripts/lib/account-lease.cjs) stops `remove` and `migrate`; a
 * stale lease is reported and cleared (REQ-108). A migrate with a live orchestrator run refuses too (REQ-106).
 */

const fs = require('fs');
const path = require('path');

const PROFILE = 'PIPELINE_PROFILE.md';
const BLOCK = /```json[ \t]+pipeline-settings[ \t]*\r?\n([\s\S]*?)\r?\n```/g;
const LIVE = new Set(['LAUNCHED', 'STALLED']);
const KIT = path.join(__dirname, '..');

const registry = () => require('../scripts/lib/accounts-registry.cjs');
const accountPaths = () => require('../scripts/lib/account-paths.cjs');
const leases = () => require('../scripts/lib/account-lease.cjs');
const secrets = () => require('../scripts/lib/account-secrets.cjs');
const profileLib = () => require('../scripts/lib/profile.cjs');
const assessment = () => require('../scripts/lib/accounts.cjs');
const probes = () => require('../scripts/lib/account-probes.cjs');
const wrappers = () => require('../scripts/lib/account-wrappers.cjs');
const accountsLock = () => require('../scripts/lib/accounts-lock.cjs');
const gatewayPolicy = () => require('../scripts/lib/gateway-policy.cjs');

/** Run ids whose state file holds a live lane. Reads only the state.json of each run under .pipeline/orchestrator/runs. */
function liveRuns(cwd, env = process.env) {
  let root;
  try {
    root = require('../scripts/lib/orch-store.cjs').orchRoot(env, cwd);
  } catch {
    root = path.join(cwd, '.pipeline', 'orchestrator');
  }
  const runs = path.join(root, 'runs');
  if (!fs.existsSync(runs)) return [];
  const out = [];
  for (const id of fs.readdirSync(runs)) {
    let state;
    try {
      state = JSON.parse(fs.readFileSync(path.join(runs, id, 'state.json'), 'utf8'));
    } catch {
      continue;
    }
    const lanes = Object.values((state && state.lanes) || {});
    if (lanes.some((l) => l && LIVE.has(l.status))) out.push(id);
  }
  return out;
}

// --------------------------- the settings block -------------------------------

/** The one pipeline-settings block of `text`: its match, its parsed object, or an error. */
function readBlock(text) {
  const blocks = [...text.matchAll(BLOCK)];
  if (blocks.length !== 1) return { error: PROFILE + ': ' + (blocks.length === 0 ? 'no' : String(blocks.length)) + ' pipeline-settings block(s) — exactly one is needed' };
  let raw;
  try {
    raw = JSON.parse(blocks[0][1]);
  } catch (e) {
    return { error: `${PROFILE}: pipeline-settings is not valid JSON: ${e.message}` };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: `${PROFILE}: pipeline-settings must be a JSON object` };
  return { match: blocks[0], raw };
}

/** `text` with the block's JSON replaced by `raw` (2-space JSON); every byte outside the block unchanged. */
function replaceBlock(text, match, raw) {
  const body = JSON.stringify(raw, null, 2);
  const start = match.index + match[0].indexOf(match[1]);
  return text.slice(0, start) + body + text.slice(start + match[1].length);
}

/**
 * Pure: the migrated profile text, the notes and whether anything changed.
 * @returns {{ changed: boolean, text: string, notes: string[], errors: string[] }}
 */
function migrateText(text) {
  const b = readBlock(text);
  if (b.error) return { changed: false, text, notes: [], errors: [b.error] };
  const r = registry().migrate(b.raw);
  if (!r.changed) return { changed: false, text, notes: r.notes, errors: [] };
  return { changed: true, text: replaceBlock(text, b.match, r.settings), notes: r.notes, errors: [] };
}

/** Write `text` to `file` as temp + rename (the profile is never half-written). */
function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/** The profile's text and its parsed block, or die. */
function loadProfile(ctx, cmd) {
  const file = path.join(ctx.CWD, PROFILE);
  if (!fs.existsSync(file)) ctx.die(`accounts ${cmd}: no ${PROFILE} in ${ctx.CWD}`);
  const text = fs.readFileSync(file, 'utf8');
  const b = readBlock(text);
  if (b.error) ctx.die(`accounts ${cmd}: ${b.error}`);
  return { file, text, match: b.match, raw: b.raw };
}

/** The raw `features.accounts.accounts` object of a parsed block ({} when absent). */
const rawAccounts = (raw) => (raw.features && raw.features.accounts && raw.features.accounts.accounts && typeof raw.features.accounts.accounts === 'object' ? raw.features.accounts.accounts : {});

/**
 * Rewrite the block with `mutate(raw)` applied, validate the result through the profile loader, write temp + rename.
 * Refuses (die) when the result does not validate; `codeOf` maps a loader error to a refusal code.
 */
function rewriteProfile(ctx, cmd, loaded, mutate, codeOf = () => null) {
  const raw = JSON.parse(JSON.stringify(loaded.raw));
  mutate(raw);
  const text = replaceBlock(loaded.text, loaded.match, raw);
  const after = profileLib().parse(text);
  // Only an error this change introduces refuses it: a fresh profile still carries placeholders elsewhere, and an
  // account entry must not wait for them. Those pre-existing errors are named, not hidden.
  const before = new Set(profileLib().parse(loaded.text).errors);
  const fresh = after.errors.filter((e) => !before.has(e));
  if (fresh.length) {
    const code = fresh.map(codeOf).find(Boolean) || 'E_ACCOUNT_INVALID';
    ctx.die(`${code}: accounts ${cmd}: the settings would not validate — nothing written:\n  ${fresh.join('\n  ')}`);
  }
  writeAtomic(loaded.file, text);
  if (before.size) console.log(`accounts ${cmd}: note — ${PROFILE} still has ${before.size} unrelated problem(s) (run npx builder-pipeline features); the accounts change was written`);
  return after.settings;
}

// --------------------------- argument parsing ----------------------------------

/**
 * `--flag value` pairs and positionals. A flag given twice is kept as a list (so `--pays a --pays b` is seen).
 * @returns {{ positional: string[], flags: Record<string, string[]>, bare: Set<string> }}
 */
function parseArgs(argv, { bare = [] } = {}) {
  const positional = [];
  const flags = {};
  const seenBare = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) { positional.push(a); continue; }
    const eq = a.indexOf('=');
    const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
    if (bare.includes(name)) { seenBare.add(name); continue; }
    const value = eq === -1 ? argv[i + 1] : a.slice(eq + 1);
    if (eq === -1) i += 1;
    if (value === undefined) { flags[name] = [...(flags[name] || []), undefined]; continue; }
    flags[name] = [...(flags[name] || []), value];
  }
  return { positional, flags, bare: seenBare };
}

const ADD_FLAGS = ['worker', 'pays', 'content', 'roles', 'family', 'note', 'config-dir', 'command', 'base-url', 'budget-hard', 'budget-soft', 'budget-kind'];

/** Build the §16 entry for `add` from parsed flags (closed sets are judged by the registry, not here). */
function accountFromFlags(ctx, flags) {
  const one = (k) => {
    const v = flags[k];
    if (!v) return undefined;
    if (v.some((x) => x === undefined || x === '')) ctx.die(`accounts add: --${k} needs a value`);
    return v;
  };
  for (const k of Object.keys(flags)) if (!ADD_FLAGS.includes(k)) ctx.die(`accounts add: unknown option --${k} — known: ${ADD_FLAGS.map((f) => `--${f}`).join(' ')}`);
  const worker = one('worker');
  const pays = one('pays');
  if (!worker) ctx.die(`accounts add: --worker is required (one of ${registry().WORKERS.join(' | ')})`);
  if (!pays) ctx.die(`accounts add: --pays is required (one of ${registry().PAYS.join(' | ')})`);
  const kinds = [...new Set(pays.flatMap((p) => p.split(',').map((s) => s.trim()).filter(Boolean)))];
  if (kinds.length !== 1) ctx.die(`E_PAYS_TWICE: accounts add: one way of paying per account (got ${kinds.map((k) => JSON.stringify(k)).join(', ')}) — add a second account for the second kind`);
  for (const k of ['worker', 'content', 'roles', 'family', 'note', 'config-dir', 'command', 'base-url', 'budget-hard', 'budget-soft', 'budget-kind']) if (flags[k] && flags[k].length > 1) ctx.die(`accounts add: --${k} given more than once`);
  const a = { worker: worker[0], pays: kinds[0] };
  if (flags.content) {
    const c = flags.content[0];
    a.content = registry().CONTENT.includes(c) ? c : c.split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (flags.roles) a.roles = flags.roles[0].split(',').map((s) => s.trim()).filter(Boolean);
  if (flags.family) a.family = flags.family[0];
  if (flags.note) a.note = flags.note[0];
  if (flags['config-dir']) a.configDir = flags['config-dir'][0];
  if (flags.command) a.command = flags.command[0];
  if (flags['base-url']) a.baseUrl = flags['base-url'][0];
  if (flags['budget-hard'] || flags['budget-soft'] || flags['budget-kind']) {
    const num = (k) => {
      if (!flags[k]) return null;
      const n = Number(flags[k][0]);
      if (!Number.isFinite(n) || n <= 0) ctx.die(`accounts add: --${k} is a number > 0 (got ${JSON.stringify(flags[k][0])})`);
      return n;
    };
    const kind = flags['budget-kind'] ? flags['budget-kind'][0] : 'percent';
    if (!registry().BUDGET_KINDS.includes(kind)) ctx.die(`accounts add: --budget-kind is one of ${registry().BUDGET_KINDS.join(' | ')} (got ${JSON.stringify(kind)})`);
    a.budget = { kind, soft: num('budget-soft'), hard: num('budget-hard') };
  }
  return a;
}

/** The refusal code a loader error for account `name` maps to. */
const codeFor = (name) => (e) => {
  if (e.includes('E_BASEURL_SUB')) return 'E_BASEURL_SUB';
  if (e.includes(`accounts.${name}:`) && /account name|reserved name/.test(e)) return 'E_ACCOUNT_NAME';
  return null;
};

/** Die with E_ACCOUNT_UNKNOWN unless `name` is in the block. Returns the raw entry. */
function mustExist(ctx, cmd, raw, name) {
  const a = rawAccounts(raw)[name];
  if (!a) ctx.die(`E_ACCOUNT_UNKNOWN: accounts ${cmd}: no account "${name}" in ${PROFILE} §16${Object.keys(rawAccounts(raw)).length ? ` — known: ${Object.keys(rawAccounts(raw)).join(', ')}` : ''}`);
  return registry().withDefaults(a);
}

/** The account's paths under the accounts home. */
const pathsOf = (name, account) => accountPaths().paths(accountPaths().home(process.env), name, account);

/** Refuse under a live lease; report and clear a stale one. */
function leaseGate(ctx, cmd, names) {
  const home = accountPaths().home(process.env);
  for (const name of names) {
    const s = leases().state(home, name);
    if (s.state === 'live') ctx.die(`E_LEASE_HELD: accounts ${cmd}: account "${name}" is in use by pid ${s.lease.pid}${s.lease.lane ? ` (lane ${s.lease.lane})` : ''} — wait for the worker to finish, then retry`);
    if (s.state === 'stale') {
      console.log(`accounts ${cmd}: stale lease on "${name}"${s.lease && s.lease.pid ? ` (pid ${s.lease.pid} is gone)` : ' (unreadable)'} — cleared, proceeding`);
      leases().release(home, name);
    }
  }
}

// --------------------------- subcommands ------------------------------------------

/** The orch root for `cwd` (BUILDER_ORCH_DIR, else the checkout's .pipeline/orchestrator). */
function orchRootOf(cwd, env = process.env) {
  try {
    return require('../scripts/lib/orch-store.cjs').orchRoot(env, cwd);
  } catch {
    return path.join(cwd, '.pipeline', 'orchestrator');
  }
}

/**
 * Rewrite every finished 1.0 run state under the orch root to name accounts (REQ-311). Pure over the file set: a
 * state that already carries `accounts`, has no `seats`, or holds a live lane is left alone.
 * @returns {{ rewritten: string[], skipped: Array<[string, string]> }}
 */
function migrateStates(cwd, settings, { env = process.env, dry = false } = {}) {
  const orchState = require('../scripts/lib/orch-state.cjs');
  const runs = path.join(orchRootOf(cwd, env), 'runs');
  const out = { rewritten: [], skipped: [] };
  if (!fs.existsSync(runs)) return out;
  const named = registry().list(settings);
  for (const id of fs.readdirSync(runs)) {
    const file = path.join(runs, id, 'state.json');
    let text;
    let state;
    try {
      text = fs.readFileSync(file, 'utf8');
      state = JSON.parse(text);
    } catch {
      continue;
    }
    if (!state || typeof state !== 'object' || !Array.isArray(state.seats)) continue;
    if (Array.isArray(state.accounts) && state.accounts.length) {
      out.skipped.push([id, 'already names accounts']);
      continue;
    }
    if (Object.values(state.lanes || {}).some((l) => l && LIVE.has(l.status))) {
      out.skipped.push([id, 'live lane']);
      continue;
    }
    const synthetic = orchState.accountsOf(state);
    const accounts = state.seats.map((seat) => {
      const row = named.find((a) => a.name === seat);
      if (row) return orchState.slimAccount(row);
      const { legacy, ...rest } = synthetic.find((a) => a.name === seat);
      return rest;
    });
    const next = { ...state, accounts, placement: 'on' };
    delete next.limits;
    for (const l of Object.values(next.lanes || {})) if (l && typeof l === 'object' && l.account === undefined) l.account = l.seat ?? null;
    out.rewritten.push(id);
    if (dry) continue;
    fs.writeFileSync(`${file}.bak`, text);
    fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n');
  }
  return out;
}

function reportStates(r, dry) {
  for (const id of r.rewritten) console.log(`  run ${id}: state.json ${dry ? 'would name' : 'names'} accounts (backup state.json.bak)`);
  for (const [id, why] of r.skipped) console.log(`  run ${id}: state.json left alone (${why})`);
}

function cmdMigrate(ctx, argv) {
  const dry = argv.includes('--dry-run');
  const unknown = argv.filter((a) => a !== '--dry-run');
  if (unknown.length) ctx.die(`accounts migrate: unknown option(s): ${unknown.join(' ')}`);
  const file = path.join(ctx.CWD, PROFILE);
  if (!fs.existsSync(file)) ctx.die(`accounts migrate: no ${PROFILE} in ${ctx.CWD}`);
  const text = fs.readFileSync(file, 'utf8');
  const r = migrateText(text);
  if (r.errors.length) ctx.die(r.errors.join('\n'));
  if (!r.changed) {
    // the profile is already 2.0: finished 1.0 run states may still need their accounts (REQ-311)
    const parsed = profileLib().parse(text);
    const live0 = liveRuns(ctx.CWD);
    if (live0.length) ctx.die(`accounts migrate: run(s) ${live0.join(', ')} hold a LAUNCHED or STALLED lane — finish or stop them (orch status), then migrate`);
    const states = parsed.errors.length ? { rewritten: [], skipped: [] } : migrateStates(ctx.CWD, parsed.settings, { dry });
    console.log(`accounts migrate: ${r.notes.join('; ')}${states.rewritten.length ? `; ${states.rewritten.length} finished run state(s) ${dry ? 'would be' : ''} rewritten` : ''}`);
    reportStates(states, dry);
    return;
  }
  const after = profileLib().parse(r.text);
  if (after.errors.length) ctx.die(`accounts migrate: the migrated settings do not validate — nothing written:\n  ${after.errors.join('\n  ')}`);
  const live = liveRuns(ctx.CWD);
  if (live.length) ctx.die(`accounts migrate: run(s) ${live.join(', ')} hold a LAUNCHED or STALLED lane — finish or stop them (orch status), then migrate`);
  // REQ-108: a worker running on an existing account reads the §16 this rewrite would change.
  leaseGate(ctx, 'migrate', Object.keys(rawAccounts(readBlock(text).raw)));
  for (const n of r.notes) console.log(`  ${n}`);
  if (dry) {
    reportStates(migrateStates(ctx.CWD, after.settings, { dry: true }), true);
    console.log(`accounts migrate --dry-run: ${PROFILE} §16 would be rewritten (backup ${PROFILE}.bak); nothing written`);
    return;
  }
  fs.writeFileSync(`${file}.bak`, text);
  fs.writeFileSync(file, r.text);
  console.log(`accounts migrate: ${PROFILE} rewritten (the pipeline-settings block only; backup ${PROFILE}.bak)`);
  reportStates(migrateStates(ctx.CWD, after.settings), false);
}

function cmdAdd(ctx, argv) {
  const { positional, flags } = parseArgs(argv);
  const [name, ...extra] = positional;
  if (!name) ctx.die(`accounts add: usage: accounts add <name> --worker <${registry().WORKERS.join('|')}> --pays <${registry().PAYS.join('|')}> [--content public|scratch|any|<root,…>] [--roles a,b] [--family …] [--note "…"] [--config-dir …] [--command "… {brief}"] [--base-url …] [--budget-hard N --budget-kind percent|usd]`);
  if (extra.length) ctx.die(`accounts add: one name only (got ${positional.map((p) => JSON.stringify(p)).join(', ')})`);
  const why = accountPaths().nameProblem(name);
  if (why) ctx.die(`E_ACCOUNT_NAME: accounts add: ${why}`);
  const account = accountFromFlags(ctx, flags);
  const loaded = loadProfile(ctx, 'add');
  if (rawAccounts(loaded.raw)[name]) ctx.die(`E_ACCOUNT_EXISTS: accounts add: account "${name}" is already in ${PROFILE} §16 — use \`npx builder-pipeline accounts note ${name} …\` to change its note, or \`npx builder-pipeline accounts remove ${name}\` first`);
  const settings = rewriteProfile(ctx, 'add', loaded, (raw) => {
    raw.features = raw.features && typeof raw.features === 'object' ? raw.features : {};
    const f = raw.features.accounts && typeof raw.features.accounts === 'object' && !Array.isArray(raw.features.accounts) ? raw.features.accounts : {};
    raw.features.accounts = f;
    if (!f.state || f.state === 'off') f.state = 'on';
    f.accounts = f.accounts && typeof f.accounts === 'object' && !Array.isArray(f.accounts) ? f.accounts : {};
    f.accounts[name] = account;
  }, codeFor(name));
  const p = pathsOf(name, settings.features.accounts.accounts[name]);
  const dir = secrets().ensureOwnerDir(p.dir);
  if (p.configDir !== p.dir) secrets().ensureOwnerDir(p.configDir);
  console.log(`accounts add: "${name}" written to ${PROFILE} §16 (features.accounts on; worker ${account.worker}, pays ${account.pays})`);
  console.log(`  account dir ${p.dir} (${dir.acl})${p.configDir !== p.dir ? `; config dir ${p.configDir}` : ''}`);
  if (account.pays === 'api-key' || account.pays === 'gateway') console.log(`  next: npx builder-pipeline accounts key ${name}   (hidden entry; the value never goes on the command line)`);
}

function cmdNote(ctx, argv) {
  const [name, ...words] = argv;
  if (!name) ctx.die('accounts note: usage: accounts note <name> <text…>');
  if (!words.length) ctx.die(`accounts note: the note text is needed — accounts note ${name} <text…>`);
  const loaded = loadProfile(ctx, 'note');
  mustExist(ctx, 'note', loaded.raw, name);
  const note = words.join(' ');
  rewriteProfile(ctx, 'note', loaded, (raw) => { rawAccounts(raw)[name].note = note; });
  console.log(`accounts note: "${name}" note replaced`);
}

async function cmdKey(ctx, argv) {
  const { positional, flags, bare } = parseArgs(argv, { bare: ['remove'] });
  const [name, ...extra] = positional;
  if (!name) ctx.die('accounts key: usage: accounts key <name> [--remove]   (the key is read from the terminal with echo off; never from argv or the environment)');
  // No argv form, no env form (REQ-1002): refuse before anything is read or written. The extra words are never echoed.
  if (extra.length) ctx.die(`accounts key: the key is entered hidden at the prompt, never on the command line — run \`npx builder-pipeline accounts key ${name}\` with no further argument (a value typed into a command line is in the shell history already: rotate it)`);
  const unknown = Object.keys(flags);
  if (unknown.length) ctx.die(`accounts key: unknown option --${unknown[0]} — there is no --env, --file or --value form; the key is entered hidden at the prompt`);
  const loaded = loadProfile(ctx, 'key');
  const account = mustExist(ctx, 'key', loaded.raw, name);
  const p = pathsOf(name, account);
  if (account.worker === 'session') ctx.die(`E_KEY_WORKER: accounts key: "${name}" is the orchestrating session (worker session); it signs in through its own harness and takes no key`);
  if (account.worker !== 'claude-code' && account.worker !== 'codex') ctx.die(`E_KEY_WORKER: accounts key: worker ${JSON.stringify(account.worker)} has no key mode`);
  if (bare.has('remove')) return keyRemove(ctx, name, account, p);
  if (account.pays !== 'api-key' && account.pays !== 'gateway') ctx.die(`E_KEY_PAYS: accounts key: "${name}" pays by ${account.pays} and signs in through the harness (claude login / codex login); a key is for an api-key or gateway account`);
  let entered;
  try {
    entered = await secrets().readSecret({ prompt: `API key for account "${name}" (hidden; Enter to finish, Ctrl-C to cancel): ` });
  } catch (e) {
    if (e.code === 'E_KEY_ABORT') { console.error('accounts key: cancelled; nothing written'); process.exit(130); }
    ctx.die(`accounts key: ${e.message}`);
  }
  if (account.worker === 'codex') {
    let r;
    try {
      r = secrets().codexLogin({ configDir: p.configDir, configFile: p.codexConfigFile, authFile: p.codexAuthFile, value: entered.value });
    } catch (e) {
      ctx.die(`${e.code ? `${e.code}: ` : ''}accounts key: ${e.message}`);
    }
    if (!r.ok) ctx.die(`E_CODEX_LOGIN: accounts key: \`codex login --with-api-key\` exited ${r.status}${r.auth.present ? '' : ' and wrote no auth.json'} under CODEX_HOME=${p.configDir}${r.stderr.trim() ? `\n  ${r.stderr.trim().split('\n').join('\n  ')}` : ''}`);
    console.log(`accounts key: "${name}" signed in through \`codex login --with-api-key\` (CODEX_HOME=${p.configDir}, cli_auth_credentials_store = "file"); auth.json ${r.auth.mode ? `mode ${r.auth.mode}` : r.auth.acl}${r.auth.ready ? '' : ' — ' + r.auth.reason}`);
    return undefined;
  }
  let written;
  try {
    written = secrets().writeKeyFile(p.keyFile, entered.value);
    secrets().editJson(p.settingsFile, (s) => { s.apiKeyHelper = secrets().helperCommand(KIT, name); });
  } catch (e) {
    ctx.die(`${e.code ? `${e.code}: ` : ''}accounts key: ${e.message}`);
  }
  // The confirmation carries no part of the value (REQ-1002): the file, its mode and the helper only.
  console.log(`accounts key: "${name}" key ${written.rotated ? 'rotated' : 'stored'} (${written.mode ? `mode ${written.mode}` : 'Windows: mode check skipped, the folder ACL rules'}); apiKeyHelper set in ${p.settingsFile}`);
  return undefined;
}

/** `key --remove`: the key file and the helper setting only (REQ-1004); Codex: `codex logout`. */
function keyRemove(ctx, name, account, p) {
  if (account.worker === 'codex') {
    const r = secrets().codexLogout({ configDir: p.configDir });
    if (!r.ok) ctx.die(`accounts key --remove: \`codex logout\` ${r.status === null ? `could not run (${r.reason})` : `exited ${r.status}`} under CODEX_HOME=${p.configDir}`);
    console.log(`accounts key --remove: "${name}" signed out through \`codex logout\` (CODEX_HOME=${p.configDir})${fs.existsSync(p.codexAuthFile) ? ' — auth.json is still present' : ''}`);
    return;
  }
  const gone = secrets().removeKeyFile(p.keyFile);
  let helper = false;
  if (fs.existsSync(p.settingsFile)) secrets().editJson(p.settingsFile, (s) => { helper = 'apiKeyHelper' in s; delete s.apiKeyHelper; });
  console.log(`accounts key --remove: "${name}" ${gone ? 'key file deleted' : 'had no key file'}; ${helper ? 'apiKeyHelper removed' : 'no apiKeyHelper to remove'}; nothing else touched`);
}

function cmdRemove(ctx, argv) {
  const [name, ...extra] = argv;
  if (!name || extra.length) ctx.die('accounts remove: usage: accounts remove <name>');
  const loaded = loadProfile(ctx, 'remove');
  const account = mustExist(ctx, 'remove', loaded.raw, name);
  leaseGate(ctx, 'remove', [name]);
  const p = pathsOf(name, account);
  const removed = [];
  for (const [label, file] of [['wrapper', p.wrapperSh], ['wrapper', p.wrapperPs1], ['key file', p.keyFile]]) {
    try { fs.unlinkSync(file); removed.push(`${label} ${path.basename(file)}`); } catch { /* absent */ }
  }
  rewriteProfile(ctx, 'remove', loaded, (raw) => { delete rawAccounts(raw)[name]; });
  console.log(`accounts remove: "${name}" removed from ${PROFILE} §16${removed.length ? `; deleted ${removed.join(', ')}` : ''}; the folder ${p.dir} is kept (delete it by hand when the account is gone for good)`);
}

/** One row of `list`: everything a person needs to see the account's state, never the key itself. */
function listRow(name, account, env = process.env, platform = process.platform) {
  const home = accountPaths().home(env);
  const p = accountPaths().paths(home, name, account);
  const keyFile = account.worker === 'codex' ? p.codexAuthFile : p.keyFile;
  const key = secrets().assessKey(keyFile, { platform });
  const lease = leases().state(home, name);
  const takesKey = (account.pays === 'api-key' || account.pays === 'gateway') && account.worker !== 'session';
  const ready = takesKey ? key.ready : true;
  return {
    name,
    worker: account.worker,
    pays: account.pays,
    content: Array.isArray(account.content) ? account.content.join(',') : account.content,
    roles: account.roles && account.roles.length ? account.roles.join(',') : 'all',
    key: { present: key.present, mode: key.mode, acl: key.acl, file: path.basename(keyFile) },
    lease: lease.state === 'none' ? { state: 'none' } : { state: lease.state, pid: lease.lease ? lease.lease.pid : null, lane: lease.lease ? lease.lease.lane : null },
    ready,
    reason: ready ? (key.present ? key.reason : takesKey ? 'ready' : 'no key needed') : key.reason,
  };
}

function cmdList(ctx, argv) {
  const json = argv.includes('--json');
  const unknown = argv.filter((a) => a !== '--json');
  if (unknown.length) ctx.die(`accounts list: unknown option(s): ${unknown.join(' ')}`);
  const loaded = loadProfile(ctx, 'list');
  const parsed = profileLib().parse(loaded.text);
  if (parsed.errors.length) ctx.die(`accounts list: ${PROFILE} does not validate:\n  ${parsed.errors.join('\n  ')}`);
  const accounts = registry().list(parsed.settings);
  if (!accounts.length) {
    if (json) console.log('[]');
    else console.log(`features.accounts: not configured — no account in ${PROFILE} §16; add one with: npx builder-pipeline accounts add <name> --worker <w> --pays <p>`);
    return;
  }
  const rows = accounts.map((a) => listRow(a.name, a));
  if (json) {
    console.log(JSON.stringify(rows.map(({ reason, ...r }) => r), null, 2));
    return;
  }
  const keyText = (r) => (r.key.present ? `key present (${r.key.mode ? `mode ${r.key.mode}` : r.key.acl})` : 'key absent');
  const leaseText = (r) => (r.lease.state === 'none' ? 'lease none' : `lease ${r.lease.state} (pid ${r.lease.pid}${r.lease.lane ? `, lane ${r.lease.lane}` : ''})`);
  const cells = rows.map((r) => [r.name, r.worker, r.pays, r.content, r.roles, keyText(r), leaseText(r), r.ready ? 'ready' : r.reason]);
  const widths = cells[0].map((_, i) => Math.max(...cells.map((c) => c[i].length)));
  for (const c of cells) console.log(c.map((v, i) => (i === c.length - 1 ? v : v.padEnd(widths[i]))).join('  '));
}

// --------------------------- the report (REQ-204, REQ-205) ----------------------------

/** The key file's presence and mode and the lease state for one account — never the key's value. */
function keyAndLease(name, account, env = process.env, platform = process.platform) {
  const home = accountPaths().home(env);
  const p = accountPaths().paths(home, name, account);
  const keyFile = account.worker === 'codex' ? p.codexAuthFile : p.keyFile;
  const key = secrets().assessKey(keyFile, { platform });
  const lease = leases().state(home, name);
  return {
    key: { present: key.present, mode: key.mode, acl: key.acl, file: path.basename(keyFile) },
    lease: lease.state === 'none' ? { state: 'none' } : { state: lease.state, pid: lease.lease ? lease.lease.pid : null, lane: lease.lease ? lease.lease.lane : null },
  };
}

/**
 * Gather the facts of every account (probes, smoke, version, usage readers) and assess them. Impure: runs the
 * probes under their timeout in the scrubbed env. Returns the assessments in assessAll's order, each with its key
 * and lease facts and the readers' notes.
 */
function reportRows(settings, env = process.env) {
  const home = accountPaths().home(env);
  const readings = {};
  const extra = {};
  for (const a of registry().list(settings)) {
    const p = accountPaths().paths(home, a.name, a);
    const got = probes().collect(a, p, { env });
    readings[a.name] = { probes: got.probes, usage: got.usage };
    extra[a.name] = { content: a.content, ...keyAndLease(a.name, a, env), notes: got.notes || [] };
  }
  return assessment().assessAll(settings, readings).map((a) => ({ ...a, ...extra[a.name] }));
}

/** One `gh auth status`-style block per account. Every string is already redacted by the assessment. */
function renderBlock(a) {
  const used = a.budget && a.budget.used;
  const usage = assessment().renderUsage(used) + (used && used.reader ? ` via ${used.reader}` : '');
  const content = Array.isArray(a.content) ? a.content.join(',') : a.content;
  const lines = [
    `${a.name}  (${a.worker}, pays ${a.pays})`,
    `  ${assessment().renderState(a)}`,
    `  - content: ${content}`,
    `  - roles: ${a.roles && a.roles.length ? a.roles.join(', ') : 'all'}`,
    `  - usage: ${usage}`,
    `  - version: ${a.version}`,
    `  - key: ${a.key.present ? `present (${a.key.file}${a.key.mode ? `, mode ${a.key.mode}` : a.key.acl ? `, ${a.key.acl}` : ''})` : 'absent'}`,
    `  - lease: ${a.lease.state === 'none' ? 'none' : `${a.lease.state} (pid ${a.lease.pid}${a.lease.lane ? `, lane ${a.lease.lane}` : ''})`}`,
  ];
  if (a.until) lines.push(`  - until: ${a.until}`);
  if (a.note) lines.push(`  - note: ${a.note}`);
  for (const n of a.notes || []) lines.push(`  - note: ${n}`);
  return lines.join('\n');
}

/**
 * `accounts [--json]`: the report. The feature off, no profile or no account prints `accounts: not configured` and
 * exits 0 — that line is never a pass (REQ-205). It reads nothing of features.orchestrator (REQ-204).
 */
function cmdReport(ctx, argv) {
  const json = argv.includes('--json');
  const unknown = argv.filter((a) => a !== '--json');
  if (unknown.length) ctx.die(`accounts: unknown option(s): ${unknown.join(' ')} — usage: ${USAGE}`);
  const loaded = profileLib().load(ctx.CWD);
  const f = profileLib().feature(loaded.settings, 'accounts');
  const names = registry().list(loaded.settings).map((a) => a.name);
  if (!f.enabled || !names.length) {
    console.log('accounts: not configured');
    return;
  }
  if (loaded.errors.length) ctx.die(`accounts: ${PROFILE} does not validate:\n  ${loaded.errors.join('\n  ')}`);
  const rows = reportRows(loaded.settings);
  if (json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  for (const a of rows) console.log(`${renderBlock(a)}\n`);
  const notReady = rows.filter((a) => a.state !== 'ready');
  if (notReady.length) {
    console.log(`accounts: ${notReady.length} of ${rows.length} not ready (${notReady.map((a) => `${a.name}: ${a.state}`).join('; ')})`);
    process.exit(1);
  }
  console.log(`accounts: ${rows.length} ready`);
}


// --------------------------- M11: install, policy, usage-snapshot ------------------------------------------

/** The gateway settings of the profile (features.accounts.gateway), with the defaults the policy module fills. */
const gatewayCfg = (settings, flags = {}) => {
  const g = (settings.features && settings.features.accounts && settings.features.accounts.gateway) || {};
  const pick = (k, f) => (flags[f] && flags[f][0]) || g[k];
  return { kind: pick('kind', 'gateway'), version: pick('version', 'version'), baseUrl: pick('baseUrl', 'base-url'), tokenFile: pick('tokenFile', 'token-file'), policyFile: pick('policyFile', 'policy') };
};

/** `accounts install [--dry-run] [--force] [--policy <file>]` (REQ-1101, REQ-1102, REQ-1103, REQ-1109). */
function cmdInstall(ctx, argv) {
  const { positional, flags, bare } = parseArgs(argv, { bare: ['dry-run', 'force'] });
  if (positional.length) ctx.die(`accounts install: unexpected argument(s): ${positional.join(' ')}`);
  for (const k of Object.keys(flags)) if (!['policy'].includes(k)) ctx.die(`accounts install: unknown option --${k}`);
  const loaded = loadProfile(ctx, 'install');
  const parsed = profileLib().parse(loaded.text);
  if (parsed.errors.length) ctx.die(`accounts install: ${PROFILE} does not validate:\n  ${parsed.errors.join('\n  ')}`);
  const home = accountPaths().home(process.env);
  const cfg = gatewayPolicy().defaults(home, gatewayCfg(parsed.settings, flags));
  let policyText = null;
  try {
    policyText = fs.readFileSync(cfg.policyFile, 'utf8');
  } catch (_) {
    policyText = null;
  }
  const osHome = require('os').homedir();
  const planned = wrappers().plan({ settings: parsed.settings, home, kitRoot: ctx.KIT, policyText, osHome, accountPaths: accountPaths() });
  if (!planned.files.length) {
    console.log(`accounts install: no claude-code or codex account in ${PROFILE} §16 — nothing to write`);
    return;
  }
  for (const f of planned.files) fs.mkdirSync(path.dirname(f.file), { recursive: true, mode: 0o700 });
  const r = accountsLock().apply(home, planned.files, { force: bare.has('force'), dry: bare.has('dry-run'), kitVersion: ctx.VERSION });
  for (const l of r.lines) console.log(`${bare.has('dry-run') ? '[dry-run] ' : ''}${l}`);
  for (const n of planned.notes) console.log(n);
  console.log(`accounts install: ${r.written.length} written, ${r.unchanged.length} unchanged, ${r.kept.length} kept, ${r.backedUp.length} backed up — lock ${path.relative(process.cwd(), accountPaths().lockFile(home))}`);
}

/** `accounts policy show | dry-run | apply [--gateway g] [--version v] [--base-url u] [--token-file f] [--policy f]` (REQ-1104). */
async function cmdPolicy(ctx, argv) {
  const action = argv[0];
  if (!['show', 'dry-run', 'apply'].includes(action)) ctx.die('accounts policy: show | dry-run | apply');
  const { positional, flags } = parseArgs(argv.slice(1));
  if (positional.length) ctx.die(`accounts policy ${action}: unexpected argument(s): ${positional.join(' ')}`);
  for (const k of Object.keys(flags)) if (!['gateway', 'version', 'base-url', 'token-file', 'policy'].includes(k)) ctx.die(`accounts policy: unknown option --${k}`);
  const loaded = loadProfile(ctx, 'policy');
  const parsed = profileLib().parse(loaded.text);
  const home = accountPaths().home(process.env);
  const r = await gatewayPolicy().run(action, gatewayCfg(parsed.settings, flags), { home });
  console.log(JSON.stringify(r, null, 2));
  if (action === 'dry-run' && r.plan.length) console.log(`accounts policy dry-run: ${r.plan.length} request(s) would be sent — apply with: npx builder-pipeline accounts policy apply`);
  if (action === 'dry-run' && !r.plan.length) console.log('accounts policy dry-run: the gateway matches the policy');
}

/** `accounts usage-snapshot [--out <file>]` (REQ-1105). */
async function cmdUsageSnapshot(ctx, argv) {
  const { positional, flags } = parseArgs(argv);
  if (positional.length) ctx.die(`accounts usage-snapshot: unexpected argument(s): ${positional.join(' ')}`);
  for (const k of Object.keys(flags)) if (!['out', 'gateway', 'version', 'base-url', 'token-file'].includes(k)) ctx.die(`accounts usage-snapshot: unknown option --${k}`);
  const loaded = loadProfile(ctx, 'usage-snapshot');
  const parsed = profileLib().parse(loaded.text);
  const home = accountPaths().home(process.env);
  const r = await gatewayPolicy().usageSnapshot(gatewayCfg(parsed.settings, flags), { home, out: flags.out ? flags.out[0] : undefined });
  console.log(`accounts usage-snapshot: ${r.keys} key row(s) written to ${r.file} (numbers only, never a token or a key)`);
}

const USAGE = 'accounts [--json] | add <name> --worker <w> --pays <p> [options] | note <name> <text…> | key <name> [--remove] | remove <name> | list [--json] | migrate [--dry-run] | install [--dry-run] [--force] [--policy <file>] | policy show|dry-run|apply [--gateway <g>] | usage-snapshot [--out <file>]';

function cmdAccounts(ctx, argv) {
  const sub = argv[0];
  const rest = argv.slice(1);
  if (!sub || sub.startsWith('--')) return cmdReport(ctx, argv);
  if (sub === 'migrate') return cmdMigrate(ctx, rest);
  if (sub === 'add') return cmdAdd(ctx, rest);
  if (sub === 'note') return cmdNote(ctx, rest);
  if (sub === 'key') return cmdKey(ctx, rest).catch((e) => ctx.die(`accounts key: ${e && e.message ? e.message : e}`));
  if (sub === 'remove') return cmdRemove(ctx, rest);
  if (sub === 'list') return cmdList(ctx, rest);
  if (sub === 'install') return cmdInstall(ctx, rest);
  if (sub === 'policy') return cmdPolicy(ctx, rest).catch((e) => ctx.die(`accounts policy: ${e && e.message ? e.message : e}`));
  if (sub === 'usage-snapshot') return cmdUsageSnapshot(ctx, rest).catch((e) => ctx.die(`accounts usage-snapshot: ${e && e.message ? e.message : e}`));
  return ctx.die(`accounts: ${sub ? `unknown subcommand "${sub}"` : 'a subcommand is needed'} — usage: ${USAGE}`);
}

module.exports = { cmdAccounts, migrateText, liveRuns, parseArgs, accountFromFlags, listRow, reportRows, renderBlock, PROFILE, USAGE };
