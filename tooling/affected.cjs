'use strict';
/**
 * Which tests can this changeset possibly break?
 *
 * Deliberately thin: selection itself is jest's own `--findRelatedTests`, which walks the REAL
 * import graph. An ownership map (module -> spec glob) was considered and REJECTED — it rots the
 * moment someone adds a spec, and this harness has already lost a whole tier to exactly that kind
 * of silent drift (677 e2e tests dead behind green gates; see `test/jest.e2e.config.cjs`).
 *
 * The graph cannot see through a migration, a platform edit, a seed, a shared harness file or a
 * jest config: those change behaviour for suites that never import them. Hence the escalation list.
 * Anything not obviously safe belongs on it — a false `full` costs minutes, a false `related` costs
 * a missed regression.
 *
 * SELECTIVE IS AN INNER-LOOP TOOL. It never produces merge evidence: a board row cites a full run,
 * and full tiers stay mandatory at pipeline Phase 3, Phase 6/6.5 and before every PR.
 *
 * Design rationale: the source repo's 2026-08-26 run-economy plan (evidence-backed; see PORTING.md).
 */
const FULL_RUN_PATTERNS = [
  /^prisma\//,
  /^src\/platform\//,
  /^src\/app\.module\.ts$/,
  /^src\/main\.ts$/,
  /^src\/config\//,
  /^test\/support\//,
  /^test\/integration\/support\//,
  /^test\/e2e\/harness\//,
  /^jest\.config\.cjs$/,
  /^test\/jest\..*\.config\.cjs$/,
  /^scripts\/lib\//,
  /^package(-lock)?\.json$/,
  /^tsconfig.*\.json$/,
];

const normalise = (file) => file.replace(/\\/g, '/');

function selectTier(changedFiles) {
  const files = changedFiles.map(normalise);
  const trigger = files.find((file) => FULL_RUN_PATTERNS.some((pattern) => pattern.test(file)));
  if (trigger) {
    return { mode: 'full', files: [], reason: `${trigger} has blast radius the import graph cannot see` };
  }
  const typescript = files.filter((file) => file.endsWith('.ts') && !file.endsWith('.d.ts'));
  if (typescript.length === 0) {
    return { mode: 'none', files: [], reason: 'no TypeScript changed' };
  }
  return { mode: 'related', files: typescript, reason: `${typescript.length} changed TypeScript file(s)` };
}

module.exports = { selectTier, FULL_RUN_PATTERNS };
