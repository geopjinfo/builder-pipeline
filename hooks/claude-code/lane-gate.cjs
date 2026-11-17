#!/usr/bin/env node
/**
 * TaskCompleted and Stop hook — run the lane's gate before a worker may call its work done. CLAUDE CODE ONLY.
 * (plan M6, REQ-605, D52)
 *
 * The kit writes this entry into a lane's `--settings` pin (orch-worker-claude-code.cjs gateHookEntries), never into
 * a project's live settings. The gate is the lane's own test command (`--gate "<command>"`, or BUILDER_LANE_GATE).
 * A gate that exits 0 lets the completion through (exit 0). A gate that fails returns exit 2, and the gate output
 * is the reason the harness shows the worker, so the verdict stays open.
 *
 * `--marker <text>` is the kit marker the pin writer adds; it is how the entry is found and removed again. It is
 * not read here. The hook reads its stdin (the harness's JSON) to the end and ignores it.
 */
'use strict';
const { spawnSync } = require('node:child_process');

function main() {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? null : argv[i + 1];
  };
  const gate = flag('--gate') || process.env.BUILDER_LANE_GATE || null;
  if (!gate) {
    process.stderr.write('lane-gate: no gate command (--gate or BUILDER_LANE_GATE) — completion refused\n');
    return 2;
  }
  try {
    require('node:fs').readFileSync(0, 'utf8');
  } catch (_) {
    /* no stdin */
  }
  const r = spawnSync(gate, { shell: true, encoding: 'utf8', windowsHide: true, timeout: Number(process.env.BUILDER_LANE_GATE_TIMEOUT_MS) || 20 * 60 * 1000 });
  if (r.status === 0) return 0;
  const out = `${r.stdout || ''}${r.stderr || ''}`.split(/\r?\n/).filter(Boolean);
  const tail = out.slice(-40).join('\n');
  process.stderr.write(`lane-gate: the gate failed (${r.status === null ? r.signal || 'no exit code' : `exit ${r.status}`}) — completion refused\n${tail}\n`);
  return 2;
}

process.exit(main());
