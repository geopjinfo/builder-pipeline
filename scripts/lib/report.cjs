'use strict';
/**
 * The progress reporter — `features.reporter` (plan M16, REQ-1601 to REQ-1605, REQ-1607, REQ-1612, REQ-1614, REQ-1615;
 * D75, D77, D78, D79). `scripts/report.mjs` is the command; `notify.cjs` the channels.
 *
 * WHY. A person who is away wants one page every half hour that says what moved, what stalled and what needs them,
 * without reading an orchestrator state file. Numbers by code, words by persona (D70): this module reads the records
 * the kit already writes (run states and next actions, events, board counts, the capacity record, the readiness record,
 * the 429 record, the cost window) and renders them in a fixed order. It never invents a figure; a source that is
 * missing prints its own line and is never dropped (REQ-1602).
 *
 *   build(sources, { now, intervalMinutes, first, lastRefused, filePath })   pure: the report text
 *   digest(sources)                                                         pure: sha256 of the state parts, not the time
 *   gather({ cwd, root, settings, env, now })                               impure: the sources from the records
 *   tick(io)                                                                a report: write the files, decide, send
 *   alertPoll(io)                                                           one-line alerts for new matching events
 *
 * Every payload passes the outbound guard with the project's env secrets first; a hit means NOT SENT, the log says
 * `report.refused` with the kind and the line, and the file copy carries `[refused: <kind>]` in that line's place
 * (REQ-1607, REQ-1615). A send failure never changes an exit code (D85).
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const guard = require('./outbound-guard.cjs');

const { FEATURE, SECTIONS, CHANNEL_KINDS, WEBHOOK_FORMATS, ALERTS, DEFAULTS, validateReporter } = require('./report-rules.cjs');
const sha256 = (t) => crypto.createHash('sha256').update(t).digest('hex');
const iso = (ms) => new Date(ms).toISOString();
const stamp = (ms) => iso(ms).replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');


/* ----------------------------------------------------------------- the sources ---- */

const readJson = (file, dflt = null) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return dflt;
  }
};
const countBy = (lanes) => {
  const out = {};
  for (const l of Object.values(lanes || {})) out[l.status || 'UNKNOWN'] = (out[l.status || 'UNKNOWN'] || 0) + 1;
  return out;
};

