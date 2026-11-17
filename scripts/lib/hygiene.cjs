'use strict';
/**
 * The hygiene runner and the completion gate (specs/repo-hygiene.spec.md M21, REQ-1831, REQ-1832, REQ-1844; decisions
 * D87, D99). One command runs every hygiene-class check whose feature is on, through the check's own script, and prints
 * one report: the findings grouped by check, one count line per check, one summary line. The runner adds no rule of its
 * own: a check decides its findings and its exit code, the runner only collects them.
 *
 *   state per check   not configured (exit 3, or the first line says so) · clean · findings · error (exit 2 or a crash)
 *   hard              the check's own exit 1 — the runner exits 1 when any check did
 *   --since REF       attribution-check and artifact-check take it themselves; secretScan, sizeCheck, ignoreCheck and
 *                     docsCheck are narrowed to the files changed since REF (their findings name a path); the sweeps,
 *                     depsCheck and deadCode judge the whole tree and the report says so in one line
 *   --apply           reaches the three sweeps only
 *
 * The gate (REQ-1844) maps the findings onto the seven rows of the completion gate — file scope, ignore rules, secrets,
 * staging, commit, delivery, separation — PASS, FAIL or NOT CONFIGURED. A row whose check is off never reads PASS.
 * The last report is written to <runs>/hygiene/last.json (the gate to gate.json) for the progress reporter (REQ-1836).
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

/** The checks, in report order. `since`: native (the script takes --since), filter (narrowed by path), ignores. */
const CHECKS = [
  { name: 'branchSweep', script: 'branch-sweep', since: 'ignores', sweep: true, kinds: ['MERGED', 'STALE', 'REMOTE'] },
  { name: 'runSweep', script: 'run-sweep', since: 'ignores', sweep: true, kinds: ['SWEEP'] },
  { name: 'worktreeSweep', script: 'worktree-sweep', since: 'ignores', sweep: true, kinds: ['SWEEP'] },
  { name: 'ignoreCheck', script: 'ignore-check', since: 'filter' },
  { name: 'sizeCheck', script: 'size-check', since: 'filter' },
  { name: 'secretScan', script: 'secret-scan', since: 'filter' },
  { name: 'depsCheck', script: 'deps-check', since: 'ignores' },
  { name: 'docsCheck', script: 'docs-check', since: 'filter' },
  { name: 'deadCode', script: 'dead-code', since: 'ignores' },
  { name: 'instructionLint', script: 'instruction-lint', since: 'ignores' },
  { name: 'instructionBudget', script: 'instruction-budget', since: 'ignores' },
  { name: 'attributionCheck', script: 'attribution-check', since: 'native' },
  { name: 'artifactCheck', script: 'artifact-check', since: 'native' },
];
/** The checks the completion gate reads (REQ-1844). */
const GATE_CHECKS = ['artifactCheck', 'attributionCheck', 'ignoreCheck', 'secretScan', 'sizeCheck'];
/** Verdict words that open a line without being a finding. */
const NOT_FINDINGS = new Set(['KEEP', 'PASS', 'OK', 'INFO', 'NOTE', 'RESULT', 'DRAINED', 'MEASURED']);
const FINDING = /^([A-Z][A-Z0-9-]{1,})\s+(\S+)(?:\s+(.*))?$/;

/** The hygiene-class feature names, for "is any check on" (REQ-1831 exit 3, REQ-1836 section). */
const FEATURES = CHECKS.map((c) => c.name);

/** Parse one check's stdout: the finding lines (kind, ref, text) and whether the first line says not configured. */
function parse(stdout) {
  const lines = String(stdout || '').replace(/\r\n/g, '\n').split('\n');
  const notConfigured = /^[A-Za-z]+: not configured/.test(lines[0] || '') && !/— checking/.test(lines[0] || '');
  const findings = [];
  for (const l of lines) {
    const m = l.match(FINDING);
    if (!m || NOT_FINDINGS.has(m[1])) continue;
    findings.push({ kind: m[1], ref: m[2], path: m[2].replace(/:\d+(:\d+)?$/, ''), text: l.trimEnd() });
  }
  return { notConfigured, findings, lines };
}

