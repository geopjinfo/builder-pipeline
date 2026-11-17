#!/usr/bin/env node
'use strict';
/**
 * Stub headless worker for the board-loop tests (BUILDER_LOOP_WORKER_BIN). Reads the pass input from stdin, records it
 * to BUILDER_LOOP_STUB_INPUTS/pass-<n>.txt, reads the pass script from BUILDER_LOOP_STUB_SCRIPT (JSON: { passes: [...],
 * default: {...} }, one entry per pass, the default for the rest) and plays it:
 *   writes: [{ path, text }]          files written in cwd (the worker's edits)
 *   boardEdit: { row, status }        flip another row on the board (a scope breach)
 *   verdict: PASS | CHANGES_REQUESTED | ERROR | null (no structured output)
 *   head: 'auto' | '<sha>'            the head the verdict judges ('auto' = HEAD of cwd)
 *   hang: true                        never exit
 *   turns: N                          assistant events to emit
 *   cost: number | null
 * The pass number comes from BUILDER_LOOP_STUB_COUNTER (a file the stub increments).
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', async () => {
  const input = Buffer.concat(chunks).toString('utf8');
  const counter = process.env.BUILDER_LOOP_STUB_COUNTER;
  let n = 1;
  try {
    n = Number(fs.readFileSync(counter, 'utf8')) + 1;
  } catch (_) {
    n = 1;
  }
  fs.writeFileSync(counter, String(n));
  if (process.env.BUILDER_LOOP_STUB_INPUTS) {
    fs.mkdirSync(process.env.BUILDER_LOOP_STUB_INPUTS, { recursive: true });
    fs.writeFileSync(path.join(process.env.BUILDER_LOOP_STUB_INPUTS, `pass-${n}.txt`), input);
  }
  const script = JSON.parse(fs.readFileSync(process.env.BUILDER_LOOP_STUB_SCRIPT, 'utf8'));
  const step = { verdict: 'PASS', head: 'auto', turns: 2, cost: 0.01, writes: [], ...(script.default || {}), ...((script.passes || [])[n - 1] || {}) };
  const out = (ev) => process.stdout.write(JSON.stringify(ev) + '\n');
  out({ type: 'system', subtype: 'init', apiKeySource: 'none' });
  for (const w of step.writes || []) {
    fs.mkdirSync(path.dirname(path.resolve(w.path)), { recursive: true });
    fs.writeFileSync(w.path, w.text);
  }
  if (step.boardEdit) {
    const m = /^Board: (.+)$/m.exec(input);
    const board = m[1].trim();
    const text = fs.readFileSync(board, 'utf8').split(/\r?\n/).map((l) => (l.startsWith(`| ${step.boardEdit.row} |`) ? l.replace(/\| (PLANNED|IN-PROGRESS|DONE|BLOCKED[^|]*) \|/, `| ${step.boardEdit.status} |`) : l)).join('\n');
    fs.writeFileSync(board, text);
  }
  for (let i = 0; i < (step.turns || 0); i++) out({ type: 'assistant', message: { content: [{ type: 'text', text: `turn ${i + 1}` }] } });
  if (step.hang) await new Promise(() => setInterval(() => {}, 1000));
  const ids = (/^Requirement ids: (.*)$/m.exec(input) || [, ''])[1].split(',').map((s) => s.trim()).filter(Boolean);
  const row = (/^Row: (\S+)/m.exec(input) || [, '?'])[1];
  let head = step.head;
  if (head === 'auto') head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const result = { type: 'result', subtype: 'success', is_error: false, total_cost_usd: step.cost === null ? undefined : step.cost };
  if (step.verdict) result.structured_output = { verdict: step.verdict, summary: `row ${row} by the stub`, filesTouched: (step.writes || []).map((w) => w.path), head, requirements: ids };
  out(result);
  process.exit(0);
});
