'use strict';
/**
 * The pipeline settings loader — the one place a script asks "is this feature configured here?"
 *
 * WHY THIS EXISTS. The pack runs on projects that have no API contract, no permission catalogue, no knowledge
 * graph and no mutation tool. A step that assumes one of those either crashes on an adopter's repo or — worse —
 * finds nothing to check and prints PASS. So every optional step asks this loader first, and an absent feature is
 * SAID: `contract-oracle: not configured`. Silence never reads as a pass, and a missing file never reads as a crash.
 *
 * WHERE SETTINGS LIVE. `PIPELINE_PROFILE.md` stays the one file that makes the pipeline concrete. Its §16 holds a
 * single fenced block:
 *
 *     ```json pipeline-settings
 *     { "schema": 2, "commands": {…}, "paths": {…}, "models": {…}, "protected": […], "features": {…} }
 *     ```
 *
 * JSON because it parses with the standard library everywhere the pack runs; one block because a second config
 * file would split the one source of truth.
 *
 * FEATURE STATES.
 *   on                 the step runs; its required keys must be filled, or the profile is INVALID (never a skip)
 *   off                the step prints "<feature>: not configured" and does nothing
 *   unmeasured         on, and every report says the benefit has not been measured yet
 *   experimental-off   shipped, not enabled
 *   experimental-on    enabled on purpose — its measurement is owed (see EXPERIMENTS.md)
 *
 * An unknown feature name is an error: a typo in a feature name would otherwise switch a check off in silence.
 *
 * Pure over text; `load()` is the only function that touches the filesystem.
 */
const { existsSync, readFileSync, realpathSync } = require('node:fs');
const { basename, dirname, isAbsolute, join, relative, resolve } = require('node:path');
const accountsRegistry = require('./accounts-registry.cjs');

const SCHEMA = 2;
const STATES = ['on', 'off', 'unmeasured', 'experimental-off', 'experimental-on'];
const ACTIVE = new Set(['on', 'unmeasured', 'experimental-on']);
/* features.costAccounting.reader: which harness's transcripts the cost scripts read (scripts/lib/transcript-usage.cjs +
 * session-usage.cjs for Claude Code; scripts/lib/codex-usage.cjs for the Codex CLI). */
const COST_READERS = ['claude-code', 'codex'];

/**
 * Every feature the pack knows, its default, and the keys that must be non-null when it is active. A default of
 * `off` is a statement that the adopter has not told us — never that the feature is unimportant.
 */
