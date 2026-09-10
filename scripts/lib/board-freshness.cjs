/**
 * Is a rendered run board still telling the truth?
 *
 * WHY THIS IS A GATE AND NOT A NICETY. `tasks/<key>.html` is a projection. The moment an event
 * lands in the run log after the last render, the page reports an earlier state of the run with the
 * full authority of a rendered document — and nothing on it looks wrong. That is strictly worse
 * than having no rendered board, and it is the same failure the `progress:auto` block already
 * guards against: a stale computed number carries last week's answer under this week's date.
 *
 * WHAT IS NOT A FAILURE. A board that never had a run log has nothing to be stale against
 * (`applicable: false`) — historical boards and md-only boards pass untouched. Opt-in by design,
 * exactly like the progress block.
 *
 * WHY TIMESTAMPS ARE NOT ENOUGH. Comparing mtimes answers "was the page rendered after the last
 * event?" and nothing else. It cannot see a page rendered promptly from a log the parser
 * understood none of — which is precisely what happened for a fortnight: ten of eleven run logs
 * stamped `type`/`t` against a reader switching on `kind`, every page rendered on time and empty,
 * and this gate reported `rendered board fresh` for all of them. A gate whose predicate measures
 * something adjacent to its claim is worse than no gate, so the content check below runs too.
 */
const { existsSync, statSync } = require('node:fs');
const { basename, dirname, join, resolve } = require('node:path');
const runLog = require('./run-log.cjs');

/**
 * @param boardPath path to `tasks/<key>.md`
 * @returns {{applicable: boolean, stale: boolean, key: string, rendered?: string, reason?: string}}
 */
function verdict(boardPath) {
  const key = basename(boardPath, '.md');
  const root = resolve(dirname(boardPath), '..');
  const log = join(root, '.pipeline', key, 'run.jsonl');
  const rendered = boardPath.replace(/\.md$/, '.html');

  if (!existsSync(log)) return { applicable: false, stale: false, key };
  if (!existsSync(rendered)) {
    return { applicable: true, stale: true, key, rendered, reason: 'run log exists but the board was never rendered' };
  }

  const renderedAt = statSync(rendered).mtimeMs;
  const newest = Math.max(statSync(log).mtimeMs, statSync(boardPath).mtimeMs);
  if (newest > renderedAt) {
    const what = statSync(log).mtimeMs > renderedAt ? 'a run-log event' : 'a board edit';
    return { applicable: true, stale: true, key, rendered, reason: `${what} landed after the last render` };
  }

  /* Content, not just timing: a log the reader recognises nothing in renders a page with an empty
   * timeline and empty accounting, on time. Report it as stale — the page is not telling the truth
   * about the run, which is the only thing this gate exists to assert. */
  const parsed = runLog.read(log);
  if (parsed.unrecognised > 0) {
    return {
      applicable: true,
      stale: true,
      key,
      rendered,
      reason:
        `${parsed.unrecognised} of ${parsed.events.length} run-log event(s) carry no kind this reader knows — ` +
        'the rendered page is empty where the run happened (schema drift)',
    };
  }
  return { applicable: true, stale: false, key, rendered };
}

module.exports = { verdict };
