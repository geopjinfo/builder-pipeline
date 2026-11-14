import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const profile = require('../scripts/lib/profile.cjs');
const registryGuard = require('../hooks/claude-code/registry-read-guard.cjs');
const reviewerGuard = require('../hooks/claude-code/reviewer-write-guard.cjs');
const bashCapHook = require('../hooks/claude-code/bash-output-cap.cjs');

const hooksDir = join(here, '..', 'hooks', 'claude-code');
const fx = (...p) => join(here, 'fixtures', 'hooks', ...p);
const settingsOf = (dir) => profile.load(fx(dir)).settings;
const withFeatures = (features, paths = {}) => profile.merge(profile.DEFAULTS, { features, paths });
const hook = (file, input, projectDir) =>
  spawnSync(process.execPath, [join(hooksDir, file)], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir } });

const capLogs = fx('bash-cap-project', 'logs-under-test');
after(() => rmSync(capLogs, { recursive: true, force: true }));

// ---- registry read guard -------------------------------------------------------------------------------

test('registry guard red: a listed seat reading the whole registry is blocked and told to read rows', () => {
  const settings = settingsOf('guard-project');
  for (const file_path of ['C:/repo/DEFERRED_TASKS.md', 'C:\\repo\\DEFERRED_TASKS.md', 'DEFERRED_TASKS.md', '/home/me/repo/deferred_tasks.md']) {
    const r = registryGuard.decide({ tool_name: 'Read', agent_type: 'module-builder', tool_input: { file_path } }, settings);
    assert.equal(r.block, true, file_path);
    // With no run command given (run-hint.cjs not loadable) it names the script, not a layout.
    assert.match(r.reason, /instead: ledger-row registry <ID>/);
    const told = registryGuard.decide({ tool_name: 'Read', agent_type: 'module-builder', tool_input: { file_path } }, settings, { ledgerRow: 'node scripts/ledger-row.mjs' });
    assert.match(told.reason, /node scripts\/ledger-row\.mjs registry <ID>/);
  }
  assert.equal(registryGuard.decide({ tool_name: 'Read', agent_type: 'module-builder', tool_input: { file_path: 'DEFERRED_TASKS.md', offset: 1, limit: 40 } }, settings).block, true);
});

test('registry guard: the orchestrator, an unlisted seat, another file and an off feature are all allowed', () => {
  const settings = settingsOf('guard-project');
  const read = (agent_type, file_path, s = settings) => registryGuard.decide({ tool_name: 'Read', agent_type, tool_input: { file_path } }, s).block;
  assert.equal(read(undefined, 'C:/repo/DEFERRED_TASKS.md'), false);
  assert.equal(read('module-reviewer', 'C:/repo/DEFERRED_TASKS.md'), false);
  assert.equal(read('module-builder', 'C:/repo/README.md'), false);
  assert.equal(read('module-builder', 'C:/repo/OLD_DEFERRED_TASKS.md'), false);
  assert.equal(read('module-builder', 'C:/repo/DEFERRED_TASKS.md', withFeatures({ registryGuard: { state: 'off', seats: ['module-builder'] } })), false);
  assert.equal(registryGuard.decide({ tool_name: 'Grep', agent_type: 'module-builder', tool_input: { path: 'DEFERRED_TASKS.md' } }, settings).block, false);
});

test('registry guard: the registry path comes from paths.registry', () => {
  const settings = withFeatures({ registryGuard: { state: 'on', seats: ['module-builder'] } }, { registry: 'docs/backlog.md' });
  assert.equal(registryGuard.decide({ tool_name: 'Read', agent_type: 'module-builder', tool_input: { file_path: '/r/docs/backlog.md' } }, settings).block, true);
  assert.equal(registryGuard.decide({ tool_name: 'Read', agent_type: 'module-builder', tool_input: { file_path: '/r/DEFERRED_TASKS.md' } }, settings).block, false);
});

