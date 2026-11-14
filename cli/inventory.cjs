'use strict';
/*
 * `builder inventory` and the project view the installer's clash check reads (scripts/lib/inventory.cjs underneath).
 *
 * WHY A VIEW AND NOT report() AS IS. report() scans every harness folder, so after the kit's own install it lists
 * the kit's personas and skills as "project items" — each one the same name as a kit item. A re-run of builder-init
 * would then ask the human to decide about every kit persona, and an upgrade would skip them all as undecided
 * clashes. The kit's own files are not the project's: an item the lock (builder.lock.json) records, or — for an
 * install from before the lock — an item carrying a kit item's name, is moved to `kitInstalled` and compared with
 * nothing. Everything else is the project's and goes through overlaps() unchanged.
 */

const path = require('path');

/**
 * { mode?, items, kitItems, overlaps, clashes, kitInstalled, withMap }.
 *   lock    the lock's files map (posix path → sha) — {} when there is none
 *   legacy  true for an install from before the lock (no lock, but the kit's profile or pointer is there)
 */
function projectView(cwd, kit, { lock = {}, legacy = false, threshold, withMode = false } = {}) {
  const inv = require(path.join(kit, 'scripts', 'lib', 'inventory.cjs'));
  const all = inv.inventory(cwd);
  const kitItems = inv.kitInventory(kit);
  const kitNames = new Set(kitItems.map((k) => k.name.toLowerCase()));
  const isKit = (it) =>
    Object.prototype.hasOwnProperty.call(lock, it.path) || (legacy && kitNames.has(it.name.toLowerCase().replace(/^builder-/, '')));
  const items = all.filter((it) => !isKit(it));
  const overlaps = inv.overlaps(items, kitItems, threshold === undefined ? {} : { threshold });
  const withMap = new Map();
  for (const p of overlaps) {
    const key = `${p.kitKind}:${p.kitName}`;
    if (!withMap.has(key)) withMap.set(key, []);
    if (!withMap.get(key).includes(p.project)) withMap.get(key).push(p.project);
  }
  const view = { items, kitItems, overlaps, clashes: [...withMap.keys()].sort(), kitInstalled: all.filter(isKit).map((it) => it.path), withMap };
  if (!withMode) return view;
  // The kit's own install is not evidence of a codebase: the files the lock records (its scripts/ copies in the folder
  // layout, its hooks, its skills) and — for an install from before the lock — the scripts/ copies of kit scripts.
  const exclude = new Set(Object.keys(lock));
  if (legacy) {
    const fs = require('fs');
    const walk = (dir, rel) => {
      if (!fs.existsSync(dir)) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) walk(path.join(dir, e.name), `${rel}${e.name}/`);
        else exclude.add(`${rel}${e.name}`);
      }
    };
    walk(path.join(kit, 'scripts'), 'scripts/');
    walk(path.join(kit, 'oracles'), 'scripts/oracles/');
    walk(path.join(kit, 'tooling', 'experimental'), 'scripts/experimental/');
  }
  return { mode: inv.mode(cwd, { exclude, isKit }), ...view };
}

/** `builder inventory [--json] [--threshold n]` — what scripts/inventory.mjs prints, without the kit's own files. */
function cmdInventory(ctx, argv) {
  const at = argv.indexOf('--threshold');
  let threshold;
  if (at !== -1) {
    threshold = Number(argv[at + 1]);
    if (!(threshold >= 0 && threshold <= 1)) ctx.die('inventory: --threshold must be a number from 0 to 1');
  }
  const { withMap, ...r } = projectView(ctx.CWD, ctx.KIT, { lock: ctx.lockPrior(), legacy: ctx.legacyInstall(), threshold, withMode: true });
  if (argv.includes('--json')) return console.log(JSON.stringify(r, null, 2));
  console.log(`mode: ${r.mode.mode} — ${r.mode.evidence.reasons.join('; ')}`);
  console.log(`\nproject items (${r.items.length}):`);
  for (const it of r.items) console.log(`  ${it.kind.padEnd(9)}${it.tool.padEnd(19)}${it.name.padEnd(28)}${it.path}`);
  if (r.kitInstalled.length) console.log(`\nkit-installed (the kit's own files, not reviewed): ${r.kitInstalled.length}`);
  console.log(`\noverlaps with the kit (${r.overlaps.length}):`);
  for (const p of r.overlaps) console.log(`  ${String(p.score).padEnd(6)}${p.project}  <->  ${p.kitKind}:${p.kitName}  — ${p.reason}`);
  console.log(`\nclashing kit items (need a recorded choice before they install): ${r.clashes.join(', ') || 'none'}`);
}

module.exports = { projectView, cmdInventory };
