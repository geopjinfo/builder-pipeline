import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const profile = require('../scripts/lib/profile.cjs');
const sample = readFileSync(join(here, 'fixtures', 'profile', 'python-service.PIPELINE_PROFILE.md'), 'utf8');

const block = (obj) => `# profile\n\n## 16. Pipeline settings\n\n\`\`\`json pipeline-settings\n${JSON.stringify(obj, null, 2)}\n\`\`\`\n`;

test('the non-TypeScript sample profile validates', () => {
  const { found, errors, settings } = profile.parse(sample);
  assert.equal(found, true);
  assert.deepEqual(errors, []);
  assert.equal(settings.commands.tier, 'python -m pytest tests/{tier} -q');
});

test('an off feature says "not configured" and does not run', () => {
  const { settings } = profile.parse(sample);
  const f = profile.feature(settings, 'contractOracle');
  assert.equal(f.enabled, false);
  assert.equal(f.line, 'contractOracle: not configured');
});

test('a feature the profile never mentions takes its default, and the default is stated', () => {
  const { settings } = profile.parse(sample);
  assert.equal(profile.feature(settings, 'claims').enabled, true);
  assert.equal(profile.feature(settings, 'builderBatch').line, 'builderBatch: not configured'); // off by default since 2.0.0 (REQ-1403)
  assert.match(profile.feature({ features: { builderBatch: { state: 'unmeasured' } } }, 'builderBatch').line, /unmeasured/);
  assert.match(profile.feature(settings, 'livePage').line, /experimental — not enabled/);
});

test('no profile block at all: defaults, found=false, optional features off', () => {
  const { found, errors, settings } = profile.parse('# a profile with prose only\n');
  assert.equal(found, false);
  assert.deepEqual(errors, []);
  assert.equal(profile.feature(settings, 'rules').line, 'rules: not configured');
});

test('red: a feature switched on with its required keys empty is invalid, never a silent skip', () => {
  const { errors } = profile.parse(block({ schema: 2, features: { contractOracle: { state: 'on' } } }));
  assert.ok(errors.some((e) => e.startsWith('features.contractOracle.spec: required')), errors.join('\n'));
});

test('red: an unknown feature name is an error — a typo must not switch a check off', () => {
  const { errors } = profile.parse(block({ schema: 2, features: { contractOracel: { state: 'off' } } }));
  assert.ok(errors.some((e) => e.startsWith('features.contractOracel: unknown feature')), errors.join('\n'));
});

test('red: an unfilled template placeholder is invalid', () => {
  const { errors } = profile.parse(block({ schema: 2, commands: { tier: '<your test command with {tier}>' } }));
  assert.ok(errors.some((e) => e.includes('unfilled placeholder')), errors.join('\n'));
});

test('red: a tier command without {tier}, a wrong schema, bad JSON, two blocks', () => {
  assert.ok(profile.parse(block({ schema: 2, commands: { tier: 'pytest' } })).errors.some((e) => e.startsWith('commands.tier')));
  assert.ok(profile.parse(block({ schema: 1 })).errors.some((e) => e.startsWith('schema:')));
  assert.ok(profile.parse('```json pipeline-settings\n{ nope\n```').errors[0].includes('not valid JSON'));
  assert.ok(profile.parse(block({ schema: 2 }) + block({ schema: 2 })).errors[0].includes('exactly one'));
});

test('red: orchestratorModel active without a declared orchestrator model', () => {
  const { errors } = profile.parse(block({ schema: 2, features: { orchestratorModel: { state: 'on' } } }));
  assert.ok(errors.some((e) => e.startsWith('models.orchestrator')), errors.join('\n'));
});

test('red: a run directory other than .pipeline is refused, not half-honoured', () => {
  const { errors } = profile.parse(block({ schema: 2, paths: { runs: 'build/runs' } }));
  assert.ok(errors.some((e) => e.startsWith('paths.runs: fixed at ".pipeline"')), errors.join('\n'));
  assert.deepEqual(profile.parse(block({ schema: 2, paths: { runs: '.pipeline' } })).errors, []);
});

test('red: a malformed plan oracle, handoff tracker or id pattern is refused at load, not mid-run', () => {
  const bad = (features) => profile.parse(block({ schema: 2, features })).errors;
  assert.ok(bad({ planSchema: { state: 'on', oracle: { table: 'routes' } } }).some((e) => e.startsWith('features.planSchema.oracle')));
  assert.ok(bad({ handoffPack: { state: 'on', tracker: { files: [] } } }).some((e) => e.startsWith('features.handoffPack.tracker')));
  assert.ok(bad({ claims: { state: 'on', registryIdPattern: '([' } }).some((e) => e.startsWith('features.claims.registryIdPattern')));
  const good = bad({
    planSchema: { state: 'on', oracle: { table: 'routes', column: 'Key', source: 'docs/keys.csv', keyColumn: 'key' } },
    handoffPack: { state: 'on', tracker: { files: ['board.csv'], lists: 'lists.csv', columnLists: {} } },
  });
  assert.deepEqual(good, []);
});

