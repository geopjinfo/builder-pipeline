'use strict';
/**
 * Plan split — read a plan file (templates/orchestrator-plan.md), give every row a risk class, a level, a track and
 * a dispatch mode with a logged reason, group rows that share no owned file into lanes, order dependent rows inside
 * a lane, and return lanes.json. Pure: no git, no I/O beyond the caller handing in the text.
 *
 * RISK → LEVEL. Every row first gets a risk class by rule, with its reason (riskFor):
 *   high   — a flagged or path-inferred money, workflow, migration, platform, permission or cross-module trigger
 *   low    — record-only (flag or kind) with no production-source file
 *   medium — everything else, including a record-only row that touches production source
 * The level is derived from it — high → Full, medium → Standard, low → Micro. A plan's level hint may RAISE the
 * level, never lower it, and never changes the risk.
 *
 * LEVEL → TRACK (the playbook's tracks; a track is a floor):
 *   Full     → FULL, or PLATFORM when the row touches a platform path
 *   Standard → ADDITIVE; FIX for a fix row; RULINGS for a rulings row with no production-source file
 *   Micro    → SOLO (record-only: SOLO may never touch production source — playbook track rule 1)
 *   Small    → off unless `smallEnabled`; when on, FIX
 *
 * TRACK → DISPATCH (what the lane worker runs):
 *   SOLO              → solo   one agent, no pipeline — declared, never assumed
 *   Full level        → full   build-module-pipeline
 *   Standard / Small  → `standardPipeline`: full (default) or lite (build-module-lite, then the gate batch)
 *
 * HOT FILES are shared by many rows (the changelog, the manifest, the registry, generated contracts). They never
 * make two rows share a lane: the merge queue serialises them instead, one merge at a time.
 *
 * FAMILY REVIEW (experimental, REQ-801, REQ-802). `opts.familyReview = { state, accounts, writer }` gives every lane
 * a `secondReader` through scripts/lib/family-review.cjs. Absent or not active, the result is byte-identical.
 *
 * Path rules are the project's, from features.orchestrator in §16: `sourceRoots` (production source),
 * `riskPaths.{migration,platform,permission}` (globs), `modulePattern` (a regex whose one capture names the
 * module — two modules in one row, or a glob in the module position, is cross-module).
 */

const FULL_FLAGS = ['money', 'workflow', 'migration', 'platform', 'permission', 'cross-module'];
const KNOWN_FLAGS = [...FULL_FLAGS, 'record-only'];
const KINDS = ['build', 'fix', 'rulings', 'record'];
const LEVEL_RANK = { Micro: 1, Small: 2, Standard: 3, Full: 4 };
const TRACK_RANK = ['SOLO', 'RULINGS', 'FIX', 'ADDITIVE', 'FULL', 'PLATFORM'];
const DISPATCH_RANK = ['solo', 'lite', 'full'];
const LEVEL_OF_RISK = Object.freeze({ high: 'Full', medium: 'Standard', low: 'Micro' });

const familyReview = require('./family-review.cjs');

const DEFAULTS = Object.freeze({
  hot: ['CHANGELOG.md', 'package.json', 'package-lock.json', '.gitignore'],
  sourceRoots: ['src/'],
  riskPaths: { migration: [], platform: [], permission: [] },
  modulePattern: null,
  maxLanes: 2,
  smallEnabled: false,
  standardPipeline: 'full',
});