/** The sources from the kit's own records. Missing sources come back null / empty and the report says so. */
function gather({ cwd = process.cwd(), root, settings = {}, env = process.env, now = Date.now(), reportsDir } = {}) {
  const cfg = { ...DEFAULTS, ...((settings.features && settings.features.reporter) || {}) };
  const dir = path.resolve(cwd, reportsDir || cfg.reportsDir);
  const stateFile = path.join(dir, 'state.json');
  const prev = readJson(stateFile, {}) || {};
  const out = { runs: [], loops: {}, events: [], eventsOffset: { ...(prev.eventsOffset || {}) }, boards: [], capacity: null, readiness: null, ratelimit: null, cost: { configured: false }, summary: null, lastSent: prev.lastSentAt || null, lastRefused: prev.lastRefused || null, lastDigest: prev.lastDigest || null, skipped: prev.skipped || 0 };
  // runs: state.json and next actions through orch-state when the root exists
  const runsDir = root ? path.join(root, 'runs') : null;
  if (runsDir && fs.existsSync(runsDir)) {
    let state = null;
    try {
      state = require('./orch-state.cjs');
    } catch (_) {
      state = null;
    }
    for (const id of fs.readdirSync(runsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
      const s = readJson(path.join(runsDir, id, 'state.json'));
      if (!s) continue;
      let next = [];
      try {
        next = state ? state.nextActions(root, s, now) : [];
      } catch (e) {
        next = [`next: unavailable (${String(e.message).split('\n')[0]})`];
      }
      const lanes = {};
      for (const [k, l] of Object.entries(s.lanes || {})) lanes[k] = { status: l.status, account: l.account || l.seat || null, rows: l.rows || [], stallReason: l.stallReason || null };
      out.runs.push({ runId: s.runId || id, target: s.target || null, approved: !!s.approved, paused: !!s.paused, lanes, next, mergeQueue: s.mergeQueue || [] });
      // events since the last offset (line count)
      const evFile = path.join(runsDir, id, 'events.jsonl');
      const lines = fs.existsSync(evFile) ? fs.readFileSync(evFile, 'utf8').split(/\r?\n/).filter(Boolean) : [];
      const from = out.eventsOffset[id] || 0;
      for (const line of lines.slice(from)) {
        try {
          out.events.push({ runId: id, ...JSON.parse(line) });
        } catch (_) {
          out.events.push({ runId: id, type: 'corrupt' });
        }
      }
      out.eventsOffset[id] = lines.length;
    }
    out.loops = readJson(path.join(root, 'loops.json'), {}) || {};
    out.capacity = readJson(path.join(root, 'capacity.json'));
    out.readiness = readJson(path.join(root, 'accounts-readiness.json'));
    out.ratelimit = readJson(path.join(root, 'ratelimit.json'));
  }
  // boards: counts through the board parser
  const boardsDir = path.resolve(cwd, (settings.paths && settings.paths.boards) || 'tasks');
  if (fs.existsSync(boardsDir)) {
    let parse = null;
    try {
      parse = require('./board-parse.cjs').parseBoard;
    } catch (_) {
      parse = null;
    }
    for (const f of fs.readdirSync(boardsDir).filter((n) => n.endsWith('.md') && !n.startsWith('_') && n !== 'README.md').sort()) {
      try {
        const b = parse ? parse(fs.readFileSync(path.join(boardsDir, f), 'utf8')) : null;
        if (b && b.totals && b.totals.total) out.boards.push({ file: path.posix.join(path.relative(cwd, boardsDir).split(path.sep).join('/'), f), settled: b.totals.settled, doing: b.totals.doing, total: b.totals.total });
      } catch (_) {
        /* not a board */
      }
    }
  }
  // cost: the cost window while costAccounting is on
  const ca = settings.features && settings.features.costAccounting;
  if (ca && ['on', 'unmeasured', 'experimental-on'].includes(ca.state)) {
    try {
      const usage = require('./transcript-usage.cjs');
      const since = prev.lastSentAt ? Date.parse(prev.lastSentAt) : now - cfg.intervalMinutes * 60000;
      const records = Object.values(usage.collect() || {});
      const inWindow = records.filter((r) => Number.isFinite(Date.parse(r.startedAt || r.at || r.ts)) && Date.parse(r.startedAt || r.at || r.ts) >= since);
      const usd = inWindow.reduce((a, r) => (typeof r.costUsd === 'number' ? a + r.costUsd : a), 0);
      const unpriced = inWindow.filter((r) => typeof r.costUsd !== 'number').length;
      out.cost = { configured: true, since: iso(since), dispatches: inWindow.length, usd: inWindow.length && !unpriced ? usd : null, unpriced };
    } catch (e) {
      out.cost = { configured: true, unmeasured: String(e.message).split('\n')[0] };
    }
  }
  // the persona's summary, with its age
  const summaryFile = path.join(dir, 'summary.md');
  if (fs.existsSync(summaryFile)) {
    const st = fs.statSync(summaryFile);
    out.summary = { text: fs.readFileSync(summaryFile, 'utf8').trim(), ageMinutes: Math.round((now - st.mtimeMs) / 60000) };
  }
  return out;
}

/* ----------------------------------------------------------------- the report (REQ-1603) ---- */

const laneLine = (runId, k, l) => `- ${runId}/${k} ${l.status}${l.account ? ` on ${l.account}` : ''}${l.rows && l.rows.length ? ` · rows ${l.rows.join(', ')}` : ''}${l.stallReason ? ` · ${l.stallReason}` : ''}`;
const counts = (lanes) => Object.entries(countBy(lanes)).map(([s, n]) => `${n} ${s}`).join(', ') || 'no lanes';
const NEEDS = /^(CHECK|RESOLVE|APPROVE|USAGE-HOLD|PAUSED|REFUSED|STOP|HOLD|CAPACITY-HOLD)/;

/** The report text. Pure: `now` is the clock, nothing else is read. */
function build(sources, { now = Date.now(), intervalMinutes = 30, first = false, lastRefused = null, filePath = null } = {}) {
  const s = sources || {};
  const L = [];
  L.push(`# Progress report — ${iso(now)}`);
  const notes = [];
  if (first) notes.push('first report');
  if (lastRefused) notes.push(`last send refused (${lastRefused})`);
  if (s.lastSent) notes.push(`previous report ${s.lastSent}`);
  L.push('', notes.length ? `_${notes.join(' · ')}_` : '_report_', '');
  // RUNS AND LANES
  L.push('## RUNS AND LANES', '');
  const runs = Array.isArray(s.runs) ? s.runs : [];
  const loops = Object.entries(s.loops || {});
  if (!runs.length && !loops.length) L.push('no runs');
  for (const r of runs) {
    L.push(`${r.runId}: ${counts(r.lanes)}${r.target ? ` → ${r.target}` : ''}${r.paused ? ' · PAUSED' : ''}${r.approved ? '' : ' · not approved'}${r.mergeQueue && r.mergeQueue.length ? ` · merge queue [${r.mergeQueue.join(', ')}]` : ''}`);
    for (const [k, l] of Object.entries(r.lanes || {})) L.push(laneLine(r.runId, k, l));
  }
  for (const [key, j] of loops) L.push(`loop ${key}: ${j.passes || 0} pass(es) on ${j.account || '?'} (cap ${j.cap}) · ${j.stopReason ? `stopped: ${j.stopReason}` : j.status || 'running'}`);
  if (Array.isArray(s.boards) && s.boards.length) {
    L.push('', 'boards:');
    for (const b of s.boards) L.push(`- ${b.file}: ${b.settled}/${b.total} settled, ${b.doing} doing`);
  }
  // SINCE LAST REPORT
  L.push('', '## SINCE LAST REPORT', '');
  const events = Array.isArray(s.events) ? s.events : [];
  if (!events.length) L.push(s.lastSent ? `no event since ${s.lastSent}` : 'no event yet');
  else {
    const byType = {};
    for (const e of events) {
      const key = e.type === 'lane.set' && e.status ? `lane.set ${e.status}` : e.type || 'event';
      byType[key] = (byType[key] || 0) + 1;
    }
    L.push(`${events.length} event(s): ${Object.entries(byType).map(([t, n]) => `${n} ${t}`).join(', ')}`);
    for (const e of events.slice(-8)) L.push(`- ${e.at || e.ts || ''} ${e.runId ? `${e.runId}` : ''}${e.lane ? `/${e.lane}` : ''} ${e.type || ''}${e.status ? ` ${e.status}` : ''}${e.machine ? ` ${e.machine}` : ''}`.replace(/\s+/g, ' ').trim());
  }
  // NEEDS A PERSON
  L.push('', '## NEEDS A PERSON', '');
  const needs = [];
  for (const r of runs) {
    for (const [k, l] of Object.entries(r.lanes || {})) if (['STALLED', 'FAILED', 'STOPPED-CONFLICT'].includes(l.status)) needs.push(laneLine(r.runId, k, l));
    for (const a of r.next || []) if (NEEDS.test(a)) needs.push(`- ${r.runId}: ${a}`);
    if (!r.approved) needs.push(`- ${r.runId}: the split is not approved (orch approve)`);
  }
  if (s.readiness && s.readiness.accounts) for (const [n, a] of Object.entries(s.readiness.accounts)) if (a && a.state && a.state !== 'ready') needs.push(`- account ${n}: ${a.state}${a.reason ? ` (${a.reason})` : ''}`);
  if (s.ratelimit && s.ratelimit.holdUntil) needs.push(`- 429 hold until ${s.ratelimit.holdUntil}`);
  L.push(...(needs.length ? needs : ['none']));
  // CAPACITY AND ACCOUNTS
  L.push('', '## CAPACITY AND ACCOUNTS', '');
  if (!s.capacity) L.push('capacity: not configured');
  else L.push(`capacity: ${s.capacity.effectiveLanes !== undefined ? `${s.capacity.effectiveLanes} lane(s) effective` : 'record present'}${s.capacity.reason ? ` · ${s.capacity.reason}` : ''}${s.capacity.updatedAt ? ` · at ${s.capacity.updatedAt}` : ''}`);
  if (!s.readiness || !s.readiness.accounts || !Object.keys(s.readiness.accounts).length) L.push('readiness: no record');
  else for (const [n, a] of Object.entries(s.readiness.accounts)) L.push(`- ${n}: ${a.state || 'unknown'}${typeof a.percent === 'number' ? ` · ${a.percent}% used` : ' · usage unmeasured'}${a.reason ? ` · ${a.reason}` : ''}`);
  if (!s.ratelimit) L.push('429 record: none');
  else L.push(`429 record: ${s.ratelimit.holdUntil ? `hold until ${s.ratelimit.holdUntil}` : 'no hold'}${typeof s.ratelimit.lanes === 'number' ? ` · lane cap ${s.ratelimit.lanes}` : ''}${typeof s.ratelimit.hits === 'number' ? ` · ${s.ratelimit.hits} hit(s)` : ''}`);
  // COST
  L.push('', '## COST', '');
  const c = s.cost || { configured: false };
  if (!c.configured) L.push('costAccounting: not configured');
  else if (c.unmeasured) L.push(`cost: unmeasured (${c.unmeasured})`);
  else L.push(`since ${c.since}: ${c.dispatches} dispatch(es), ${c.usd === null ? `unpriced${c.unpriced ? ` (${c.unpriced} without a rate)` : ''}` : `$${c.usd.toFixed(2)}`}`);
  // NEXT
  L.push('', '## NEXT', '');
  const nexts = runs.flatMap((r) => (r.next || []).map((a) => `- ${r.runId}: ${a}`));
  L.push(...(nexts.length ? nexts : ['nothing to do']));
  // SUMMARY (model): only while younger than one interval
  if (s.summary && typeof s.summary.text === 'string' && s.summary.text && Number.isFinite(s.summary.ageMinutes) && s.summary.ageMinutes < intervalMinutes) {
    L.push('', '## SUMMARY (model)', '', "_written by the progress-reporter persona; a model's words, not a measurement_", '', s.summary.text);
  }
  if (filePath) L.push('', `full report: ${filePath}`);
  return L.join('\n') + '\n';
}

/** The digest of the state parts: runs, loops, boards, capacity, readiness, ratelimit, cost figures. Never the time. */
function digest(sources) {
  const s = sources || {};
  const part = {
    runs: (s.runs || []).map((r) => ({ runId: r.runId, approved: r.approved, paused: r.paused, lanes: Object.fromEntries(Object.entries(r.lanes || {}).map(([k, l]) => [k, [l.status, l.account, l.stallReason]])), next: r.next, mergeQueue: r.mergeQueue })),
    loops: Object.fromEntries(Object.entries(s.loops || {}).map(([k, j]) => [k, [j.passes, j.stopReason, j.status, j.account]])),
    boards: s.boards || [],
    capacity: s.capacity ? [s.capacity.effectiveLanes, s.capacity.reason] : null,
    readiness: s.readiness && s.readiness.accounts ? Object.fromEntries(Object.entries(s.readiness.accounts).map(([n, a]) => [n, [a.state, a.reason, a.percent]])) : null,
    ratelimit: s.ratelimit ? [s.ratelimit.holdUntil, s.ratelimit.lanes, s.ratelimit.hits] : null,
    cost: s.cost ? [s.cost.configured, s.cost.dispatches, s.cost.usd] : null,
  };
  return sha256(JSON.stringify(part));
}

/* ----------------------------------------------------------------- the guard (REQ-1607, REQ-1615) ---- */

/** Scan the text with the project's env secrets; the copy replaces each hit line with `[refused: <kind>]`. */
function guardText(text, { cwd = process.cwd(), config = {} } = {}) {
  const secrets = guard.knownSecrets(cwd, config.envFiles || guard.DEFAULTS.envFiles);
  const hits = guard.scan(text, { secrets, extraPatterns: config.extraPatterns || [] });
  if (!hits.length) return { text, hits: [] };
  const byLine = new Map();
  for (const h of hits) byLine.set(h.line, [...(byLine.get(h.line) || []), h.kind]);
  const copy = text.split('\n').map((l, i) => (byLine.has(i + 1) ? `[refused: ${[...new Set(byLine.get(i + 1))].join(', ')}]` : l)).join('\n');
  return { text: copy, hits };
}

/* ----------------------------------------------------------------- a tick ---- */

const writeAtomic = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, text);
  fs.renameSync(`${file}.tmp`, file);
};
const appendLog = (dir, entry) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'report.log.jsonl'), JSON.stringify({ at: iso(Date.now()), ...entry }) + '\n');
};

