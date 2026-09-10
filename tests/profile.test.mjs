import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
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
  assert.match(profile.feature(settings, 'builderBatch').line, /unmeasured/);
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

test('feature() refuses a name the pack does not know', () => {
  assert.throws(() => profile.feature(profile.DEFAULTS, 'nope'), /unknown feature/);
});
