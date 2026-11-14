/**
 * Generate a run's handoff pack skeleton at close-out. Check it with scripts/handoff-check.mjs.
 *
 *   node scripts/handoff-pack.mjs <key> [--base <ref>] [--out <path>] [--date YYYY-MM-DD]
 *
 * Reads the board (<boards>/<key>.md: rows done / deferred / dropped / open), the run log (<runs>/<key>/run.jsonl:
 * verdict, last result per gate), the registry diff against --base (default: main), the decision ids the board
 * cites, HEAD, and the version — the top versioned heading of the nearest CHANGELOG.md, else a package manifest
 * (package.json, pyproject.toml, Cargo.toml), else `<fill version>`. Everything a script cannot know is left as
 * `<fill …>`; the checker refuses the pack until it is filled.
 *
 * Writes <paths.handoffs>/<date>-<key>-handoff.md unless --out is given, then prints how many placeholders remain.
 * Exit 0 written (or the feature is off) · 2 usage or an invalid profile.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { readContext, settingsOrExit } from './handoff-check.mjs';

const require = createRequire(import.meta.url);
const { runHint } = require('./lib/run-hint.cjs');
const lib = require('./lib/handoff-check.cjs');
const runLog = require('./lib/run-log.cjs');

const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf(n);
  return i === -1 ? d : argv[i + 1];
};
const key = argv[0];
if (!key || key.startsWith('--')) {
  console.error(`usage: ${runHint('handoff-pack')} <key> [--base <ref>] [--out <path>] [--date YYYY-MM-DD]`);
  process.exit(2);
}
const { settings, feature } = settingsOrExit('handoff-pack');
const paths = settings.paths;

/** git, or '' — a checkout without git (or without the base ref) yields placeholders, never a crash. */
const git = (...a) => {
  try {
    return execFileSync('git', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
};

const base = flag('--base', 'main');
const date = flag('--date', new Date().toISOString().slice(0, 10));
const out = flag('--out', join(paths.handoffs, `${date}-${key}-handoff.md`));
const boardPath = join(paths.boards, `${key}.md`);
const board = existsSync(boardPath) ? readFileSync(boardPath, 'utf8') : '';
if (!board) console.log(`handoff-pack: no board at ${boardPath} — the progress line is empty`);

const log = runLog.read(join(paths.runs, key, 'run.jsonl'));
const decisionIdPattern = feature.config.decisionIdPattern || lib.DEFAULT_DECISION_ID;
const registryIdPattern = settings.features?.claims?.registryIdPattern || lib.DEFAULT_REGISTRY_ID;
const diff = git('diff', base, '--', paths.registry);

/** The nearest CHANGELOG.md: this directory, then each parent up to (and including) the repository root. */
function nearestChangelog() {
  let dir = resolve('.');
  for (;;) {
    const p = join(dir, 'CHANGELOG.md');
    if (existsSync(p)) return readFileSync(p, 'utf8');
    if (existsSync(join(dir, '.git')) || dirname(dir) === dir) return null;
    dir = dirname(dir);
  }
}
const manifests = ['package.json', 'pyproject.toml', 'Cargo.toml'].filter((n) => existsSync(n)).map((name) => ({ name, text: readFileSync(name, 'utf8') }));

const pack = lib.renderPack({
  key,
  sha: (git('rev-parse', '--short', 'HEAD') ?? '').trim(),
  version: lib.versionFrom({ changelog: nearestChangelog(), manifests }),
  base,
  date,
  verdict: log.end?.verdict ?? null,
  gates: log.gatesLatest ?? [],
  board: lib.summariseBoard(board),
  registryChanges: diff === null ? null : lib.registryChanges(diff, registryIdPattern),
  decisions: [...lib.idsIn(board, decisionIdPattern)],
  trackerFiles: feature.config.tracker ? feature.config.tracker.files ?? [] : null,
});

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, pack);
let errors = [];
try {
  errors = lib.checkHandoff(pack, readContext(settings, feature));
} catch (e) {
  errors = [e.message];
}
const placeholders = errors.filter((e) => /placeholder/.test(e));
const other = errors.filter((e) => !/placeholder/.test(e));
console.log(`handoff-pack — wrote ${out.replace(/\\/g, '/')}; ${placeholders.length} placeholder(s) to fill, ${other.length} other problem(s)`);
for (const e of other) console.log(`  ${e}`);