/** The tracked files changed since `since` (added, modified, renamed), posix, or null when git cannot say. */
function changedSince(repo, since) {
  const r = spawnSync('git', ['diff', '--name-only', '--diff-filter=AMR', '-z', `${since}..HEAD`], { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) return null;
  return new Set(r.stdout.split('\0').filter(Boolean).map((p) => p.replace(/\\/g, '/')));
}

/** True when the index holds added or modified files. */
function indexNonEmpty(repo) {
  const r = spawnSync('git', ['diff', '--cached', '--name-only', '--diff-filter=AM'], { cwd: repo, encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim().length > 0;
}

/**
 * Run one check through its script. opts: { kitScripts, repo, since, apply, timeoutMs, extraArgs }.
 * Returns { name, script, state, hard, exit, findings, summary, sinceNote, error }.
 */
function runCheck(check, { kitScripts, repo, since = null, apply = false, timeoutMs = 300000, extraArgs = [], changed = null }) {
  const args = [path.join(kitScripts, `${check.script}.mjs`), ...extraArgs];
  if (since && check.since === 'native') args.push('--since', since);
  if (apply && check.sweep) args.push('--apply');
  const r = spawnSync(process.execPath, args, { cwd: repo, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, BUILDER_NO_BASH_CAP: '1' } });
  const out = { name: check.name, script: check.script, exit: r.status, hard: false, findings: [], summary: null, sinceNote: null, error: null };
  if (r.error && r.error.code === 'ETIMEDOUT') {
    out.state = 'error';
    out.error = `timed out after ${Math.round(timeoutMs / 1000)}s`;
    return out;
  }
  const p = parse(r.stdout);
  if (r.status === 3 || (r.status === 0 && p.notConfigured)) {
    out.state = 'not configured';
    out.summary = (p.lines[0] || `${check.name}: not configured`).trim();
    return out;
  }
  if (r.status !== 0 && r.status !== 1) {
    out.state = 'error';
    out.error = ((r.stderr || r.stdout || '').trim().split('\n')[0] || `exit ${r.status}`).slice(0, 200);
    return out;
  }
  let findings = p.findings;
  if (since && check.since === 'filter' && changed) {
    findings = findings.filter((f) => changed.has(f.path) || [...changed].some((c) => f.path.startsWith(`${c}/`)));
    out.sinceNote = 'narrowed to the files changed since the ref';
  }
  if (since && check.since === 'ignores') out.sinceNote = 'judges the whole tree; --since does not apply';
  out.findings = findings;
  out.hard = r.status === 1;
  // a hard check whose finding lines were all narrowed away since REF is clean for this range
  if (out.hard && since && check.since === 'filter' && findings.length === 0 && p.findings.length > 0) out.hard = false;
  out.state = findings.length || out.hard ? 'findings' : 'clean';
  const last = p.lines.filter((l) => l.trim()).pop();
  out.summary = last && !FINDING.test(last) ? last.trim() : null;
  return out;
}

/**
 * The runner. opts: { kitScripts, repo, settings (the profile), since, apply, only (array of names), timeoutMs }.
 * Returns { at, since, checks: [...], anyOn, hardFail, exit }.
 */
function run(opts) {
  const { settings, only = null } = opts;
  const profile = require('./profile.cjs');
  const selected = CHECKS.filter((c) => !only || only.includes(c.name) || only.includes(c.script));
  const checks = [];
  const changed = opts.since ? changedSince(opts.repo, opts.since) : null;
  for (const c of selected) {
    const f = profile.feature(settings, c.name);
    if (!f.enabled) {
      checks.push({ name: c.name, script: c.script, state: 'not configured', hard: false, exit: 3, findings: [], summary: f.line, sinceNote: null, error: null });
      continue;
    }
    checks.push(runCheck(c, { ...opts, changed }));
  }
  const anyOn = checks.some((c) => c.state !== 'not configured');
  const hardFail = checks.some((c) => c.hard || c.state === 'error');
  return { at: new Date().toISOString(), since: opts.since || null, apply: !!opts.apply, checks, anyOn, hardFail, exit: !anyOn ? 3 : hardFail ? 1 : 0 };
}

/** The text report of a run (REQ-1831): findings grouped by check, one count line per check, one summary line. */
function format(report) {
  const L = [];
  for (const c of report.checks) {
    if (c.state === 'not configured') {
      L.push(c.summary || `${c.name}: not configured`);
      continue;
    }
    if (c.state === 'error') {
      L.push(`${c.script}: ERROR — ${c.error}`);
      continue;
    }
    for (const f of c.findings) L.push(`  ${f.text}`);
    L.push(`${c.script}: ${c.findings.length} finding(s)${c.hard ? ' — hard, fails the run' : ''}${c.sinceNote ? ` · ${c.sinceNote}` : ''}`);
  }
  const on = report.checks.filter((c) => c.state !== 'not configured');
  const total = on.reduce((n, c) => n + c.findings.length, 0);
  const hard = on.filter((c) => c.hard).map((c) => c.script);
  const errors = on.filter((c) => c.state === 'error').map((c) => c.script);
  if (!report.anyOn) L.push('hygiene: no check is on — switch one on in PIPELINE_PROFILE.md §16 (exit 3, never a pass)');
  else L.push(`hygiene: ${on.length} check(s) ran, ${total} finding(s)${hard.length ? ` — hard: ${hard.join(', ')}` : ''}${errors.length ? ` — could not run: ${errors.join(', ')}` : ''}${report.since ? ` · since ${report.since}` : ''}${report.apply ? ' · --apply reached the sweeps' : ''}`);
  return L.join('\n');
}

const kindsOf = (c, kinds) => (c && c.state !== 'not configured' ? c.findings.filter((f) => kinds.includes(f.kind)) : []);
const rowOf = (name, configured, failing, note) => ({ gate: name, result: !configured ? 'NOT CONFIGURED' : failing.length ? 'FAIL' : 'PASS', findings: failing.map((f) => f.text), note });

/**
 * The completion gate (REQ-1844). opts as run(), plus `staged` (default: the index when it is not empty).
 * Returns { at, since, rows: [...7], exit, checks }.
 */
function gate(opts) {
  const { settings } = opts;
  const profile = require('./profile.cjs');
  const on = (n) => profile.feature(settings, n).enabled;
  const report = run({ ...opts, only: GATE_CHECKS });
  const by = Object.fromEntries(report.checks.map((c) => [c.name, c]));
  const artifactOn = on('artifactCheck');
  let staged = null;
  if (artifactOn && indexNonEmpty(opts.repo)) staged = runCheck(CHECKS.find((c) => c.name === 'artifactCheck'), { ...opts, since: null, extraArgs: ['--staged'] });
  const stagingFindings = staged ? staged.findings : opts.since ? kindsOf(by.artifactCheck, ['ASSISTANT-FILE', 'SCRATCH-FILE', 'ARCHIVE']) : [];
  const rows = [
    rowOf('file scope', artifactOn, kindsOf(by.artifactCheck, ['ASSISTANT-FILE', 'SCRATCH-FILE']), 'artifactCheck: assistant and scratch files in the tree'),
    rowOf('ignore rules', on('ignoreCheck') || artifactOn, [...kindsOf(by.ignoreCheck, ['TRACKED-JUNK', 'UNIGNORED-JUNK']), ...kindsOf(by.artifactCheck, ['ASSISTANT-IGNORE'])], 'ignoreCheck findings and assistant lines in .gitignore'),
    rowOf('secrets', on('secretScan'), by.secretScan ? by.secretScan.findings : [], 'secretScan over the tracked text'),
    rowOf('staging', artifactOn, stagingFindings, staged ? 'artifactCheck --staged over the index' : opts.since ? `artifactCheck over the commits since ${opts.since} (index empty)` : 'index empty, no base given'),
    rowOf('commit', on('attributionCheck'), by.attributionCheck ? by.attributionCheck.findings : [], 'attributionCheck: trailers, author identities, branch names'),
    rowOf('delivery', on('ignoreCheck') || on('sizeCheck'), [...kindsOf(by.ignoreCheck, ['TRACKED-JUNK']), ...kindsOf(by.sizeCheck, ['LARGE', 'LARGE-HISTORY'])], 'tracked junk and large files'),
    rowOf('separation', artifactOn, kindsOf(by.artifactCheck, ['ARCHIVE']), 'archives and packaging output; the repo-steward judges the rest when it runs'),
  ];
  for (const c of report.checks) if (c.state === 'error') for (const r of rows) if (r.note.includes(c.name) && r.result !== 'NOT CONFIGURED') { r.result = 'FAIL'; r.findings.push(`${c.script}: ERROR — ${c.error}`); }
  const configured = rows.filter((r) => r.result !== 'NOT CONFIGURED');
  const exit = !configured.length ? 3 : rows.some((r) => r.result === 'FAIL') ? 1 : 0;
  return { at: new Date().toISOString(), since: opts.since || null, rows, exit, checks: report.checks.concat(staged ? [{ ...staged, name: 'artifactCheck --staged' }] : []) };
}

/** The gate rows as text: `RESULT  gate — note`, the failing findings indented under a FAIL. */
function formatGate(g) {
  const L = [];
  for (const r of g.rows) {
    L.push(`${r.result.padEnd(15)} ${r.gate.padEnd(13)} ${r.note}`);
    for (const f of r.findings) L.push(`    ${f}`);
  }
  L.push(g.exit === 3 ? 'gate: no gate check is on — NOT CONFIGURED is never a pass (exit 3)' : g.exit === 1 ? `gate: FAIL — ${g.rows.filter((r) => r.result === 'FAIL').length} row(s) fail; the task is not Done` : `gate: PASS — every configured row passes${g.rows.some((r) => r.result === 'NOT CONFIGURED') ? ' (rows NOT CONFIGURED are not passes)' : ''}`);
  return L.join('\n');
}

/** Where the last report lives: <runs>/hygiene/<file>. */
function recordPath(cwd, settings, file) {
  const runs = (settings && settings.paths && settings.paths.runs) || '.pipeline';
  return path.join(cwd, runs, 'hygiene', file);
}
function writeRecord(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = { CHECKS, GATE_CHECKS, FEATURES, parse, changedSince, indexNonEmpty, runCheck, run, format, gate, formatGate, recordPath, writeRecord };
