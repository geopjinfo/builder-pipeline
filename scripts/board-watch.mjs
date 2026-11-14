/**
 * `npx builder run board-watch` — keep every rendered run board current while a run is happening.
 * (folder layout: node scripts/board-watch.mjs in place of npx builder run board-watch)
 *
 * WHY THIS EXISTS. A page that is only fresh when somebody remembers to render it is a page that is
 * usually stale, and the freshness gate would then be failing runs for a forgotten chore rather than
 * for a defect. Worse, a stale board is silent about being stale — it shows an earlier state of the
 * run with the full authority of a rendered document. So the run drives the page: the watcher is
 * started once, at the start of a run, and nobody types a render command again.
 *
 * WHAT IT WATCHES. The `tasks` directory and every run log under `.pipeline`. The run log is one
 * half; the board file is the point of the whole design — **a coder flipping a row to `IN-PROGRESS` is
 * already a write to the markdown board**, so the timeline moves without any seat emitting anything
 * extra, and without a new instruction anybody can forget.
 *
 * WHAT IT DOES NOT DO. It does not rewrite the markdown, does not touch the run log, and never
 * fails a run — a watcher that can break the build is a liability, so every error is reported and
 * swallowed. It renders only boards the freshness check calls stale, so a sweep over an idle repo
 * writes nothing at all.
 *
 *   npx builder run board-watch                  watch until stopped (the pipeline runs this)
 *   npx builder run board-watch --once          one sweep, then exit (what the tests drive)
 *   npx builder run board-watch --interval 30   also sweep on a timer, seconds (default 20)
 *   npx builder run board-watch --root <dir>    a repo root other than the cwd (tests, worktrees)
 */
import { createRequire } from 'node:module';
import { existsSync, readdirSync, watch } from 'node:fs';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const freshness = require('./lib/board-freshness.cjs');
const { renderBoard } = await import('./board-render.mjs');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};

const root = resolve(flag('root', process.cwd()));
const once = args.includes('--once');
const intervalMs = Math.max(5, Number(flag('interval', '20'))) * 1000;
const profile = require('./lib/profile.cjs');
const tasksDir = join(root, profile.load(root).settings.paths?.boards || 'tasks'); // §16 paths.boards
const pipelineDir = join(root, '.pipeline');

const boards = () =>
  existsSync(tasksDir)
    ? readdirSync(tasksDir)
        .filter((f) => f.endsWith('.md') && !f.startsWith('_') && f !== 'README.md')
        .map((f) => join(tasksDir, f))
    : [];

/**
 * One sweep. Renders exactly the stale boards and says which — silence about what changed is how a
 * watcher that has quietly died looks identical to a run where nothing happened.
 */
function sweep() {
  const rendered = [];
  for (const board of boards()) {
    let verdict;
    try {
      verdict = freshness.verdict(board);
    } catch (error) {
      console.error(`board-watch: cannot check ${board} — ${error.message}`);
      continue;
    }
    if (!verdict.applicable || !verdict.stale) continue;
    try {
      renderBoard(board);
      rendered.push(board);
    } catch (error) {
      /** Never fatal. A watcher that can break a run is worse than a board that lags a minute. */
      console.error(`board-watch: render failed for ${board} — ${error.message}`);
    }
  }
  const stamp = new Date().toISOString().slice(11, 19);
  if (rendered.length === 0) console.log(`${stamp} board-watch: nothing to render — 0 board(s) stale.`);
  else console.log(`${stamp} board-watch: rendered ${rendered.length} — ${rendered.join(', ')}`);
  return rendered;
}

sweep();
if (once) process.exit(0);

/** Debounced: an editor writing a file can fire several events for one save. */
let pending = null;
const schedule = () => {
  if (pending) clearTimeout(pending);
  pending = setTimeout(() => {
    pending = null;
    sweep();
  }, 400);
};

for (const dir of [tasksDir, pipelineDir]) {
  if (!existsSync(dir)) continue;
  try {
    watch(dir, { recursive: true }, schedule);
  } catch {
    /** Recursive watch is unsupported on some platforms; the interval sweep below still covers it. */
    try {
      watch(dir, schedule);
    } catch (error) {
      console.error(`board-watch: cannot watch ${dir} — ${error.message}`);
    }
  }
}

/** The timer is the safety net, not the mechanism: it catches whatever the watcher missed. */
setInterval(sweep, intervalMs);

console.log(
  `board-watch: watching ${tasksDir} and .pipeline/ under ${root} — sweeping every ${intervalMs / 1000}s. Ctrl-C to stop.`,
);
