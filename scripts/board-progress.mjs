/**
 * `node scripts/board-progress.mjs <board>` — recompute the progress block at the top of a task board.
 *
 * WHY THIS EXISTS. A hand-maintained progress bar is a claim nobody re-derives: the rows move and
 * the bar does not, and the board then reports a number that was true a week ago. The bar is not
 * an input — it is a projection of the Status column, so it is computed, never typed.
 *
 * It reads the board's counted sections (`## B<n> — …` batches on a delivery board, `## P<n> — …`
 * phases on a per-module build board), counts each row's Status cell, and rewrites ONLY the block
 * between the `progress:auto` markers. Nothing else in the file is touched.
 *
 *   node scripts/board-progress.mjs <path>          rewrite the block
 *   node scripts/board-progress.mjs <path> --check  exit 1 if the block is stale (CI-friendly)
 *
 * No path is a usage error (exit 2): there is no default board to fall back on, and guessing one
 * would rewrite whichever file happened to match.
 *
 * A row counts as SETTLED when its status is DONE, DROPPED or DEFERRED→<id> — the three ways the
 * board format lets a row legitimately end. PLANNED, IN-PROGRESS and PROPOSED (a drafted ruling
 * awaiting the lead) are all open; a proposal is not a decision.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import boardRows from './lib/board-rows.cjs';
const { ROW_ID, stripAnnotation, isDecorativeCell , normalizeStatus } = boardRows;

const START = '<!-- progress:auto start -->';
const END = '<!-- progress:auto end -->';
const BAR_WIDTH = 20;

/** A `|` escaped as `\|` sits INSIDE a cell (e.g. `activate\|deactivate`); it is not a boundary. */
const CELL = /(?<!\\)\|/;

const SETTLED = /^(DONE|DROPPED|DEFERRED→)/;
const DOING = /^IN-PROGRESS/;
/** Rows whose first cell looks like an id the board format does not know. Reported, not counted. */
const unrecognised = [];

const USAGE = [
  'usage: node scripts/board-progress.mjs <board.md>          rewrite the progress block',
  '       node scripts/board-progress.mjs <board.md> --check  exit 1 if the block is stale',
].join('\n');

const args = process.argv.slice(2);
const check = args.includes('--check');
const file = args.find((a) => !a.startsWith('--'));
if (!file) {
  console.error(USAGE);
  process.exit(2);
}

const source = readFileSync(file, 'utf8');
const eol = source.includes('\r\n') ? '\r\n' : '\n';
const lines = source.split(/\r?\n/);

const cells = (line) =>
  line
    .split(CELL)
    .slice(1, -1)
    .map((c) => c.trim().replace(/\\\|/g, '|'));

/**
 * A counted section is `## <ID> — <title>`, where `<ID>` is `B<n>` on a cross-module delivery board
 * (batch = branch = one pipeline run) or `P<n>` on a per-module build board (phase = pipeline seat).
 * Everything else (`## Plan on a page`, `## Deferred this cycle`) is prose and is not counted.
 */
const batches = [];
let current = null;
let statusColumn = -1;

for (const line of lines) {
  const heading = /^##\s+([BP]\d+)\s+—\s+(.+?)(?:\s+·.*)?$/.exec(line);
  if (heading) {
    current = { id: heading[1], title: heading[2].trim(), settled: 0, doing: 0, total: 0 };
    batches.push(current);
    statusColumn = -1;
    continue;
  }
  if (/^##\s/.test(line)) {
    current = null;
    continue;
  }
  if (!current || !line.startsWith('|')) continue;

  const row = cells(line);
  const headerIndex = row.findIndex((c) => c === 'Status');
  if (headerIndex !== -1) {
    statusColumn = headerIndex;
    continue;
  }
  if (statusColumn === -1) continue;
  if (!ROW_ID.test(stripAnnotation(row[0] ?? ''))) {
    /**
     * An unrecognised id is REPORTED, never silently skipped.
     *
     * This loop used to `continue` on any first cell the pattern did not match, so a row filed
     * under an id outside the known set was dropped from every count while the table still showed
     * it. The board then read "7/7" over nine rows and `board-check-all.mjs` passed, because a stale
     * block and a block that never counted those rows are indistinguishable from the outside.
     *
     * It has happened in practice both ways: rows filed under an ad-hoc id, and a batch heading
     * whose shape the section regex did not match, taking its whole section with it. Both were the
     * orchestrator's naming, and neither was visible in any output.
     *
     * **When an id is also an index, "unrecognised" and "absent" look the same.** So say so: a
     * table row whose first cell is non-empty, is not the header, and is not a known id is almost
     * always a real row with a wrong name, not a decorative line.
     */
    if (!isDecorativeCell(row[0])) unrecognised.push({ batch: current.id, id: (row[0] ?? '').trim() });
    continue;
  }

  const status = normalizeStatus(row[statusColumn]);
  current.total += 1;
  if (SETTLED.test(status)) current.settled += 1;
  else if (DOING.test(status)) current.doing += 1;
}