// ---------------------------------------------------------------------------------------------- globs
const norm = (p) => String(p).trim().replace(/\\/g, '/').replace(/^\.\//, '');
function globRe(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*';
      i++;
      if (glob[i + 1] === '/') i++;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}
const stem = (g) => {
  const i = g.search(/[*?]/);
  return i === -1 ? g : g.slice(0, i);
};
const isGlob = (g) => /[*?]/.test(g);

/** Could two path patterns name a common file? Conservative: when unsure, they overlap. */
function overlaps(a, b) {
  a = norm(a);
  b = norm(b);
  if (a === b) return true;
  if (!isGlob(a) && !isGlob(b)) return false;
  if (globRe(a).test(b) || globRe(b).test(a)) return true;
  if (isGlob(a) && isGlob(b)) {
    const sa = stem(a);
    const sb = stem(b);
    return sa.startsWith(sb) || sb.startsWith(sa);
  }
  const [g, lit] = isGlob(a) ? [a, b] : [b, a];
  return globRe(g).test(lit);
}

/** A row file is hot when a hot pattern covers it (a glob row file only when it equals the hot pattern). */
const isHot = (file, hot) => hot.some((h) => norm(h) === norm(file) || globRe(norm(h)).test(norm(file)));

/** Is `file` (a path or a glob) under one of `roots` (directory prefixes like `src/`, or globs)? */
function isUnder(file, roots) {
  const f = norm(file);
  return (roots || []).some((r) => {
    const root = norm(r);
    if (isGlob(root)) return overlaps(root, f);
    const dir = root.replace(/\/+$/, '');
    return f === dir || f.startsWith(`${dir}/`);
  });
}

// ---------------------------------------------------------------------------------------------- parse
function splitCells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}
const list = (cell) =>
  (cell || '')
    .split(/[;,]/)
    .map((s) => s.trim().replace(/^`|`$/g, ''))
    .filter((s) => s && s !== '-' && s !== '—');

/** Parse the plan: header `key: value` lines and the first table under `## Rows`. */
function parsePlan(text) {
  const lines = String(text).split(/\r?\n/);
  const meta = {};
  for (const l of lines) {
    const m = /^([a-z][a-z-]*):\s*(.+)$/.exec(l.trim());
    if (m && !l.trim().startsWith('|')) meta[m[1]] = m[2].trim();
  }
  const start = lines.findIndex((l) => /^##\s+Rows\b/i.test(l.trim()));
  if (start === -1) throw new Error('plan has no "## Rows" section');
  const table = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i].trim();
    if (/^##\s/.test(l)) break;
    if (l.startsWith('|')) table.push(l);
  }
  if (table.length < 2) throw new Error('"## Rows" has no table');
  const head = splitCells(table[0]).map((h) => h.toLowerCase());
  for (const n of ['id', 'title', 'kind', 'files', 'depends-on', 'flags']) {
    if (!head.includes(n)) throw new Error(`rows table lacks column "${n}" (have: ${head.join(', ')})`);
  }
  const rows = [];
  for (const l of table.slice(1)) {
    if (/^\|?\s*:?-{2,}/.test(l)) continue;
    const c = splitCells(l);
    const get = (k) => c[head.indexOf(k)] ?? '';
    const row = {
      id: get('id'),
      title: get('title'),
      source: head.includes('source') ? get('source') : '',
      kind: (get('kind') || 'build').toLowerCase(),
      files: list(get('files')).map(norm),
      dependsOn: list(get('depends-on')),
      flags: list(get('flags')).map((f) => f.toLowerCase()),
      levelHint: head.includes('level') ? (get('level') || '').trim() : '',
      confirm: head.includes('confirm') ? get('confirm') : '', // `orch digest` marks inferred cells here
    };
    if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(row.id)) throw new Error(`bad row id ${JSON.stringify(row.id)}`);
    if (!KINDS.includes(row.kind)) throw new Error(`${row.id}: kind "${row.kind}" not one of ${KINDS.join('|')}`);
    for (const f of row.flags) if (!KNOWN_FLAGS.includes(f)) throw new Error(`${row.id}: unknown flag "${f}" (known: ${KNOWN_FLAGS.join(', ')})`);
    if (!row.files.length) throw new Error(`${row.id}: no files listed — a row must name the files it touches`);
    rows.push(row);
  }
  const ids = new Set();
  for (const r of rows) {
    if (ids.has(r.id)) throw new Error(`duplicate row id ${r.id}`);
    ids.add(r.id);
  }
  return { meta, rows };
}

// ---------------------------------------------------------------------------------------------- level
const cfgOf = (opts = {}) => ({
  ...DEFAULTS,
  ...opts,
  riskPaths: { ...DEFAULTS.riskPaths, ...(opts.riskPaths || {}) },
});

