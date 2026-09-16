'use strict';
/**
 * EXAMPLE — the digest half of a jest tier runner. The interface it implements is in README.md beside this file.
 *
 * A tier's result, in at most 25 lines.
 *
 * WHY THIS EXISTS. A full integration log can run to several megabytes. Read raw into an orchestrator window
 * that is also holding a plan, a board and four auditors' findings, it does not just cost tokens —
 * it pushes the loop-back list into the MIDDLE of the window, the position least likely to be acted
 * on. The full log is still written; only the digest is spoken.
 *
 * Six facts are wanted from a tier run: suites, tests, which tests failed, in which file, the first
 * assertion line of each, and where the full log is. Everything else is burn.
 */
const NEWLINE = String.fromCharCode(10);
const MAX_FAILURES_SHOWN = 10;

/**
 * The one line of a jest failure message worth speaking.
 *
 * Order matters and is not arbitrary: `Expected: 413` tells the reader what the contract was,
 * while the `Error: expect(received).toBe(expected)` header that precedes it says only that an
 * assertion failed — which the FAIL count already said. Taking the first matching line of either
 * kind would always pick the useless one, since the header comes first in every jest message.
 */
const PREFERENCE = [
  // Compile/resolve failures first: for a suite that never ran, `error TS2322: …` is the whole
  // diagnosis, while jest's own `● Test suite failed to run` header repeats what the head said.
  /error TS\d+/,
  /Cannot find module/,
  /^Expected:/,
  /^Received:/,
  /^(Error|expect\()/,
];

/** jest colours its messages; the digest is read in a plain window and in a commit message. */
const ANSI = new RegExp(String.fromCharCode(27) + String.raw`\[[0-9;]*m`, 'g');

function firstAssertionLine(message = '') {
  const lines = String(message).replace(ANSI, '').split(NEWLINE).map((candidate) => candidate.trim());
  for (const pattern of PREFERENCE) {
    const found = lines.find((candidate) => pattern.test(candidate));
    if (found) return found.slice(0, 160);
  }
  return (lines[0] ?? '').slice(0, 160);
}

/**
 * The suite-level failure text. jest's `--json` reporter writes `message`; the programmatic result
 * object writes `failureMessage`. `run-tier.mjs` reads the JSON file, so reading only the latter
 * left the digest naming a suite with no reason beside it.
 */
function suiteMessage(suite) {
  return suite.failureMessage ?? suite.message ?? '';
}

function summarize(result, { logPath }) {
  const failed = [];
  for (const suite of result.testResults ?? []) {
    for (const assertion of suite.assertionResults ?? []) {
      if (assertion.status === 'failed') {
        failed.push({
          file: String(suite.name).split(/[\\/]/).pop(),
          name: assertion.fullName,
          why: firstAssertionLine(assertion.failureMessages?.[0]),
        });
      }
    }
  }

  /**
   * A suite that FAILED TO RUN contributes zero tests, so `numFailedTests` cannot see it. Judging the
   * head on the test count alone printed `PASS — 327/328 suites, 4026/4026 tests` beside jest's own
   * `Test Suites: 1 failed` — a green head for a run that did not happen, which is the one
   * thing a governed runner must never say. The suite count is the authority; the test figure stays.
   */
  const unrun = (result.testResults ?? []).filter(
    (suite) =>
      (suite.status === 'failed' || suiteMessage(suite)) && (suite.assertionResults ?? []).length === 0,
  );

  const head =
    result.numFailedTestSuites === 0 && result.numFailedTests === 0
      ? `PASS — ${result.numPassedTestSuites}/${result.numTotalTestSuites} suites, ${result.numPassedTests}/${result.numTotalTests} tests`
      : `FAIL — ${result.numFailedTestSuites}/${result.numTotalTestSuites} suites red, ${result.numFailedTests}/${result.numTotalTests} tests failed`;

  /**
   * One budget across both kinds, so the 25-line cap holds when a run has BOTH unrun suites and
   * failing tests. A suite that did not run is listed first: it is the fact the head used to hide.
   */
  const entries = [
    ...unrun.map((suite) => ({
      what: `${suite.name} :: suite did not run`,
      why: firstAssertionLine(suiteMessage(suite)),
    })),
    ...failed.map((failure) => ({ what: `${failure.file} :: ${failure.name}`, why: failure.why })),
  ];

  const lines = [head];
  for (const entry of entries.slice(0, MAX_FAILURES_SHOWN)) {
    lines.push(`  ${entry.what}`);
    lines.push(`      ${entry.why}`);
  }
  if (entries.length > MAX_FAILURES_SHOWN) {
    lines.push(`  … ${entries.length - MAX_FAILURES_SHOWN} more failure(s) — see the log`);
  }
  lines.push(`full log: ${logPath}`);
  return lines.join(NEWLINE);
}

module.exports = { summarize, MAX_FAILURES_SHOWN };
