#!/usr/bin/env node
/**
 * EXPERIMENTAL (`features.personas`) — write or check one role profile per role column of the permission
 * catalogue. See EXPERIMENTS.md, role persona profiles. Rule: persona.cjs.
 *
 *   node scripts/experimental/persona-gen.mjs            write missing profiles; refresh the generated blocks of existing ones
 *   node scripts/experimental/persona-gen.mjs --check    exit 1 on any drift, missing or stray profile, or uncited drafted bullet
 *
 * Installed by `node builder/cli.js unpack --experimental` beside `persona.cjs` in `scripts/experimental/`.
 *
 * Settings (features.personas): catalogue · keyColumn · labelColumn · roleColumns · grant · out · logins ·
 * citationPattern. Paths resolve against the working directory.
 *
 * Exit 0 written, or check passed (also when the feature is not enabled) · 1 check failed, or an existing
 * profile has lost its markers and was not overwritten · 2 usage, an invalid profile, an unreadable catalogue
 * or login map, or a catalogue with zero role columns.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
/** A pack lib: `scripts/lib/` beside an installed copy, or the pack's own `scripts/lib/` when run in the pack. */
const lib = (name) => [join(here, '..', 'lib', name), join(here, '..', '..', 'scripts', 'lib', name)].find((p) => existsSync(p));
const profile = require(lib('profile.cjs'));
const { csvCells } = require(lib('output-check.cjs'));
const persona = require(join(here, 'persona.cjs'));

const NAME = 'persona-gen';
const USAGE = 'usage: node scripts/experimental/persona-gen.mjs [--check]';
const fail = (code, ...lines) => {
  for (const l of lines) console.error(l);
  process.exit(code);
};

const loaded = profile.load(process.cwd());
if (loaded.errors.length > 0) fail(2, `${NAME}: PIPELINE_PROFILE.md is invalid — run node scripts/features.mjs`, ...loaded.errors.map((e) => `  ${e}`));
const feature = profile.feature(loaded.settings, 'personas');
if (!feature.enabled) {
  console.log(feature.line);
  process.exit(0);
}
const args = process.argv.slice(2);
if (args.some((a) => a !== '--check')) fail(2, USAGE);
const check = args.includes('--check');

const cfg = feature.config;
const root = process.cwd();
const shown = (p) => relative(root, p).replace(/\\/g, '/') || '.';

const catalogue = resolve(cfg.catalogue);
if (!existsSync(catalogue)) fail(2, `${NAME}: no catalogue at ${shown(catalogue)} (features.personas.catalogue)`);
const { columns, keysFor, errors } = persona.parseCatalogue(readFileSync(catalogue, 'utf8'), {
  csvCells,
  keyColumn: cfg.keyColumn,
  labelColumn: cfg.labelColumn,
  roleColumns: cfg.roleColumns,
  grant: String(cfg.grant),
});
if (errors.length) fail(2, `${NAME}: cannot read the catalogue ${shown(catalogue)}`, ...errors.map((e) => `  ${e}`));
if (columns.length === 0) {
  fail(
    2,
    `${NAME}: ${shown(catalogue)} has zero role columns — a generator over nothing proves nothing.`,
    `  Inferred role columns hold only ${JSON.stringify(String(cfg.grant))} or nothing, at least once; name them in features.personas.roleColumns if yours differ.`,
  );
}

let logins = {};
if (cfg.logins !== null) {
  const at = resolve(cfg.logins);
  try {
    logins = JSON.parse(readFileSync(at, 'utf8'));
  } catch (e) {
    fail(2, `${NAME}: cannot read the login map ${shown(at)} (features.personas.logins) — ${e.message}`);
  }
  const shape = persona.checkLoginsShape(logins);
  if (shape.length) fail(2, `${NAME}: ${shown(at)} is not a login map`, ...shape.map((p) => `  ${p}`));
}

const out = resolve(cfg.out);
const citation = new RegExp(cfg.citationPattern);
const catalogueName = shown(catalogue);
const fileFor = (column) => join(out, `${persona.slugOf(column)}.md`);
const inputsFor = (column) => ({ column, keys: keysFor[column], login: Object.hasOwn(logins, column) ? logins[column] : null });

if (check) {
  const problems = [];
  for (const column of columns) {
    const file = fileFor(column);
    if (!existsSync(file)) {
      problems.push(`${column}: no profile at ${shown(file)} — run ${NAME}`);
      continue;
    }
    for (const p of persona.checkProfile(readFileSync(file, 'utf8'), { ...inputsFor(column), citation })) problems.push(`${column}: ${p}`);
  }
  const expected = new Set(columns.map((c) => `${persona.slugOf(c)}.md`));
  if (existsSync(out)) {
    for (const f of readdirSync(out).sort()) if (f.endsWith('.md') && f !== 'README.md' && !expected.has(f)) problems.push(`${f}: no role column in the catalogue matches this profile`);
  }
  for (const k of Object.keys(logins)) if (!columns.includes(k)) problems.push(`logins: "${k}" names no role column in the catalogue`);
  for (const p of problems) console.log(`  ${p}`);
  console.log(`${NAME} --check: ${problems.length === 0 ? 'PASS' : 'FAIL'} — ${columns.length} role column(s), ${problems.length} problem(s)`);
  process.exit(problems.length === 0 ? 0 : 1);
}

mkdirSync(out, { recursive: true });
const refused = [];
let written = 0;
for (const column of columns) {
  const file = fileFor(column);
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : null;
  const text = persona.renderProfile({ ...inputsFor(column), catalogue: catalogueName, existing });
  if (text === null) {
    refused.push(`${shown(file)}: a generated marker pair is missing — not overwritten, so its drafted sections survive; restore the markers`);
    continue;
  }
  if (text !== existing) {
    writeFileSync(file, text, 'utf8');
    written += 1;
  }
}
for (const r of refused) console.log(`  ${r}`);
const withLogin = columns.filter((c) => Object.hasOwn(logins, c)).length;
console.log(`${NAME}: ${columns.length} role column(s) → ${shown(out)}/ — ${written} written, ${columns.length - written - refused.length} unchanged, ${refused.length} refused (${withLogin} with a seeded login)`);
process.exit(refused.length ? 1 : 0);
