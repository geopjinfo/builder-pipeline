'use strict';
/**
 * Run state — one state file per run (lanes, seat, branch, level, dispatch, status, timings) plus an append-only
 * events.jsonl.
 *
 * WHY. The orchestrating session is the most fragile part of a batch: it is long-lived, it compacts, it gets
 * killed. Nothing it knows may live only in its context. A new session resumes from this file alone:
 * `nextActions()` derives what to do next from state + clock, with no memory of the previous session.
 *
 * PLACEMENT. A lane runs in one of two seats, tried in the order `seats` lists them (features.orchestrator.seats):
 *   secondary  a terminal worker signed in to a second account (its own usage limit; launched by the project's
 *              `launchCommand`, watched by `orch watch`)
 *   primary    the orchestrating session's own account: a sub-agent for a solo lane; its own session for a
 *              pipeline lane (seats never dispatch, so a sub-agent cannot run a pipeline's seats)
 * A lane goes to the first seat whose fresh usage reading is under its limit (`limits.<seat>`, percent). The
 * primary seat's limit should sit BELOW the secondary's: the orchestrating session runs on that account too and
 * needs headroom of its own. The first lane may start on the first seat unmeasured; any later placement needs a
 * reading younger than `usageStaleMinutes`. When every seat is full: USAGE-HOLD, nothing launches.
 * Credit jobs are placed by the credit lane, not here (orch-credit.cjs).
 *
 * CAPACITY (features.orchestrator.capacity; null = off). A standing lane policy instead of a per-run guess: while the
 * capacity seat (default secondary) is freshly measured under `underPct`, keep up to `laneCap` lanes live — `next`
 * prints ADD-LANES with how many rows to pull from the run's plan — and `split --measured <file>` sizes the split
 * from the file's last "<seat> <n>%" reading (under → laneCap, else defaultLanes). `BUILDER_ORCH_LANE_CAP` (a whole
 * number 1–16) overrides laneCap for the process that reads it.
 *
 * SELF-AUDIT. A lane that stopped with `RESULT: PASS WAIT-P4 …` hands its seats to the credit lane. While the credit
 * lane is busy with other work (orch-credit.cjs creditBusy) and holds no seat job of the lane's own, `next` says
 * SELF-AUDIT instead of ENQUEUE: resume the worker to run those seats itself (`gate-launch --resume`).
 */
const fs = require('fs');
const path = require('path');
const { runDir, readJson, writeJsonAtomic, withLock } = require('./orch-store.cjs');
const snapshots = require('./orch-snapshot.cjs');
const ratelimit = require('./orch-ratelimit.cjs');
const { integritySnapshot, integrityDiff } = require('./orch-integrity.cjs');

const STATUSES = ['PLANNED', 'CLAIMED', 'LAUNCHED', 'DONE', 'QUEUED', 'MERGING', 'MERGED', 'STALLED', 'PAUSED', 'STOPPED-CONFLICT', 'FAILED'];
const ACTIVE = ['LAUNCHED', 'STALLED']; // a live worker session holds a lane slot
const SNAPSHOT_ON = ['STALLED', 'FAILED']; // a lane entering one of these is pinned by snapshot refs
const SEATS = ['secondary', 'primary'];
const DEFAULTS = Object.freeze({ stallMinutes: 90, usageStaleMinutes: 30, seats: ['primary'], limits: { secondary: 80, primary: 60 } });
const RUNNER_OF = Object.freeze({ secondary: 'terminal worker on the secondary account', primary: 'primary account: a sub-agent for a solo lane, its own session for a pipeline lane' });

const stateFile = (root, runId) => path.join(runDir(root, runId), 'state.json');
const lockFile = (root, runId) => path.join(runDir(root, runId), 'state.lock');
const pauseFile = (root) => path.join(root, 'PAUSE');
const now = () => new Date().toISOString();

function event(root, runId, type, data = {}) {
  const line = JSON.stringify({ at: now(), type, ...data });
  fs.mkdirSync(runDir(root, runId), { recursive: true });
  fs.appendFileSync(path.join(runDir(root, runId), 'events.jsonl'), line + '\n');
}

function load(root, runId) {
  const s = readJson(stateFile(root, runId), null);
  if (!s) throw new Error(`no run "${runId}" under ${root}`);
  return s;
}

/**
 * Create a run from a split result. Refuses to overwrite an existing run (resume it instead).
 * opts: repo, target, worktreeBase, worktreePrefix, branchPrefix, preflightMode, seats, limits, stallMinutes,
 * usageStaleMinutes, capacity (features.orchestrator.capacity), credit (the credit lane is enabled).
 */