test('red: an unknown orchestrator primaryLaunch mode is refused; both known modes load', () => {
  const errs = (primaryLaunch) => profile.parse(block({ schema: 2, features: { orchestrator: { state: 'off', primaryLaunch } } })).errors
    .filter((e) => e.includes('primaryLaunch'));
  assert.equal(errs('cloud').length, 1);
  assert.deepEqual(errs('manual'), []);
  assert.deepEqual(errs('app-session'), []);
});

test('feature() refuses a name the pack does not know', () => {
  assert.throws(() => profile.feature(profile.DEFAULTS, 'nope'), /unknown feature/);
});

test('red: REQ-401 the top-level visibility fact is private by default and a closed set', () => {
  assert.equal(profile.parse(block({ schema: 2 })).settings.visibility, 'private');
  assert.equal(profile.parse(block({ schema: 2, visibility: 'public' })).settings.visibility, 'public');
  assert.deepEqual(profile.parse(block({ schema: 2, visibility: 'public' })).errors, []);
  const { errors } = profile.parse(block({ schema: 2, visibility: 'internal' }));
  assert.ok(errors.some((e) => e.startsWith('visibility: "public" or "private"')), errors.join('\n'));
  assert.equal(profile.DEFAULTS.visibility, 'private');
});

test('REQ-401 the template §16 block carries visibility private', () => {
  const tpl = readFileSync(join(here, '..', 'PIPELINE_PROFILE.template.md'), 'utf8');
  const raw = JSON.parse(/```json pipeline-settings\r?\n([\s\S]*?)\r?\n```/.exec(tpl)[1]);
  assert.equal(raw.visibility, 'private');
  assert.match(tpl, /\*\*Visibility:\*\*/);
});

test('red: AC-1801 branchSweep on without target is invalid; remote outside list|off prints the allowed set; negative days refused', () => {
  const on = profile.parse(block({ schema: 2, features: { branchSweep: { state: 'on' } } })).errors;
  assert.ok(on.some((e) => e.startsWith('features.branchSweep.target: required')), on.join('\n'));
  const remote = profile.parse(block({ schema: 2, features: { branchSweep: { state: 'off', remote: 'delete' } } })).errors;
  assert.ok(remote.some((e) => e.includes('features.branchSweep.remote') && e.includes('list, off')), remote.join('\n'));
  const neg = profile.parse(block({ schema: 2, features: { branchSweep: { state: 'off', staleDays: -1 }, runSweep: { state: 'off', keepDays: -2 } } })).errors;
  assert.ok(neg.some((e) => e.startsWith('features.branchSweep.staleDays')), neg.join('\n'));
  assert.ok(neg.some((e) => e.startsWith('features.runSweep.keepDays')), neg.join('\n'));
  const ok = profile.parse(block({ schema: 2, features: { branchSweep: { state: 'on', target: 'main', remote: 'off' }, runSweep: { state: 'on', roots: ['.pipeline'] } } })).errors;
  assert.deepEqual(ok, []);
  assert.equal(profile.FEATURES.branchSweep.defaults.state, 'off');
  assert.equal(profile.FEATURES.runSweep.defaults.state, 'off');
});

/* ------------------------------------------------------------------ 2.1.0: the capacity governor (M15) ---- */

test('REQ-1501 capacity on without perLaneMb is invalid naming the key; a negative reserveCores is invalid (AC-1501a, AC-1501b)', () => {
  const on = profile.parse(block({ schema: 2, features: { capacity: { state: 'on' } } }));
  assert.ok(on.errors.some((e) => e.startsWith('features.capacity.perLaneMb: required while the feature is on')), on.errors.join('\n'));
  const neg = profile.parse(block({ schema: 2, features: { capacity: { state: 'on', perLaneMb: 1500, reserveCores: -1 } } }));
  assert.ok(neg.errors.some((e) => e.startsWith('features.capacity.reserveCores: a whole number 0 or more')), neg.errors.join('\n'));
  const zero = profile.parse(block({ schema: 2, features: { capacity: { state: 'on', perLaneMb: 1500, intervalSeconds: 0 } } }));
  assert.ok(zero.errors.some((e) => e.startsWith('features.capacity.intervalSeconds: a whole number of 1 or more')), zero.errors.join('\n'));
  const ok = profile.parse(block({ schema: 2, features: { capacity: { state: 'on', perLaneMb: 1500 } } }));
  assert.deepEqual(ok.errors, []);
  assert.equal(profile.feature(ok.settings, 'capacity').config.riseAfterTicks, 3, 'the defaults fill the rest');
  const off = profile.parse(block({ schema: 2, features: { capacity: { state: 'off' } } }));
  assert.deepEqual(off.errors, [], 'off needs no perLaneMb');
});

