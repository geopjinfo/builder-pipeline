export const meta = {
  name: 'repo-audit',
  description: 'Repo-wide read-only audit: live gate baseline, every unit through the four auditor lenses in parallel, one verified and ranked report',
  whenToUse: 'A periodic whole-repo health check, launched by the repo-audit skill after the user has explicitly opted in.',
  phases: [
    { title: 'Discover', detail: 'units from args, a units command, or the profile layout' },
    { title: 'Gates', detail: 'the gate and test commands, run read-only' },
    { title: 'Scan', detail: 'per unit: standards + security + vuln + invariant lenses in parallel' },
    { title: 'Synthesize', detail: 'repo-auditor verifies, de-duplicates, ranks, extracts systemic patterns' },
  ],
}

/*
 * Claude Code Workflow for the repo-audit skill.
 *
 * LAUNCH ONLY ON THE USER'S EXPLICIT OPT-IN. It spawns one agent per unit per lens plus the gate run: many
 * subagents, many tokens. The skill asks first; nothing else may start it.
 *
 * Nothing project-specific lives here. Everything comes from `args`, and whatever args leave out is read from
 * PIPELINE_PROFILE.md by the agent that needs it:
 *
 *   {
 *     units?: [{ name, path, kind? }],   // kind: module | shared | template (default module)
 *     unitsCommand?: string,             // a read-only command that lists the units, when units is absent
 *     gates?: string[],                  // gate/test commands; absent -> the gate agent reads profile §2/§8
 *     lenses?: string[],                 // subset of standards | security | vuln | invariant (or their agent types)
 *     since?: string,                    // git ref: each lens audits only the diff since it
 *     reportDate?: string,               // the sandbox has no clock: pass the date in
 *   }
 *
 * Returns { reportDate, units, lenses, gates, rawFindingCount, coverageGaps, report }. The report is markdown;
 * the orchestrator writes it (audits/<date>-repo-audit.md). No agent here writes a file.
 */

const A = args && typeof args === 'object' && !Array.isArray(args) ? args : {}
const nonEmptyString = (v) => typeof v === 'string' && v.trim() !== ''

const LENSES = [
  { key: 'standards', agentType: 'standards-auditor' },
  { key: 'security', agentType: 'security-auditor' },
  { key: 'vuln', agentType: 'vuln-auditor' },
  { key: 'invariant', agentType: 'invariant-auditor' },
]
const requested = Array.isArray(A.lenses) && A.lenses.length ? A.lenses.map(String) : null
const lenses = requested ? LENSES.filter((l) => requested.includes(l.key) || requested.includes(l.agentType)) : LENSES
if (requested) {
  const unknown = requested.filter((r) => !LENSES.some((l) => l.key === r || l.agentType === r))
  if (unknown.length) log(`ignored unknown lens name(s): ${unknown.join(', ')}`)
  const skipped = LENSES.filter((l) => !lenses.includes(l)).map((l) => l.key)
  if (skipped.length) log(`lenses not run this time (by request): ${skipped.join(', ')}`)
}
const since = nonEmptyString(A.since) ? String(A.since) : null
const reportDate = nonEmptyString(A.reportDate) ? String(A.reportDate) : '<run date>'
const READ_ONLY = 'Read-only: edit nothing, write nothing, run nothing that changes state.'

// ---- schemas ------------------------------------------------------------------------------------
const UNITS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['units'],
  properties: {
    units: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'path', 'kind'],
        properties: {
          name: { type: 'string' },
          path: { type: 'string', description: 'repo-relative directory' },
          kind: { type: 'string', enum: ['module', 'shared', 'template'] },
        },
      },
    },
    notes: { type: 'string', description: 'what was excluded and why (scaffolds, generated code, vendored code)' },
  },
}

const GATES_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['gates'],
  properties: {
    gates: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'command', 'status', 'summary'],
        properties: {
          name: { type: 'string' },
          command: { type: 'string' },
          status: { type: 'string', enum: ['passed', 'failed', 'skipped'] },
          summary: { type: 'string', description: 'counts and the tail of the output; the failure class if failed; the reason if skipped' },
        },
      },
    },
  },
}