const FEATURES = {
  graph: { defaults: { state: 'off', check: null, sync: null, syncFree: null, autoLimitKb: 300 }, requires: ['check'] },
  claims: { defaults: { state: 'on', retracted: null, registryIdPattern: '[A-Z][A-Z0-9]{1,8}-D\\d+[a-z]?', jestBatch: null }, requires: [] },
  planSchema: {
    defaults: { state: 'on', sections: ['Track', 'Context', 'Tasks', 'BLOCKERS'], tables: {}, taskColumns: ['Task', 'Cites', 'Test-seed'], oracle: null },
    requires: ['sections'],
  },
  findingsSchema: { defaults: { state: 'on' }, requires: [] },
  reviewTemplate: { defaults: { state: 'on' }, requires: [] },
  handoffPack: { defaults: { state: 'on', tracker: null, decisionIdPattern: 'D-\\d+', base: 'main' }, requires: [] },
  /* The spec authoring stage before Phase 1 — scripts/spec-check.mjs, skills/spec-author.md. `dir` holds one
   * `<key>.spec.md` per module; `idPattern` is the requirement-id shape its rows must use. */
  specAuthoring: { defaults: { state: 'off', dir: 'specs', idPattern: 'REQ-\\d+' }, requires: ['dir', 'idPattern'] },
  rowReader: { defaults: { state: 'on' }, requires: [] },
  contractOracle: {
    defaults: { state: 'off', adapter: 'openapi3', spec: null, transcript: null, baseline: null, codeField: 'code', statusFamilies: {}, platformCodePattern: null },
    requires: ['adapter', 'spec', 'transcript'],
  },
  rules: { defaults: { state: 'off', runner: 'ast-grep', scan: null, baseline: null, ratcheted: [] }, requires: ['scan'] },
  mutation: { defaults: { state: 'off', tool: null, command: null, report: null, payloadPattern: null }, requires: ['command', 'report'] },
  orchestratorModel: { defaults: { state: 'off', recentTurns: 40 }, requires: [] },
  costAccounting: { defaults: { state: 'off', reader: 'claude-code' }, requires: ['reader'] },
  bashCap: { defaults: { state: 'off', limitBytes: 4096 }, requires: ['limitBytes'] },
  registryGuard: { defaults: { state: 'off', seats: [] }, requires: ['seats'] },
  citations: { defaults: { state: 'off', schemes: [] }, requires: ['schemes'] },
  lineCitations: {
    defaults: { state: 'off', catalogues: [], roots: [], extensions: ['.md'], roster: null, control: null, minFiles: 1, keyColumn: 0 },
    requires: ['catalogues', 'roots'],
  },
  wiring: { defaults: { state: 'off', roots: [], extensions: [], testPattern: null, allow: null, kinds: [] }, requires: ['roots', 'extensions', 'kinds'] },
  /* Every requirement id has a test or a requirement-pack step (assert · by-design · gap · skipped) — scripts/spec-trace-check.mjs. */
  specTrace: {
    defaults: { state: 'off', idPattern: 'REQ-\\d+', requirements: [], tests: [], testPattern: null, packs: [] },
    requires: ['idPattern', 'requirements'],
  },
  instructionBudget: { defaults: { state: 'off', files: [], maxLines: 200 }, requires: ['files', 'maxLines'] },
  /* What instruction files state about the repo must still be true of it — scripts/instruction-lint.mjs. */
  instructionLint: {
    defaults: { state: 'off', files: ['CLAUDE.md', 'AGENTS.md', '.claude/**/*.md'], ignorePaths: [], figures: [], sets: [], history: null, baseline: null },
    requires: ['files'],
  },
  decisionIndex: { defaults: { state: 'off', roots: [], idPattern: 'D-\\d+', out: null }, requires: ['roots', 'idPattern', 'out'] },
  ratchets: { defaults: { state: 'off', lists: [] }, requires: ['lists'] },
  builderBatch: { defaults: { state: 'unmeasured', rows: 5 }, requires: ['rows'] },
  fixLane: { defaults: { state: 'unmeasured' }, requires: [] },
  livePage: { defaults: { state: 'experimental-off' }, requires: [] },
  graphTrial: {
    defaults: { state: 'experimental-off', seats: ['orchestrator', 'module-planner', 'standards-auditor', 'invariant-auditor'], callPattern: null },
    requires: ['seats', 'callPattern'],
  },
  personas: {
    defaults: { state: 'experimental-off', catalogue: null, keyColumn: 0, labelColumn: 1, roleColumns: null, grant: '1', out: null, logins: null, citationPattern: null },
    requires: ['catalogue', 'out', 'citationPattern'],
  },
  advisorBuilder: { defaults: { state: 'experimental-off' }, requires: [] },
  /* A third-party cost plugin on trial lanes (tool pruning + loop guard) — EXPERIMENTS.md §9. Protocol only. */
  tokenEconomizer: { defaults: { state: 'experimental-off' }, requires: [] },
  /* A fresh-context readiness review of plan.md between planner and builder — EXPERIMENTS.md §10. Protocol only. */
  planReview: { defaults: { state: 'experimental-off' }, requires: [] },
  /* After a compaction, hand the session its run files and open FIX rows — hooks/claude-code/reanchor-after-compact.cjs. */
  reanchor: { defaults: { state: 'off', maxRuns: 2 }, requires: ['maxRuns'] },
  /* The one door a model-backed check sends through: denied files, secret shapes, env values, size — scripts/lib/outbound-guard.cjs. */
  outboundGuard: {
    defaults: {
      state: 'off',
      maxBytes: 8000,
      denyPaths: ['.env', '.env.*', '*.pem', '*.key', '*.p12', '*.pfx', 'id_rsa*', 'id_ed25519*', '*.keystore', 'credentials*.json'],
      envFiles: ['.env', '.env.local', '.env.development', '.env.test'],
      extraPatterns: [],
      timeoutMs: 20000,
    },
    requires: ['maxBytes', 'denyPaths'],
  },
  /* Cheap-model checks from the decision-model review — EXPERIMENTS.md §12–15. Protocol only; each needs outboundGuard on. */
  rankedSearch: { defaults: { state: 'experimental-off' }, requires: [] },
  riskHint: { defaults: { state: 'experimental-off' }, requires: [] },
  walkPriority: { defaults: { state: 'experimental-off' }, requires: [] },
  ruleNotes: { defaults: { state: 'experimental-off' }, requires: [] },
  mutationGate: { defaults: { state: 'experimental-off' }, requires: [] },
  /* The lite split: build-module-lite (plan → build → test, then queue) + build-module-lite-gate-batch (every
   * later phase over up to `cap` queued modules). `ledgers` / `docsOnly` are extra path regexes the gate queue
   * treats as bookkeeping (re-opens nothing) / docs (re-opens no module phase) — see scripts/lib/gate-queue.cjs. */
  liteSplit: {
    defaults: { state: 'experimental-off', cap: 4, trigger: 3, ledgers: ['(^|/)CHANGELOG\\.md$'], docsOnly: ['(^|/)README\\.md$'] },
    requires: [],
  },
  /* Removes finished git worktrees after their branch merged — scripts/worktree-sweep.mjs. `holdCommand` is the
   * project's own "something still needs this worktree" check (null = none). */
  worktreeSweep: {
    defaults: { state: 'off', target: null, idleHours: 6, prefix: null, reserved: [], backupDirs: ['logs', '.pipeline'], holdCommand: null },
    requires: ['target'],
  },
  /* The batch orchestrator above the pipeline — scripts/orch.mjs, skills/orchestrator.md. It splits a plan into
   * disjoint lanes, places each lane on an account (`features.accounts`), merges finished lanes one at a time into
   * `target` through `gates`, and runs headless jobs on an api-key account with the guards in scripts/lib/orch-credit.cjs.
   * The 1.0 keys `seats`, `limits`, `secondaryConfigDir` and `credit` are gone: a profile that still carries them is
   * refused while the orchestrator is active and warned about otherwise (`npx builder accounts migrate`, D33). Every
   * command template is the project's own; null means "not available here" and the step says so. */
  orchestrator: {
    defaults: {
      state: 'off',
      target: null,
      branchPrefix: 'orch/',
      worktreePrefix: null,
      maxLanes: 2,
      smallEnabled: false,
      standardPipeline: 'full',
      hot: ['CHANGELOG.md', 'package.json', 'package-lock.json', '.gitignore'],
      sourceRoots: ['src/'],
      riskPaths: { migration: [], platform: [], permission: [] },
      modulePattern: null,
      modulesDir: null,
      stallMinutes: 90,
      usageStaleMinutes: 30,
      primaryLaunch: 'manual',
      usageCommand: null,
      launchCommand: null,
      stateCommand: null,
      stopCommand: null,
      gates: null,
      integration: true,
      linkDirs: [],
      linkGuard: [],
      mechanical: null,
      capacity: null,
      preflight: [],
      tests: { mode: 'local', local: null, remote: null },
    },
    requires: ['target'],
  },
  /* Named accounts the orchestrator places lanes on: worker, who pays, content class, roles, budget, note — the
   * registry rules are in scripts/lib/accounts-registry.cjs (plan M1, D22, D32). Replaces the 1.0 seats and credit lane. */
  accounts: { defaults: accountsRegistry.FEATURE_DEFAULTS, requires: [] },
};

