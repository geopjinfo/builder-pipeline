'use strict';
/**
 * EXPERIMENTS.md as data — the evidence programme (plan M14, REQ-1401, REQ-1402, REQ-1405, REQ-1409 family; D57).
 *
 * WHY. Every experimental or unmeasured feature ends with a decision row, and the decision must be readable by a
 * script, not only by a person: `features` prints it beside each flag, `experiments --check` refuses a blank or an
 * unsupported keep, and a scheduled measurement appends its row without a hand edit. One parser, used everywhere.
 *
 *   section      `## <n>. <title> — \`<flag>\` (<state words>)`; the flag is the first backticked name in the heading
 *   decision     `**Decision (<YYYY-MM-DD>).** keep | drop | not yet measured — <number or "no measurement">`
 *   rates        the §20 false-positive table: `| \`<check>\` ... | <findings> | <false> | <rate> |`
 */
const fs = require('fs');

const DECISION = /^\*\*Decision \((\d{4}-\d{2}-\d{2})\)\.\*\* (keep|drop|not yet measured) — (.+)$/m;
const HEAD = /^## (\d+)\. (.+)$/gm;

/** Every numbered section: { n, title, flag, body, decision: { date, verdict, text } | null }. */
function parse(md) {
  const heads = [...md.matchAll(HEAD)];
  return heads.map((h, i) => {
    const end = i + 1 < heads.length ? heads[i + 1].index : md.length;
    const body = md.slice(h.index, end);
    const flag = (/`([A-Za-z][\w.]*)`/.exec(h[2]) || [])[1] || null;
    const d = DECISION.exec(body);
    return { n: Number(h[1]), title: h[2].trim(), flag, body, decision: d ? { date: d[1], verdict: d[2], text: d[3].trim() } : null };
  });
}

/** Why a section's decision row is not acceptable, or null. */
function decisionFault(s) {
  if (!s.decision) return `§${s.n} ${s.title}: no decision row`;
  if (s.decision.verdict === 'keep' && (/no measurement/i.test(s.decision.text) || !/\d/.test(s.decision.text))) return `§${s.n}: keep without a number`;
  return null;
}

/**
 * The decision of a feature flag, or null: `{ date, verdict, text, n }`. The section is the one whose heading carries
 * the flag; a flag measured inside a shared section (profile `experiment: '§20'`) names that section number instead.
 */
function decisionFor(md, flag, section = null) {
  const all = parse(md);
  const n = section ? Number(String(section).replace(/[^0-9]/g, '')) : null;
  const s = all.find((x) => x.flag === flag) || (n ? all.find((x) => x.n === n) : null);
  return s && s.decision ? { ...s.decision, n: s.n } : null;
}

/** The §20 false-positive rows: { <check>: { findings, false, percent|null, raw } }. */
function falsePositiveRates(body) {
  const out = {};
  for (const line of body.split(/\r?\n/)) {
    const m = /^\| `([a-z-]+)[^`]*`[^|]*\| [^|]*\| ([^|]*)\| ([^|]*)\| ([^|]*)\|$/.exec(line.trim());
    if (!m) continue;
    const findings = Number((/\d+/.exec(m[2]) || [NaN])[0]);
    const falseCount = Number((/\d+/.exec(m[3]) || [NaN])[0]);
    const pct = /(\d+(?:\.\d+)?)%/.exec(m[4]);
    out[m[1]] = { findings: Number.isFinite(findings) ? findings : null, false: Number.isFinite(falseCount) ? falseCount : null, percent: pct ? Number(pct[1]) : null, raw: m[4].trim() };
  }
  return out;
}

/** Append `row` to the last table of section `n` in `file`; the decision row and the flag are never touched. */
function recordRow(file, n, row) {
  if (!fs.existsSync(file)) throw new Error(`no §${n} to record into: ${file} does not exist`);
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^## ${n}\\.`).test(l));
  if (start === -1) throw new Error(`no §${n} in ${file}`);
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end === -1) end = lines.length;
  let at = -1;
  for (let i = start + 1; i < end; i++) if (lines[i].startsWith('|')) at = i;
  if (at === -1) throw new Error(`no table in §${n} of ${file} to append to`);
  lines.splice(at + 1, 0, row);
  fs.writeFileSync(file, lines.join('\n'));
}

/** The trial matrix: what each 2.0 experimental feature runs against and the rule that promotes it. */
const MATRIX = Object.freeze([
  { flag: 'familyReview', section: 16, bed: 'three modules of an adopting project, three without', command: 'the pipeline with features.familyReview experimental-on', keep: 'accepted findings rise, loop-backs do not, cost per task inside budget' },
  { flag: 'boardLoop', section: 17, bed: 'the polyglot test bed (six aider exercises, pytest gate)', command: 'npx builder-pipeline run board-loop <account> tasks/<board>.md --record-experiment EXPERIMENTS.md', keep: "a person's call on pass rate, cost, turns, timeouts and silent failures" },
  { flag: 'remoteLanes', section: 18, bed: 'the polyglot test bed, one local and one remote lane', command: 'npx builder-pipeline run orch remote preflight|launch|poll on the same board', keep: 'equal pass rate and no orphaned worker; drop on ssh failures or orphans in more than one run in three' },
  { flag: 'builderBatch', section: 6, bed: 'the §19 recorded run', command: 'npx builder-pipeline run seat-peaks and cost-window over the run window', keep: 'p90 peak and builder cost per row both fall' },
  { flag: 'fixLane', section: 7, bed: 'the §19 recorded run', command: 'npx builder-pipeline run fix-rate over the run boards', keep: 'fix-of-fix rate at or below the baseline and loop-back cost not higher' },
]);

module.exports = { DECISION, parse, decisionFault, decisionFor, falsePositiveRates, recordRow, MATRIX };
