'use strict';
/*
 * `builder accounts migrate [--dry-run]` — rewrite the 1.0 seat keys of `features.orchestrator` (`seats`, `limits`,
 * `secondaryConfigDir`, `credit`) into `features.accounts` (REQ-103, REQ-104, REQ-106; plan decision D33).
 *
 * WHY. 2.0 refuses the seat keys while the orchestrator is on and warns about them while it is off, so every 1.0
 * project needs one mechanical step that keeps its placement decisions (the golden fixture proves `migrate()` keeps
 * them). The command rewrites only the `pipeline-settings` block of PIPELINE_PROFILE.md: every byte outside the block
 * stays, a backup `PIPELINE_PROFILE.md.bak` is written first, and a second run changes nothing. A run with a live
 * lane (LAUNCHED or STALLED in `.pipeline/orchestrator/runs/<id>/state.json`) refuses: the running orchestrator read
 * the old keys and would place the next lane from a profile it no longer understands.
 *
 * More `accounts` subcommands (add, note, key, remove, list, install, policy, usage-snapshot) arrive with M10.
 */

const fs = require('fs');
const path = require('path');

const PROFILE = 'PIPELINE_PROFILE.md';
const BLOCK = /```json[ \t]+pipeline-settings[ \t]*\r?\n([\s\S]*?)\r?\n```/g;
const LIVE = new Set(['LAUNCHED', 'STALLED']);

/** Run ids whose state file holds a live lane. Reads only the state.json of each run under .pipeline/orchestrator/runs. */
function liveRuns(cwd, env = process.env) {
  let root;
  try {
    root = require('../scripts/lib/orch-store.cjs').orchRoot(env, cwd);
  } catch {
    root = path.join(cwd, '.pipeline', 'orchestrator');
  }
  const runs = path.join(root, 'runs');
  if (!fs.existsSync(runs)) return [];
  const out = [];
  for (const id of fs.readdirSync(runs)) {
    let state;
    try {
      state = JSON.parse(fs.readFileSync(path.join(runs, id, 'state.json'), 'utf8'));
    } catch {
      continue;
    }
    const lanes = Object.values((state && state.lanes) || {});
    if (lanes.some((l) => l && LIVE.has(l.status))) out.push(id);
  }
  return out;
}

/**
 * Pure: the migrated profile text, the notes and whether anything changed.
 * @returns {{ changed: boolean, text: string, notes: string[], errors: string[] }}
 */
function migrateText(text) {
  const registry = require('../scripts/lib/accounts-registry.cjs');
  const blocks = [...text.matchAll(BLOCK)];
  if (blocks.length !== 1) return { changed: false, text, notes: [], errors: [PROFILE + ': ' + (blocks.length === 0 ? 'no' : String(blocks.length)) + ' pipeline-settings block(s) — exactly one is needed'] };
  let raw;
  try {
    raw = JSON.parse(blocks[0][1]);
  } catch (e) {
    return { changed: false, text, notes: [], errors: [`${PROFILE}: pipeline-settings is not valid JSON: ${e.message}`] };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { changed: false, text, notes: [], errors: [`${PROFILE}: pipeline-settings must be a JSON object`] };
  const r = registry.migrate(raw);
  if (!r.changed) return { changed: false, text, notes: r.notes, errors: [] };
  const m = blocks[0];
  const body = JSON.stringify(r.settings, null, 2);
  const start = m.index + m[0].indexOf(m[1]);
  const out = text.slice(0, start) + body + text.slice(start + m[1].length);
  return { changed: true, text: out, notes: r.notes, errors: [] };
}

function cmdMigrate(ctx, argv) {
  const dry = argv.includes('--dry-run');
  const unknown = argv.filter((a) => a !== '--dry-run');
  if (unknown.length) ctx.die(`accounts migrate: unknown option(s): ${unknown.join(' ')}`);
  const file = path.join(ctx.CWD, PROFILE);
  if (!fs.existsSync(file)) ctx.die(`accounts migrate: no ${PROFILE} in ${ctx.CWD}`);
  const text = fs.readFileSync(file, 'utf8');
  const r = migrateText(text);
  if (r.errors.length) ctx.die(r.errors.join('\n'));
  if (!r.changed) {
    console.log(`accounts migrate: ${r.notes.join('; ')}`);
    return;
  }
  const profile = require('../scripts/lib/profile.cjs');
  const after = profile.parse(r.text);
  if (after.errors.length) ctx.die(`accounts migrate: the migrated settings do not validate — nothing written:\n  ${after.errors.join('\n  ')}`);
  const live = liveRuns(ctx.CWD);
  if (live.length) ctx.die(`accounts migrate: run(s) ${live.join(', ')} hold a LAUNCHED or STALLED lane — finish or stop them (orch status), then migrate`);
  for (const n of r.notes) console.log(`  ${n}`);
  if (dry) {
    console.log(`accounts migrate --dry-run: ${PROFILE} §16 would be rewritten (backup ${PROFILE}.bak); nothing written`);
    return;
  }
  fs.writeFileSync(`${file}.bak`, text);
  fs.writeFileSync(file, r.text);
  console.log(`accounts migrate: ${PROFILE} rewritten (the pipeline-settings block only; backup ${PROFILE}.bak)`);
}

function cmdAccounts(ctx, argv) {
  const sub = argv[0];
  if (sub === 'migrate') return cmdMigrate(ctx, argv.slice(1));
  ctx.die(`accounts: ${sub ? `unknown subcommand "${sub}"` : 'a subcommand is needed'} — usage: accounts migrate [--dry-run]`);
}

module.exports = { cmdAccounts, migrateText, liveRuns, PROFILE };