/** The project's visibility (§1, D23): what a `public` or `scratch` account may launch on. Default private — fail closed. */
const VISIBILITY = Object.freeze(['public', 'private']);

const DEFAULTS = {
  schema: SCHEMA,
  visibility: 'private',
  commands: { tier: null, tiers: [], affected: null, typecheck: null },
  paths: {
    boards: 'tasks',
    registry: 'DEFERRED_TASKS.md',
    runs: '.pipeline',
    decisions: 'DECISIONS.md',
    handoffs: 'handoffs',
    logs: 'logs',
    citationRoots: [],
  },
  models: { orchestrator: null, strong: null, mid: null },
  protected: [],
  features: Object.fromEntries(Object.entries(FEATURES).map(([k, v]) => [k, { ...v.defaults }])),
};

const BLOCK = /```json[ \t]+pipeline-settings[ \t]*\r?\n([\s\S]*?)\r?\n```/g;
const PLACEHOLDER = /<[^<>\n]{2,80}>/;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => JSON.parse(JSON.stringify(v));

/** Walk every string in a value, with its dotted path. */
function strings(value, path, out = []) {
  if (typeof value === 'string') out.push([path, value]);
  else if (Array.isArray(value)) value.forEach((v, i) => strings(v, `${path}[${i}]`, out));
  else if (isObject(value)) for (const [k, v] of Object.entries(value)) strings(v, path ? `${path}.${k}` : k, out);
  return out;
}

/**
 * A path as forward-slash segments, as Windows reads them: `.` and empty segments dropped, trailing dots and spaces
 * cut from each segment (`.claude./hooks ` is `.claude/hooks`): `a//./b\c/` → `a/b/c`.
 */
const logSegs = (p) =>
  String(p)
    .replace(/\\/g, '/')
    .split('/')
    .map((s) => (s === '..' ? s : s.replace(/[. ]+$/, '')))
    .filter((s) => s && s !== '.');
const LOG_FENCE_DIRS = ['.claude/hooks', '.codex/hooks'];

/** Real path of `p` (which may not exist yet): realpath of the deepest existing ancestor, plus the rest. Throws. */
function realDeepest(p) {
  const tail = [];
  for (let head = resolve(p); ;) {
    if (existsSync(head)) return join(realpathSync.native(head), ...tail);
    const up = dirname(head);
    if (up === head) return resolve(p);
    tail.unshift(basename(head));
    head = up;
  }
}

/**
 * Why a `paths.logs` value is refused, or null. The bash cap writes there with fs, unseen by the protected-paths
 * fence, so the folder must be project-relative (no drive, root, `~`, `$`), have no `..` segment anywhere, and lie
 * outside `.claude/hooks/`, `.codex/hooks/`, every §16 `protected` glob's fixed prefix and every prefix in
 * `opts.prefixes` (the fence's whole set: its built-in list and BUILDER_PROTECTED). Compared by SEGMENTS after
 * normalising (`.claude//hooks`, `.claude/./hooks`, `.claude\hooks` are `.claude/hooks`), case-insensitively. With
 * `opts.root` it is also judged by where it LANDS — the real path of its deepest existing ancestor, so a junction or
 * symlink into a fence or a hook folder, or out of the project, is refused; a path that cannot be resolved is refused.
 * @param {{ root?: string, prefixes?: string[] }} [opts]
 */
