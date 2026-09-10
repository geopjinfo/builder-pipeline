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
const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');

const SCHEMA = 2;
const STATES = ['on', 'off', 'unmeasured', 'experimental-off', 'experimental-on'];
const ACTIVE = new Set(['on', 'unmeasured', 'experimental-on']);

/**
 * Every feature the pack knows, its default, and the keys that must be non-null when it is active. A default of
 * `off` is a statement that the adopter has not told us — never that the feature is unimportant.
 */
const FEATURES = {
  graph: { defaults: { state: 'off', check: null, sync: null, syncFree: null, autoLimitKb: 300 }, requires: ['check'] },
  claims: { defaults: { state: 'on', retracted: null, registryIdPattern: '[A-Z][A-Z0-9]{1,8}-D\\d+[a-z]?' }, requires: [] },
  planSchema: {
    defaults: { state: 'on', sections: ['Track', 'Context', 'Tasks', 'BLOCKERS'], tables: {}, taskColumns: ['Task', 'Cites', 'Test-seed'], oracle: null },
    requires: ['sections'],
  },
  findingsSchema: { defaults: { state: 'on' }, requires: [] },
  reviewTemplate: { defaults: { state: 'on' }, requires: [] },
  handoffPack: { defaults: { state: 'on', tracker: null, decisionIdPattern: 'D-\\d+', base: 'main' }, requires: [] },
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
  builderBatch: { defaults: { state: 'unmeasured', rows: 5 }, requires: ['rows'] },
  fixLane: { defaults: { state: 'unmeasured' }, requires: [] },
  livePage: { defaults: { state: 'experimental-off' }, requires: [] },
  graphTrial: { defaults: { state: 'experimental-off' }, requires: [] },
  personas: { defaults: { state: 'experimental-off' }, requires: [] },
  advisorBuilder: { defaults: { state: 'experimental-off' }, requires: [] },
  mutationGate: { defaults: { state: 'experimental-off' }, requires: [] },
};

const DEFAULTS = {
  schema: SCHEMA,
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

/** @returns {string[]} every problem with a merged settings object */
function validate(settings) {
  const errors = [];
  if (settings.schema !== SCHEMA) errors.push(`schema: expected ${SCHEMA}, got ${JSON.stringify(settings.schema)}`);
  for (const section of ['commands', 'paths', 'models', 'features']) {
    if (!isObject(settings[section])) errors.push(`${section}: must be an object`);
  }
  if (!Array.isArray(settings.protected)) errors.push('protected: must be an array of globs');
  const tier = settings.commands?.tier;
  if (tier !== null && tier !== undefined && (typeof tier !== 'string' || !tier.includes('{tier}'))) {
    errors.push('commands.tier: a command containing {tier}, or null');
  }
  if (settings.paths && !Array.isArray(settings.paths.citationRoots)) errors.push('paths.citationRoots: must be an array');
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
  for (const [name, key] of [['claims', 'registryIdPattern'], ['handoffPack', 'decisionIdPattern']]) {
    const src = settings.features?.[name]?.[key];
    if (typeof src !== 'string') continue;
    try {
      new RegExp(src);
    } catch (e) {
      errors.push(`features.${name}.${key}: not a valid regular expression — ${e.message}`);
    }
  }
  if (settings.features?.orchestratorModel && ACTIVE.has(settings.features.orchestratorModel.state) && !settings.models?.orchestrator) {
    errors.push('models.orchestrator: required while features.orchestratorModel is active');
  }
  for (const [path, value] of strings(settings, '')) {
    if (PLACEHOLDER.test(value)) errors.push(`${path}: unfilled placeholder "${value.slice(0, 80)}"`);
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
  if (blocks.length === 0) return { found: false, settings: clone(DEFAULTS), errors: [] };
  if (blocks.length > 1) return { found: true, settings: clone(DEFAULTS), errors: [`${blocks.length} pipeline-settings blocks — exactly one is allowed`] };
  let raw;
  try {
    raw = JSON.parse(blocks[0][1]);
  } catch (e) {
    return { found: true, settings: clone(DEFAULTS), errors: [`pipeline-settings is not valid JSON: ${e.message}`] };
  }
  if (!isObject(raw)) return { found: true, settings: clone(DEFAULTS), errors: ['pipeline-settings must be a JSON object'] };
  const settings = merge(DEFAULTS, raw);
  return { found: true, settings, errors: validate(settings) };
}

/**
 * Read `PIPELINE_PROFILE.md` from a project root. No profile, or a profile without the block, yields the defaults
 * and `found: false` — every optional feature is then off and says so.
 */
function load(root = process.cwd(), file = 'PIPELINE_PROFILE.md') {
  const path = join(root, file);
  if (!existsSync(path)) return { path, found: false, settings: clone(DEFAULTS), errors: [] };
  return { path, ...parse(readFileSync(path, 'utf8')) };
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

module.exports = { SCHEMA, STATES, FEATURES, DEFAULTS, parse, load, validate, feature, merge };
