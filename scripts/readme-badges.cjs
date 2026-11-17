#!/usr/bin/env node
/**
 * The README badges, computed from source — a maintainer tool (specs/toolkit-distribution.spec.md, REQ-505 to REQ-507).
 *
 * It runs in the kit repository (folder layout, from the kit root; it is not an `npx builder-pipeline run` target):
 *   folder layout: node scripts/readme-badges.cjs            check README.md against the generated block; exit 1 on a mismatch
 *   folder layout: node scripts/readme-badges.cjs --write    rewrite the badge block in README.md
 *   folder layout: node scripts/readme-badges.cjs [--write] FILE   the same on another file
 *
 * WHY. A hand-written badge drifts: the README said "10 phases" while the phase table had 13 numbered rows. Each value
 * here has one source, named next to it, and tests/toolkit-distribution.test.mjs fails when the README differs.
 *
 * Sources: phases — the numbered rows of the `## Phase order` table in skills/build-module-pipeline.md (the `—`
 * orchestration row is not a phase) · personas — agents/*.md, not agents/experimental/ · tool targets — the keys of
 * `TOOLS` in cli.js · node — package.json engines.node · dependencies — zero when package.json has none · install — npm.
 * Exit 0 OK · 1 mismatch · 2 usage, no badge block or no such file. Node built-ins only.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const KIT = path.join(__dirname, '..');
const OPEN = '<p align="center">';
const CLOSE = '</p>';

/** The numbered rows of the phase table: a `#` cell that is not `—`, not the header and not the separator. */
function phaseCount(root = KIT) {
  const text = fs.readFileSync(path.join(root, 'skills', 'build-module-pipeline.md'), 'utf8');
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^## Phase order\s*$/.test(l));
  if (start === -1) throw new Error('skills/build-module-pipeline.md: no "## Phase order" section');
  let n = 0;
  for (let i = start + 1; i < lines.length && !/^## /.test(lines[i]); i++) {
    const m = /^\|\s*([^|]*?)\s*\|/.exec(lines[i]);
    if (!m) continue;
    const cell = m[1];
    if (cell === '#' || /^-+$/.test(cell) || cell === '' || /^[—-]+$/.test(cell)) continue;
    n++;
  }
  return n;
}

/** The neutral personas: agents/*.md (experimental/ is installed only with --experimental). */
function personaCount(root = KIT) {
  return fs.readdirSync(path.join(root, 'agents')).filter((n) => n.endsWith('.md')).length;
}

/** The `--tool` targets: the keys of the TOOLS table in cli.js (what `npx builder-pipeline targets` prints). */
function toolTargetCount(root = KIT) {
  const text = fs.readFileSync(path.join(root, 'cli.js'), 'utf8');
  const m = /^const TOOLS = \{\r?\n([\s\S]*?)^\};/m.exec(text);
  if (!m) throw new Error('cli.js: no `const TOOLS = { … };` table');
  return m[1].split(/\r?\n/).filter((l) => /^\s*'?[\w-]+'?:\s*\{/.test(l)).length;
}

/** Every badge value with the source it came from. */
function values(root = KIT) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const node = String((pkg.engines && pkg.engines.node) || '');
  const floor = /^>=\s*(\d+)/.exec(node);
  if (!floor) throw new Error(`package.json engines.node is ${JSON.stringify(node)}, expected ">=N"`);
  const deps = Object.keys(pkg.dependencies || {}).length;
  return {
    phases: { value: phaseCount(root), source: 'skills/build-module-pipeline.md § Phase order (numbered rows)' },
    personas: { value: personaCount(root), source: 'agents/*.md (not agents/experimental/)' },
    toolTargets: { value: toolTargetCount(root), source: 'cli.js TOOLS keys' },
    node: { value: floor[1], source: 'package.json engines.node' },
    deps: { value: deps === 0 ? 'zero' : String(deps), source: 'package.json dependencies' },
    install: { value: 'npm', source: 'package.json name (registry listing from 2.0.0)' },
  };
}