function init(root, runId, splitResult, opts = {}) {
  const {
    repo = null, target = null, worktreeBase = null, worktreePrefix = 'wt-', branchPrefix = 'orch/', preflightMode = 'single',
    seats = DEFAULTS.seats, limits = DEFAULTS.limits, stallMinutes = DEFAULTS.stallMinutes, usageStaleMinutes = DEFAULTS.usageStaleMinutes,
    capacity = null, credit = false,
  } = opts;
  const file = stateFile(root, runId);
  if (fs.existsSync(file)) throw new Error(`run "${runId}" already exists — resume it, never re-init`);
  for (const seat of seats) if (!SEATS.includes(seat)) throw new Error(`unknown seat "${seat}" (${SEATS.join('|')})`);
  const lanes = {};
  for (const l of splitResult.lanes) {
    const name = `${runId}-${l.name}`;
    lanes[l.name] = {
      name, rows: l.rows, level: l.level, track: l.track, dispatch: l.dispatch || 'full', ownedFiles: l.ownedFiles, hotFiles: l.hotFiles,
      seat: null, branch: `${branchPrefix}${name}`, worktree: worktreeBase ? path.join(worktreeBase, `${worktreePrefix}${name}`) : null,
      status: 'PLANNED', sessionId: null,
      brief: path.join(runDir(root, runId), 'briefs', `${l.name}.md`),
      result: path.join(runDir(root, runId), 'results', `${l.name}.md`),
      timings: { plannedAt: now() }, stallMinutes,
    };
  }
  const state = {
    runId, createdAt: now(), updatedAt: now(), repo, target,
    approved: false, approvedBy: null, paused: false, preflightMode,
    plannedMaxLanes: splitResult.maxLanes ?? 2,
    maxLanes: preflightMode === 'parallel' ? (splitResult.maxLanes ?? 2) : 1,
    seats: [...seats], limits: { ...DEFAULTS.limits, ...limits }, usageStaleMinutes,
    ...(capacity ? { capacity: { ...capacity } } : {}),
    ...(credit ? { credit: true } : {}), // the run uses the credit lane: a WAIT-P4 lane may be offered SELF-AUDIT
    // the plan the lanes came from, so ADD-LANES can say where to pull the next rows
    ...(splitResult.plan && (splitResult.plan.file || splitResult.plan.title) ? { plan: { file: splitResult.plan.file || null, title: splitResult.plan.title || null } } : {}),
    usage: {}, mergeQueue: [],
    rows: splitResult.rows, lanes,
  };
  writeJsonAtomic(file, state);
  writeJsonAtomic(path.join(runDir(root, runId), 'lanes.json'), splitResult);
  event(root, runId, 'run.init', { lanes: Object.keys(lanes), preflightMode });
  return state;
}

/** Read-modify-write under the run lock. `fn` mutates the state; its return value is passed back. */
function update(root, runId, fn, evt) {
  return withLock(lockFile(root, runId), () => {
    const s = load(root, runId);
    const out = fn(s);
    s.updatedAt = now();
    writeJsonAtomic(stateFile(root, runId), s);
    if (evt) event(root, runId, evt.type, evt.data);
    return out;
  });
}

function setLane(root, runId, lane, patch) {
  if (patch.status && !STATUSES.includes(patch.status)) throw new Error(`unknown status ${patch.status}`);
  const out = update(
    root,
    runId,
    (s) => {
      const l = s.lanes[lane];
      if (!l) throw new Error(`no lane ${lane} in ${runId}`);
      const { timings, ...rest } = patch;
      Object.assign(l, rest);
      if (timings) Object.assign(l.timings, timings);
      if (patch.status) l.timings[`${patch.status.toLowerCase()}At`] = now();
      return l;
    },
    { type: 'lane.set', data: { lane, ...patch } },
  );
  if (SNAPSHOT_ON.includes(patch.status)) snapshotLane(root, runId, lane, `status ${patch.status}`);
  return out;
}

/** Pin a lane's branch tip (and a dirty worktree's work) under refs/orch/snapshots/. Never throws. */
function snapshotLane(root, runId, lane, reason, { repo } = {}) {
  try {
    const s = load(root, runId);
    const l = s.lanes[lane];
    const r = snapshots.snapshot({ repo: repo || s.repo, runId, lane, branch: l && l.branch, worktree: l && l.worktree });
    event(root, runId, r.skipped ? 'snapshot.skipped' : 'snapshot', { lane, reason, ...r });
    return r;
  } catch (e) {
    event(root, runId, 'snapshot.skipped', { lane, reason, skipped: e.message });
    return { skipped: e.message };
  }
}

