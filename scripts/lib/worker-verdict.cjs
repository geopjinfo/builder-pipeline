'use strict';
/**
 * The worker verdict — a required structured result, never the exit code alone (plan M6, REQ-604, D13, D47).
 *
 * Claude Code gets the schema through `--json-schema`, Codex through `--output-schema`. The adapter extracts the
 * object; `readVerdict` judges it against the worktree head and the ids the lane claimed:
 *   no object, or a missing or malformed field    → FAILED (the reason names the field)
 *   `head` differs from the head at read time      → FAILED-STALE-VERDICT
 *   `requirements` misses a claimed id             → FAILED
 *   a denied tool in the run                       → INCOMPLETE
 *   otherwise                                      → VERDICT, with the worker's own verdict inside
 * Pure.
 */
const VERDICTS = Object.freeze(['PASS', 'CHANGES_REQUESTED', 'ERROR']);
const JOB = Object.freeze({ verdict: 'VERDICT', failed: 'FAILED', stale: 'FAILED-STALE-VERDICT', incomplete: 'INCOMPLETE' });
const SHA = /^[0-9a-f]{7,40}$/i;

const VERDICT_SCHEMA = Object.freeze({
  type: 'object',
  required: ['verdict', 'summary', 'filesTouched', 'head', 'requirements'],
  properties: {
    verdict: { type: 'string', enum: [...VERDICTS], description: 'The judgement of the commit named in head.' },
    summary: { type: 'string', description: 'What was done and what was judged, in a few sentences.' },
    filesTouched: { type: 'array', items: { type: 'string' }, description: 'Every file the worker changed, repository-relative.' },
    head: { type: 'string', pattern: '^[0-9a-f]{7,40}$', description: 'The commit the verdict judges (git rev-parse HEAD at the end of the work).' },
    requirements: { type: 'array', items: { type: 'string' }, description: 'The requirement ids the worker judged.' },
  },
  additionalProperties: true,
});

/** Why `raw` is not a verdict, or null. */
function shapeFault(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return `no verdict object${raw === null ? '' : ` (got ${typeof raw})`}`;
  for (const f of VERDICT_SCHEMA.required) if (!(f in raw)) return `verdict field missing: ${f}`;
  if (!VERDICTS.includes(raw.verdict)) return `verdict field malformed: verdict is ${JSON.stringify(raw.verdict)}, not one of ${VERDICTS.join(' | ')}`;
  if (typeof raw.summary !== 'string') return 'verdict field malformed: summary is not a string';
  if (!Array.isArray(raw.filesTouched) || !raw.filesTouched.every((s) => typeof s === 'string')) return 'verdict field malformed: filesTouched is not a list of strings';
  if (typeof raw.head !== 'string' || !SHA.test(raw.head)) return `verdict field malformed: head is ${JSON.stringify(raw.head)}, not a commit sha`;
  if (!Array.isArray(raw.requirements) || !raw.requirements.every((s) => typeof s === 'string')) return 'verdict field malformed: requirements is not a list of strings';
  return null;
}

const sameHead = (a, b) => {
  const x = String(a || '').toLowerCase();
  const y = String(b || '').toLowerCase();
  return !!x && !!y && (x.startsWith(y) || y.startsWith(x)) && Math.min(x.length, y.length) >= 7;
};

/**
 * @param {object|string|null} raw  the structured result (an object, or its JSON text)
 * @param {{ head: string, claimed?: string[], exitCode?: number|null, denials?: string[] }} o
 * @returns {{ job: string, verdict: object|null, reason: string|null }}
 */
function readVerdict(raw, { head, claimed = [], exitCode = null, denials = [] }) {
  let v = raw;
  if (typeof raw === 'string') {
    try {
      v = JSON.parse(raw);
    } catch (_) {
      return { job: JOB.failed, verdict: null, reason: 'verdict text is not JSON' };
    }
  }
  const fault = shapeFault(v === undefined ? null : v);
  if (fault) return { job: JOB.failed, verdict: null, reason: `${fault}${exitCode !== null && exitCode !== undefined ? ` (exit ${exitCode})` : ''}` };
  if (!sameHead(v.head, head)) return { job: JOB.stale, verdict: v, reason: `verdict judges ${v.head}, the worktree head is ${head}` };
  const missing = (claimed || []).filter((id) => !v.requirements.includes(id));
  if (missing.length) return { job: JOB.failed, verdict: v, reason: `verdict does not judge the claimed id(s): ${missing.join(', ')}` };
  if (denials && denials.length) return { job: JOB.incomplete, verdict: v, reason: `denied tool: ${denials.join('; ')}` };
  return { job: JOB.verdict, verdict: v, reason: null };
}

module.exports = { VERDICTS, JOB, VERDICT_SCHEMA, shapeFault, readVerdict };
