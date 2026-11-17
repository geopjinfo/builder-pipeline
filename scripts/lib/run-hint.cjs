'use strict';
/**
 * Where a kit script runs from, and how a person is told to run one. THE ONE PLACE a kit script or hook spells a
 * run command — `tests/invocation.test.mjs` fails on a hard-coded one anywhere else under scripts/ or hooks/.
 *
 * WHY. The kit runs in two layouts. Installed as a package it lives under `node_modules/builder-pipeline/`
 * and its scripts run from there (`npx builder run <name>`), with the project as the working directory; the few the
 * Claude Code hooks use are vendored into `.claude/hooks/kit/` (package layout only). Copied in as a `builder/`
 * folder, unpack copies the scripts to the project's `scripts/` (`node scripts/<name>.mjs`). A script that spawned
 * `scripts/<sibling>.mjs` relative to the working directory, or that printed the folder form as advice, worked in
 * one layout only. So a sibling is resolved beside the calling script, the project is BUILDER_PROJECT_ROOT || cwd,
 * and the advice names the layout this file — always in the same layout as its caller — is actually running in.
 */
const path = require('node:path');

/** True when `file` sits inside an installed package, or in the hooks' vendored copy of it (package layout only). */
const inPackage = (file) => /(^|[\\/])node_modules[\\/]/.test(String(file || '')) || /(^|[\\/])\.claude[\\/]hooks[\\/]kit[\\/]/.test(String(file || ''));

/** The project root: what `builder run` names, else the working directory. */
const projectRoot = () => path.resolve(process.env.BUILDER_PROJECT_ROOT || process.cwd());

const PACKAGED = inPackage(__filename);

/** How to run kit script `name` (no extension) with `args`, for the layout the kit runs in. */
function runHint(name, args = '') {
  const tail = args ? ` ${args}` : '';
  return PACKAGED ? `npx builder run ${name}${tail}` : `node scripts/${name}.mjs${tail}`;
}

/** How to run CLI command `cmd` (`verify`, `features` …) for the layout the kit runs in. */
function cliHint(cmd = '', args = '') {
  const tail = `${cmd ? ` ${cmd}` : ''}${args ? ` ${args}` : ''}`;
  return PACKAGED ? `npx builder${tail}` : `node builder/cli.js${tail}`;
}

module.exports = { inPackage, projectRoot, runHint, cliHint, PACKAGED };
