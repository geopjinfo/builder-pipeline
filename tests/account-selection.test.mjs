/**
 * The delegation rulebook — skills/references/account-selection.md (plan M5, REQ-501, REQ-502).
 *
 * WHY. The rulebook is the one place that says which account a job goes to. It is read on every placement and
 * believed, so it may name only feature keys the loader knows (REQ-501), it must pass the instruction lint's pure
 * rules (no bare line references, no count claims that drift, no history inside a rule), and every file it points at
 * must ship. The orchestrator skill points at it; the worker brief carries the `Account:` line it describes
 * (REQ-502); the playbook's P4 dispatch and every harness adapter name the account side of a launch.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const PACK = join(dirname(fileURLToPath(import.meta.url)), '..');
const profile = require(join(PACK, 'scripts', 'lib', 'profile.cjs'));
const lint = require(join(PACK, 'scripts', 'lib', 'instruction-lint.cjs'));

const RULEBOOK = 'skills/references/account-selection.md';
const read = (rel) => readFileSync(join(PACK, rel), 'utf8');
const prose = (text) => lint.proseLines(text).join('\n');

describe('REQ-501 the rulebook names only what the kit knows', () => {
  test('red: REQ-501 the rulebook ships and the orchestrator skill §3 points at it', () => {
    assert.ok(existsSync(join(PACK, RULEBOOK)), `${RULEBOOK} is missing`);
    const skill = read('skills/orchestrator.md');
    const s3 = skill.slice(skill.indexOf('## 3.'), skill.indexOf('## 4.'));
    assert.match(s3, /references\/account-selection\.md/, '§3 of the orchestrator skill does not point at the rulebook');
  });

  test('red: REQ-501 every features.<x> key the rulebook names is one the settings loader knows', () => {
    const names = [...read(RULEBOOK).matchAll(/(?<![\w/\\])features\.([A-Za-z]+)/g)].map((m) => m[1]);
    assert.ok(names.includes('accounts'), 'the rulebook never names features.accounts');
    assert.deepEqual([...new Set(names.filter((n) => !profile.FEATURES[n]))], []);
  });

  test('red: REQ-501 every features.accounts key the rulebook names is a registry key', () => {
    const r = profile.accounts;
    const known = new Set([...Object.keys(r.FEATURE_DEFAULTS), ...Object.keys(r.ACCOUNT_DEFAULTS), 'accounts', 'include', 'kind', 'soft', 'hard', 'period']);
    const unknown = [...read(RULEBOOK).matchAll(/`features\.accounts\.([A-Za-z.]+)`/g)].map((m) => m[1]).flatMap((k) => k.split('.')).filter((k) => !known.has(k));
    assert.deepEqual([...new Set(unknown)], []);
  });

  test('red: REQ-501 the rulebook passes the instruction lint rules: no bare line refs, no count claims, no history', () => {
    const text = prose(read(RULEBOOK));
    assert.deepEqual(lint.bareLineRefs(text), []);
    assert.deepEqual(lint.countClaims(text), []);
    assert.deepEqual(lint.historyHits(text), []);
    for (const p of lint.pathCandidates(text, { dirExists: (d) => existsSync(join(PACK, d)) })) {
      const token = typeof p === 'string' ? p : p.token || p.path;
      if (!token) continue;
      assert.ok(existsSync(join(PACK, token)) || existsSync(join(PACK, 'skills', 'references', token)) || existsSync(join(PACK, 'skills', token)), `${RULEBOOK} names ${token}, which does not ship`);
    }
  });

  test('red: REQ-501 the rulebook carries every rule the plan lists, in the registry vocabulary', () => {
    const text = read(RULEBOOK);
    const r = profile.accounts;
    for (const v of [...r.PAYS, ...r.CONTENT]) assert.match(text, new RegExp(`\`${v}\``), `pays/content value ${v} is not named`);
    for (const role of r.HEADLESS_ROLES) assert.ok(text.includes(role), `headless role ${role} is not named`);
    for (const must of ['NEEDS-IT-ONLY', 'needs-account', 'LIMIT', 'BUDGET', 'AUTH', 'OVERLOAD', 'shadow', 'api-key', 'Account:', 'note', 'draft', 'bypass', 'resume']) {
      assert.ok(text.includes(must), `the rulebook does not say "${must}"`);
    }
    assert.match(text, /never a retry loop|not a retry loop/i);
    assert.match(text, /hooks/, 'the rulebook does not rule out a worker that runs without the repo hooks');
  });
});

describe('REQ-502 the Account: line and the account side of a launch', () => {
  test('red: REQ-502 the worker-brief template carries an `Account:` line the orchestrator fills', () => {
    const tpl = read('templates/orchestrator-worker-brief.md');
    assert.match(tpl, /^- Account: <account>/m, 'the template has no `- Account: <account>` line');
  });

  test('red: the playbook P4 dispatch names the account the auditors run on', () => {
    const playbook = read('skills/build-module-pipeline.md');
    const p4 = playbook.slice(playbook.indexOf('**Audit**'), playbook.indexOf('**Validate before you pass'));
    assert.match(p4, /account/i, 'the P4 dispatch step does not name its account');
    assert.match(p4, /account-selection\.md/, 'the P4 dispatch step does not point at the rulebook');
  });

  test('red: every harness adapter carries a worker recipe that says what the kit cannot enforce there', () => {
    for (const tool of ['claude-code', 'codex', 'antigravity']) {
      const text = read(`adapters/${tool}.md`);
      const i = text.indexOf('### Worker recipe');
      assert.ok(i >= 0, `adapters/${tool}.md has no "### Worker recipe" subsection`);
      const section = text.slice(i, text.indexOf('\n## ', i) > 0 ? text.indexOf('\n## ', i) : undefined);
      assert.match(section, /cannot enforce|does not enforce|not enforced/i, `adapters/${tool}.md worker recipe does not say what the kit cannot enforce`);
      assert.match(section, /account-selection\.md/, `adapters/${tool}.md worker recipe does not point at the rulebook`);
    }
  });
});
