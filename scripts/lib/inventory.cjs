'use strict';
/**
 * What a project already has, before the kit adds anything — the mechanical half of `builder-init`.
 *
 * WHY. A project that already runs its own skills, agents or personas loses them silently to an installer that
 * writes first and asks never: a kit `code-review` beside a project `code-review`, or two seats that do the same job
 * under different names, and the harness now loads both or the wrong one. The ruling is that the project's items win
 * by default and nothing that could clash lands until a person decided it. This module does the part that needs no
 * judgement: it lists every item, fingerprints it, and scores how much each one looks like each kit item. The
 * `builder-init` skill then reviews EVERY item (not only the high scores) and the human confirms per item; the
 * decisions go to `builder.choices.json` (scripts/lib/choices.cjs).
 *
 * Reads the filesystem only. No network, no dependencies, nothing written.
 *
 *   inventory(projectRoot)      -> items[]    { kind, tool, name, path, sha256, description, triggers }
 *   kitInventory(kitRoot)       -> items[]    the same shape, for what the kit would install
 *   overlaps(items, kitItems)   -> pairs[]    { project, kit, sameName, sameContent, score, reason }
 *   mode(projectRoot)           -> { mode: 'greenfield'|'brownfield', evidence }
 *   report(projectRoot, kitRoot)-> everything above in one object (what `inventory --json` prints)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** Where each harness keeps the items the kit could clash with. `layout`: 'dir' = <name>/SKILL.md, 'file' = <name>.<ext>. */
const LOCATIONS = [
  { dir: '.claude/skills', kind: 'skill', tool: 'claude-code', layout: 'dir' },
  { dir: '.claude/agents', kind: 'agent', tool: 'claude-code', layout: 'file', ext: ['.md'] },
  { dir: '.claude/hooks', kind: 'hook', tool: 'claude-code', layout: 'file', ext: null },
  { dir: '.agents/skills', kind: 'skill', tool: 'codex/antigravity', layout: 'dir' },
  { dir: '.agents/agents', kind: 'agent', tool: 'codex/antigravity', layout: 'file', ext: ['.md', '.toml'] },
  { dir: '.codex/agents', kind: 'agent', tool: 'codex', layout: 'file', ext: ['.md', '.toml'] },
  { dir: '.builder/personas', kind: 'persona', tool: 'builder', layout: 'file', ext: ['.md'] },
  { dir: '.builder/playbooks', kind: 'playbook', tool: 'builder', layout: 'file', ext: ['.md'] },
  { dir: '.builder/skills', kind: 'skill', tool: 'builder', layout: 'dir' },
  { dir: 'personas', kind: 'persona', tool: 'project', layout: 'file', ext: ['.md'] },
];

/** Kinds that can stand in for one another. A hook never clashes with a skill; a persona and an agent are one seat. */
const FAMILY = { skill: 'skill', playbook: 'skill', agent: 'seat', persona: 'seat', hook: 'hook' };

/** Pairs at or above this score are reported even with different names and contents. */
const SIMILAR = 0.3;

const posix = (p) => p.split(path.sep).join('/');
/** Line endings are not content: a checkout with autocrlf must not read an identical file as different. */
const normalise = (buf) => buf.toString('utf8').replace(/\r\n/g, '\n');
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