function derivedFlags(files, opts) {
  const cfg = cfgOf(opts);
  const out = new Set();
  const mods = new Set();
  const moduleRe = cfg.modulePattern ? new RegExp(cfg.modulePattern) : null;
  for (const f of files) {
    for (const flag of ['migration', 'platform', 'permission']) {
      if ((cfg.riskPaths[flag] || []).some((p) => overlaps(p, f))) out.add(flag);
    }
    const m = moduleRe ? moduleRe.exec(f) : null;
    if (m && m[1] !== undefined) {
      if (isGlob(m[1])) out.add('cross-module');
      else mods.add(m[1]);
    }
  }
  if (mods.size > 1) out.add('cross-module');
  return out;
}

function riskFor(row, opts) {
  const cfg = cfgOf(opts);
  const touchesSrc = row.files.some((f) => isUnder(f, cfg.sourceRoots));
  const derived = derivedFlags(row.files, cfg);
  const flags = new Set([...row.flags, ...derived]);
  const full = FULL_FLAGS.filter((f) => flags.has(f));
  const recordOnly = flags.has('record-only') || row.kind === 'record';
  const triggers = full.map((f) => (derived.has(f) && !row.flags.includes(f) ? `${f} (from files)` : f)).join(', ');
  if (full.length) return { risk: 'high', riskReason: `high: ${triggers}`, flags, touchesSrc, recordOnly };
  if (recordOnly && !touchesSrc) return { risk: 'low', riskReason: 'low: record-only, no production-source file', flags, touchesSrc, recordOnly };
  return {
    risk: 'medium',
    riskReason: recordOnly ? 'medium: marked record-only but touches production source' : 'medium: no high trigger, not record-only',
    flags,
    touchesSrc,
    recordOnly,
  };
}

function levelReason({ risk, riskReason, recordOnly }) {
  if (risk === 'high') return `Full: ${riskReason.slice('high: '.length)}`;
  if (risk === 'low') return 'Micro: record-only, no production-source file';
  return recordOnly
    ? 'Standard: marked record-only but touches production source — SOLO may never touch production source (playbook track rule 1)'
    : 'Standard: no Full trigger, not record-only';
}

function dispatchFor(level, track, cfg) {
  if (track === 'SOLO') return 'solo';
  if (level === 'Full') return 'full';
  return cfg.standardPipeline === 'lite' ? 'lite' : 'full';
}

function levelFor(row, opts = {}) {
  const cfg = cfgOf(opts);
  const rk = riskFor(row, cfg);
  const { flags, touchesSrc } = rk;
  const reasons = [levelReason(rk)];
  let level = LEVEL_OF_RISK[rk.risk];
  const hint = row.levelHint && row.levelHint[0].toUpperCase() + row.levelHint.slice(1).toLowerCase();
  if (hint) {
    if (!LEVEL_RANK[hint]) throw new Error(`${row.id}: level hint "${row.levelHint}" not one of ${Object.keys(LEVEL_RANK).join('|')}`);
    if (hint === 'Small' && !cfg.smallEnabled) reasons.push('hint Small ignored: Small is off (features.orchestrator.smallEnabled)');
    else if (hint === 'Small' && level === 'Standard') {
      level = 'Small';
      reasons.push('Small: hint, Small enabled');
    } else if (LEVEL_RANK[hint] > LEVEL_RANK[level]) {
      reasons.push(`raised to ${hint} by plan hint (a level is a floor)`);
      level = hint;
    } else if (LEVEL_RANK[hint] < LEVEL_RANK[level]) reasons.push(`hint ${hint} ignored: a level is never lowered`);
  }
  let track;
  if (level === 'Full') track = flags.has('platform') ? 'PLATFORM' : 'FULL';
  else if (level === 'Micro') track = 'SOLO';
  else if (level === 'Small') track = 'FIX';
  else if (row.kind === 'fix') track = 'FIX';
  else if (row.kind === 'rulings' && !touchesSrc) track = 'RULINGS';
  else track = 'ADDITIVE';
  return { risk: rk.risk, riskReason: rk.riskReason, level, track, dispatch: dispatchFor(level, track, cfg), flags: [...flags].sort(), reason: reasons.join('; ') };
}

