/**
 * What this project already has, and how much of it looks like the kit — `node scripts/inventory.mjs`.
 *
 *   node scripts/inventory.mjs [--json] [--root <project dir>] [--kit <kit dir>] [--threshold 0.3]
 *
 * Lists every skill, agent, persona, playbook and hook under the harness folders (scripts/lib/inventory.cjs
 * LOCATIONS), the greenfield/brownfield call with its evidence, and every project↔kit pair that shares a name, a
 * content hash or enough wording to clash. Reads only; writes nothing. The `builder-init` skill reads `--json`.
 *
 * Exit 0 always on a readable project (an overlap is a finding for the review, not a failure) · 1 bad arguments
 * or the kit could not be found.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const inv = require('./lib/inventory.cjs');

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};

/** The kit beside this script (the pack itself), else the installed package. */
function findKit() {
  const given = opt('--kit');
  if (given) return resolve(given);
  const beside = join(dirname(fileURLToPath(import.meta.url)), '..');
  if (existsSync(join(beside, 'agents')) && existsSync(join(beside, 'cli.js'))) return beside;
  try {
    return dirname(require.resolve('@geopjinfo/builder-pipeline/package.json', { paths: [process.cwd()] }));
  } catch {
    return null;
  }
}

const root = resolve(opt('--root') || process.cwd());
const kit = findKit();
if (!kit) {
  console.error('inventory: kit not found — pass --kit <dir>, or run from a project with the kit installed');
  process.exit(1);
}
const threshold = opt('--threshold') === undefined ? inv.SIMILAR : Number(opt('--threshold'));
if (!(threshold >= 0 && threshold <= 1)) {
  console.error('inventory: --threshold must be a number from 0 to 1');
  process.exit(1);
}

const r = inv.report(root, kit, { threshold });
if (argv.includes('--json')) {
  console.log(JSON.stringify(r, null, 2));
  process.exit(0);
}

console.log(`mode: ${r.mode.mode} — ${r.mode.evidence.reasons.join('; ')}`);
console.log(`\nproject items (${r.items.length}):`);
for (const it of r.items) console.log(`  ${it.kind.padEnd(9)}${it.tool.padEnd(19)}${it.name.padEnd(28)}${it.path}`);
console.log(`\noverlaps with the kit (${r.overlaps.length}):`);
for (const p of r.overlaps) console.log(`  ${String(p.score).padEnd(6)}${p.project}  <->  ${p.kitKind}:${p.kitName}  — ${p.reason}`);
console.log(`\nclashing kit items (need a recorded choice before they install): ${r.clashes.join(', ') || 'none'}`);