/** Build the channel objects of a profile (notify.cjs) — injectable through io.channels for tests. */
function channelsOf(cfg) {
  const notify = require('./notify.cjs');
  return (cfg.channels || []).filter((c) => c.kind !== 'file').map((c) => ({ kind: c.kind, send: (payload) => notify.send(c, payload) }));
}

/**
 * One report: gather, build, guard, write the files, decide (only on change, heartbeat), send.
 * io: { cwd, root, settings, env, now, channels, reportsDir }
 */
async function tick(io = {}) {
  const { cwd = process.cwd(), root, settings = {}, env = process.env, now = Date.now() } = io;
  const cfg = { ...DEFAULTS, ...((settings.features && settings.features.reporter) || {}) };
  const dir = path.resolve(cwd, io.reportsDir || cfg.reportsDir);
  const log = (e) => appendLog(dir, e);
  const sources = gather({ cwd, root, settings, env, now, reportsDir: io.reportsDir || cfg.reportsDir });
  const prev = readJson(path.join(dir, 'state.json'), {}) || {};
  const first = !prev.lastDigest && !prev.lastSentAt;
  const rel = path.posix.join(String(io.reportsDir || cfg.reportsDir).split(path.sep).join('/'), 'latest.md');
  const raw = build(sources, { now, intervalMinutes: cfg.intervalMinutes, first, lastRefused: prev.lastRefused || null, filePath: rel });
  const d = digest(sources);
  const guarded = guardText(raw, { cwd, config: settings.features && settings.features.outboundGuard });
  const file = path.join(dir, `report-${stamp(now)}.md`);
  writeAtomic(file, guarded.text);
  writeAtomic(path.join(dir, 'latest.md'), guarded.text);
  const state = { ...prev, lastDigest: prev.lastDigest || null, eventsOffset: sources.eventsOffset, lastTickAt: iso(now), lastFile: path.basename(file) };
  const result = { file, digest: d, sent: false, skipped: false, heartbeat: false, refused: false, failures: [] };
  if (guarded.hits.length) {
    const kinds = [...new Set(guarded.hits.map((h) => h.kind))];
    for (const h of guarded.hits) log({ type: 'report.refused', kind: h.kind, line: h.line });
    state.lastRefused = kinds.join(', ');
    state.lastDigest = d;
    writeAtomic(path.join(dir, 'state.json'), JSON.stringify(state, null, 2) + '\n');
    result.refused = true;
    return result;
  }
  state.lastRefused = null;
  const channels = io.channels || channelsOf(cfg);
  const unchanged = cfg.onlyOnChange && prev.lastDigest === d;
  let text = guarded.text;
  if (unchanged) {
    const skipped = (prev.skipped || 0) + 1;
    if (skipped % cfg.heartbeatEvery === 0) {
      text = `heartbeat: no change since ${prev.lastSentAt || prev.lastTickAt} (${skipped} ticks skipped) · ${rel}\n`;
      result.heartbeat = true;
    } else {
      state.skipped = skipped;
      state.lastDigest = d;
      writeAtomic(path.join(dir, 'state.json'), JSON.stringify(state, null, 2) + '\n');
      log({ type: 'report.skipped', digest: d, skipped });
      result.skipped = true;
      return result;
    }
  }
  const payload = { text, sources, digest: d, at: iso(now), file: rel, env, cwd, log, timeoutMs: cfg.timeoutMs, maxBytes: cfg.maxBytes };
  for (const ch of channels) {
    try {
      const r = await ch.send(payload);
      if (!r || r.ok === false) result.failures.push({ kind: ch.kind, error: (r && r.error) || 'send failed' });
    } catch (e) {
      result.failures.push({ kind: ch.kind, error: String(e && e.message ? e.message : e).split('\n')[0] });
    }
  }
  for (const f of result.failures) log({ type: 'notify.failed', kind: f.kind, error: f.error });
  result.sent = true;
  state.skipped = 0;
  state.lastDigest = d;
  state.lastSentAt = iso(now);
  state.lastSentKinds = channels.map((c) => c.kind);
  writeAtomic(path.join(dir, 'state.json'), JSON.stringify(state, null, 2) + '\n');
  log({ type: result.heartbeat ? 'report.heartbeat' : 'report.sent', digest: d, channels: state.lastSentKinds, failures: result.failures.length });
  return result;
}

