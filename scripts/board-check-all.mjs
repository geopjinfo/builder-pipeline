/**
 * `npm run board:check-all` — every task board that carries a computed progress block must be fresh.
 *
 * WHY THIS EXISTS. `board-progress.mjs` makes the bar a projection instead of a claim, but only for
 * the board somebody remembered to re-run. A stale bar is worse than no bar: it reports a number
 * that was true a week ago with the authority of a computed one. This walks every board and fails
 * the gate on any that has drifted.
 *
 * SCOPE IS DELIBERATELY OPT-IN. Only boards containing the `progress:auto` markers are checked.
 * The ~30 legacy flat boards (`tasks/prj_6.md` and friends) neither fail nor need converting — a
 * closed board's progress bar signals nothing to anyone. New boards get the block; a legacy board
 * gains it when it reopens (see `tasks/README.md`).
 *
 * SECOND CHECK, SAME RULE (2026-08-28). A board that also carries a run log publishes a rendered
 * run board (`tasks/<key>.html`). That page is a projection too, and it goes stale the same way —
 * an event lands after the last render and the page keeps reporting the earlier state with the
 * authority of a rendered document. So the rendered board must be no older than the newest of its
 * run log and its markdown. A board with no run log has nothing to be stale against and is skipped.
 *
 *   node scripts/board-check-all.mjs           check every marked board (exit 1 on any stale)
 *   node scripts/board-check-all.mjs --fix     rewrite every stale block, re-render every stale page
 */
import { createRequire } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const freshness = require('./lib/board-freshness.cjs');

const MARKER = '<!-- progress:auto start -->';
const DIR = 'tasks';

const fix = process.argv.includes('--fix');

const boards = readdirSync(DIR)
  /**
   * `_template.md` carries the markers as a shape to copy, with no rows to count; `README.md`
   * documents the format and quotes the markers inside a fence. Neither is a board — counting
   * them writes a fabricated bar into documentation, which is the exact defect this file exists
   * to stop.
   */
  .filter((f) => f.endsWith('.md') && !f.startsWith('_') && f !== 'README.md')
  .map((f) => join(DIR, f).replace(/\\/g, '/'))
  .filter((p) => readFileSync(p, 'utf8').includes(MARKER));

if (boards.length === 0) {
  console.error(`board-check-all: no board under ${DIR}/ carries a ${MARKER} block.`);
  process.exit(1);
}

const stale = [];
for (const board of boards) {
  const args = ['scripts/board-progress.mjs', board];
  if (!fix) args.push('--check');
  const run = spawnSync(process.execPath, args, { encoding: 'utf8' });
  const label = board.padEnd(34);
  if (run.status === 0) {
    console.log(`ok    ${label} ${(run.stdout ?? '').trim().split('\n').pop() ?? ''}`);
  } else {
    stale.push(board);
    console.log(`STALE ${label}`);
    if (run.stderr) process.stderr.write(run.stderr);
  }
}

/**
 * The rendered run boards. Checked over EVERY board, not only the ones carrying a progress block:
 * the two opt-ins are independent — a board can have a run log and no computed bar.
 */
const allBoards = readdirSync(DIR)
  .filter((f) => f.endsWith('.md') && !f.startsWith('_') && f !== 'README.md')
  .map((f) => join(DIR, f).replace(/\\/g, '/'));

const staleRenders = [];
for (const board of allBoards) {
  const v = freshness.verdict(board);
  if (!v.applicable) continue;
  if (!v.stale) {
    console.log(`ok    ${board.padEnd(34)} rendered board fresh`);
    continue;
  }
  if (fix) {
    const run = spawnSync(process.execPath, ['scripts/board-render.mjs', board], { encoding: 'utf8' });
    if (run.status === 0) {
      console.log(`fixed ${board.padEnd(34)} re-rendered`);
      continue;
    }
    if (run.stderr) process.stderr.write(run.stderr);
  }
  staleRenders.push({ board, reason: v.reason });
  console.log(`STALE ${board.padEnd(34)} ${v.reason}`);
}

if (staleRenders.length > 0 && !fix) {
  console.error(
    `
board-check-all: FAIL — ${staleRenders.length} rendered run board(s) stale.
` +
      `Run \`npm run board:check-all -- --fix\`, then commit the re-rendered pages.`,
  );
  process.exit(1);
}

if (stale.length > 0 && !fix) {
  console.error(
    `\nboard-check-all: FAIL — ${stale.length} of ${boards.length} board(s) stale.\n` +
      `Run \`npm run board:check-all -- --fix\`, then commit the recomputed blocks.`,
  );
  process.exit(1);
}

console.log(
  `\nboard-check-all: PASS — ${boards.length} board(s) checked${fix ? ' (rewritten where stale)' : ''}.`,
);
