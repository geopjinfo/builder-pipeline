'use strict';
/**
 * Claims — each lane claims its files before launch; an overlapping claim by another live lane is REFUSED.
 *
 * WHY. Two writers on one file in two worktrees always end in a merge conflict, and the second one to merge pays
 * for both. The split already keeps a plan's own lanes disjoint; the claims file keeps lanes of DIFFERENT runs (and
 * a second orchestrator session) disjoint too. One store-wide claims.json, written under its own lock.
 *
 * Hot files are recorded as shared (never refused): the merge queue serialises them instead.
 */
const path = require('path');
const { readJson, writeJsonAtomic, withLock } = require('./orch-store.cjs');
const { overlaps } = require('./orch-plan.cjs');

const file = (root) => path.join(root, 'claims.json');
const lock = (root) => path.join(root, 'claims.lock');
const load = (root) => readJson(file(root), { claims: [] });

/** Claim `owned` (exclusive) and `hot` (shared) files for run/lane. Returns { ok, conflicts }. */
function claim(root, { runId, lane, owned = [], hot = [] }) {
  return withLock(lock(root), () => {
    const db = load(root);
    const others = db.claims.filter((c) => !c.hot && !(c.runId === runId && c.lane === lane));
    const conflicts = [];
    for (const f of owned) for (const c of others) if (overlaps(f, c.pattern)) conflicts.push({ file: f, heldBy: `${c.runId}/${c.lane}`, pattern: c.pattern });
    if (conflicts.length) return { ok: false, conflicts };
    db.claims = db.claims.filter((c) => !(c.runId === runId && c.lane === lane));
    const at = new Date().toISOString();
    for (const f of owned) db.claims.push({ runId, lane, pattern: f, hot: false, at });
    for (const f of hot) db.claims.push({ runId, lane, pattern: f, hot: true, at });
    writeJsonAtomic(file(root), db);
    return { ok: true, conflicts: [] };
  });
}

/** Release a lane's claims (or every claim of the run when `lane` is undefined). Returns how many were removed. */
function release(root, { runId, lane }) {
  return withLock(lock(root), () => {
    const db = load(root);
    const before = db.claims.length;
    db.claims = db.claims.filter((c) => !(c.runId === runId && (lane === undefined || c.lane === lane)));
    writeJsonAtomic(file(root), db);
    return before - db.claims.length;
  });
}

const list = (root) => load(root).claims;

module.exports = { claim, release, list };