/** Record the lane worktree's git config/hooks hashes at launch. null when the worktree does not exist yet. */
function integrityBaseline(root, runId, lane) {
  const l = load(root, runId).lanes[lane];
  if (!l || !l.worktree || !fs.existsSync(l.worktree)) return null;
  const snap = integritySnapshot(l.worktree);
  update(root, runId, (s) => {
    s.lanes[lane].integrity = snap;
  }, { type: 'integrity.baseline', data: { lane, entries: Object.keys(snap).length } });
  return snap;
}

/** What changed in the lane's git config/hooks since its baseline; fail closed when it cannot be checked. */
function integrityFaults(l) {
  if (!l.integrity) return [];
  try {
    return integrityDiff(l.integrity, integritySnapshot(l.worktree));
  } catch (e) {
    return [`integrity check could not run — ${e.message}`];
  }
}

/** A finish (or progress) notice from a worker. Finish without a result file is NOT done — it is a stall. */
function notice(root, runId, lane, kind = 'finish') {
  const r = update(
    root,
    runId,
    (s) => {
      const l = s.lanes[lane];
      if (!l) throw new Error(`no lane ${lane}`);
      l.timings.lastNoticeAt = now();
      if (kind !== 'finish') return { lane, status: l.status };
      let first = null;
      try {
        first = fs.readFileSync(l.result, 'utf8').split(/\r?\n/)[0];
      } catch (_) {
        /* no result file */
      }
      const tampered = integrityFaults(l);
      if (tampered.length) {
        l.status = 'STALLED';
        l.stallReason = `integrity: git config/hooks changed during the run — ${tampered.join('; ')}`;
        l.integrityFaults = tampered;
        l.timings.stalledAt = now();
      } else if (first) {
        l.status = 'DONE';
        l.timings.doneAt = now();
        l.resultLine = first.slice(0, 200);
      } else {
        l.status = 'STALLED';
        l.stallReason = 'finish notice but no result file';
        l.timings.stalledAt = now();
      }
      return { lane, status: l.status, resultLine: l.resultLine || null };
    },
    { type: 'lane.notice', data: { lane, kind } },
  );
  if (SNAPSHOT_ON.includes(r.status) && kind === 'finish') snapshotLane(root, runId, lane, 'finish notice without a clean result');
  if (r.status === 'DONE' && kind === 'finish') ratelimit.recordCleanFinish(root);
  return r;
}

function recordUsage(root, runId, seat, pct) {
  if (!SEATS.includes(seat)) throw new Error(`unknown seat "${seat}" (${SEATS.join('|')})`);
  if (!Number.isFinite(Number(pct))) throw new Error(`usage: a percentage, got ${JSON.stringify(pct)}`);
  return update(root, runId, (s) => {
    s.usage[seat] = { pct: Number(pct), at: now() };
    return s.usage;
  }, { type: 'usage', data: { seat, pct: Number(pct) } });
}

function approve(root, runId, by) {
  return update(root, runId, (s) => {
    s.approved = true;
    s.approvedBy = by;
    s.approvedAt = now();
    return true;
  }, { type: 'run.approved', data: { by } });
}

function setPaused(root, runId, paused) {
  return update(root, runId, (s) => {
    s.paused = paused;
    return paused;
  }, { type: paused ? 'run.paused' : 'run.resumed' });
}

/** Where the next lane goes: { seat, why } or { seat: null, why } (USAGE-UNKNOWN / USAGE-HOLD). */
function placement(s, at = Date.now(), running = 0) {
  const u = s.usage || {};
  const order = s.seats && s.seats.length ? s.seats : DEFAULTS.seats;
  const limits = { ...DEFAULTS.limits, ...(s.limits || {}) };
  const staleMin = s.usageStaleMinutes ?? DEFAULTS.usageStaleMinutes;
  const fresh = (seat) => u[seat] && at - Date.parse(u[seat].at) <= staleMin * 60000;
  const full = [];
  for (let i = 0; i < order.length; i++) {
    const seat = order[i];
    const limit = limits[seat];
    if (fresh(seat)) {
      if (u[seat].pct < limit) return { seat, why: `${seat} at ${u[seat].pct}% under its limit ${limit}%` };
      full.push(`${seat} at ${u[seat].pct}% (limit ${limit}%)`);
      continue;
    }
    if (i === 0 && running === 0 && (!u[seat] || u[seat].pct < limit)) return { seat, why: `${seat}: first lane, usage unmeasured` };
    return {
      seat: null,
      why: `USAGE-UNKNOWN: ${seat} usage unmeasured in ${staleMin} min${full.length ? ` and ${full.join(', ')}` : ''} — orch usage-read ${s.runId} ${seat} (or orch usage ${s.runId} ${seat} <pct>)`,
    };
  }
  return { seat: null, why: `USAGE-HOLD: ${full.join(' and ')} — no new lanes` };
}