function logsProblem(logs, protectedGlobs, opts = {}) {
  if (typeof logs !== 'string' || !logs.trim()) return 'a non-empty project-relative folder';
  const shown = JSON.stringify(logs);
  // Judged as written: the cap joins the raw value, so surrounding whitespace is refused, never trimmed away.
  if (logs !== logs.trim()) return `must not start or end with whitespace (it is written as given), got ${shown}`;
  const p = logs.trim().replace(/\\/g, '/');
  if (/^(?:\/|~|[A-Za-z]:|\$|%)/.test(p) || /[$%`]/.test(p)) return `must be a literal project-relative folder, got ${shown}`;
  if (p.split('/').includes('..')) return `must stay inside the project (no .. segment), got ${shown}`;
  if (p.split('/').some((s) => s.includes(':'))) return `must not name a stream or a drive (a ':' in a segment), got ${shown}`;
  // A segment Windows would rewrite (trailing dots or spaces, leading or inner whitespace runs at the ends) is refused,
  // not normalised: the folder judged must be exactly the folder written.
  if (p.split('/').some((s) => s && s !== '.' && s !== s.replace(/[. ]+$/, '').replace(/^\s+/, ''))) return `must not end a segment in a dot or a space, got ${shown}`;
  const fences = [];
  for (const h of LOG_FENCE_DIRS) fences.push({ segs: logSegs(h), what: `the hook folder ${h}/` });
  for (const g of Array.isArray(protectedGlobs) ? protectedGlobs : []) {
    if (typeof g !== 'string' || g.trim().startsWith('!')) continue;
    let pre = g.trim().replace(/\\/g, '/');
    const wild = pre.search(/[*?[\]{}]/);
    if (wild !== -1) pre = pre.slice(0, pre.slice(0, wild).lastIndexOf('/') + 1);
    const segs = logSegs(pre);
    if (!segs.length) continue; // no fixed folder (`*.md`): the fence skips such a glob too (globPrefix)
    fences.push({ segs, what: `the protected glob ${JSON.stringify(g)}` });
  }
  for (const pre of Array.isArray(opts.prefixes) ? opts.prefixes : []) if (typeof pre === 'string' && logSegs(pre).length) fences.push({ segs: logSegs(pre), what: `the protected path ${JSON.stringify(pre)}` });
  // The cap writes into <logs>/bash: refused when that target is under a fence, or a fence equals it or sits under it.
  const same = (a, b) => a.every((s, i) => s.toLowerCase() === b[i].toLowerCase());
  const inside = (segs) => fences.find((f) => (f.segs.length <= segs.length ? same(f.segs, segs) : same(segs, f.segs)));
  const spelled = inside([...logSegs(p), 'bash']);
  if (spelled) return `must not be under ${spelled.what}, got ${shown}`;
  if (opts.root) {
    let rel;
    try {
      const root = realDeepest(opts.root);
      const real = realDeepest(join(opts.root, ...logSegs(p), 'bash'));
      const r = relative(root, real);
      if (r.startsWith('..') || isAbsolute(r)) return `must land inside the project, got ${shown} (it resolves to ${real.replace(/\\/g, '/')})`;
      rel = logSegs(r);
      if (!rel.length) return `must not land on the project root, got ${shown}`;
    } catch (e) {
      return `cannot be resolved (${e.code || e.message}); this fails closed, got ${shown}`;
    }
    const landed = inside(rel);
    if (landed) return `must not land under ${landed.what}, got ${shown} (it resolves to ${rel.join('/')})`;
  }
  return null;
}

/** @returns {string[]} every problem with a merged settings object */
function validate(settings) {
  const errors = [];
  if (settings.schema !== SCHEMA) errors.push(`schema: expected ${SCHEMA}, got ${JSON.stringify(settings.schema)}`);
  if (!VISIBILITY.includes(settings.visibility)) errors.push(`visibility: ${VISIBILITY.map((v) => JSON.stringify(v)).join(' or ')} (the project's visibility, §1; a public-only account launches only on a public project), got ${JSON.stringify(settings.visibility)}`);
  for (const section of ['commands', 'paths', 'models', 'features']) {
    if (!isObject(settings[section])) errors.push(`${section}: must be an object`);
  }
  if (!Array.isArray(settings.protected)) errors.push('protected: must be an array of globs');
  const tier = settings.commands?.tier;
  if (tier !== null && tier !== undefined && (typeof tier !== 'string' || !tier.includes('{tier}'))) {
    errors.push('commands.tier: a command containing {tier}, or null');
  }
  if (settings.paths && !Array.isArray(settings.paths.citationRoots)) errors.push('paths.citationRoots: must be an array');
  // The bash cap hook writes logs there with fs, unseen by the protected-paths fence: keep it inside the project and
  // out of every protected glob and hook folder.
  if (settings.paths && settings.paths.logs !== undefined) {
    const why = logsProblem(settings.paths.logs, settings.protected);
    if (why) errors.push(`paths.logs: ${why}`);
  }
  /*
   * The run directory is fixed in schema 2. The board freshness gate, the watcher, the renderer's run-log reader and
   * the installer's .gitignore line all use `.pipeline`; a setting three of them ignored would put a run's pages in
   * one folder and read its log from another. Refused rather than half-honoured.
   */
  if (settings.paths && settings.paths.runs !== '.pipeline') {
    errors.push(`paths.runs: fixed at ".pipeline" in schema ${SCHEMA} (the freshness gate, watcher and installer assume it), got ${JSON.stringify(settings.paths.runs)}`);
  }

  for (const [name, config] of Object.entries(settings.features ?? {})) {
    const known = FEATURES[name];
    if (!known) {
      errors.push(`features.${name}: unknown feature — known: ${Object.keys(FEATURES).join(', ')}`);
      continue;
    }
    if (!isObject(config)) {
      errors.push(`features.${name}: must be an object`);
      continue;
    }
    if (!STATES.includes(config.state)) errors.push(`features.${name}.state: one of ${STATES.join(' | ')}, got ${JSON.stringify(config.state)}`);
    if (ACTIVE.has(config.state)) {
      for (const key of known.requires) {
        const v = config[key];
        const empty = v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
        if (empty) errors.push(`features.${name}.${key}: required while the feature is ${config.state} — fill it, or set state to "off"`);
      }
    }
  }
  /* Nested shapes a script would otherwise only reject mid-run, after a seat had already been dispatched. */
  const oracle = settings.features?.planSchema?.oracle;
  if (oracle !== null && oracle !== undefined) {
    const bad = !isObject(oracle) || ['table', 'column', 'source', 'keyColumn'].some((k) => typeof oracle[k] !== 'string' || !oracle[k]);
    if (bad) errors.push('features.planSchema.oracle: null, or { "table", "column", "source", "keyColumn" } — all non-empty strings');
  }
  const jestBatch = settings.features?.claims?.jestBatch;
  if (jestBatch !== null && jestBatch !== undefined && (!isObject(jestBatch) || typeof jestBatch.cacheDir !== 'string' || !jestBatch.cacheDir)) {
    errors.push('features.claims.jestBatch: null, or { "cacheDir": "<folder for the per-config result logs>" }');
  }
  const tracker = settings.features?.handoffPack?.tracker;
  if (tracker !== null && tracker !== undefined) {
    const bad =
      !isObject(tracker) ||
      !Array.isArray(tracker.files) ||
      tracker.files.length === 0 ||
      typeof tracker.lists !== 'string' ||
      !isObject(tracker.columnLists ?? {});
    if (bad) errors.push('features.handoffPack.tracker: null, or { "files": [non-empty], "lists": "<csv>", "columnLists": { file: { column: list } } }');
  }
  const badRegex = (src) => {
    try {
      new RegExp(src);
      return null;
    } catch (e) {
      return e.message;
    }
  };
  for (const [name, key] of [
    ['claims', 'registryIdPattern'],
    ['handoffPack', 'decisionIdPattern'],
    ['wiring', 'testPattern'],
    ['lineCitations', 'control'],
    ['decisionIndex', 'idPattern'],
    ['graphTrial', 'callPattern'],
    ['personas', 'citationPattern'],
    ['specTrace', 'idPattern'],
    ['specTrace', 'testPattern'],
  ]) {
    const src = settings.features?.[name]?.[key];
    if (typeof src !== 'string') continue;
    const why = badRegex(src);
    if (why) errors.push(`features.${name}.${key}: not a valid regular expression — ${why}`);
  }
  /*
   * The list-shaped features. Each entry is checked here, at load, because a malformed entry found mid-run is
   * found after a seat has already been dispatched on the strength of a check that could not have run.
   */
  const entries = (name, key) => {
    const v = settings.features?.[name]?.[key];
    return Array.isArray(v) ? v : null;
  };
  for (const [name, key] of [['citations', 'schemes'], ['wiring', 'kinds'], ['ratchets', 'lists'], ['lineCitations', 'catalogues'], ['instructionBudget', 'files']]) {
    const v = settings.features?.[name]?.[key];
    if (v !== undefined && v !== null && !Array.isArray(v)) errors.push(`features.${name}.${key}: must be an array`);
  }
  (entries('citations', 'schemes') ?? []).forEach((s, i) => {
    const at = `features.citations.schemes[${i}]`;
    if (!isObject(s) || typeof s.name !== 'string' || !s.name) return errors.push(`${at}: { "name", "pattern", "source" } with a non-empty name`);
    if (typeof s.pattern !== 'string' || badRegex(s.pattern)) errors.push(`${at}.pattern: a valid regular expression for the whole id`);
    if (s.skip !== undefined && s.skip !== null && (typeof s.skip !== 'string' || badRegex(s.skip))) errors.push(`${at}.skip: null, or a valid regular expression`);
    const src = s.source;
    const kinds = isObject(src) ? ['csv', 'dir', 'files'].filter((k) => src[k] !== undefined) : [];
    if (kinds.length !== 1) return errors.push(`${at}.source: exactly one of { "csv", "column" } · { "dir", "filePattern" } · { "files", "idPattern" }`);
    if (kinds[0] === 'csv' && (typeof src.csv !== 'string' || !(typeof src.column === 'string' || Number.isInteger(src.column)))) errors.push(`${at}.source: "csv" needs a path and a "column" (header name or 0-based index)`);
    /* `dir` is one path or a non-empty list of paths: ids from every directory are merged into one set (a project
       whose records live in more than one folder must not see a real id in the second folder fail as invented). */
    const dirOk = typeof src.dir === 'string' || (Array.isArray(src.dir) && src.dir.length > 0 && src.dir.every((d) => typeof d === 'string' && d));
    if (kinds[0] === 'dir' && (!dirOk || typeof src.filePattern !== 'string' || badRegex(src.filePattern))) errors.push(`${at}.source: "dir" needs a path (or a non-empty list of paths) and a "filePattern" regular expression with one capture group`);
    if (kinds[0] === 'files' && (!Array.isArray(src.files) || src.files.length === 0 || typeof src.idPattern !== 'string' || badRegex(src.idPattern))) errors.push(`${at}.source: "files" needs a non-empty path list and an "idPattern" regular expression`);
  });
  (entries('wiring', 'kinds') ?? []).forEach((k, i) => {
    const at = `features.wiring.kinds[${i}]`;
    if (!isObject(k) || typeof k.name !== 'string' || !k.name) return errors.push(`${at}: { "name", "declare", "join" } with a non-empty name`);
    if (typeof k.declare !== 'string' || badRegex(k.declare) || !/\((?!\?)/.test(k.declare)) errors.push(`${at}.declare: a valid regular expression with one capture group (the seam id)`);
    if (typeof k.join !== 'string' || !k.join.includes('{id}') || badRegex(k.join.split('{id}').join('x'))) errors.push(`${at}.join: a regular expression containing {id}`);
    if (k.scope !== undefined && !['other-files', 'any-file'].includes(k.scope)) errors.push(`${at}.scope: "other-files" (default) or "any-file"`);
    if (k.optional !== undefined && typeof k.optional !== 'boolean') errors.push(`${at}.optional: true or false`);
    if (k.detail !== undefined && typeof k.detail !== 'string') errors.push(`${at}.detail: a string`);
  });
  (entries('ratchets', 'lists') ?? []).forEach((l, i) => {
    const at = `features.ratchets.lists[${i}]`;
    if (!isObject(l) || ['name', 'bank', 'measured'].some((k) => typeof l[k] !== 'string' || !l[k])) errors.push(`${at}: { "name", "bank", "measured" } — all non-empty strings`);
  });
  /* A repeated name silently merges two entries in every report keyed by it — one bank drained into another. */
  for (const [name, key] of [['citations', 'schemes'], ['wiring', 'kinds'], ['ratchets', 'lists']]) {
    const seen = new Set();
    for (const e of entries(name, key) ?? []) {
      if (!isObject(e) || typeof e.name !== 'string') continue;
      if (seen.has(e.name)) errors.push(`features.${name}.${key}: the name "${e.name}" is used twice — names must be unique`);
      seen.add(e.name);
    }
  }
  const trace = settings.features?.specTrace;
  if (isObject(trace)) {
    for (const k of ['requirements', 'tests', 'packs']) {
      const v = trace[k];
      if (v !== undefined && v !== null && (!Array.isArray(v) || v.some((p) => typeof p !== 'string' || !p))) errors.push(`features.specTrace.${k}: an array of non-empty paths`);
    }
    const none = (v) => !Array.isArray(v) || v.length === 0;
    if (ACTIVE.has(trace.state) && none(trace.tests) && none(trace.packs)) {
      errors.push('features.specTrace: needs "tests" or "packs" (or both) while the feature is on — a trace with nowhere to look traces nothing');
    }
  }
  const sweep = settings.features?.worktreeSweep;
  if (isObject(sweep)) {
    for (const k of ['reserved', 'backupDirs']) {
      const v = sweep[k];
      if (v !== undefined && (!Array.isArray(v) || v.some((s) => typeof s !== 'string' || !s))) errors.push(`features.worktreeSweep.${k}: an array of non-empty strings`);
    }
    if (sweep.idleHours !== undefined && !(typeof sweep.idleHours === 'number' && Number.isFinite(sweep.idleHours) && sweep.idleHours >= 0)) {
      errors.push('features.worktreeSweep.idleHours: a number >= 0');
    }
    const hold = sweep.holdCommand;
    if (hold !== undefined && hold !== null && (typeof hold !== 'string' || !hold.includes('{path}'))) {
      errors.push('features.worktreeSweep.holdCommand: null, or a command containing {path}');
    }
  }
  /* The cost readers the kit ships. A third value would make cost-window print "unmeasurable" for a typo. */
  const reader = settings.features?.costAccounting?.reader;
  if (reader !== undefined && reader !== null && !COST_READERS.includes(reader)) {
    errors.push(`features.costAccounting.reader: one of ${COST_READERS.map((r) => `"${r}"`).join(' | ')}, got ${JSON.stringify(reader)}`);
  }
  errors.push(...validateOrchestrator(settings, badRegex));
  errors.push(...accountsRegistry.validateAccounts(settings, { secretPatterns: require('./outbound-guard.cjs').PATTERNS }));
  // The 1.0 seat keys: refused only while the orchestrator is active (D33); `warnings()` carries the other case.
  const legacy = accountsRegistry.legacyKeys(settings.features?.orchestrator);
  if (legacy.length && ACTIVE.has(settings.features?.orchestrator?.state)) errors.push(accountsRegistry.legacyMessage(legacy));
  const budget = settings.features?.instructionBudget?.maxLines;
  if (budget !== undefined && budget !== null && !(Number.isInteger(budget) && budget > 0)) errors.push('features.instructionBudget.maxLines: a positive integer');
  if (settings.features?.orchestratorModel && ACTIVE.has(settings.features.orchestratorModel.state) && !settings.models?.orchestrator) {
    errors.push('models.orchestrator: required while features.orchestratorModel is active');
  }
  for (const [path, value] of strings(settings, '')) {
    if (PLACEHOLDER.test(value)) errors.push(`${path}: unfilled placeholder "${value.slice(0, 80)}"`);
  }
  return errors;
}

/**
 * features.orchestrator — the shapes a run would otherwise only reject after lanes were launched. Shapes are
 * checked in any state (a typo waits for the day someone switches it on); requirements only while it is active.
 */
function validateOrchestrator(settings, badRegex) {
  const errors = [];
  const o = settings.features?.orchestrator;
  if (!isObject(o)) return errors;
  const at = (k) => `features.orchestrator.${k}`;
  const strList = (v) => Array.isArray(v) && v.every((s) => typeof s === 'string' && s);
  const active = ACTIVE.has(o.state);
  for (const k of ['hot', 'sourceRoots', 'linkDirs', 'linkGuard']) if (o[k] !== undefined && !strList(o[k])) errors.push(`${at(k)}: an array of non-empty strings`);
  if (o.riskPaths !== undefined) {
    if (!isObject(o.riskPaths)) errors.push(`${at('riskPaths')}: { "migration": [globs], "platform": [globs], "permission": [globs] }`);
    else {
      for (const [k, v] of Object.entries(o.riskPaths)) {
        if (!['migration', 'platform', 'permission'].includes(k)) errors.push(`${at(`riskPaths.${k}`)}: unknown — migration | platform | permission`);
        else if (!strList(v)) errors.push(`${at(`riskPaths.${k}`)}: an array of globs`);
      }
    }
  }
  if (o.modulePattern !== undefined && o.modulePattern !== null) {
    const why = typeof o.modulePattern === 'string' ? badRegex(o.modulePattern) : 'not a string';
    if (why) errors.push(`${at('modulePattern')}: not a valid regular expression — ${why}`);
    else if (!/\((?!\?)/.test(o.modulePattern)) errors.push(`${at('modulePattern')}: needs one capture group (the module name)`);
  }
  const positive = (k, int = false) => {
    const v = o[k];
    if (v !== undefined && !(typeof v === 'number' && Number.isFinite(v) && v > 0 && (!int || Number.isInteger(v)))) errors.push(`${at(k)}: a ${int ? 'positive integer' : 'number > 0'}`);
  };
  if (o.mechanical !== undefined && o.mechanical !== null) {
    const kinds = ['semver', 'changelog', 'json', 'union'];
    if (!isObject(o.mechanical)) errors.push(`${at('mechanical')}: null, or { "semver": [files], "changelog": [files], "json": [files], "union": [files] }`);
    else {
      const seen = new Set();
      for (const [k, v] of Object.entries(o.mechanical)) {
        if (!kinds.includes(k)) errors.push(`${at(`mechanical.${k}`)}: unknown — ${kinds.join(' | ')}`);
        else if (!strList(v)) errors.push(`${at(`mechanical.${k}`)}: an array of repo-relative file paths`);
        else for (const f of v) seen.has(f) ? errors.push(`${at('mechanical')}: ${f} is listed under two kinds`) : seen.add(f);
      }
    }
  }
  if (o.capacity !== undefined && o.capacity !== null) {
    const c = o.capacity;
    const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
    if (!isObject(c)) errors.push(`${at('capacity')}: null, or { "laneCap": n, "seat": "secondary"|"primary", "underPct": pct, "defaultLanes": n }`);
    else {
      if (!int(c.laneCap, 1, 16)) errors.push(`${at('capacity.laneCap')}: a whole number of lanes, 1–16`);
      if (c.seat !== undefined && !['secondary', 'primary'].includes(c.seat)) errors.push(`${at('capacity.seat')}: "secondary" or "primary"`);
      if (c.underPct !== undefined && !(typeof c.underPct === 'number' && c.underPct > 0 && c.underPct <= 100)) errors.push(`${at('capacity.underPct')}: a percentage in (0, 100]`);
      if (c.defaultLanes !== undefined && !int(c.defaultLanes, 1, 16)) errors.push(`${at('capacity.defaultLanes')}: a whole number of lanes, 1–16`);
    }
  }
  positive('maxLanes', true);
  positive('stallMinutes');
  positive('usageStaleMinutes');
  if (o.standardPipeline !== undefined && !['full', 'lite'].includes(o.standardPipeline)) errors.push(`${at('standardPipeline')}: "full" or "lite"`);
  if (active && o.standardPipeline === 'lite' && !ACTIVE.has(settings.features?.liteSplit?.state)) {
    errors.push(`${at('standardPipeline')}: "lite" needs features.liteSplit enabled — the lite lanes queue into its gate batch`);
  }
  if (o.primaryLaunch !== undefined && !['manual', 'app-session'].includes(o.primaryLaunch)) {
    errors.push(`${at('primaryLaunch')}: "manual" (the human starts the lane's session) or "app-session" (the orchestrator starts it — adapters/claude-code.md)`);
  }
  const template = (k, needs) => {
    const v = o[k];
    if (v === undefined || v === null) return;
    if (typeof v !== 'string' || !v.trim()) return errors.push(`${at(k)}: null, or a command`);
    for (const n of needs) if (!v.includes(`{${n}}`)) errors.push(`${at(k)}: must contain {${n}}`);
  };
  template('usageCommand', ['seat']);
  template('stateCommand', ['session']);
  template('stopCommand', ['session']);
  template('launchCommand', ['brief']);
  template('gates', []);
  for (const k of ['branchPrefix', 'worktreePrefix', 'modulesDir']) if (o[k] !== undefined && o[k] !== null && (typeof o[k] !== 'string' || !o[k])) errors.push(`${at(k)}: null, or a non-empty string`);
  /* The accounts the orchestrator runs on (features.accounts, through the 1.0 view until M3): a terminal worker
   * account needs a launch command; an api-key account needs a model floor to check against. */
  if (active) {
    const view = accountsRegistry.legacyView(settings);
    if (view.seats.includes('secondary') && !view.launchCommand && !o.launchCommand) {
      errors.push(`features.accounts.accounts.${view.accounts.secondary}.command: required for a terminal worker account — it is how its lane starts ({brief})`);
    }
    if (view.credit.enabled && !settings.models?.strong && !settings.models?.mid) errors.push('models.strong / models.mid: at least one is required while an api-key account exists — the model floor is checked against them');
  }
  if (o.preflight !== undefined) {
    if (!Array.isArray(o.preflight)) errors.push(`${at('preflight')}: an array of { "name", "command", "tests"? }`);
    else {
      const names = new Set();
      o.preflight.forEach((c, i) => {
        if (!isObject(c) || typeof c.name !== 'string' || !c.name || typeof c.command !== 'string' || !c.command) return errors.push(`${at(`preflight[${i}]`)}: { "name", "command" } — non-empty strings`);
        if (c.tests !== undefined && !['local', 'remote'].includes(c.tests)) errors.push(`${at(`preflight[${i}].tests`)}: "local" or "remote"`);
        if (names.has(c.name)) errors.push(`${at('preflight')}: the name "${c.name}" is used twice`);
        names.add(c.name);
      });
    }
  }
  const tests = o.tests;
  if (tests !== undefined) {
    if (!isObject(tests)) errors.push(`${at('tests')}: { "mode", "local", "remote" }`);
    else {
      if (!['local', 'remote'].includes(tests.mode)) errors.push(`${at('tests.mode')}: "local" or "remote"`);
      for (const k of ['local', 'remote']) if (tests[k] !== undefined && tests[k] !== null && (typeof tests[k] !== 'string' || !tests[k].includes('{tier}'))) errors.push(`${at(`tests.${k}`)}: null, or a command containing {tier}`);
      if (tests.mode === 'remote' && !tests.remote) errors.push(`${at('tests.remote')}: required while tests.mode is "remote"`);
    }
  }
  return errors;
}

/** Deep-merge a profile block over the defaults. Arrays replace; objects merge; unknown keys are kept (validate names them). */
function merge(base, over) {
  if (!isObject(over)) return clone(over);
  const out = clone(base);
  for (const [k, v] of Object.entries(over)) out[k] = isObject(v) && isObject(out[k]) ? merge(out[k], v) : clone(v);
  return out;
}

/**
 * @param {string} text  the profile markdown
 * @returns {{ found: boolean, settings: object, errors: string[] }}
 */
function parse(text) {
  const blocks = [...String(text).matchAll(BLOCK)];
  if (blocks.length === 0) return { found: false, settings: clone(DEFAULTS), errors: [], warnings: [] };
  if (blocks.length > 1) return { found: true, settings: clone(DEFAULTS), errors: [`${blocks.length} pipeline-settings blocks — exactly one is allowed`], warnings: [] };
  let raw;
  try {
    raw = JSON.parse(blocks[0][1]);
  } catch (e) {
    return { found: true, settings: clone(DEFAULTS), errors: [`pipeline-settings is not valid JSON: ${e.message}`], warnings: [] };
  }
  if (!isObject(raw)) return { found: true, settings: clone(DEFAULTS), errors: ['pipeline-settings must be a JSON object'], warnings: [] };
  const settings = merge(DEFAULTS, raw);
  return { found: true, settings, errors: validate(settings), warnings: warnings(settings) };
}

/**
 * What loads but should be said once: the 1.0 seat keys on a profile whose orchestrator is off (D33). An error
 * here would stop every checker in every installed project after `upgrade`; a warning names the fix and lets them run.
 * @returns {string[]}
 */
function warnings(settings) {
  const out = [];
  const legacy = accountsRegistry.legacyKeys(settings.features?.orchestrator);
  if (legacy.length && !ACTIVE.has(settings.features?.orchestrator?.state)) out.push(accountsRegistry.legacyMessage(legacy));
  return out;
}

const warned = new Set();
/** Print a profile warning to stderr once per process (every checker loads the profile; the person reads it once). */
function warnOnce(path, list) {
  for (const w of list || []) {
    const key = `${path}:${w}`;
    if (warned.has(key) || process.env.BUILDER_PROFILE_QUIET) continue;
    warned.add(key);
    process.stderr.write(`${basename(path)}: warning — ${w}\n`);
  }
}

/**
 * The project root that owns a directory: the nearest ancestor holding `PIPELINE_PROFILE.md` or a `.pipeline/`.
 * A board's directory is `paths.boards`, which may sit several levels below the root, so "the board's grandparent"
 * is not the root — it was, in the installer's default layout, and every reader that assumed so lost the run log
 * and the profile the moment an adopter moved the boards. With nothing marking a root the grandparent stands in,
 * which keeps a fixture board in a bare temp directory working as before.
 */
function rootOf(dir) {
  let cur = resolve(dir);
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(cur, 'PIPELINE_PROFILE.md')) || existsSync(join(cur, '.pipeline'))) return cur;
    const up = dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return resolve(dir, '..');
}

/** The one settings block as bare JSON text (a config file, REQ-101): the same merge and validation as the §16 block. */
function parseJson(text) {
  let raw;
  try {
    raw = JSON.parse(String(text));
  } catch (e) {
    return { found: true, settings: clone(DEFAULTS), errors: [`pipeline-settings is not valid JSON: ${e.message}`] };
  }
  if (!isObject(raw)) return { found: true, settings: clone(DEFAULTS), errors: ['pipeline-settings must be a JSON object'] };
  const settings = merge(DEFAULTS, raw);
  return { found: true, settings, errors: validate(settings) };
}

/** The config file a project without a profile may use: `BUILDER_CONFIG` names it, else `<root>/builder.config.json`. */
const CONFIG_FILE = 'builder.config.json';
function configPath(root, env = process.env) {
  if (env.BUILDER_CONFIG) return isAbsolute(env.BUILDER_CONFIG) ? env.BUILDER_CONFIG : resolve(root, env.BUILDER_CONFIG);
  const local = join(root, CONFIG_FILE);
  return existsSync(local) ? local : null;
}

/**
 * Read the project's settings. `PIPELINE_PROFILE.md` is the source when it exists; a profile without the block yields
 * the defaults and `found: false`. With no profile, the config file (`BUILDER_CONFIG`, else `builder.config.json`)
 * is read as the bare JSON of the §16 block — same shape, same validation — so one kit tool runs in a project that
 * never adopted the pipeline (REQ-101, REQ-102). A config file beside a profile is ignored and named in `notes`
 * (REQ-103): two sources would be two truths. `source` is 'profile' | 'config' | 'defaults'.
 */
function load(root = process.cwd(), file = 'PIPELINE_PROFILE.md', env = process.env) {
  const path = join(root, file);
  const config = configPath(root, env);
  if (existsSync(path)) {
    const notes = config ? [`${relative(root, config).split('\\').join('/') || config} is ignored: ${file} exists and is the one source of settings`] : [];
    const loaded = { path, source: 'profile', configPath: null, notes, ...parse(readFileSync(path, 'utf8')) };
    warnOnce(path, loaded.warnings || []);
    return loaded;
  }
  if (config) {
    if (!existsSync(config)) {
      return { path, source: 'config', configPath: config, notes: [], found: false, settings: clone(DEFAULTS), errors: [`BUILDER_CONFIG names ${config}, which does not exist`], warnings: [] };
    }
    const loaded = { path, source: 'config', configPath: config, notes: [], ...parseJson(readFileSync(config, 'utf8')) };
    if (!loaded.warnings) loaded.warnings = [];
    warnOnce(config, loaded.warnings);
    return loaded;
  }
  return { path, source: 'defaults', configPath: null, notes: [], found: false, settings: clone(DEFAULTS), errors: [], warnings: [] };
}

/**
 * The one sentence a step prints about a feature, and whether it should run.
 * @returns {{ name: string, state: string, enabled: boolean, config: object, line: string }}
 */
function feature(settings, name) {
  if (!FEATURES[name]) throw new Error(`profile.feature: unknown feature "${name}"`);
  const config = { ...FEATURES[name].defaults, ...(settings?.features?.[name] ?? {}) };
  const { state } = config;
  const enabled = ACTIVE.has(state);
  const line = {
    on: `${name}: on`,
    off: `${name}: not configured`,
    unmeasured: `${name}: on (unmeasured — its benefit has not been measured; see EXPERIMENTS.md)`,
    'experimental-off': `${name}: experimental — not enabled`,
    'experimental-on': `${name}: experimental — enabled; its measurement is owed (EXPERIMENTS.md)`,
  }[state] ?? `${name}: invalid state ${JSON.stringify(state)}`;
  return { name, state, enabled, config, line };
}

module.exports = { SCHEMA, STATES, VISIBILITY, FEATURES, DEFAULTS, CONFIG_FILE, COST_READERS, parse, parseJson, load, configPath, validate, warnings, logsProblem, feature, merge, rootOf, accounts: accountsRegistry };
