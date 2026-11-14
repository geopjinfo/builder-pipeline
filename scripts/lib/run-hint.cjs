'use strict';
/**
 * Where a kit script runs from, and how a person is told to run one.
 *
 * WHY. The kit runs in two layouts. Installed as a package it lives under `node_modules/@geopjinfo/builder-pipeline/`
 * and its scripts run from there (`npx builder run <name>`), with the project as the working directory. Copied in as
 * a `builder/` folder, unpack copies the scripts to the project's `scripts/` (`node scripts/<name>.mjs`). A script
 * that spawned `scripts/<sibling>.mjs` relative to the working directory, or that printed the folder form as advice,
 * worked in one layout only. So a sibling is resolved beside the calling script, the project is
 * BUILDER_PROJECT_ROOT || cwd, and the advice names the layout the script is actually running in.
 */
const path = require('node:path');

/** True when `file` (a script's own path) sits inside an installed package. */
const inPackage = (file) => /(^|[\\/])node_modules[\\/]/.test(String(file || ''));

/** The project root: what `builder run` names, else the working directory. */
const projectRoot = () => path.resolve(process.env.BUILDER_PROJECT_ROOT || process.cwd());

/** How to run kit script `name` (no extension) with `args`, for the layout `file` runs in. */
function runHint(name, file, args = '') {
  const tail = args ? ` ${args}` : '';
  return inPackage(file) ? `npx builder run ${name}${tail}` : `node scripts/${name}.mjs${tail}`;
}

module.exports = { inPackage, projectRoot, runHint };
