/**
 * session-usage.cjs + transcript-usage.cjs over a synthetic Claude Code project transcript directory:
 * turns de-duplicated by message id, a background seat measured from its own transcript, a seat with
 * neither usage nor transcript reported as unmeasured, and the orchestrator's own turns scoped to the
 * run's sessions and window.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const sessionUsage = require('../scripts/lib/session-usage.cjs');
const transcript = require('../scripts/lib/transcript-usage.cjs');
const pricing = require('../scripts/lib/pricing.cjs');

const here = dirname(fileURLToPath(import.meta.url));
const project = join(here, 'fixtures', 'transcripts', 'project');
const missing = join(here, 'fixtures', 'transcripts', 'no-such-project');
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `expected ${expected}, got ${actual}`);

test('a message written as several lines is counted once', () => {
  const recs = sessionUsage.records(join(project, 'sess-1', 'subagents', 'agent-bg1.jsonl'));
  const assistantLines = recs.filter((r) => r.type === 'assistant').length;
  const summary = sessionUsage.sumTurns(recs);
  assert.equal(assistantLines, 7);
  assert.equal(summary.turns, 3);
  assert.equal(summary.inputTokens, 100 + 10 + 1);
  // red proof: summing lines instead of messages would read 322 input tokens
  assert.notEqual(summary.inputTokens, 100 * 3 + 10 * 2 + 1 * 2);
  assert.equal(summary.outputTokens, 600);
  assert.equal(summary.durationMs, 12 * 60_000);
});

test('the sidechain filter separates the orchestrator from subagent turns, and <synthetic> is never a model', () => {
  const recs = sessionUsage.records(join(project, 'sess-1.jsonl'));
  const orch = sessionUsage.sumTurns(recs, { sidechain: false });
  assert.deepEqual(orch.perModel.map((m) => m.model), ['claude-opus-5']);
  assert.equal(orch.turns, 3); // msg_o0, msg_o1 (two lines), msg_o2
});

test('costOf prices model by model and is null when any model is unpriced', () => {
  const summary = sessionUsage.sumTurns(sessionUsage.records(join(project, 'sess-1', 'subagents', 'agent-bg1.jsonl')));
  close(sessionUsage.costOf(summary, pricing), (111 * 5 + 600 * 25) / 1e6);
  const unpriced = sessionUsage.sumTurns([{ type: 'assistant', message: { id: 'x', model: 'unknown-model', usage: { input_tokens: 5 } } }]);
  assert.equal(sessionUsage.costOf(unpriced, pricing), null);
});

test('the subagent index reads the agent type from the meta file', () => {
  const index = sessionUsage.subagentIndex(project);
  assert.deepEqual([...index.keys()], ['bg1']);
  assert.equal(index.get('bg1').agentType, 'security-auditor');
  assert.equal(index.get('bg1').sessionId, 'sess-1');
  assert.equal(sessionUsage.subagentUsage('bg2', index), null);
  assert.equal(sessionUsage.subagentIndex(missing).size, 0);
});

test('the subagent index keeps the agent type when a resumed session copies a transcript without its meta', () => {
  const root = mkdtempSync(join(tmpdir(), 'su-dup-'));
  try {
    for (const [sess, meta] of [['a-orig', true], ['b-copy', false]]) {
      const dir = join(root, sess, 'subagents');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'agent-x1.jsonl'), '');
      if (meta) writeFileSync(join(dir, 'agent-x1.meta.json'), JSON.stringify({ agentType: 'security-auditor' }));
    }
    assert.equal(sessionUsage.subagentIndex(root).get('x1').agentType, 'security-auditor');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('orchestrator usage is scoped to the named sessions and the run window', () => {
  const inWindow = sessionUsage.orchestratorUsage(project, ['sess-1'], '2026-01-05T10:00:00.000Z', '2026-01-05T12:00:00.000Z');
  assert.equal(inWindow.turns, 2);
  assert.equal(inWindow.inputTokens, 3000);
  assert.equal(inWindow.outputTokens, 1500);
  // red proof: without the window, the turn before the run starts would be billed to it
  assert.equal(sessionUsage.orchestratorUsage(project, ['sess-1']).inputTokens, 3000 + 99999);
  assert.equal(sessionUsage.orchestratorUsage(project, ['another-session']).turns, 0);
});

test('collect: a foreground dispatch is measured from its dispatch result, with the TTL split', () => {
  const fg = transcript.collect(project).get('fg1');
  assert.equal(fg.source, 'dispatch-result');
  assert.equal(fg.unmeasured, undefined);
  assert.equal(fg.cacheWrite1hTokens, 6000);
  close(pricing.cost(fg.model, fg), (1000 * 2 + 2000 * 10 + 50000 * 0.2 + 4000 * 2.5 + 6000 * 4) / 1e6);
});

test('collect: a background seat with no usage in its dispatch result but its own transcript is measured', () => {
  const bg = transcript.collect(project).get('bg1');
  assert.equal(bg.hasUsage, false);
  assert.equal(bg.source, 'subagent-transcript');
  assert.equal(bg.unmeasured, undefined);
  assert.equal(bg.agentType, 'security-auditor');
  assert.equal(bg.model, 'claude-opus-5');
  assert.equal(bg.inputTokens, 111);
  assert.equal(bg.sessionId, 'sess-1');
  assert.equal(bg.durationMs, 12 * 60_000);
});

test('collect: no transcript and no usage is unmeasured — not a zero-cost seat', () => {
  const bg = transcript.collect(project).get('bg2');
  assert.equal(bg.unmeasured, true);
  assert.equal(bg.source, 'dispatch-result');
});

test('a directory with no transcripts yields empty results, never zeros presented as measurements', () => {
  assert.equal(transcript.collect(missing).size, 0);
  assert.equal(transcript.orchestratorUsage(['sess-1'], null, null, missing), null);
  assert.equal(transcript.orchestratorUsage([], null, null, project), null);
  assert.deepEqual(transcript.orchestratorModel(missing), { models: {}, dominant: null, turns: 0 });
});

test('orchestratorModel tallies the non-sidechain model since the run start', () => {
  const orch = transcript.orchestratorModel(project, '2026-01-05T10:00:00.000Z');
  assert.equal(orch.dominant, 'claude-opus-5');
  assert.equal(orch.models['claude-haiku-4-5'], undefined);
});