test('REQ-1514 the template §16 block carries capacity off with perLaneMb null — the kit ships no machine figure (AC-1514b)', () => {
  const tpl = readFileSync(join(here, '..', 'PIPELINE_PROFILE.template.md'), 'utf8');
  const raw = JSON.parse(/```json pipeline-settings\r?\n([\s\S]*?)\r?\n```/.exec(tpl)[1]);
  assert.equal(raw.features.capacity.state, 'off');
  assert.equal(raw.features.capacity.perLaneMb, null);
  assert.equal(profile.FEATURES.capacity.defaults.perLaneMb, null);
});

describe('REQ-1601 — features.reporter rules', () => {
  const withReporter = (reporter) => profile.parse('```json pipeline-settings\n' + JSON.stringify({ schema: 2, features: { reporter: { state: 'on', ...reporter } } }) + '\n```\n');
  test('red: AC-1601a a channel of kind email is invalid and the message prints the allowed set', () => {
    const r = withReporter({ channels: [{ kind: 'email' }] });
    assert.ok(r.errors.some((e) => /features\.reporter\.channels\[0\]\.kind: one of stdout \| file \| webhook \| command/.test(e)), r.errors.join('\n'));
  });
  test('red: AC-1601b a webhook with a literal url is invalid, names urlEnv or urlFile, and never echoes the URL', () => {
    const r = withReporter({ channels: [{ kind: 'webhook', format: 'slack', url: 'https://hooks.example.test/T000/B000/secretpart' }] });
    const text = r.errors.join('\n');
    assert.match(text, /urlEnv|urlFile/);
    assert.ok(!text.includes('secretpart') && !text.includes('hooks.example.test'), text);
  });
  test('red: AC-1601d alertOn outside the closed set is invalid and the message prints the set', () => {
    const r = withReporter({ channels: [{ kind: 'stdout' }], alertOn: ['email'] });
    assert.ok(r.errors.some((e) => /stall, failed, conflict, rate-limit, limit, run-complete/.test(e)), r.errors.join('\n'));
    assert.deepEqual(withReporter({ channels: [{ kind: 'stdout' }], alertOn: ['stall'] }).errors, []);
  });
});

describe('REQ-1811 to REQ-1813 — the tree hygiene rows', () => {
  const parse = (features) => profile.parse('```json pipeline-settings\n' + JSON.stringify({ schema: 2, features }) + '\n```\n');
  test('red: the three features exist with the spec defaults, off', () => {
    assert.deepEqual(profile.FEATURES.ignoreCheck.defaults, { state: 'off', extra: [], allow: [] });
    assert.deepEqual(profile.FEATURES.sizeCheck.defaults, { state: 'off', maxFileKb: 512, history: false, maxCommits: 500, allow: [] });
    assert.deepEqual(profile.FEATURES.secretScan.defaults, { state: 'off', roots: ['.'], allow: [], history: false, maxCommits: 200 });
  });
  test('red: a negative number, a non-boolean history and a list with a non-string are invalid, each naming its key', () => {
    const r = parse({ sizeCheck: { state: 'on', maxFileKb: -1, history: 'yes' }, secretScan: { state: 'on', roots: [1] }, ignoreCheck: { state: 'on', allow: 'x' } });
    for (const key of ['features.sizeCheck.maxFileKb: a positive integer', 'features.sizeCheck.history: true or false', 'features.secretScan.roots: an array of non-empty strings', 'features.ignoreCheck.allow: an array of non-empty strings']) {
      assert.ok(r.errors.includes(key), `${key}\n${r.errors.join('\n')}`);
    }
    assert.deepEqual(parse({ sizeCheck: { state: 'on', maxFileKb: 256, history: true, maxCommits: 50, allow: ['a/*'] } }).errors, []);
  });
});

describe('REQ-1845 — features.orchestrator.gates is a command or a list of commands', () => {
  const parse = (orchestrator) => profile.parse('```json pipeline-settings\n' + JSON.stringify({ schema: 2, features: { orchestrator: { state: 'on', target: 'dev', ...orchestrator } } }) + '\n```\n');
  test('red: a string, null and a list naming hygiene-gate are valid; an empty list and a list with a blank entry are not, each naming the key', () => {
    assert.deepEqual(parse({ gates: 'npm test' }).errors.filter((e) => e.includes('gates')), []);
    assert.deepEqual(parse({ gates: null }).errors.filter((e) => e.includes('gates')), []);
    assert.deepEqual(parse({ gates: ['hygiene-gate', 'npm test'] }).errors.filter((e) => e.includes('gates')), []);
    for (const bad of [[], [''], ['npm test', 3]]) {
      const r = parse({ gates: bad });
      assert.ok(r.errors.some((e) => e.startsWith('features.orchestrator.gates:') && e.includes('hygiene-gate')), `${JSON.stringify(bad)}\n${r.errors.join('\n')}`);
    }
  });
});
