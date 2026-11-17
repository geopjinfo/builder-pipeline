/**
 * The loop runner above a board — the manual command (plan M9, REQ-901 to REQ-915). Rules: scripts/lib/board-loop.cjs.
 *
 *   npx builder-pipeline run board-loop <account> <board.md> [--more-passes N] [--record-experiment <EXPERIMENTS.md>]
 * (folder layout: node scripts/board-loop.mjs in place of npx builder-pipeline run board-loop)
 *
 * Settings (PIPELINE_PROFILE.md): features.boardLoop.{state, promptFile, gate, maxPasses, passTimeoutMinutes,
 * maxTurnsPerPass, stallMinutes, maxRetriesPerRow, maxConsecutiveFailures, maxConsecutiveNoProgress, testRoots} ·
 * features.accounts.accounts.<account> · features.bashCap.limitBytes (the gate digest cap).
 *
 * Exit 0 every row done (or the feature is off) · 10 stopped with rows open · 2 usage, an invalid profile or a refusal.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runHint } = require('./lib/run-hint.cjs');
const profile = require('./lib/profile.cjs');
const loop = require('./lib/board-loop.cjs');

const argv = process.argv.slice(2);
const pos = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--') && !['--help'].includes(argv[i - 1])));
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1];
};
const [account, board] = pos;
if (!account || !board) {
  console.error(`usage: ${runHint('board-loop')} <account> <board.md> [--more-passes N] [--record-experiment <EXPERIMENTS.md>]`);
  process.exit(2);
}
const loaded = profile.load(process.cwd());
if (loaded.errors.length > 0) {
  console.error(`board-loop: PIPELINE_PROFILE.md is invalid — run ${runHint('features')}`);
  for (const e of loaded.errors) console.error(`  ${e}`);
  process.exit(2);
}
const more = flag('--more-passes') ? Number(flag('--more-passes')) : 0;
if (flag('--more-passes') && !(Number.isInteger(more) && more > 0)) {
  console.error('board-loop: --more-passes takes a positive whole number');
  process.exit(2);
}
try {
  const r = await loop.runLoop({ cwd: process.cwd(), settings: loaded.settings, accountName: account, board, morePasses: more, io: { log: (l) => console.log(l) } });
  if (r.notConfigured) {
    console.log(r.line);
    process.exit(0);
  }
  const record = flag('--record-experiment');
  if (record) {
    const { execFileSync } = await import('node:child_process');
    const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
    loop.recordExperiment(record, loop.experimentRow({ date: new Date().toISOString().slice(0, 10), commit, passes: r.passes, rowsDone: r.rowsDone, rowsTotal: r.rowsTotal, costUsd: null, turns: 'see run log', timeouts: 'see run log', silentFailures: 0, note: `manual run on account ${account}, stop ${r.reason}` }));
    console.log(`board-loop: one row appended to §17 of ${record}`);
  }
  process.exit(r.exitCode);
} catch (e) {
  console.error(`board-loop: ${e.message}`);
  process.exit(2);
}