test('registry guard as a hook: exit 2 with the reason on stderr for a seat, exit 0 for the orchestrator', () => {
  const project = fx('guard-project');
  const blocked = hook('registry-read-guard.cjs', { tool_name: 'Read', agent_type: 'module-tester', tool_input: { file_path: join(project, 'DEFERRED_TASKS.md') } }, project);
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /Blocked Read of .*DEFERRED_TASKS\.md by module-tester/);
  assert.equal(hook('registry-read-guard.cjs', { tool_name: 'Read', tool_input: { file_path: join(project, 'DEFERRED_TASKS.md') } }, project).status, 0);
  assert.equal(hook('registry-read-guard.cjs', {}, project).status, 0);
});

// ---- reviewer write guard ------------------------------------------------------------------------------

test('reviewer guard red: the reviewer may not write outside its review file', () => {
  const settings = settingsOf('guard-project');
  const write = (file_path, tool_name = 'Write') => reviewerGuard.decide({ tool_name, agent_type: 'module-reviewer', tool_input: { file_path } }, settings, { root: 'C:/repo' });
  for (const p of ['src/items/items.service.ts', '.pipeline/items/review-pass2.md.bak', '.pipeline/items/notes.md', '.pipeline/items/sub/review-pass1.md', '.pipeline/../review-pass1.md', '.pipeline/review-pass1.md', 'tasks/items.md']) {
    const r = write(p);
    assert.equal(r.block, true, p);
    assert.match(r.reason, /may write only \.pipeline\/<key>\/review-pass<n>\.md/);
  }
  assert.equal(write('src/x.ts', 'Edit').block, true);
  assert.equal(write('src/x.ts', 'MultiEdit').block, true);
});

test('reviewer guard: its own review pass is allowed, relative or absolute; other seats are not its business', () => {
  const settings = settingsOf('guard-project');
  const decide = (agent_type, file_path) => reviewerGuard.decide({ tool_name: 'Write', agent_type, tool_input: { file_path } }, settings, { root: 'C:/repo' }).block;
  assert.equal(decide('module-reviewer', '.pipeline/items/review-pass2.md'), false);
  assert.equal(decide('module-reviewer', 'C:\\repo\\.pipeline\\items\\review-pass12.md'), false);
  assert.equal(decide('module-builder', 'src/items/items.service.ts'), false);
  assert.equal(decide(undefined, 'src/items/items.service.ts'), false);
});

test('reviewer guard red: a review-pass spelling that LANDS elsewhere through a link is blocked', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const project = fs.mkdtempSync(join(os.tmpdir(), 'rwg-'));
  try {
    fs.mkdirSync(join(project, '.pipeline'), { recursive: true });
    fs.mkdirSync(join(project, 'src', 'items'), { recursive: true });
    fs.symlinkSync(join(project, 'src', 'items'), join(project, '.pipeline', 'k2'), process.platform === 'win32' ? 'junction' : 'dir');
    const decide = (file_path) => reviewerGuard.decide({ tool_name: 'Write', agent_type: 'module-reviewer', tool_input: { file_path } }, withFeatures({}), { root: project }).block;
    assert.equal(decide('.pipeline/k2/review-pass1.md'), true);
    assert.equal(decide('.pipeline/items/review-pass1.md'), false); // control: a real runs folder
  } finally {
    fs.unlinkSync(join(project, '.pipeline', 'k2')); // the link itself, never its target
    rmSync(project, { recursive: true, force: true });
  }
});

test('reviewer guard: the runs directory comes from paths.runs', () => {
  const settings = withFeatures({}, { runs: 'build/runs' });
  const decide = (file_path) => reviewerGuard.decide({ tool_name: 'Write', agent_type: 'module-reviewer', tool_input: { file_path } }, settings).block;
  assert.equal(decide('build/runs/items/review-pass1.md'), false);
  assert.equal(decide('.pipeline/items/review-pass1.md'), true);
});

test('reviewer guard as a hook: exit 2 outside, exit 0 on the review file', () => {
  const project = fx('guard-project');
  const out = hook('reviewer-write-guard.cjs', { tool_name: 'Write', agent_type: 'module-reviewer', tool_input: { file_path: join(project, 'src', 'x.ts'), content: 'x' } }, project);
  assert.equal(out.status, 2);
  assert.match(out.stderr, /Blocked write to src\/x\.ts by module-reviewer/);
  const ok = hook('reviewer-write-guard.cjs', { tool_name: 'Write', agent_type: 'module-reviewer', tool_input: { file_path: join(project, '.pipeline', 'items', 'review-pass1.md'), content: '# review' } }, project);
  assert.equal(ok.status, 0, ok.stderr);
});

