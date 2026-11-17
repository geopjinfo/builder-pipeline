#!/usr/bin/env node
/**
 * PreToolUse hook (matcher `Bash`) — the loop worker's gate command in its two normalised forms, nothing wider.
 * CLAUDE CODE ONLY. (plan M9, D69)
 *
 * The loop's allow list names the gate command exactly. Measured runs showed the model running the same command with
 * a `cd <worktree> &&` prefix or a `| tail -n 15` behind it, and every such pass ended INCOMPLETE on a denied tool. D69
 * normalises those two forms and widens nothing else:
 *   - `cd <path> && <gate>` where <path> normalises to the lane's own worktree: no `..`, no other directory, no second
 *     `&&`;
 *   - `<gate> | head -n N` or `<gate> | tail -n N`, N numeric, one pipe;
 *   - both together, in that order.
 * Any other shell command gets no answer from this hook, so the permission system (the exact allow list, `dontAsk`)
 * denies it as before. `--gate` and `--worktree` come from the pin the runner writes; `--marker` is the kit marker that
 * finds the entry again. Exit 0 always; a fault here changes nothing.
 */
'use strict';
const path = require('node:path');

const PIPE = /^\s*\|\s*(head|tail)\s+-n\s+(\d+)\s*$/;

/** Is `command` the gate command in one of the D69 forms for this worktree? Pure. */
function allowed(command, { gate, worktree }) {
  if (typeof command !== 'string' || typeof gate !== 'string' || !gate.trim()) return false;
  let rest = command.trim();
  const g = gate.trim();
  // optional `cd <path> &&` prefix: exactly the worktree after normalisation, no `..` segment
  const cd = /^cd\s+("([^"]+)"|'([^']+)'|(\S+))\s*&&\s*/.exec(rest);
  if (cd) {
    const p = cd[2] || cd[3] || cd[4];
    if (p.split(/[\\/]/).includes('..')) return false;
    const norm = (x) => path.posix.normalize(String(x).replace(/\\/g, '/')).replace(/\/+$/, '');
    if (!worktree || norm(p) !== norm(worktree)) return false;
    rest = rest.slice(cd[0].length);
  }
  if (!rest.startsWith(g)) return false;
  const tail = rest.slice(g.length);
  if (tail.trim() === '') return true;
  return PIPE.test(tail);
}

function main() {
  const argv = process.argv.slice(2);
  const flag = (n) => {
    const i = argv.indexOf(n);
    return i === -1 ? null : argv[i + 1];
  };
  let input = '';
  try {
    input = require('node:fs').readFileSync(0, 'utf8');
  } catch (_) {
    return 0;
  }
  let msg;
  try {
    msg = JSON.parse(input);
  } catch (_) {
    return 0;
  }
  if (!msg || msg.tool_name !== 'Bash' || !msg.tool_input || typeof msg.tool_input.command !== 'string') return 0;
  const gate = flag('--gate') || process.env.BUILDER_LANE_GATE || null;
  const worktree = flag('--worktree') || process.cwd();
  if (gate && allowed(msg.tool_input.command, { gate, worktree })) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'the lane gate command in a D69 form (own worktree prefix, or one pipe to head or tail)' } }) + '\n');
  }
  return 0;
}

if (require.main === module) process.exit(main());

module.exports = { allowed, PIPE };