// The pack's findings contract: the same shape every auditor seat returns in a module build.
const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['seat', 'verdict', 'findings'],
  properties: {
    seat: { type: 'string' },
    verdict: { type: 'string', enum: ['PASS', 'CHANGES-REQUIRED', 'PASS-WITH-RULINGS'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'severity', 'location', 'cite', 'claim', 'evidence'],
        properties: {
          id: { type: 'string' },
          severity: { type: 'string', enum: ['blocker', 'warning', 'nit'] },
          location: { type: 'string', description: 'file:line' },
          cite: { type: 'string', description: 'the stated rule: profile section, gate, oracle entry, decision record' },
          claim: { type: 'string' },
          evidence: { type: 'string' },
        },
      },
    },
    rulings: { type: 'array', items: { type: 'string' }, description: 'questions only a person can rule on (invariant lens)' },
  },
}

// ---- Phase 0: Discover --------------------------------------------------------------------------
phase('Discover')
let units = []
if (Array.isArray(A.units) && A.units.length) {
  units = A.units
    .filter((u) => u && nonEmptyString(u.name) && nonEmptyString(u.path))
    .map((u) => ({ name: String(u.name), path: String(u.path), kind: ['module', 'shared', 'template'].includes(u.kind) ? u.kind : 'module' }))
  if (units.length < A.units.length) log(`dropped ${A.units.length - units.length} unit(s) from args without a name and path`)
} else {
  const how = nonEmptyString(A.unitsCommand)
    ? `Run \`${A.unitsCommand}\` from the repo root; each entry it lists is a unit.`
    : 'Read PIPELINE_PROFILE.md §1 (layout) and §5 (golden path) and enumerate the units from the layout they describe: each bounded module, each shared/core layer as its own unit, and the template/golden-path unit.'
  const found = await agent(
    `${how} Confirm every path exists by listing it. Mark kind "template" for the unit new units are copied from, `
      + '"shared" for core layers whose rules differ from a module\'s, "module" otherwise. Exclude empty scaffolds, generated '
      + `and vendored code, and say what you excluded in notes. ${READ_ONLY}`,
    { label: 'discover', phase: 'Discover', schema: UNITS_SCHEMA },
  )
  units = (found && found.units) || []
  if (found && found.notes) log(`discover: ${found.notes}`)
}
if (!units.length) {
  log('no units found: nothing to audit. Pass args.units or args.unitsCommand, or fill profile §1.')
  return { reportDate, units: [], lenses: lenses.map((l) => l.key), gates: [], rawFindingCount: 0, coverageGaps: [], report: null }
}
log(`work-list: ${units.length} unit(s) × ${lenses.length} lens(es) = ${units.length * lenses.length} lens run(s)`)

// ---- Phase 1: Gates -----------------------------------------------------------------------------
phase('Gates')
const gateSource = Array.isArray(A.gates) && A.gates.length
  ? `Run exactly these commands from the repo root, in order:\n- ${A.gates.join('\n- ')}`
  : 'Read PIPELINE_PROFILE.md §2 (commands) and §8 (gates) and run every gate and test command named there, from the repo root.'
const gatesResult = await agent(
  `Run the live gate baseline and report each gate. Fix NOTHING. ${gateSource}\n`
    + 'Run every test tier through the tier wrapper (§2 `commands.tier`, `{tier}` filled in) when the profile names one, '
    + 'never the bare suite command: the wrapper keeps the full log on disk and prints a short digest. '
    + 'A command that would change state beyond its own caches and logs (migrations, formatters that write, deploys, '
    + 'anything destructive) is NOT run: record it as skipped with that reason. A command that needs infrastructure '
    + 'that is not up is skipped with that reason, never reported as passed. Capture counts and the tail of each output.',
  { label: 'gates', phase: 'Gates', schema: GATES_SCHEMA },
)
const gates = (gatesResult && gatesResult.gates) || []
if (!gatesResult) log('gate agent returned nothing: the report will say the baseline is unmeasured')

