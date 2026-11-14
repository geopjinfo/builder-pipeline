/**
 * The persona roster holds: one roster block in personas/INDEX.md, every entry complete, ids unique, every
 * profile file present, and nothing marked to render that the human has not confirmed. Rule: scripts/lib/personas.cjs.
 *
 *   node scripts/personas-check.mjs                    check personas/ under the current directory
 *   node scripts/personas-check.mjs <dir>              check that personas directory instead
 *   --render <out>                                     also write one neutral agent file per confirmed entry marked
 *                                                      "render": true, as <out>/persona-<id>.md (refused while any
 *                                                      roster problem stands)
 *   --json                                             machine-readable result
 *
 * No personas directory → "personas-check: no personas/ — nothing to check", exit 0 (said, never PASS).
 *
 * Exit 0 PASS · 1 any roster problem, or a render that could not be written · 2 a missing INDEX.md, or a roster
 *      block that cannot be read.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const lib = require('./lib/personas.cjs');

const NAME = 'personas-check';
const args = process.argv.slice(2);
const asJson = args.includes('--json');
const renderAt = args.indexOf('--render');
const renderDir = renderAt === -1 ? null : args[renderAt + 1];
if (renderAt !== -1 && (!renderDir || renderDir.startsWith('--'))) {
  console.error(`${NAME}: --render needs an output directory`);
  process.exit(2);
}
const positional = args.filter((a, i) => !a.startsWith('--') && !(renderAt !== -1 && i === renderAt + 1));
const dir = resolve(positional[0] || 'personas');
const slash = (p) => p.replace(/\\/g, '/');

if (!existsSync(dir)) {
  console.log(`${NAME}: no ${slash(positional[0] || 'personas')}/ — nothing to check`);
  process.exit(0);
}
const indexPath = join(dir, 'INDEX.md');
if (!existsSync(indexPath)) {
  console.error(`${NAME}: ${slash(indexPath)} is missing — the roster lives there`);
  process.exit(2);
}

let roster;
try {
  roster = lib.parseRoster(readFileSync(indexPath, 'utf8'));
} catch (e) {
  console.error(`${NAME}: ${e.message}`);
  process.exit(2);
}

const problems = lib.validate(roster, { fileExists: (rel) => existsSync(join(dir, rel)) });
const personas = Array.isArray(roster.personas) ? roster.personas : [];
const confirmed = personas.filter((p) => p && p.confirmed === true).length;
const rendered = [];

if (problems.length === 0 && renderDir) {
  mkdirSync(renderDir, { recursive: true });
  for (const p of personas.filter((x) => x.confirmed === true && x.render === true)) {
    try {
      const text = lib.toNeutralAgent(readFileSync(join(dir, lib.fileOf(p)), 'utf8'), p);
      const out = join(renderDir, `persona-${p.id}.md`);
      writeFileSync(out, text);
      rendered.push(slash(out));
    } catch (e) {
      problems.push(`render ${p.id}: ${e.message}`);
    }
  }
}

if (asJson) {
  console.log(JSON.stringify({ ok: problems.length === 0, personas: personas.length, confirmed, problems, rendered }, null, 2));
} else if (problems.length === 0) {
  console.log(`${NAME}: PASS — ${personas.length} persona(s), ${confirmed} confirmed${renderDir ? `, ${rendered.length} rendered` : ''}`);
  for (const r of rendered) console.log(`  rendered ${r}`);
} else {
  console.error(`${NAME}: FAIL — ${problems.length} problem(s)${renderDir ? ' (nothing rendered while a roster problem stands)' : ''}`);
  for (const p of problems) console.error(`  ${p}`);
}
process.exit(problems.length === 0 ? 0 : 1);
