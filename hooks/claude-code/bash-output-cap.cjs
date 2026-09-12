#!/usr/bin/env node
/**
 * PostToolUse hook (matcher `Bash`) — cap a large shell result to a digest. CLAUDE CODE ONLY.
 *
 * A result over `features.bashCap.limitBytes` is written whole to `<paths.logs>/bash/`, and the context
 * receives a digest instead: every error-shaped line with its line number, the last 30 lines, and the log
 * path (`scripts/lib/bash-cap.cjs`). Output of a `run-tier.mjs` tier runner (already a digest), a command carrying
 * `--no-cap`, and a command or environment with `BUILDER_NO_BASH_CAP=1` pass through untouched.
 * Feature off → the hook exits silently and changes nothing.
 *
 * WHERE IT TAKES EFFECT (probed with a payload and a negative control). In the MAIN session the harness
 * replaces the tool result with the hook's `updatedToolOutput`, and a small result passes through untouched.
 * Inside a SUBAGENT the hook fires but the raw output still reaches the seat. So this caps the orchestrator,
 * whose context lives longest, and not the seats. Other harnesses: no post-tool hook — route test suites
 * through the tier runner's digest instead.
 *
 * NEVER FAILS THE TOOL CALL. Any error here exits 0 with no output, which leaves the original result in place.
 *
 * Arming: copy to `.claude/hooks/`, then add a `PostToolUse` entry with matcher `Bash` running
 * `node .claude/hooks/bash-output-cap.cjs`. Arming is a person's deliberate act.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ACTIVE = ['on', 'unmeasured', 'experimental-on'];

function lib(root, name) {
  for (const candidate of [path.join(root, 'scripts', 'lib', name), path.join(__dirname, '..', '..', 'scripts', 'lib', name)]) {
    if (fs.existsSync(candidate)) return require(candidate);
  }
  throw new Error(`bash-output-cap: ${name} not found`);
}

/**
 * @param {object} input     the hook input (`tool_name`, `tool_input.command`, `tool_response`)
 * @param {object} settings  merged pipeline settings
 * @param {{ root: string, env?: object, stamp?: string, pid?: number, bashCap?: object }} context
 * @returns {{ action: 'pass', reason: string } | { action: 'cap', logPath: string, log: string, output: object }}
 */
function decide(input, settings, { root, env = {}, stamp = new Date().toISOString().replace(/[:.]/g, '-'), pid = process.pid, bashCap = null }) {
  const { digest, EXEMPT, LIMIT_BYTES } = bashCap ?? lib(root, 'bash-cap.cjs');
  if (!input || input.tool_name !== 'Bash') return { action: 'pass', reason: 'not a Bash call' };
  const feature = { state: 'off', limitBytes: LIMIT_BYTES, ...(settings?.features?.bashCap ?? {}) };
  if (!ACTIVE.includes(feature.state)) return { action: 'pass', reason: 'bashCap: not configured' };
  if (env.BUILDER_NO_BASH_CAP === '1') return { action: 'pass', reason: 'opted out by environment' };
  const command = String(input.tool_input?.command ?? '');
  if (EXEMPT.test(command)) return { action: 'pass', reason: 'exempt command' };

  const r = input.tool_response;
  const res = typeof r === 'string' ? { stdout: r, stderr: '' } : { stdout: r?.stdout ?? '', stderr: r?.stderr ?? '' };
  const logDir = path.join(root, settings?.paths?.logs ?? 'logs', 'bash');
  const logPath = path.join(logDir, `${stamp}-${pid}.log`);
  const limit = Number(feature.limitBytes) > 0 ? Number(feature.limitBytes) : LIMIT_BYTES;
  const d = digest(res, { limit, logPath: path.relative(root, logPath).replace(/\\/g, '/') });
  if (!d.capped) return { action: 'pass', reason: 'within the limit' };

  return {
    action: 'cap',
    logPath,
    log: `$ ${command}\n\n${res.stdout}${res.stderr ? `\n[stderr]\n${res.stderr}` : ''}`,
    output: {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        updatedToolOutput: { stdout: d.text, stderr: '', interrupted: Boolean(r?.interrupted), isImage: false },
      },
    },
  };
}

if (require.main === module) {
  try {
    const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
    const { settings } = lib(root, 'profile.cjs').load(root);
    const result = decide(input, settings, { root, env: process.env });
    if (result.action === 'cap') {
      fs.mkdirSync(path.dirname(result.logPath), { recursive: true });
      fs.writeFileSync(result.logPath, result.log);
      process.stdout.write(JSON.stringify(result.output));
    }
  } catch {
    /* a cap that breaks the tool call is worse than no cap */
  }
  process.exit(0);
}

module.exports = { decide };
