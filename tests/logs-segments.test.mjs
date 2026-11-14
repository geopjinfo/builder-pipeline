/**
 * paths.logs is judged exactly as it will be written. A segment Windows would silently rewrite — a trailing dot or
 * space — is refused, not normalised, so the folder the check approves is the folder the bash-output cap creates.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { describe, test } from 'node:test';

const require = createRequire(import.meta.url);
const { logsProblem } = require('../scripts/lib/profile.cjs');

describe('paths.logs segments', () => {
  for (const bad of ['logs.', 'logs ', 'a/logs./b', '.claude./hooks', 'logs. /x']) {
    test(`red: ${JSON.stringify(bad)} is refused`, () => {
      assert.match(String(logsProblem(bad, [], { root: tmpdir() })), /dot or a space|whitespace/);
    });
  }
  for (const ok of ['logs', './logs', 'a/b', 'build/logs']) {
    test(`green: ${JSON.stringify(ok)} is accepted`, () => {
      assert.equal(logsProblem(ok, [], { root: tmpdir() }), null);
    });
  }
});