// ---------------------------------------------------------------------------------------------- split
/** The rows still carrying an inferred, unconfirmed cell (a digested plan). */
const openConfirms = (rows) => rows.filter((r) => (r.confirm && r.confirm.includes('⚠')) || r.files.includes('⚠ CONFIRM'));

function split(text, opts = {}) {
  const cfg = cfgOf(opts);
  const hot = cfg.hot.map(norm);
  const { meta, rows } = parsePlan(text);
  // a digested plan is never split while a row still carries an inferred, unconfirmed cell
  const open = openConfirms(rows);
  if (open.length) {
    throw new Error(`plan has ${open.length} row(s) still ⚠ CONFIRM: ${open.map((r) => r.id).join(', ')} — resolve each (search the project's sources, decide, record), clear its confirm cell, then get the human's OK`);
  }
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const r of rows) for (const d of r.dependsOn) if (!byId.has(d)) throw new Error(`${r.id}: depends-on ${d}, which is not a row`);

  for (const r of rows) {
    Object.assign(r, levelFor(r, cfg));
    r.hotFiles = r.files.filter((f) => isHot(f, hot));
    r.ownedFiles = r.files.filter((f) => !r.hotFiles.includes(f));
    r.score = LEVEL_RANK[r.level] * 10 + r.files.length;
  }

  // union-find: an owned-file overlap or a dependency puts two rows in the same lane
  const parent = new Map(rows.map((r) => [r.id, r.id]));
  const find = (x) => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x))), parent.get(x)));
  const joins = [];
  const union = (a, b, why) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
    joins.push({ a, b, why });
  };
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i];
      const b = rows[j];
      const shared = a.ownedFiles.filter((fa) => b.ownedFiles.some((fb) => overlaps(fa, fb)));
      if (shared.length) union(a.id, b.id, `share ${shared.join(', ')}`);
    }
  }
  for (const r of rows) for (const d of r.dependsOn) union(r.id, d, `${r.id} depends on ${d}`);

  const groups = new Map();
  for (const r of rows) {
    const k = find(r.id);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }

  // Kahn order inside each lane; plan order breaks ties
  const order = (members) => {
    const ids = new Set(members.map((m) => m.id));
    const indeg = new Map(members.map((m) => [m.id, m.dependsOn.filter((d) => ids.has(d)).length]));
    const out = [];
    const ready = members.filter((m) => indeg.get(m.id) === 0);
    while (ready.length) {
      const m = ready.shift();
      out.push(m);
      for (const n of members) {
        if (n.dependsOn.includes(m.id)) {
          indeg.set(n.id, indeg.get(n.id) - 1);
          if (indeg.get(n.id) === 0) ready.push(n);
        }
      }
    }
    if (out.length !== members.length) throw new Error(`dependency cycle among ${members.filter((m) => !out.includes(m)).map((m) => m.id).join(', ')}`);
    return out;
  };

  const uniq = (xs) => [...new Set(xs)];
  const lanes = [...groups.values()].map((members) => {
    const ordered = order(members);
    const level = ordered.reduce((acc, r) => (LEVEL_RANK[r.level] > LEVEL_RANK[acc] ? r.level : acc), 'Micro');
    const track = ordered.reduce((acc, r) => (TRACK_RANK.indexOf(r.track) > TRACK_RANK.indexOf(acc) ? r.track : acc), 'SOLO');
    const dispatch = ordered.reduce((acc, r) => (DISPATCH_RANK.indexOf(r.dispatch) > DISPATCH_RANK.indexOf(acc) ? r.dispatch : acc), 'solo');
    return {
      rows: ordered.map((r) => r.id),
      level,
      track,
      dispatch,
      ownedFiles: uniq(ordered.flatMap((r) => r.ownedFiles)),
      hotFiles: uniq(ordered.flatMap((r) => r.hotFiles)),
      score: ordered.reduce((s, r) => s + r.score, 0),
      why: joins.filter((j) => ordered.some((r) => r.id === j.a)).map((j) => `${j.a}+${j.b}: ${j.why}`),
    };
  });
  lanes.sort((a, b) => b.score - a.score || a.rows[0].localeCompare(b.rows[0]));
  lanes.forEach((l, i) => {
    l.name = `l${i + 1}`;
  });

  return familyReview.apply({
    plan: { title: meta.plan || meta.title || '', run: meta.run || '', source: meta.source || '' },
    maxLanes: cfg.maxLanes,
    smallEnabled: !!cfg.smallEnabled,
    rows: rows.map((r) => ({
      id: r.id,
      title: r.title,
      source: r.source,
      kind: r.kind,
      risk: r.risk,
      riskReason: r.riskReason,
      level: r.level,
      track: r.track,
      dispatch: r.dispatch,
      reason: r.reason,
      flags: r.flags,
      dependsOn: r.dependsOn,
      ownedFiles: r.ownedFiles,
      hotFiles: r.hotFiles,
      lane: lanes.find((l) => l.rows.includes(r.id)).name,
    })),
    lanes,
    hotFilesQueued: uniq(lanes.flatMap((l) => l.hotFiles)),
  }, opts.familyReview);
}

