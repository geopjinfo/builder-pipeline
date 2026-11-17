/**
 * The evidence programme in one place — `npx builder run experiments` (plan M14, REQ-1401, REQ-1402, REQ-1405; D57).
 *
 *   npx builder run experiments                 one line per EXPERIMENTS.md section: number, flag, default state, decision
 *   npx builder run experiments --check         exit 1 when a section has no decision row, or a keep without a number
 *   npx builder run experiments --matrix        the trial matrix: feature, section, test bed, command, keep rule, decision
 *   npx builder run experiments --record <n> --row "| … |" [--file <EXPERIMENTS.md>]
 *                                               append one measurement row to the table of section n (the flag stays)
 *   --json                                      machine-readable
 * (folder layout: node scripts/experiments.mjs in place of npx builder run experiments)
 *
 * Reads the kit's own EXPERIMENTS.md (beside scripts/) unless --file names another. Exit 0 · 1 a check failed · 2 usage.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { runHint } = require('./lib/run-hint.cjs');
const exp = require('./lib/experiments.cjs');
const profile = require('./lib/profile.cjs');

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1];
};
const file = resolve(flag('--file') || join(dirname(fileURLToPath(import.meta.url)), '..', 'EXPERIMENTS.md'));
if (!existsSync(file)) {
  console.error(`experiments: no ${file}`);
  process.exit(2);
}
if (argv.includes('--record')) {
  const n = Number(flag('--record'));
  const row = flag('--row');
  if (!Number.isInteger(n) || !row || !row.startsWith('|')) {
    console.error(`usage: ${runHint('experiments')} --record <section> --row "| … |" [--file <EXPERIMENTS.md>]`);
    process.exit(2);
  }
  try {
    exp.recordRow(file, n, row);
  } catch (e) {
    console.error(`experiments: ${e.message}`);
    process.exit(2);
  }
  console.log(`experiments: one row appended to §${n} of ${file}`);
  process.exit(0);
}
const sections = exp.parse(readFileSync(file, 'utf8'));
const stateOf = (f) => (f && profile.FEATURES[f] ? profile.FEATURES[f].defaults.state : '—');
if (argv.includes('--matrix')) {
  const rows = exp.MATRIX.map((m) => {
    const s = sections.find((x) => x.n === m.section);
    return { ...m, decision: s && s.decision ? `${s.decision.verdict} (${s.decision.date})` : 'no decision row', state: stateOf(m.flag) };
  });
  if (argv.includes('--json')) console.log(JSON.stringify(rows, null, 2));
  else for (const r of rows) console.log(`${r.flag} · §${r.section} · default ${r.state} · bed: ${r.bed} · run: ${r.command} · keep when: ${r.keep} · decision: ${r.decision}`);
  process.exit(0);
}
const faults = sections.map(exp.decisionFault).filter(Boolean);
if (argv.includes('--json')) console.log(JSON.stringify({ sections: sections.map(({ body, ...s }) => ({ ...s, state: stateOf(s.flag) })), faults }, null, 2));
else {
  for (const s of sections) console.log(`§${s.n} ${s.flag ? `${s.flag} (default ${stateOf(s.flag)})` : s.title} — ${s.decision ? `${s.decision.verdict} (${s.decision.date}): ${s.decision.text}` : 'NO DECISION ROW'}`);
  for (const f of faults) console.log(`FAULT ${f}`);
  console.log(faults.length ? `experiments: ${faults.length} fault(s)` : `experiments: ${sections.length} sections, every decision row present`);
}
if (argv.includes('--check')) process.exit(faults.length ? 1 : 0);