/** `name` and `description` from YAML-ish frontmatter (one line each), or null. */
function frontmatter(text) {
  if (!text.startsWith('---')) return null;
  const end = text.indexOf('\n---', 3);
  if (end === -1) return null;
  const fm = text.slice(3, end);
  const lines = fm.split('\n');
  const get = (k) => {
    const i = lines.findIndex((l) => l.startsWith(`${k}:`));
    if (i === -1) return '';
    const v = lines[i].slice(k.length + 1).trim();
    // A folded or literal block (`description: >`) continues on the indented lines below it.
    if (/^[>|][+-]?$/.test(v)) {
      const more = [];
      for (let j = i + 1; j < lines.length && /^\s+\S/.test(lines[j]); j++) more.push(lines[j].trim());
      return more.join(' ');
    }
    return v.replace(/^(['"])([\s\S]*)\1$/, '$2');
  };
  return { name: get('name'), description: get('description'), body: text.slice(end + 4) };
}

/** A TOML agent file's `name` / `description` (single-line string values only). */
function tomlFields(text) {
  const get = (k) => ((text.match(new RegExp(`^${k}\\s*=\\s*"([^"\\n]*)"`, 'm')) || [])[1] || '');
  return { name: get('name'), description: get('description') };
}

/** The first prose line of a body: what a file without a description says it is for. */
function firstProse(body, markdown = true) {
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    // In a shell script `#` is a comment, not a heading: the first worded comment says what it is for.
    if (!markdown && /^#(?!!)/.test(line)) {
      const t = line.replace(/^#+\s*/, '').trim();
      if (/[a-z]{3}/i.test(t)) return t.slice(0, 240);
      continue;
    }
    if (!markdown && /^(set |\[|\(|if |exit\b|[A-Z_]+=)/.test(line)) continue;
    if (!line || line.startsWith('#') || line.startsWith('```') || line.startsWith('<!--') || line === '---') continue;
    if (line.startsWith('//') || line.startsWith('/*') || line.startsWith('*')) {
      const c = line.replace(/^(\/\/+|\/\*+|\*+)\s*/, '').replace(/\*\/$/, '').trim();
      if (c && !c.startsWith('!') && c !== "'use strict';") return c.slice(0, 240);
      continue;
    }
    if (/^['"]use strict['"];?$/.test(line) || line.startsWith('#!')) continue;
    return line.slice(0, 240);
  }
  return '';
}

/** Quoted trigger phrases in a description: `Trigger on "x", "y"` → ['x', 'y']. */
function triggers(description) {
  const at = description.search(/trigger(s|ed)?\b/i);
  if (at === -1) return [];
  return [...description.slice(at).matchAll(/["“]([^"”]{2,80})["”]/g)].map((m) => m[1].trim());
}

/** One item from one file. */
function describe(abs, rel, { kind, tool }, fallbackName) {
  const raw = normalise(fs.readFileSync(abs));
  let name = fallbackName;
  let description = '';
  const fm = frontmatter(raw);
  if (fm) {
    name = fm.name || name;
    description = fm.description || firstProse(fm.body);
  } else if (abs.endsWith('.toml')) {
    const t = tomlFields(raw);
    name = t.name || name;
    description = t.description;
  } else {
    description = firstProse(raw, abs.endsWith('.md'));
  }
  return { kind, tool, name, path: posix(rel), sha256: sha256(raw), description, triggers: triggers(description) };
}

function listDir(abs) {
  try {
    return fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/** Every item under one location. A skill dir without a SKILL.md is still an item (its README or first .md). */
function scanLocation(root, loc) {
  const base = path.join(root, loc.dir);
  const out = [];
  for (const entry of listDir(base)) {
    const abs = path.join(base, entry.name);
    if (loc.layout === 'dir' && entry.isDirectory()) {
      const inner = listDir(abs).filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md'));
      const main = inner.find((e) => e.name === 'SKILL.md') || inner.find((e) => e.name.toLowerCase() === 'readme.md') || inner[0];
      if (!main) continue;
      out.push(describe(path.join(abs, main.name), path.join(loc.dir, entry.name, main.name), loc, entry.name));
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name);
      // A loose `<name>.md` in a skills dir is a skill some harnesses still load.
      if (loc.layout === 'dir' && ext !== '.md') continue;
      if (loc.layout === 'file' && loc.ext && !loc.ext.includes(ext)) continue;
      if (/^readme\.md$/i.test(entry.name)) continue;
      out.push(describe(abs, path.join(loc.dir, entry.name), loc, path.basename(entry.name, ext)));
    }
  }
  return out;
}

/** Every skill, agent, persona, playbook and hook the project already has, in a stable order. */
function inventory(projectRoot) {
  return LOCATIONS.flatMap((loc) => scanLocation(projectRoot, loc));
}

/**
 * What the kit would install, in the same shape. Names are the names the installer gives them (file basename),
 * because a clash is decided where the file lands. `path` is relative to the kit root.
 */
function kitInventory(kitRoot) {
  const out = [];
  const add = (rel, kind, name) => out.push(describe(path.join(kitRoot, rel), rel, { kind, tool: 'kit' }, name));
  for (const e of listDir(path.join(kitRoot, 'skills'))) {
    if (e.isFile() && e.name.endsWith('.md') && e.name !== 'state-template.md') add(path.join('skills', e.name), 'skill', path.basename(e.name, '.md'));
  }
  for (const e of listDir(path.join(kitRoot, 'agents'))) {
    if (e.isFile() && e.name.endsWith('.md')) add(path.join('agents', e.name), 'agent', path.basename(e.name, '.md'));
  }
  for (const e of listDir(path.join(kitRoot, 'skills-extra'))) {
    if (!e.isDirectory()) continue;
    const dir = path.join('skills-extra', e.name);
    if (fs.existsSync(path.join(kitRoot, dir, 'SKILL.md'))) add(path.join(dir, 'SKILL.md'), 'skill', e.name);
    for (const a of listDir(path.join(kitRoot, dir, 'agents'))) {
      if (a.isFile() && a.name.endsWith('.md')) add(path.join(dir, 'agents', a.name), 'agent', path.basename(a.name, '.md'));
    }
  }
  for (const sub of ['hooks', path.join('hooks', 'claude-code')]) {
    for (const e of listDir(path.join(kitRoot, sub))) {
      if (e.isFile() && /\.(c?js|mjs|sh)$/.test(e.name)) add(path.join(sub, e.name), 'hook', path.basename(e.name, path.extname(e.name)));
    }
  }
  // The frontmatter `name` wins over the file name for the description, but the clash key is the installed name.
  return out.map((it) => ({ ...it, name: path.basename(it.path).toUpperCase() === 'SKILL.MD' ? path.basename(path.dirname(it.path)) : path.basename(it.path, path.extname(it.path)) }));
}

// ------------------------------- similarity ---------------------------------

const STOP = new Set(
  ('a an and any are as at be before by can do does for from get has have how in into is it its of on or per run runs ' +
    'so such than that the their them then there these they this those to up use used uses using via was what when where ' +
    'which while who will with without you your skill skills agent agents persona personas trigger triggers triggered ' +
    'say says said user users file files one only also not no all each every other own here like just md')
    .split(' '),
);

/** Lower-cased word tokens; a crude singular so "reviews" meets "review". */
function tokens(text) {
  const out = new Set();
  for (const w of String(text).toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length < 3 || STOP.has(w) || /^\d+$/.test(w)) continue;
    out.add(w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
  }
  return out;
}

const itemTokens = (it) => tokens(`${it.name.replace(/[-_]/g, ' ')} ${it.description} ${(it.triggers || []).join(' ')}`);

function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Pairs of a project item and a kit item that could clash: same name, same content, or a token-Jaccard score over
 * name + description + trigger phrases at or above `threshold`. Only kinds of one family are compared. Sorted by
 * score, highest first. Every project item still goes to the AI review — a pair list is a hint, not the review.
 */
function overlaps(items, kitItems, { threshold = SIMILAR } = {}) {
  const pairs = [];
  for (const p of items) {
    const pt = itemTokens(p);
    for (const k of kitItems) {
      if (FAMILY[p.kind] !== FAMILY[k.kind]) continue;
      const sameName = p.name.toLowerCase() === k.name.toLowerCase();
      const sameContent = p.sha256 === k.sha256;
      const jac = jaccard(pt, itemTokens(k));
      const score = sameContent ? 1 : Math.round(jac * 1000) / 1000;
      if (!sameName && !sameContent && score < threshold) continue;
      const shared = [...pt].filter((t) => itemTokens(k).has(t)).sort();
      const reason = sameContent
        ? 'exact duplicate: byte-identical to the kit file (line endings ignored)'
        : sameName
          ? `same name, different content (wording score ${score})`
          : `similar purpose by wording (score ${score}; shared: ${shared.slice(0, 8).join(', ')})`;
      pairs.push({ project: p.path, projectName: p.name, kind: p.kind, kit: k.path, kitName: k.name, kitKind: k.kind, sameName, sameContent, score, reason });
    }
  }
  return pairs.sort((a, b) => b.score - a.score || Number(b.sameName) - Number(a.sameName) || a.project.localeCompare(b.project));
}

// --------------------------------- mode -------------------------------------

const SKIP_DIRS = new Set(['.git', 'node_modules', '.builder', '.pipeline', '.claude', '.agents', '.codex', 'dist', 'build', 'out', 'vendor', '.venv', 'venv', 'target', 'coverage', '__pycache__', 'builder']);
const CODE_EXT = new Set(['.js', '.cjs', '.mjs', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs', '.java', '.kt', '.cs', '.rb', '.php', '.swift', '.c', '.cc', '.cpp', '.h', '.hpp', '.scala', '.dart', '.vue', '.svelte', '.sql', '.ex', '.exs', '.lua']);
const MANIFESTS = ['package.json', 'pyproject.toml', 'requirements.txt', 'setup.py', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'Gemfile', 'composer.json', 'mix.exs', 'pubspec.yaml', 'Package.swift', 'deno.json'];
const INSTRUCTION_FILES = ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md', 'CONVENTIONS.md', '.github/copilot-instructions.md', '.cursorrules', '.cursor/rules', '.windsurf/rules', '.clinerules'];
/** Enough source to call it a codebase. Below it, a repo with no manifest and no own items is still being started. */
const CODE_FLOOR = 3;
const WALK_CAP = 5000;

/** A package.json that only exists because the kit was installed (no own deps, no own scripts) is not evidence. */
function manifestCounts(root, file) {
  if (file !== 'package.json') return true;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((d) => !/builder-pipeline$/.test(d));
    const scripts = Object.entries(pkg.scripts || {}).filter(([k, v]) => !(k === 'test' && /no test specified/.test(String(v))));
    return deps.length > 0 || scripts.length > 0 || Boolean(pkg.main || pkg.bin || pkg.exports);
  } catch {
    return true; // unreadable is still somebody's file
  }
}

function countFiles(root) {
  let files = 0;
  let code = 0;
  const stack = [root];
  while (stack.length && files < WALK_CAP) {
    const dir = stack.pop();
    for (const e of listDir(dir)) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(path.join(dir, e.name));
      } else if (e.isFile()) {
        files++;
        if (CODE_EXT.has(path.extname(e.name).toLowerCase())) code++;
      }
    }
  }
  return { files, code, capped: files >= WALK_CAP };
}

/**
 * Greenfield (being started: interview first) or brownfield (has code or its own agent setup: read first), with the
 * evidence so the skill can show its working and the human can overrule it.
 */
function mode(projectRoot) {
  const counts = countFiles(projectRoot);
  const manifests = MANIFESTS.filter((f) => fs.existsSync(path.join(projectRoot, f)));
  const countedManifests = manifests.filter((f) => manifestCounts(projectRoot, f));
  const instructionFiles = INSTRUCTION_FILES.filter((f) => fs.existsSync(path.join(projectRoot, f)));
  const hasSrc = ['src', 'lib', 'app', 'cmd', 'pkg'].filter((d) => {
    try {
      return fs.statSync(path.join(projectRoot, d)).isDirectory();
    } catch {
      return false;
    }
  });
  const items = inventory(projectRoot).length;
  const evidence = {
    files: counts.files,
    codeFiles: counts.code,
    walkCapped: counts.capped,
    sourceDirs: hasSrc,
    manifests,
    countedManifests,
    instructionFiles,
    existingItems: items,
  };
  const reasons = [];
  if (counts.code >= CODE_FLOOR) reasons.push(`${counts.code} source file(s)`);
  if (hasSrc.length) reasons.push(`source dir(s): ${hasSrc.join(', ')}`);
  if (countedManifests.length) reasons.push(`package manifest(s): ${countedManifests.join(', ')}`);
  if (instructionFiles.length) reasons.push(`agent instruction file(s): ${instructionFiles.join(', ')}`);
  if (items) reasons.push(`${items} existing skill/agent/persona/hook item(s)`);
  evidence.reasons = reasons.length ? reasons : [`${counts.files} file(s), ${counts.code} source file(s), no manifest, no instruction file, no own items`];
  return { mode: reasons.length ? 'brownfield' : 'greenfield', evidence };
}

/** Everything `inventory --json` prints. */
function report(projectRoot, kitRoot, opts = {}) {
  const items = inventory(projectRoot);
  const kitItems = kitInventory(kitRoot);
  const pairs = overlaps(items, kitItems, opts);
  return { mode: mode(projectRoot), items, kitItems, overlaps: pairs, clashes: [...new Set(pairs.map((p) => `${p.kitKind}:${p.kitName}`))].sort() };
}

module.exports = { LOCATIONS, SIMILAR, inventory, kitInventory, overlaps, mode, report, tokens, jaccard, frontmatter, triggers };
