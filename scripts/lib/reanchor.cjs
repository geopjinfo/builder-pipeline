'use strict';
/**
 * What a compacted orchestrator must re-read before its next dispatch, and where — `features.reanchor`.
 *
 * WHY THIS EXISTS. The playbook's rule after any compaction is "re-read (1) state.md, (2) the board's phase:status
 * block, (3) the open FIX-n rows — never reconstruct a run from scrollback". A summary written by a model may drop
 * the paths, or paraphrase a FIX row into a different fix. This reads the files themselves and prints the paths, the
 * `Now:` line and the open FIX rows verbatim. No model call, no judgement: it only points, the orchestrator still
 * reads the files.
 *
 * WHICH RUNS. Every `<runs>/<key>/state.md`, newest first, skipping a run whose board has no open row and every
 * phase settled. At most `maxRuns` are printed, so a repo with old runs on disk does not flood the context.
 *
 * Pure over an injected `fsLike` so the tests hold fixtures; `defaultFs` is the only filesystem access.
 */
const fs = require('node:fs');
const path = require('node:path');
const { parseBoard } = require('./board-parse.cjs');

const SETTLED = /^(DONE|DROPPED|DEFERRED→)/;
const posix = (p) => p.split('\\').join('/');

const defaultFs = {
  list: (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir) : []),
  read: (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null),
  mtime: (file) => fs.statSync(file).mtimeMs,
};

/** `| FIX-n | … | <status> |` lines of a state file's open-FIX table whose last filled cell is not settled. */
function openFixLinesOfState(source) {
  return source
    .split(/\r?\n/)
    .filter((l) => /^\|\s*FIX-(?:\d+|[A-Z])\s*\|/.test(l))
    .filter((l) => {
      const cells = l.split('|').slice(1, -1).map((c) => c.trim());
      return !SETTLED.test(cells[cells.length - 1] ?? '');
    })
    .map((l) => l.trim());
}

/** The board's own open FIX rows, as their source lines. */
function openFixLinesOfBoard(board) {
  const ids = new Set(board.sections.flatMap((s) => s.rows).filter((r) => r.id.startsWith('FIX-') && r.state !== 'settled').map((r) => r.id));
  return board.source
    .split(/\r?\n/)
    .filter((l) => {
      const m = /^\|\s*(FIX-(?:\d+|[A-Z]))\b/.exec(l);
      return m && ids.has(m[1]);
    })
    .map((l) => l.trim());
}

/**
 * @param {{ root: string, settings: object, fsLike?: typeof defaultFs }} opts
 * @returns {{ runs: Array<{ key: string, state: string, board: string | null, now: string | null, phase: string | null, fix: string[] }> }}
 */
function collect({ root, settings, fsLike = defaultFs }) {
  const runsDir = settings?.paths?.runs ?? '.pipeline';
  const boardsDir = settings?.paths?.boards ?? 'tasks';
  const maxRuns = settings?.features?.reanchor?.maxRuns ?? 2;
  const found = [];
  for (const key of fsLike.list(path.join(root, runsDir))) {
    const statePath = path.join(root, runsDir, key, 'state.md');
    const state = fsLike.read(statePath);
    if (state === null) continue;
    const boardRel = posix(path.join(boardsDir, `${key}.md`));
    const boardSource = fsLike.read(path.join(root, boardRel));
    const board = boardSource === null ? null : parseBoard(boardSource);
    const stateFix = openFixLinesOfState(state);
    const boardFix = board ? openFixLinesOfBoard(board) : [];
    const openPhase = board?.phases.find((p) => !SETTLED.test(p.status)) ?? null;
    const openRows = board ? board.totals.total - board.totals.settled : 0;
    if (board && !openPhase && openRows === 0 && stateFix.length === 0) continue; // finished run
    const seen = new Set(stateFix.map((l) => /FIX-(?:\d+|[A-Z])/.exec(l)[0]));
    found.push({
      key,
      mtime: fsLike.mtime(statePath),
      state: posix(path.join(runsDir, key, 'state.md')),
      board: board ? boardRel : null,
      now: (/^\*\*Now:\*\*\s*(.+)$/m.exec(state) ?? [])[1]?.trim() ?? null,
      phase: openPhase ? `${openPhase.phase} · ${openPhase.status}` : null,
      fix: [...stateFix, ...boardFix.filter((l) => !seen.has(/FIX-(?:\d+|[A-Z])/.exec(l)[0]))],
    });
  }
  found.sort((a, b) => b.mtime - a.mtime);
  return { runs: found.slice(0, maxRuns).map(({ mtime, ...r }) => r) };
}

/** The text the hook hands back to the session. Empty string when there is no run in flight. */
function render({ runs }) {
  if (runs.length === 0) return '';
  const out = ['Context was compacted. Before the next dispatch, re-read these files in order — do not rebuild the run from the summary:'];
  for (const r of runs) {
    out.push('', `Run ${r.key}`);
    out.push(`  1. ${r.state}${r.now ? `  (Now: ${r.now})` : ''}`);
    out.push(`  2. ${r.board ?? '(no board found)'} — phase:status block${r.phase ? `; first open phase: ${r.phase}` : ''}`);
    out.push(`  3. open FIX rows: ${r.fix.length === 0 ? 'none' : ''}`);
    for (const line of r.fix) out.push(`     ${line}`);
  }
  return out.join('\n');
}

module.exports = { collect, render, openFixLinesOfState, openFixLinesOfBoard };