/** `BUILDER_ORCH_LANE_CAP`: a whole number 1–16 overrides the capacity lane cap; unset or invalid → null (no override). */
function envLaneCap(v) {
  const n = Number(v);
  return v !== undefined && v !== null && v !== '' && Number.isInteger(n) && n >= 1 && n <= 16 ? n : null;
}

/** The capacity policy in force: the run's (or the profile's) features.orchestrator.capacity, env override applied. */
function capacityOf(capacity, env = process.env) {
  if (!capacity || !capacity.laneCap) return null;
  return {
    laneCap: envLaneCap(env.BUILDER_ORCH_LANE_CAP) || capacity.laneCap,
    seat: capacity.seat || 'secondary',
    underPct: capacity.underPct ?? 50,
    defaultLanes: capacity.defaultLanes ?? null,
  };
}

/**
 * The split cap a measured file supports — the LAST "<seat> <n>%" figure it holds (the file is appended to, latest
 * reading last). Under `underPct` → laneCap; at/over it, or no figure → defaultLanes (else `fallback`).
 */
function measuredLanes(text, capacity, fallback = 2) {
  const c = capacityOf(capacity);
  if (!c) return { maxLanes: fallback, pct: null, seat: null };
  const seat = c.seat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const all = [...String(text).matchAll(new RegExp(String.raw`\b${seat}\b\s*[=:]?\s*(\d+(?:\.\d+)?)\s*%`, 'gi'))];
  const low = c.defaultLanes || fallback;
  if (!all.length) return { maxLanes: low, pct: null, seat: c.seat };
  const pct = Number(all[all.length - 1][1]);
  return { maxLanes: pct < c.underPct ? c.laneCap : low, pct, seat: c.seat };
}

/** A lane that stopped at WAIT-P4: its seats are owed to the credit lane. */
const isWaitP4 = (l) => l.status === 'DONE' && /^RESULT: PASS WAIT-P4\b/.test(l.resultLine || '');

/** Default credit-busy probe: the credit lib's view from the run's repo; a fault reads as not busy (no new line). */
function defaultCreditBusy(s) {
  return (laneWorktree, since) => {
    try {
      return require('./orch-credit.cjs').creditBusy({ cwd: s.repo || process.cwd(), laneWorktree, since });
    } catch (_) {
      return null;
    }
  };
}

/**
 * Deterministic next steps from state + clock. Nothing here remembers anything a killed session knew.
 * `opts.creditBusy(laneWorktree, since)` → a reason string while the credit lane is busy for that lane, else null
 * (tests inject it; the default asks orch-credit.cjs, and only when the run uses the credit lane).
 */
