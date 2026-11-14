/**
 * `npx builder run board-check-all` — every task board that carries a computed progress block must be fresh.
 * (folder layout: node scripts/board-check-all.mjs in place of npx builder run board-check-all)
 *
 * WHY THIS EXISTS. `board-progress.mjs` makes the bar a projection instead of a claim, but only for
 * the board somebody remembered to re-run. A stale bar is worse than no bar: it reports a number
 * that was true a week ago with the authority of a computed one. This walks every board and fails
 * the gate on any that has drifted.
 *
 * SCOPE IS DELIBERATELY OPT-IN. Only boards containing the `progress:auto` markers are checked.
 * Legacy flat boards written before the block existed neither fail nor need converting — a
 * closed board's progress bar signals nothing to anyone. New boards get the block; a legacy board
 * gains it when it reopens (see `tasks/README.md`).
 *
 * SECOND CHECK, SAME RULE. A board that also carries a run log publishes a rendered
 * run board (`tasks/<key>.html`). That page is a projection too, and it goes stale the same way —
 * an event lands after the last render and the page keeps reporting the earlier state with the
 * authority of a rendered document. So the rendered board must be no older than the newest of its
 * run log and its markdown. A board with no run log has nothing to be stale against and is skipped.
 *
 *   npx builder run board-check-all            check every marked board (exit 1 on any stale)
 *   npx builder run board-check-all --fix     rewrite every stale block, re-render every stale page
 *   npx builder run board-check-all --only <key>   <boards>/<key>.md alone (combines with --fix)
 */
import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const freshness = require('./lib/board-freshness.cjs');
const profile = require('./lib/profile.cjs');
const { projectRoot, runHint } = require('./lib/run-hint.cjs');

/**
 * The sibling scripts are found BESIDE this one, never under the working directory: installed as a package the
 * project has no scripts/ folder, and a cwd-relative spawn crashed on every board.
 */
const sibling = (name) => fileURLToPath(new URL(`./${name}`, import.meta.url));
const ROOT = projectRoot();
process.chdir(ROOT); // board paths below are printed and passed relative to the project
const CHILD = { encoding: 'utf8', cwd: ROOT, env: { ...process.env, BUILDER_PROJECT_ROOT: ROOT } };
const FIX_HINT = runHint('board-check-all', '--fix');

const MARKER = '<!-- progress:auto start -->';
/** The boards directory is §16 `paths.boards`; `tasks/` only when there is no profile to say otherwise. */
const DIR = profile.load(ROOT).settings.paths?.boards || 'tasks';

const fix = process.argv.includes('--fix');

if (!existsSync(DIR)) {
  console.error(`board-check-all: boards directory missing — paths.boards says ${JSON.stringify(DIR)}; nothing was checked.`);
  process.exit(1);
}

/**
 * `--only <key>` — check `<boards>/<key>.md` alone (the builder hand-back check): a run is
 * answerable for its own board, not for another lane's half-finished one.
 */
const onlyAt = process.argv.indexOf('--only');
const only = onlyAt === -1 ? null : process.argv[onlyAt + 1];
if (onlyAt !== -1 && (!only || only.startsWith('--'))) {
  console.error(`usage: ${runHint('board-check-all')} [--fix] [--only <key>]`);
  process.exit(2);
}
const isBoard = (f) =>
  f.endsWith('.md') && !f.startsWith('_') && f !== 'README.md' && (only === null || f === `${only}.md`);

if (only !== null && !existsSync(join(DIR, `${only}.md`))) {
  console.error(`board-check-all: no board ${DIR}/${only}.md.`);
  process.exit(1);
}

const boards = readdirSync(DIR)
  /**
   * `_template.md` carries the markers as a shape to copy, with no rows to count; `README.md`
   * documents the format and quotes the markers inside a fence. Neither is a board — counting
   * them writes a fabricated bar into documentation, which is the exact defect this file exists
   * to stop.
   */
  .filter(isBoard)
  .map((f) => join(DIR, f).replace(/\\/g, '/'))
  .filter((p) => readFileSync(p, 'utf8').includes(MARKER));

if (boards.length === 0 && only === null) {
  console.error(`board-check-all: no board under ${DIR}/ carries a ${MARKER} block.`);
  process.exit(1);
}

const stale = [];
for (const board of boards) {
  const args = [sibling('board-progress.mjs'), board];
  if (!fix) args.push('--check');
  const run = spawnSync(process.execPath, args, CHILD);
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
  .filter(isBoard)
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
    const run = spawnSync(process.execPath, [sibling('board-render.mjs'), board], CHILD);
    if (run.status === 0) {
      console.log(`fixed ${board.padEnd(34)} re-rendered`);
      continue;
    }
    if (run.stderr) process.stderr.write(run.stderr);
  }
  staleRenders.push({ board, reason: v.reason });
  console.log(`STALE ${board.padEnd(34)} ${v.reason}`);
}

/**
 * Under --fix a board or page that could NOT be rewritten is still stale: a child that failed (a missing script, a
 * board it cannot parse) fails the run. Printing PASS after a crashed child was a false green.
 */
if (fix && (stale.length > 0 || staleRenders.length > 0)) {
  console.error(`\nboard-check-all: FAIL — --fix could not rewrite ${[...stale, ...staleRenders.map((s) => s.board)].join(', ')}; see the errors above.`);
  process.exit(1);
}

if (staleRenders.length > 0 && !fix) {
  console.error(
    `
board-check-all: FAIL — ${staleRenders.length} rendered run board(s) stale.
` +
      `Run \`${FIX_HINT}\`, then commit the re-rendered pages.`,
  );
  process.exit(1);
}

if (stale.length > 0 && !fix) {
  console.error(
    `\nboard-check-all: FAIL — ${stale.length} of ${boards.length} board(s) stale.\n` +
      `Run \`${FIX_HINT}\`, then commit the recomputed blocks.`,
  );
  process.exit(1);
}

console.log(
  only === null
    ? `\nboard-check-all: PASS — ${boards.length} board(s) checked${fix ? ' (rewritten where stale)' : ''}.`
    : `\nboard-check-all: PASS — ${DIR}/${only}.md (progress block ${boards.length ? 'fresh' : 'absent'}; rendered board fresh or not applicable)${fix ? ' (rewritten where stale)' : ''}.`,
);
