'use strict';
/**
 * Mechanical resolution of the hot ledger files at `orch merge` (features.orchestrator.mechanical; null = off, every
 * conflict stops as before).
 *
 * WHY. In one adopting project every sequential `orch merge` re-conflicted on the same few files: each lane bumps the
 * version, appends a CHANGELOG section, adds an API path or a ledger batch. The conflict is in WHERE the appends go,
 * never in what they say — and a person resolving it by hand, lane after lane, is where a section gets dropped. These
 * are resolved here from the three blobs (merge base, target = ours, lane = theirs):
 *
 *   semver     JSON manifests carrying a `version` (package.json, package-lock.json): 3-way structural merge, and
 *              `version` (with package-lock's packages[""].version) = resolveVersion — the lane's own bump kind
 *              applied to the target, or the lane's when it is already higher. The first file is the version source.
 *   changelog  union by `## <version>` section, newest first; the lane's section for its version is re-versioned,
 *              with a note line, when the version moved
 *   json       3-way structural JSON merge (a key both sides changed differently = not mechanical)
 *   union      line union (`git merge-file --union`) — for append-only ledgers only
 *
 * When both sides bumped the version, the semver and changelog files are resolved even where git merged them
 * "cleanly": two lanes that took the same next version would otherwise both keep it. Anything else, or a case above
 * that is not mechanical, stays a conflict and the caller names the exact set. The gates still run on the result.
 * Pure apart from `mergeFileUnion` (git merge-file on temp files).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const KINDS = Object.freeze(['semver', 'changelog', 'json', 'union']);

class NotMechanical extends Error {}

/** The configured files by kind, normalised: { semver: [], changelog: [], json: [], union: [] }. null → null (off). */
function rulesOf(mechanical) {
  if (!mechanical) return null;
  const out = {};
  for (const k of KINDS) out[k] = [...new Set((mechanical[k] || []).map((f) => String(f).replace(/\\/g, '/')))];
  return out;
}
const kindOf = (rules, f) => KINDS.find((k) => rules[k].includes(f)) || null;

