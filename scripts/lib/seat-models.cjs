/**
 * Seat model parity (specs/pipeline-cost-3.spec.md REQ-2021, REQ-2029; D150, D151). Rule and reading of
 * `npx builder-pipeline run seat-models`.
 *
 * WHY. A persona declares a tier (`strong` | `mid`); the Claude Code install writes a `model:` line from the tier →
 * model map (opus / sonnet by default, or `--models`). Profile §16 `models.strong` / `models.mid` is where a project
 * declares its models, but until pipeline-cost-3 the install never read it: the benchmark pinned both to
 * claude-sonnet-5-5 and the seats still ran Opus, 76 to 83 percent of the kit's cost (plan of 20 November 2026).
 * Two rules close the gap: the install reads §16 (cli.js), and this check reads the installed agents back against it.
 *
 * `check(root, kitRoot, settings)` → { declared, entries, drift }. `declared` is the §16 map with placeholders and
 * nulls removed; `entries` one per installed `.claude/agents/*.md` whose name is a kit persona (`builder-` prefix
 * stripped), with its tier (from the kit's neutral `agents/**.md`), the model installed and the model expected;
 * `drift` the entries whose model differs from the declared one for their tier. A tier with no declared model is in
 * step by definition. A project-owned agent (no kit persona of that name) is skipped.
 *
 * `write(root, result)` rewrites the `model:` line of every drifted agent and refreshes its builder.lock.json hash,
 * so the next `upgrade` sees a kit-owned file, not a local edit.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const TIERS = ['strong', 'mid', 'low'];
const PLACEHOLDER = /<[^<>\n]{2,80}>/;
const AGENTS_DIR = path.join('.claude', 'agents');
const LOCK_FILE = 'builder.lock.json';

/** The models profile §16 declares, by tier: strings only, no unfilled placeholder. */
function declaredModels(settings) {
  const out = {};
  for (const tier of TIERS) {
    const v = settings?.models?.[tier];
    if (typeof v === 'string' && v.trim() && !PLACEHOLDER.test(v)) out[tier] = v.trim();
  }
  return out;
}

const frontmatter = (text) => {
  if (!text.startsWith('---')) return null;
  const end = text.indexOf('\n---', 3);
  return end === -1 ? null : text.slice(3, end);
};
const field = (fm, key) => ((fm.match(new RegExp(`^${key}:[ \\t]*(.*)$`, 'm')) || [])[1] || '').split('#')[0].trim();

/** The kit's personas by name → tier, from `agents/*.md` and `agents/experimental/*.md`. */
function kitTiers(kitRoot) {
  const out = {};
  for (const dir of [path.join(kitRoot, 'agents'), path.join(kitRoot, 'agents', 'experimental')]) {
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')); } catch { continue; }
    for (const f of files) {
      const fm = frontmatter(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (!fm) continue;
      const name = field(fm, 'name') || path.basename(f, '.md');
      out[name] = field(fm, 'tier') || 'strong';
      out[path.basename(f, '.md')] = out[name];
    }
  }
  return out;
}

function check(root, kitRoot, settings) {
  const declared = declaredModels(settings);
  const tiers = kitTiers(kitRoot);
  const dir = path.join(root, AGENTS_DIR);
  const entries = [];
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort(); } catch { files = []; }
  for (const f of files) {
    const abs = path.join(dir, f);
    const text = fs.readFileSync(abs, 'utf8');
    const fm = frontmatter(text);
    if (!fm) continue;
    const stem = path.basename(f, '.md');
    const key = Object.prototype.hasOwnProperty.call(tiers, stem) ? stem : stem.replace(/^builder-/, '');
    if (!Object.prototype.hasOwnProperty.call(tiers, key)) continue;
    const tier = tiers[key];
    const model = field(fm, 'model');
    const expected = declared[tier] ?? null;
    entries.push({ file: `${AGENTS_DIR.split(path.sep).join('/')}/${f}`, name: stem, tier, model, expected, ok: expected === null || model === expected });
  }
  return { declared, entries, drift: entries.filter((e) => !e.ok) };
}

/** `seat models: …` lines: one verdict line, or one `DRIFT:` line per agent. */
function render(result) {
  const declared = Object.entries(result.declared).map(([k, v]) => `${k}=${v}`).join(', ');
  if (!declared) return ['seat models: profile §16 declares no strong or mid model — nothing to compare'];
  if (!result.entries.length) return [`seat models: no kit agent installed under ${AGENTS_DIR.split(path.sep).join('/')} (declared ${declared})`];
  if (!result.drift.length) return [`seat models: in step — ${result.entries.length} agent(s) on the declared models (${declared})`];
  return result.drift.map((e) => `DRIFT: ${e.file} runs ${e.model || '(no model line)'}, profile §16 declares ${e.tier}=${e.expected}`);
}

const shaOf = (text) => crypto.createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');

/** Rewrite the model line of every drifted agent; refresh its lock hash. Returns the files written. */
function write(root, result) {
  const written = [];
  let lock = null;
  const lockPath = path.join(root, LOCK_FILE);
  try { lock = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch { lock = null; }
  for (const e of result.drift) {
    const abs = path.join(root, ...e.file.split('/'));
    const text = fs.readFileSync(abs, 'utf8');
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const next = /^model:.*$/m.test(text)
      ? text.replace(/^model:.*$/m, `model: ${e.expected}`)
      : text.replace(/^---(\r?\n)/, `---$1model: ${e.expected}$1`);
    fs.writeFileSync(abs, next.split(/\r?\n/).join(eol));
    if (lock?.files && Object.prototype.hasOwnProperty.call(lock.files, e.file)) lock.files[e.file] = shaOf(next);
    written.push(e.file);
  }
  if (written.length && lock) fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
  return written;
}

module.exports = { TIERS, declaredModels, kitTiers, check, render, write };
