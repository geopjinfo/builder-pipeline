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
const PREFERENCE = [/^Expected:/, /^Received:/, /^(Error|expect\()/];

function firstAssertionLine(message = '') {
  const lines = message.split(NEWLINE).map((candidate) => candidate.trim());
  for (const pattern of PREFERENCE) {
    const found = lines.find((candidate) => pattern.test(candidate));
    if (found) return found.slice(0, 160);
  }
  return (lines[0] ?? '').slice(0, 160);
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

  const head =
    result.numFailedTests === 0
      ? `PASS — ${result.numPassedTestSuites}/${result.numTotalTestSuites} suites, ${result.numPassedTests}/${result.numTotalTests} tests`
      : `FAIL — ${result.numFailedTestSuites}/${result.numTotalTestSuites} suites red, ${result.numFailedTests}/${result.numTotalTests} tests failed`;

  const lines = [head];
  for (const failure of failed.slice(0, MAX_FAILURES_SHOWN)) {
    lines.push(`  ${failure.file} :: ${failure.name}`);
    lines.push(`      ${failure.why}`);
  }
  if (failed.length > MAX_FAILURES_SHOWN) {
    lines.push(`  … ${failed.length - MAX_FAILURES_SHOWN} more failure(s) — see the log`);
  }
  lines.push(`full log: ${logPath}`);
  return lines.join(NEWLINE);
}

module.exports = { summarize, MAX_FAILURES_SHOWN };