/* ----------------------------------------------------------------- alerts (REQ-1612) ---- */

/** The alert kind of an event, or null. */
function alertKind(e) {
  if (!e || typeof e !== 'object') return null;
  const t = String(e.type || '');
  if (t === 'lane.set' && e.status === 'STALLED') return 'stall';
  if (/stall/.test(t)) return 'stall';
  if (t === 'lane.set' && e.status === 'FAILED') return 'failed';
  if (/\.(failed|refused)$/.test(t) && !/launch\.refused/.test(t)) return 'failed';
  if (/merge\.stop|conflict/.test(t) || (t === 'lane.set' && e.status === 'STOPPED-CONFLICT')) return 'conflict';
  if (/ratelimit|429/.test(t)) return 'rate-limit';
  if (/account\.limit|budget|account\.paid/.test(t)) return 'limit';
  if (t === 'run.end' || t === 'run.complete') return 'run-complete';
  return null;
}

/** Poll every run's events since the alert offset; send one line per matching event, once. */
async function alertPoll(io = {}) {
  const { cwd = process.cwd(), root, settings = {}, env = process.env, now = Date.now() } = io;
  const cfg = { ...DEFAULTS, ...((settings.features && settings.features.reporter) || {}) };
  const dir = path.resolve(cwd, io.reportsDir || cfg.reportsDir);
  const want = new Set(cfg.alertOn || []);
  const out = { sent: 0, seen: 0 };
  if (!want.size || !root || !fs.existsSync(path.join(root, 'runs'))) return out;
  const stateFile = path.join(dir, 'state.json');
  const st = readJson(stateFile, {}) || {};
  const offsets = { ...(st.alertOffset || {}) };
  const channels = io.channels || channelsOf(cfg);
  const log = (e) => appendLog(dir, e);
  for (const id of fs.readdirSync(path.join(root, 'runs'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
    const evFile = path.join(root, 'runs', id, 'events.jsonl');
    if (!fs.existsSync(evFile)) continue;
    const lines = fs.readFileSync(evFile, 'utf8').split(/\r?\n/).filter(Boolean);
    // events the last report already covered are not alerts; with no report yet the first poll only records where it starts
    const from = offsets[id] !== undefined ? offsets[id] : st.eventsOffset && st.eventsOffset[id] !== undefined ? st.eventsOffset[id] : lines.length;
    for (let i = from; i < lines.length; i++) {
      let e;
      try {
        e = JSON.parse(lines[i]);
      } catch (_) {
        continue;
      }
      out.seen += 1;
      const kind = alertKind(e);
      if (!kind || !want.has(kind)) continue;
      const line = `alert ${kind}: ${id}${e.lane ? `/${e.lane}` : ''} ${e.status || e.type}${e.stallReason ? ` — ${e.stallReason}` : ''}${e.at ? ` (${e.at})` : ''}\n`;
      const guarded = guardText(line, { cwd, config: settings.features && settings.features.outboundGuard });
      if (guarded.hits.length) {
        for (const h of guarded.hits) log({ type: 'report.refused', kind: h.kind, line: h.line, alert: kind });
        continue;
      }
      for (const ch of channels) {
        try {
          const r = await ch.send({ text: guarded.text, sources: null, digest: null, at: iso(now), file: null, env, cwd, log, timeoutMs: cfg.timeoutMs, maxBytes: cfg.maxBytes, alert: kind });
          if (!r || r.ok === false) log({ type: 'notify.failed', kind: ch.kind, error: (r && r.error) || 'send failed', alert: kind });
        } catch (err) {
          log({ type: 'notify.failed', kind: ch.kind, error: String(err && err.message ? err.message : err).split('\n')[0], alert: kind });
        }
      }
      log({ type: 'alert.sent', alert: kind, run: id, offset: i });
      out.sent += 1;
    }
    offsets[id] = lines.length;
  }
  writeAtomic(stateFile, JSON.stringify({ ...st, alertOffset: offsets }, null, 2) + '\n');
  return out;
}

/** The `orch status` line (REQ-1613): the last send, its time and the channel kinds; or the not-configured line. */
function statusLine(cwd, settings = {}) {
  const f = settings.features && settings.features.reporter;
  if (!f || !['on', 'unmeasured', 'experimental-on'].includes(f.state)) return 'reporter: not configured';
  const cfg = { ...DEFAULTS, ...f };
  const st = readJson(path.resolve(cwd, cfg.reportsDir, 'state.json'), {}) || {};
  if (!st.lastSentAt) return `reporter: last sent never (${cfg.channels.map((c) => c.kind).join(', ') || 'no channel'}${st.lastRefused ? `; last refused: ${st.lastRefused}` : ''})`;
  return `reporter: last sent ${st.lastSentAt} via ${(st.lastSentKinds || []).join(', ') || 'no channel'}${st.lastRefused ? ` · last refused: ${st.lastRefused}` : ''}`;
}

module.exports = { statusLine, FEATURE, SECTIONS, CHANNEL_KINDS, WEBHOOK_FORMATS, ALERTS, DEFAULTS, validateReporter, gather, build, digest, guardText, tick, alertPoll, alertKind, channelsOf };