/** Owned-file overlaps between lanes — must be empty for a valid split. */
function laneOverlaps(lanes) {
  const out = [];
  for (let i = 0; i < lanes.length; i++) {
    for (let j = i + 1; j < lanes.length; j++) {
      for (const a of lanes[i].ownedFiles) for (const b of lanes[j].ownedFiles) if (overlaps(a, b)) out.push(`${lanes[i].name}:${a} ~ ${lanes[j].name}:${b}`);
    }
  }
  return out;
}

/**
 * The worker brief from the template (templates/orchestrator-worker-brief.md, installed as
 * specs/orchestrator-worker-brief.template.md): the fenced markdown body with the lane facts filled in — the run and
 * lane, level/track and dispatch, the rows table, the owned and hot files, worktree, branch, target, result and the
 * `Account:` line from the placement (REQ-502). A placeholder the lane cannot fill (the done-test, the tiers, the
 * records) stays as written for the orchestrator. No account → the `Account:` line keeps its placeholder, never an
 * empty name. Pure.
 */
function renderBrief(template, { run, lane, rows = [], target = null, account = null }) {
  const fence = /```markdown\r?\n([\s\S]*?)\r?\n```/.exec(String(template));
  let body = fence ? fence[1] : String(template);
  const byId = new Map((rows || []).map((r) => [r.id, r]));
  const rowLines = (lane.rows || []).map((id) => {
    const r = byId.get(id) || { id };
    return `| ${id} | ${r.title || '<title>'} | ${r.level || lane.level || '<level>'}/${r.track || lane.track || '<track>'} | ${r.reason || '<reason from lanes.json>'} |`;
  });
  if (rowLines.length) body = body.replace(/^\| <id> \| <title> \| <level>\/<track> \| <reason from lanes\.json> \|$/m, rowLines.join('\n'));
  const list = (a) => (Array.isArray(a) && a.length ? a.join(', ') : 'none');
  const subs = {
    '<run>': run, '<lane>': lane.name, '<level>': lane.level, '<track>': lane.track, '<full|lite|solo>': lane.dispatch,
    '<ownedFiles>': list(lane.ownedFiles), '<hotFiles>': list(lane.hotFiles),
    '<worktree>': lane.worktree, '<branch>': lane.branch, '<target>': target, '<result>': lane.result,
    ...(account && account.name ? { '<account>': account.name, '<worker>': account.worker || 'unknown', '<pays>': account.pays || 'unknown' } : {}),
  };
  for (const [k, v] of Object.entries(subs)) if (v !== null && v !== undefined && v !== '') body = body.split(k).join(String(v));
  return body.endsWith('\n') ? body : `${body}\n`;
}

module.exports = {
  split, parsePlan, renderBrief, levelFor, riskFor, derivedFlags, openConfirms, overlaps, isHot, isUnder, laneOverlaps, globRe, norm,
  DEFAULTS, FULL_FLAGS, KNOWN_FLAGS, KINDS, LEVEL_RANK, LEVEL_OF_RISK, TRACK_RANK,
};
