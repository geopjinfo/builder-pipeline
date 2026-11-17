/**
 * FIX rows and the fix-of-fix rate, per board and in total. Rule: scripts/lib/fix-rate.cjs.
 *
 *   npx builder-pipeline run fix-rate                      every board in paths.boards (files named _*.md and README.md skipped)
 *   npx builder-pipeline run fix-rate <board.md> …        exactly these boards
 *   --json                                        machine-readable totals
 * (folder layout: node scripts/fix-rate.mjs in place of npx builder-pipeline run fix-rate)
 *
 * Settings: paths.boards · features.fixLane.state. The lane ships off (2.0.0, REQ-1403); switched to `unmeasured` it is on
 * and this report says so on its first line; off → "fixLane: not configured", exit 0.
 *
 * Exit 0 report printed · 3 the lane is on but no board has a FIX row (unmeasured, never a pass; REQ-1403) · 2 no boards
 * directory, or an invalid profile.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { runHint } = require('./lib/run-hint.cjs');
const { fixOfFix } = require('./lib/fix-rate.cjs');
const profile = require('./lib/profile.cjs');

const loaded = profile.load(process.cwd());
if (loaded.errors.length > 0) {
  console.error(`fix-rate: PIPELINE_PROFILE.md is invalid — run ${runHint('features')}`);
  for (const e of loaded.errors) console.error(`  ${e}`);
  process.exit(2);
}
const feature = profile.feature(loaded.settings, 'fixLane');
if (!feature.enabled) {
  console.log(feature.line);
  process.exit(0);
}
const dir = loaded.settings.paths.boards;

const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (files.length === 0 && !existsSync(dir)) {
  console.error(`fix-rate: no boards directory ${dir}`);
  process.exit(2);
}
const boards = files.length
  ? files
  : readdirSync(dir)
      .filter((f) => f.endsWith('.md') && !f.startsWith('_') && f !== 'README.md')
      .sort()
      .map((f) => join(dir, f));

let total = 0;
let loops = 0;
const rows = [];
for (const board of boards) {
  const r = fixOfFix(readFileSync(board, 'utf8'));
  if (r.total === 0) continue;
  total += r.total;
  loops += r.fixOfFix;
  rows.push({ board: board.replace(/\\/g, '/'), ...r });
}
// REQ-1403: no FIX row is no measurement. The rate is not printed (a 0.0% would read as a pass) and the exit code is the
// not-configured code, 3: the lane was on, nothing was measured.
if (total === 0) {
  const line = `fixLane: unmeasured — no FIX row in ${boards.length} board(s); the fix-of-fix rate was not measured`;
  console.log(process.argv.includes('--json') ? JSON.stringify({ feature: feature.line, total: 0, fixOfFix: 0, rate: null, unmeasured: line, rows: [] }, null, 2) : line);
  process.exit(3);
}
if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ feature: feature.line, total, fixOfFix: loops, rate: total ? loops / total : 0, rows }, null, 2));
  process.exit(0);
}
console.log(feature.line);
for (const r of rows.sort((a, b) => b.total - a.total || a.board.localeCompare(b.board))) {
  console.log(`${r.board.padEnd(44)} ${String(r.total).padStart(3)} FIX · ${String(r.fixOfFix).padStart(2)} fix-of-fix${r.ids.length ? ` (${r.ids.join(', ')})` : ''}`);
}
console.log(`TOTAL ${total} FIX rows · ${loops} fix-of-fix · ${total ? ((100 * loops) / total).toFixed(1) : '0.0'}%`);