if (unrecognised.length > 0) {
  console.error(`board-progress: ${unrecognised.length} table row(s) carry an id this format does not recognise, so they are counted NOWHERE:`);
  for (const u of unrecognised) console.error(`  ${u.batch ?? '(no batch)'}: "${u.id}"  — expected T<n> / C<n> / D<n> / FIX-<n> / IC-<n>`);
  console.error('Rename them, or widen ROW_ID deliberately. A row that counts nowhere is worse than a row that counts wrong.');
  process.exit(1);
}

if (batches.length === 0) {
  console.error(`board-progress: no "## B<n> — …" or "## P<n> — …" sections found in ${file}`);
  process.exit(1);
}

const bar = (settled, total) => {
  const filled = total === 0 ? 0 : Math.round((settled / total) * BAR_WIDTH);
  return '▓'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled);
};
const pct = (settled, total) => (total === 0 ? 0 : Math.round((settled / total) * 100));

const rows = batches.map(
  (b) =>
    `| ${b.id} — ${b.title} | \`${bar(b.settled, b.total)}\` ${pct(b.settled, b.total)}% | ${b.settled} | ${b.doing} | ${b.total} |`,
);
const sum = batches.reduce(
  (a, b) => ({ settled: a.settled + b.settled, doing: a.doing + b.doing, total: a.total + b.total }),
  { settled: 0, doing: 0, total: 0 },
);

const block = [
  START,
  '| Batch | Progress | Done | Doing | Total |',
  '|---|---|---|---|---|',
  ...rows,
  `| **TOTAL** | \`${bar(sum.settled, sum.total)}\` **${pct(sum.settled, sum.total)}%** | **${sum.settled}** | **${sum.doing}** | **${sum.total}** |`,
  END,
].join(eol);

const startAt = source.indexOf(START);
const endAt = source.indexOf(END);
if (startAt === -1 || endAt === -1) {
  console.error(`board-progress: ${file} has no ${START} / ${END} markers`);
  process.exit(1);
}
const next = source.slice(0, startAt) + block + source.slice(endAt + END.length);

for (const b of batches) {
  console.log(`${b.id.padEnd(3)} ${String(pct(b.settled, b.total)).padStart(3)}%  ${b.settled}/${b.total} settled${b.doing ? `, ${b.doing} in progress` : ''}  — ${b.title}`);
}

/**
 * Hint, not a number: if this board also exists in another git worktree, the totals above count only
 * THIS checkout and are routinely behind.
 *
 * The hint is printed rather than written, and it carries no figures. Copying another checkout's
 * counts into this file would make a tracked ledger claim work its own commit does not contain —
 * exactly the unearned-status defect this script exists to prevent. So the file stays truthful about
 * what has merged, and the operator gets told where the rest is.
 */
try {
  const { execFileSync } = await import('node:child_process');
  const { existsSync } = await import('node:fs');
  const { join, resolve } = await import('node:path');
  const others = execFileSync('git', ['worktree', 'list', '--porcelain'], { encoding: 'utf8' })
    .split(/\r?\n/)
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length).trim())
    .filter((d) => resolve(d) !== resolve(process.cwd()) && existsSync(join(d, file)));
  if (others.length > 0) {
    console.log(
      `\nNOTE: ${others.length} other checkout(s) also hold ${file} — these totals count THIS one only.`,
    );
  }
} catch {
  /* worktree discovery is a convenience; never fail the gate on it */
}
console.log(`TOTAL ${pct(sum.settled, sum.total)}%  ${sum.settled}/${sum.total}`);

if (next === source) {
  console.log(`${file} is up to date.`);
  process.exit(0);
}
if (check) {
  console.error(
    `board-progress: ${file} progress block is STALE — run \`node scripts/board-progress.mjs ${file}\`.`,
  );
  process.exit(1);
}
writeFileSync(file, next);
console.log(`${file} progress block rewritten.`);
