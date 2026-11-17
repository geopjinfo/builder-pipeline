/**
 * The golden placement fixture (plan M0, REQ-106). `tests/fixtures/orch-placements-1.0.json` records what the 1.0
 * placement rule (seats `primary` / `secondary`, percent limits, a stale window) decided for 36 scenarios. The
 * accounts registry (2.0, `features.accounts`) must place the migrated form of each scenario on the same account:
 * `accounts migrate` is proven against this file, not against the messages a test happened to assert.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const PACK = join(dirname(fileURLToPath(import.meta.url)), '..');
const state = require(join(PACK, 'scripts', 'lib', 'orch-state.cjs'));
const golden = JSON.parse(readFileSync(join(PACK, 'tests', 'fixtures', 'orch-placements-1.0.json'), 'utf8'));

describe('golden placement fixture (REQ-106)', () => {
  test('red: the fixture holds the 1.0 scenarios, each with a seat decision or a hold', () => {
    assert.ok(golden.cases.length >= 30, 'the fixture must cover the seat orders, fresh, stale and absent readings');
    for (const c of golden.cases) {
      assert.ok(c.name && c.state && c.expected && typeof c.running === 'number', `malformed case ${c.name}`);
      assert.ok(c.expected.seat === null || ['primary', 'secondary'].includes(c.expected.seat), `${c.name}: seat`);
      assert.ok(typeof c.expected.why === 'string' && c.expected.why.length > 0, `${c.name}: why`);
    }
    assert.ok(golden.cases.some((c) => c.expected.seat === null && /USAGE-HOLD/.test(c.expected.why)), 'a hold case');
    assert.ok(golden.cases.some((c) => c.expected.seat === null && /USAGE-UNKNOWN/.test(c.expected.why)), 'an unknown case');
  });

  test('red: the 1.0 placement rule reproduces every golden decision (the fixture is the reference, not the code)', () => {
    const at = Date.parse(golden.at);
    for (const c of golden.cases) {
      const got = state.placement(c.state, at, c.running);
      assert.deepEqual(got, c.expected, c.name);
    }
  });
});

describe('accounts migrate reproduces every golden decision through the registry (REQ-106)', () => {
  const registry = require(join(PACK, 'scripts', 'lib', 'accounts-registry.cjs'));
  test('red: 1.0 seats and limits → accounts → the 1.0 view → the same placement', () => {
    const at = Date.parse(golden.at);
    for (const c of golden.cases) {
      const legacy = { schema: 2, features: { orchestrator: { state: 'on', target: 'dev', seats: c.state.seats, ...(c.state.limits ? { limits: c.state.limits } : {}), launchCommand: 'go {brief}' } } };
      const migrated = registry.migrate(legacy);
      assert.equal(migrated.changed, true, c.name);
      assert.equal(registry.legacyKeys(migrated.settings.features.orchestrator).length, 0, `${c.name}: legacy keys left`);
      assert.equal(registry.migrate(migrated.settings).changed, false, `${c.name}: a second migrate must change nothing`);
      const view = registry.legacyView(migrated.settings);
      const got = state.placement({ ...c.state, seats: view.seats, limits: view.limits }, at, c.running);
      assert.deepEqual(got, c.expected, c.name);
    }
  });
});