// ---- Phase 2: Scan (per unit, all lenses in parallel) -------------------------------------------
phase('Scan')
const frame = since
  ? `Audit ONLY what changed since \`${since}\` (\`git diff ${since}...HEAD -- <path>\`); ignore untouched files.`
  : 'Audit the full contents of the unit (every file, not a diff).'
const kindNote = {
  module: 'This is a module: hold it to the module rules in the profile (§5 golden path, §6 contracts, §7 invariants).',
  shared: 'This is a shared/core layer: apply the profile\'s rules for shared layers, which differ from a module\'s (what it may import, what may live in it).',
  template: 'This is the TEMPLATE / golden-path unit: every future unit is copied from it, so a defect here replicates. Say so in the claim of any finding.',
}

function lensPrompt(lens, unit) {
  return [
    `Repo-wide audit. Unit **${unit.name}** at \`${unit.path}\`.`,
    frame,
    kindNote[unit.kind] || kindNote.module,
    `Apply your standard ${lens.key} checks to this whole unit, not to a module build's diff.`,
    'Ground every finding in a rule the project states AND a real file:line. No evidence, no finding.',
    READ_ONLY,
    'Return your verdict and findings in the schema.',
  ].join(' ')
}

const scanned = await pipeline(units, (unit) =>
  parallel(
    lenses.map((lens) => () =>
      agent(lensPrompt(lens, unit), { agentType: lens.agentType, label: `${lens.key}:${unit.name}`, phase: 'Scan', schema: FINDINGS_SCHEMA }),
    ),
  ).then((results) => ({
    unit: unit.name,
    path: unit.path,
    kind: unit.kind,
    lenses: Object.fromEntries(lenses.map((lens, i) => [lens.key, results[i] || null])),
  })),
)

const coverageGaps = []
let rawFindingCount = 0
units.forEach((unit, i) => {
  const s = scanned[i]
  for (const lens of lenses) {
    const r = s && s.lenses[lens.key]
    if (!r) coverageGaps.push(`${unit.name}:${lens.key}`)
    else rawFindingCount += (r.findings || []).length
  }
})
log(`scan complete: ${rawFindingCount} raw finding(s); ${coverageGaps.length} lens run(s) returned nothing${coverageGaps.length ? ` (${coverageGaps.join(', ')})` : ''}`)

// ---- Phase 3: Synthesize ------------------------------------------------------------------------
phase('Synthesize')
const report = await agent(
  [
    `Synthesize the repo-wide audit (date: ${reportDate}; ${since ? `incremental since ${since}` : 'full run'}).`,
    `Lenses run: ${lenses.map((l) => l.key).join(', ')}.`,
    'Gate baseline (JSON):',
    '```json',
    JSON.stringify(gatesResult ? gates : 'UNMEASURED: the gate agent returned nothing'),
    '```',
    'Units and their lens results (JSON; a null lens is a coverage gap, never a pass):',
    '```json',
    JSON.stringify(scanned.map((s, i) => s || { unit: units[i].name, path: units[i].path, kind: units[i].kind, lenses: null })),
    '```',
    `Coverage gaps: ${coverageGaps.length ? coverageGaps.join(', ') : 'none'}.`,
    'Verify every finding at its file:line, drop and count the unverifiable per lens, de-duplicate across units,',
    'extract the systemic patterns (template-unit defects outrank isolated ones), rank, and return the full report',
    'in your output contract. Return ONLY the report markdown.',
  ].join('\n'),
  { agentType: 'repo-auditor', label: 'synthesize', phase: 'Synthesize' },
)

return {
  reportDate,
  units,
  lenses: lenses.map((l) => l.key),
  gates,
  rawFindingCount,
  coverageGaps,
  report, // markdown; the orchestrator writes it
}