function nextActions(root, s, at = Date.now(), opts = {}) {
  const creditBusy = opts.creditBusy || (s.credit ? defaultCreditBusy(s) : () => null);
  const acts = [];
  const lanes = Object.entries(s.lanes);
  const paused = s.paused || fs.existsSync(pauseFile(root));
  for (const [k, l] of lanes) {
    if (l.status === 'LAUNCHED') {
      const since = Date.parse(l.timings.lastNoticeAt || l.timings.launchedAt || l.timings.plannedAt);
      if (at - since > l.stallMinutes * 60000) acts.push(`STALL ${k}: no notice for ${Math.round((at - since) / 60000)} min — check session ${l.sessionId}; relaunch it`);
      else acts.push(`WAIT ${k}: running on ${l.seat || '?'} (session ${l.sessionId}) — its finish notice is \`orch watch ${s.runId} ${k}\` in the background; start one if this is a new orchestrator session`);
    }
    if (l.status === 'STALLED') acts.push(`CHECK ${k}: stalled (${l.stallReason || 'no notice in time'}) — read its result/log pointer, then relaunch, or move it to the other seat`);
    if (l.status === 'STOPPED-CONFLICT') acts.push(`HEADS-UP ${k}: merge conflict on ${(l.conflictFiles || []).join(', ')} — see ${l.headsUp}; refresh the lane, re-run gates, re-enqueue`);
    if (l.status === 'FAILED') acts.push(`FIX ${k}: gates red (log ${l.gatesLog || '?'}) — send the lane a FIX pointer, then re-enqueue`);
    if (l.status === 'PAUSED') acts.push(paused ? `HOLD ${k}: paused (session ${l.sessionId})` : `RELAUNCH ${k}: resume session ${l.sessionId}`);
    if (l.status === 'DONE') {
      // a WAIT-P4 lane while the credit lane is busy with other work: the lane runs its own seats
      const busy = isWaitP4(l) ? creditBusy(l.worktree, l.timings && l.timings.doneAt) : null;
      acts.push(busy ? `SELF-AUDIT ${k}: credit busy — resume the worker to run its owed seats itself (${busy}); gate-launch ${s.runId} ${k} --resume` : `ENQUEUE ${k}: done — "${l.resultLine}"`);
    }
  }
  if (paused) {
    acts.unshift('PAUSED: no new launches, no merges (orch resume to continue)');
    return acts;
  }
  if (!s.approved) {
    acts.unshift(`AWAIT-APPROVAL: show the human the lane split + levels (orch status ${s.runId} --split), then orch approve ${s.runId} --by <who>`);
    return acts;
  }

  const merging = lanes.find(([, l]) => l.status === 'MERGING');
  if (merging) acts.push(`MERGING ${merging[0]}: one merge at a time — wait`);
  else if (s.mergeQueue.length) acts.push(`MERGE ${s.mergeQueue[0]}: queue head — confirm the machine's test slot is free, then orch merge ${s.runId} --slot-ok`);

  const running = lanes.filter(([, l]) => ACTIVE.includes(l.status)).length;
  const cap = ratelimit.laneCap(ratelimit.load(root), at);
  const maxLanes = cap ? Math.min(s.maxLanes, cap.lanes) : s.maxLanes;
  let free = Math.max(0, maxLanes - running);
  if (cap && cap.holdUntil) {
    acts.push(`RATE-LIMIT-HOLD: global back-off after a 429 until ${cap.holdUntil} — no new lanes`);
    free = 0;
  } else if (maxLanes < s.maxLanes) acts.push(`RATE-LIMIT: lanes capped at ${maxLanes} of ${s.maxLanes} after a 429 — one more per clean finish`);
  const place = free > 0 && lanes.some(([, l]) => l.status === 'PLANNED' || l.status === 'CLAIMED') ? placement(s, at, running) : null;
  if (place && !place.seat) {
    acts.push(place.why);
    free = 0;
  }

  for (const [k, l] of lanes) {
    if (free <= 0) break;
    if (l.status === 'PLANNED' || l.status === 'CLAIMED') {
      acts.push(`LAUNCH ${k}: ${l.level}/${l.track} ${l.dispatch} rows ${l.rows.join(',')}${l.status === 'PLANNED' ? ' (claim first)' : ''} on ${place.seat} (${RUNNER_OF[place.seat]})`);
      free--;
    }
  }
  // CAPACITY: keep the seat busy — while it is freshly measured under its percentage and fewer than laneCap lanes are
  // live (LAUNCHED, STALLED or PAUSED — a paused lane is offered RELAUNCH, so it holds its slot), pull more rows; a lane
  // waiting to launch already holds a slot. Never beside a 429 cap or in single-lane preflight.
  const c = capacityOf(s.capacity);
  if (c) {
    const u = (s.usage || {})[c.seat];
    const staleMin = s.usageStaleMinutes ?? DEFAULTS.usageStaleMinutes;
    const fresh = u && at - Date.parse(u.at) <= staleMin * 60000;
    const live = running + lanes.filter(([, l]) => l.status === 'PAUSED').length;
    const waiting = lanes.filter(([, l]) => l.status === 'PLANNED' || l.status === 'CLAIMED').length;
    const pull = c.laneCap - live - waiting;
    const capped = (cap && cap.holdUntil) || maxLanes < s.maxLanes || s.preflightMode === 'single';
    if (fresh && u.pct < c.underPct && pull > 0 && !capped) {
      const from = (s.plan && (s.plan.file || s.plan.title)) || 'the next plan (orch digest <artifact>)';
      acts.push(`ADD-LANES: ${c.seat} at ${u.pct}% — pull ${pull} row(s) from ${from} (${live} of cap ${c.laneCap} lanes live)`);
    }
  }
  if (lanes.every(([, l]) => l.status === 'MERGED')) acts.push('RUN COMPLETE: every lane merged — close out the records');
  return acts;
}

module.exports = {
  init, load, update, setLane, notice, snapshotLane, integrityBaseline, recordUsage, approve, setPaused, nextActions, placement, event, pauseFile,
  envLaneCap, capacityOf, measuredLanes, isWaitP4,
  STATUSES, ACTIVE, SEATS, DEFAULTS, RUNNER_OF,
};