// ---- bash output cap hook ------------------------------------------------------------------------------

const big = (middle) => [...Array.from({ length: 300 }, (_, i) => `line ${i} ${'x'.repeat(20)}`), middle, ...Array.from({ length: 300 }, (_, i) => `after ${i}`)].join('\n');
const bashInput = (stdout, command = 'grep -rn thing .', stderr = '') => ({ tool_name: 'Bash', tool_input: { command }, tool_response: { stdout, stderr, interrupted: false, isImage: false } });

test('bash cap hook: off feature, small output, exempt command and the env opt-out all pass through', () => {
  const root = fx('bash-cap-project');
  const on = settingsOf('bash-cap-project');
  assert.deepEqual(bashCapHook.decide(bashInput(big('fine')), settingsOf('guard-project'), { root }), { action: 'pass', reason: 'bashCap: not configured' });
  assert.equal(bashCapHook.decide(bashInput('small'), on, { root }).action, 'pass');
  assert.equal(bashCapHook.decide(bashInput(big('fine'), 'node scripts/run-tier.mjs integration'), on, { root }).reason, 'exempt command');
  assert.equal(bashCapHook.decide(bashInput(big('fine'), 'grep -rn thing . --no-cap'), on, { root }).reason, 'exempt command');
  assert.equal(bashCapHook.decide(bashInput(big('fine')), on, { root, env: { BUILDER_NO_BASH_CAP: '1' } }).reason, 'opted out by environment');
});

test('bash cap hook: a large result is replaced by the digest, the log goes under paths.logs/bash, stderr is kept', () => {
  const root = fx('bash-cap-project');
  const r = bashCapHook.decide(bashInput(big('Error: cannot reach the stock ledger'), 'grep -rn thing .', 'warning: deprecated flag'), settingsOf('bash-cap-project'), { root, stamp: 'T', pid: 1 });
  assert.equal(r.action, 'cap');
  assert.equal(r.logPath, join(root, 'logs-under-test', 'bash', 'T-1.log'));
  assert.match(r.log, /^\$ grep -rn thing \.\n/);
  assert.match(r.log, /\[stderr\]\nwarning: deprecated flag/);
  const out = r.output.hookSpecificOutput;
  assert.equal(out.hookEventName, 'PostToolUse');
  assert.match(out.updatedToolOutput.stdout, /full output: logs-under-test\/bash\/T-1\.log/);
  assert.match(out.updatedToolOutput.stdout, /^301: Error: cannot reach the stock ledger$/m);
  assert.match(out.updatedToolOutput.stdout, /warning: deprecated flag/);
});

test('bash cap hook as a hook: rewrites a large result and writes one log; small and exempt print nothing', () => {
  const project = fx('bash-cap-project');
  rmSync(capLogs, { recursive: true, force: true });
  const large = hook('bash-output-cap.cjs', bashInput(big('fine')), project);
  assert.equal(large.status, 0, large.stderr);
  assert.match(JSON.parse(large.stdout).hookSpecificOutput.updatedToolOutput.stdout, /output capped/);
  const logs = readdirSync(join(capLogs, 'bash'));
  assert.equal(logs.length, 1);
  assert.match(readFileSync(join(capLogs, 'bash', logs[0]), 'utf8'), /after 299/);
  assert.equal(hook('bash-output-cap.cjs', bashInput('small'), project).stdout, '');
  assert.equal(hook('bash-output-cap.cjs', bashInput(big('fine'), 'node scripts/run-tier.mjs unit'), project).stdout, '');
  assert.equal(hook('bash-output-cap.cjs', bashInput(big('fine')), fx('guard-project')).stdout, '');
  assert.equal(hook('bash-output-cap.cjs', 'not json at all', project).status, 0);
  assert.equal(existsSync(join(fx('guard-project'), 'logs')), false);
});
