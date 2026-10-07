'use strict';
/**
 * Cap a shell result before it enters the orchestrator's context — the pure digest half.
 *
 * WHY. The orchestrator re-reads its whole context on every turn, so a 40 KB grep is paid for again on
 * every later turn of the session. In one adopting project shell output was the largest share of the
 * orchestrator's tool-result volume. The tier runner already proved the pattern for tests: full log to
 * disk, a digest in context. This is that pattern for every shell call.
 *
 * THE ONE RULE: NEVER DROP AN ERROR LINE. A digest that hides the failure is worse than the bytes it
 * saved. Every error-shaped line before the tail is kept with its line number (up to 200, each clipped to
 * 400 chars; past that the digest SAYS so and names the log), then the last 30 lines verbatim, then the
 * log path. stderr is appended to stdout before digesting, so it is never lost either.
 *
 * WHAT IS EXEMPT. Output that is already a digest (a tier runner installed as `scripts/run-tier.mjs`, as in the pack's
 * `examples/jest-tier-runner/`), and
 * any command that opts out with `--no-cap` or `BUILDER_NO_BASH_CAP=1`.
 *
 * Pure: strings in, a digest out. The harness hook (`hooks/claude-code/bash-output-cap.cjs`) does the I/O.
 */

const LIMIT_BYTES = 4096;
const TAIL_LINES = 30;
const MAX_ERROR_LINES = 200;
const ERROR_SHAPE =
  /\b(error|errors|failed|failure|failing|exception|fatal|denied|cannot|not found|traceback|panic|refused|timed? ?out|unresolved|stale|red)\b|^\s*(FAIL|ERR!|✕|●)|\bexit(?:ed)? (?:code |with code )?[1-9]\d*\b/i;

/**
 * First line of a result that a pre-run cap (a PreToolUse hook that rewrites the command so its output goes to
 * a log and only a digest comes back) already digested. The post-run cap passes such a result through: one cap
 * per call, never two.
 */
const PRECAP_MARK = '# bash-precap:';

/**
 * Commands whose output is already a digest, or that asked not to be capped: the tier runner, `--no-cap`,
 * `BUILDER_NO_BASH_CAP=1`, and a command a pre-run cap already rewrote (it names `bash-precap`).
 */
const EXEMPT = /(?:^|[\s;&|("'/\\])run-tier\.mjs\b|(?:^|\s)--no-cap\b|\bBUILDER_NO_BASH_CAP=1\b|\bbash-precap\b/;

/**
 * @param {{ stdout?: string, stderr?: string }} output
 * @param {{ limit?: number, logPath?: string, source?: string }} [options]  `source` names the cap in the header
 * @returns {{ capped: false } | { capped: true, text: string, bytes: number, lines: number, errorLines: number }}
 */
function digest({ stdout = '', stderr = '' } = {}, { limit = LIMIT_BYTES, logPath = '<log>', source = 'the bash output cap' } = {}) {
  if (stdout.startsWith(PRECAP_MARK)) return { capped: false };
  const full = stderr ? `${stdout}\n[stderr]\n${stderr}` : stdout;
  const bytes = Buffer.byteLength(full, 'utf8');
  if (bytes <= limit) return { capped: false };

  const lines = full.split(/\r?\n/);
  const tailStart = Math.max(0, lines.length - TAIL_LINES);
  const errors = [];
  for (let i = 0; i < tailStart; i += 1) {
    if (ERROR_SHAPE.test(lines[i])) errors.push(`${i + 1}: ${lines[i].slice(0, 400)}`);
  }
  const shown = errors.slice(0, MAX_ERROR_LINES);
  const text = [
    `[output capped by ${source}: ${bytes} bytes, ${lines.length} lines — full output: ${logPath}]`,
    errors.length === 0
      ? '[no error-shaped line before the tail]'
      : `[${errors.length} error-shaped line(s) before the tail${errors.length > MAX_ERROR_LINES ? ` — first ${MAX_ERROR_LINES} shown, the rest are in the log` : ', all shown'}]`,
    ...shown,
    `[tail — last ${lines.length - tailStart} line(s)]`,
    ...lines.slice(tailStart).map((l) => l.slice(0, 2000)),
  ].join('\n');
  return { capped: true, text, bytes, lines: lines.length, errorLines: errors.length };
}

module.exports = { digest, EXEMPT, PRECAP_MARK, ERROR_SHAPE, LIMIT_BYTES, TAIL_LINES, MAX_ERROR_LINES };
