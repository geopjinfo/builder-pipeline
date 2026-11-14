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
 * The process loads its libraries only when they match HEAD (`hook-trust.cjs`) — a hook must not run code an agent
 * just wrote. Untrusted → the original result stays in place, as with the feature off.
 *
 * NEVER FAILS THE TOOL CALL. Any error here exits 0 with no output, which leaves the original result in place.
 *
 * Arming: copy this and `hook-trust.cjs` to `.claude/hooks/`, then add a `PostToolUse` entry with matcher `Bash` running
 * `node .claude/hooks/bash-output-cap.cjs`. Arming is a person's deliberate act.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ACTIVE = ['on', 'unmeasured', 'experimental-on'];

function trustLib() {
  for (const p of [path.join(__dirname, 'hook-trust.cjs'), path.join(__dirname, 'claude-code', 'hook-trust.cjs')]) if (fs.existsSync(p)) return require(p);
  throw new Error('hook-trust.cjs not found');
}

function lib(root, name) {
  for (const candidate of [path.join(root, 'scripts', 'lib', name), path.join(__dirname, '..', '..', 'scripts', 'lib', name)]) {
    if (fs.existsSync(candidate)) return require(candidate);
  }
  throw new Error(`bash-output-cap: ${name} not found`);
}

/**
 * The protected-paths fence's WHOLE prefix set for this project (its built-in PROTECTED, BUILDER_PROTECTED, §16), read
 * from the fence hook installed beside this one — loaded only when it matches HEAD (hook-trust). No fence installed
 * = [] (only §16 and the hook folders apply); a fence that is present but untrusted or that throws = { reason }, and
 * the caller writes no log (fails closed).
 */
function fenceSet(root, env = process.env) {
  const file = [path.join(__dirname, 'protected-paths.cjs'), path.join(__dirname, '..', 'protected-paths.cjs')].find((f) => fs.existsSync(f));
  if (!file) return [];
  try {
    const rel = path.relative(root, file);
    const base = rel.startsWith('..') || path.isAbsolute(rel) ? path.join(__dirname, '..', '..') : root;
    const t = trustLib().trusted(file, { base });
    if (!t.ok) return { reason: t.reason };
    return require(file).config({ ...env, CLAUDE_PROJECT_DIR: root }, root).prefixes;
  } catch (e) {
    return { reason: e.message };
  }
}

/**
 * @param {object} input     the hook input (`tool_name`, `tool_input.command`, `tool_response`)
 * @param {object} settings  merged pipeline settings
 * @param {{ root: string, env?: object, stamp?: string, pid?: number, bashCap?: object }} context
 * @returns {{ action: 'pass', reason: string } | { action: 'cap', logPath: string, log: string, output: object }}
 */
function decide(input, settings, { root, env = {}, stamp = new Date().toISOString().replace(/[:.]/g, '-'), pid = process.pid, bashCap = null, profileLib = null, fencePrefixes = undefined }) {
  const { digest, EXEMPT, LIMIT_BYTES } = bashCap ?? lib(root, 'bash-cap.cjs');
  if (!input || input.tool_name !== 'Bash') return { action: 'pass', reason: 'not a Bash call' };
  const feature = { state: 'off', limitBytes: LIMIT_BYTES, ...(settings?.features?.bashCap ?? {}) };
  if (!ACTIVE.includes(feature.state)) return { action: 'pass', reason: 'bashCap: not configured' };
  if (env.BUILDER_NO_BASH_CAP === '1') return { action: 'pass', reason: 'opted out by environment' };
  const command = String(input.tool_input?.command ?? '');
  if (EXEMPT.test(command)) return { action: 'pass', reason: 'exempt command' };

  // The log is written with fs, where the protected-paths fence cannot see it: a paths.logs that leaves the project
  // or sits in a protected glob or a hook folder writes nothing (profile validate() refuses it too).
  const logs = settings?.paths?.logs ?? 'logs';
  const prefixes = fencePrefixes === undefined ? fenceSet(root, env) : fencePrefixes;
  if (!Array.isArray(prefixes)) return { action: 'pass', refused: true, reason: `bashCap: no log written — the protected-paths fence's set could not be read (${prefixes?.reason ?? 'unknown'}), so paths.logs cannot be checked against it` };
  const refused = (profileLib ?? lib(root, 'profile.cjs')).logsProblem(logs, settings?.protected, { root, prefixes });
  if (refused) return { action: 'pass', refused: true, reason: `bashCap: no log written — paths.logs ${refused}` };
  const r = input.tool_response;
  const res = typeof r === 'string' ? { stdout: r, stderr: '' } : { stdout: r?.stdout ?? '', stderr: r?.stderr ?? '' };
  const logDir = path.join(root, logs, 'bash');
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
    const trust = trustLib();
    const profile = trust.load(root, __dirname, 'profile.cjs');
    const bashCap = profile.ok ? trust.load(root, __dirname, 'bash-cap.cjs') : profile;
    if (!bashCap.ok) process.exit(0);
    const result = decide(input, profile.module.load(root).settings, { root, env: process.env, bashCap: bashCap.module, profileLib: profile.module });
    if (result.refused) process.stderr.write(`${result.reason}\n`);
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