// ------------------------------------------------------------------------------------------------ semver
const parseV = (v) => {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v || ''));
  return m ? m.slice(1, 4).map(Number) : null;
};
const cmpV = (a, b) => {
  const x = parseV(a);
  const y = parseV(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};
const bumpV = (v, kind) => {
  const [a, b, c] = parseV(v);
  return kind === 0 ? `${a + 1}.0.0` : kind === 1 ? `${a}.${b + 1}.0` : `${a}.${b}.${c + 1}`;
};
/** The component the lane bumped from the base: 0 major, 1 minor, 2 patch; null when it did not bump. */
const bumpKind = (base, theirs) => {
  const x = parseV(base);
  const y = parseV(theirs);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (y[i] > x[i]) return i;
  return null;
};

/** The merged version: the lane's when higher than the target; else the target bumped the way the lane bumped. */
function resolveVersion({ base, ours, theirs }) {
  if (!parseV(ours) || !parseV(theirs)) throw new NotMechanical('a version is not semver');
  if (cmpV(theirs, ours) > 0) return theirs;
  const kind = bumpKind(base, theirs);
  return kind === null ? ours : bumpV(ours, kind);
}

// -------------------------------------------------------------------------------------------------- JSON
// A key is always defined as an OWN property: a "__proto__" key in a merged file stays data, never a prototype.
const own = (o, k, v) => Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** 3-way structural merge; undefined = absent. Throws NotMechanical where both sides changed the same key differently. */
function merge3(b, o, t, at = '$') {
  if (same(o, t)) return o;
  if (same(b, o)) return t;
  if (same(b, t)) return o;
  if (isObj(o) && isObj(t) && (b === undefined || isObj(b))) {
    const out = {};
    for (const k of [...Object.keys(o), ...Object.keys(t).filter((k2) => !Object.prototype.hasOwnProperty.call(o, k2))]) {
      const v = merge3(b === undefined || !Object.prototype.hasOwnProperty.call(b, k) ? undefined : b[k], Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined, Object.prototype.hasOwnProperty.call(t, k) ? t[k] : undefined, `${at}.${k}`);
      if (v !== undefined) own(out, k, v);
    }
    return out;
  }
  throw new NotMechanical(`both sides changed ${at}`);
}

const indentOf = (text) => {
  const m = /\n([ \t]+)"/.exec(text);
  return m ? m[1] : 2;
};
const writeJson = (obj, like) => JSON.stringify(obj, null, indentOf(like)) + (like.endsWith('\n') ? '\n' : '');
const readJson = (text) => {
  try {
    return JSON.parse(text);
  } catch (_) {
    throw new NotMechanical('not valid JSON');
  }
};

function mergeVersioned(b, o, t, version) {
  const [B, O, T] = [b, o, t].map(readJson);
  const strip = (x) => {
    const y = JSON.parse(JSON.stringify(x));
    delete y.version;
    if (y.packages && y.packages['']) delete y.packages[''].version;
    return y;
  };
  const m = merge3(strip(B), strip(O), strip(T));
  const out = {};
  for (const k of Object.keys(O)) own(out, k, k === 'version' ? version : m[k]); // keep the target's key order
  for (const k of Object.keys(m)) if (!Object.prototype.hasOwnProperty.call(out, k)) own(out, k, m[k]);
  if (out.packages && out.packages['']) {
    const root = out.packages[''];
    out.packages[''] = { name: root.name, version, ...Object.fromEntries(Object.entries(root).filter(([k]) => k !== 'name' && k !== 'version')) };
  }
  return writeJson(out, o);
}

// --------------------------------------------------------------------------------------------- CHANGELOG
const SECTION = /^## \[?(\d+\.\d+\.\d+)\b/;
function sections(text) {
  const lines = String(text).split('\n');
  const first = lines.findIndex((l) => SECTION.test(l));
  if (first === -1) return { pre: text, secs: [] };
  const secs = [];
  for (let i = first; i < lines.length; i++) {
    if (SECTION.test(lines[i])) secs.push({ v: SECTION.exec(lines[i])[1], lines: [lines[i]] });
    else secs[secs.length - 1].lines.push(lines[i]);
  }
  return { pre: lines.slice(0, first).join('\n'), secs: secs.map((s) => ({ v: s.v, text: s.lines.join('\n').replace(/\n+$/, '') })) };
}

function mergeChangelog(b, o, t, { from, to }) {
  const [B, O, T] = [b, o, t].map(sections);
  const inBase = new Map(B.secs.map((s) => [s.v, s.text]));
  const out = O.secs.map((s) => ({ ...s }));
  for (const s of T.secs) {
    if (inBase.has(s.v)) {
      if (inBase.get(s.v) === s.text) continue; // untouched history
      const mine = out.find((x) => x.v === s.v);
      if (mine && mine.text !== inBase.get(s.v) && mine.text !== s.text) throw new NotMechanical(`both sides edited the ${s.v} section`);
      if (mine) mine.text = s.text;
      continue;
    }
    let sec = s;
    if (s.v === from && to !== from) {
      const [head, ...rest] = s.text.split('\n');
      sec = { v: to, text: [head.replace(s.v, to), '', `_Re-versioned from ${from} at merge (orch merge)._`, ...rest.filter((l, i) => !(i === 0 && l === ''))].join('\n') };
    }
    if (out.some((x) => x.v === sec.v)) throw new NotMechanical(`a ${sec.v} section on both sides`);
    out.push(sec);
  }
  out.sort((x, y) => cmpV(y.v, x.v));
  const trail = O.secs.length ? (String(o).endsWith('\n') ? '\n' : '') : '';
  return `${O.pre.replace(/\n*$/, '\n\n')}${out.map((s) => s.text).join('\n\n')}${trail}`;
}

// ------------------------------------------------------------------------------------------- line union
/** `git merge-file --union` on temp files. `gitBin` must be an absolute path (never a cwd-first bare name). */
function mergeFileUnion(b, o, t, { gitBin, spawn = spawnSync } = {}) {
  if (!gitBin) throw new NotMechanical('no git executable on an absolute PATH entry');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-union-'));
  const [fb, fo, ft] = ['base', 'ours', 'theirs'].map((n) => path.join(dir, n));
  fs.writeFileSync(fb, b);
  fs.writeFileSync(fo, o);
  fs.writeFileSync(ft, t);
  const r = spawn(gitBin, ['merge-file', '--union', '-p', fo, fb, ft], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  for (const x of [fb, fo, ft]) {
    try {
      fs.unlinkSync(x);
    } catch (_) {
      /* tmp */
    }
  }
  try {
    fs.rmdirSync(dir);
  } catch (_) {
    /* tmp */
  }
  // With --union every non-zero exit is an error (255 on POSIX): its stdout must never become the append-only ledger.
  if (r.status !== 0 || r.error) throw new NotMechanical(`git merge-file failed (exit ${r.status}): ${String(r.stderr || r.error || '').trim()}`);
  return r.stdout;
}

/**
 * Resolve the conflicted `files` given a reader `blob(side, file)` → text | null (side = 'base' | 'ours' | 'theirs').
 * `mechanical` is features.orchestrator.mechanical. Returns { resolved: { file: text }, unresolved: [{ file, why }] }.
 */
function resolve(conflicted, blob, mechanical, { gitBin = null, spawn } = {}) {
  const rules = rulesOf(mechanical);
  if (!rules) return { resolved: {}, unresolved: conflicted.map((file) => ({ file, why: 'mechanical resolution is off (features.orchestrator.mechanical)' })) };
  const resolved = {};
  const unresolved = [];
  let version = null;
  let from = null;
  let bothBumped = false;
  const tryIt = (f, fn) => {
    try {
      resolved[f] = fn();
    } catch (e) {
      if (!(e instanceof NotMechanical)) throw e;
      unresolved.push({ file: f, why: e.message });
    }
  };
  const versionFile = rules.semver[0];
  if (versionFile) {
    try {
      const [b, o, t] = ['base', 'ours', 'theirs'].map((s) => readJson(blob(s, versionFile)).version);
      version = resolveVersion({ base: b, ours: o, theirs: t });
      from = t;
      bothBumped = o !== b && t !== b;
    } catch (_) {
      version = null; // no version file (or no semver) on a side: no re-versioning
      from = null;
    }
  }
  const files = [...conflicted];
  if (bothBumped) for (const f of [...rules.semver, ...rules.changelog]) if (!files.includes(f) && blob('base', f) !== null) files.push(f);
  for (const f of files) {
    const kind = kindOf(rules, f);
    if (!kind) {
      unresolved.push({ file: f, why: 'not a mechanical file' });
      continue;
    }
    const o = blob('ours', f);
    const t = blob('theirs', f);
    const b0 = blob('base', f);
    const b = b0 === null ? (kind === 'semver' || kind === 'json' ? '{}' : '') : b0; // added on both sides: an empty base
    if (o === null || t === null) {
      unresolved.push({ file: f, why: 'absent on one side (modify/delete)' }); // never a crash
      continue;
    }
    if (kind === 'semver') {
      tryIt(f, () => {
        if (!version) throw new NotMechanical('no semver version');
        return mergeVersioned(b, o, t, version);
      });
    } else if (kind === 'changelog') tryIt(f, () => mergeChangelog(b, o, t, { from: from || '', to: version || from || '' }));
    else if (kind === 'json') tryIt(f, () => writeJson(merge3(readJson(b), readJson(o), readJson(t)), o));
    else tryIt(f, () => mergeFileUnion(b, o, t, { gitBin, spawn }));
  }
  return { resolved, unresolved };
}

module.exports = { KINDS, resolve, resolveVersion, merge3, mergeChangelog, mergeVersioned, mergeFileUnion, rulesOf, NotMechanical };