/**
 * The badge lines, in README order. The first and last badges are fixed claims the kit's design makes. Labels are
 * written as shields.io reads them: `_` is a space, `--` is a literal dash (so `--tool_targets` renders `-tool targets`).
 */
function badgeLines(root = KIT) {
  const v = values(root);
  const img = (alt, label, value, colour, extra = '') => `  <img alt="${alt}" src="https://img.shields.io/badge/${label}-${value}-${colour}?style=flat-square${extra}">`;
  return [
    img('agent-agnostic', 'agents', 'agnostic_by_design', 'critical'),
    img('pipeline', 'pipeline', `${v.phases.value}_phases`, 'blue'),
    img('personas', 'personas', `${v.personas.value}_agents`, '8A2BE2'),
    img('harnesses', '--tool_targets', String(v.toolTargets.value), 'success'),
    img('deps', 'CLI_dependencies', v.deps.value, 'brightgreen'),
    img('node', 'node', `%E2%89%A5${v.node.value}`, '339933', '&logo=node.js&logoColor=white'),
    img('install', 'install', v.install.value, 'orange'),
    img('inert', 'at_rest', '100%25_inert', 'lightgrey'),
  ];
}

/** The whole block, markers included, as it stands in the README. */
function badges(root = KIT) {
  return [OPEN, ...badgeLines(root), CLOSE].join('\n');
}

/** The badge block of a README text: its line range, or null when a marker is missing. */
function locate(text) {
  const lines = text.split(/\r?\n/);
  const open = lines.findIndex((l) => l.trim() === OPEN);
  if (open === -1) return null;
  const close = lines.findIndex((l, i) => i > open && l.trim() === CLOSE);
  if (close === -1) return null;
  return { lines, open, close };
}

/** One entry per badge whose line differs from the generated one: `alt: expected … got …`. */
function check(text, root = KIT) {
  const at = locate(text);
  if (!at) return ['no badge block: the README needs `<p align="center">` … `</p>` around the badges'];
  const have = at.lines.slice(at.open + 1, at.close).map((l) => l.trim());
  const want = badgeLines(root).map((l) => l.trim());
  const alt = (l) => (/alt="([^"]*)"/.exec(l) || [, '?'])[1];
  const out = [];
  for (let i = 0; i < Math.max(have.length, want.length); i++) {
    if (have[i] !== want[i]) out.push(`${alt(want[i] || have[i])}: expected ${want[i] || '(no line)'} — got ${have[i] || '(no line)'}`);
  }
  return out;
}

/** The text with its badge block replaced; null when there is no block. */
function rewrite(text, root = KIT) {
  const at = locate(text);
  if (!at) return null;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  return [...at.lines.slice(0, at.open), ...badges(root).split('\n'), ...at.lines.slice(at.close + 1)].join(eol);
}

function main(argv) {
  const write = argv.includes('--write');
  const file = path.resolve(argv.find((a) => a !== '--write') || path.join(KIT, 'README.md'));
  if (!fs.existsSync(file)) {
    console.error(`readme-badges: no such file — ${file}`);
    return 2;
  }
  const text = fs.readFileSync(file, 'utf8');
  if (write) {
    const next = rewrite(text);
    if (next === null) {
      console.error(`readme-badges: no badge block found in ${file} (needs ${OPEN} … ${CLOSE}); nothing written`);
      return 2;
    }
    if (next !== text) fs.writeFileSync(file, next);
    console.log(`readme-badges: ${next === text ? 'already current' : 'rewrote the badge block in'} ${path.relative(process.cwd(), file) || '.'}`);
    return 0;
  }
  const problems = check(text);
  for (const p of problems) console.log(`readme-badges: ${p}`);
  console.log(problems.length ? `readme-badges: FAIL — ${problems.length} badge(s) differ; run with --write` : 'readme-badges: OK');
  return problems.length ? 1 : 0;
}

module.exports = { badges, badgeLines, check, rewrite, values, phaseCount, personaCount, toolTargetCount };

if (require.main === module) process.exit(main(process.argv.slice(2)));
