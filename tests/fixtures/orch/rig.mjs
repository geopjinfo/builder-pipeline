/**
 * Shared rig for the orchestrator tests: scratch git repos, a profile with features.orchestrator on, and a runner
 * for the CLI. Not a test file itself (the runner picks up *.test.mjs only).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
export const PACK = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const ORCH = join(PACK, 'scripts', 'orch.mjs');
export const FIX = join(PACK, 'tests', 'fixtures', 'orch');
export const STUB = join(FIX, 'stub-worker.cjs');
export const registry = require(join(PACK, 'scripts', 'lib', 'accounts-registry.cjs'));

export const tmp = (p) => mkdtempSync(join(tmpdir(), `orch-${p}-`));
export const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

/** The project path rules the sample plan is written against. */
export const PATHS = {
  sourceRoots: ['src/'],
  riskPaths: { migration: ['db/migrations/**'], platform: ['src/platform/**'], permission: ['config/permissions.csv'] },
  modulePattern: '^src/modules/([^/]+)/',
  hot: ['CHANGELOG.md', 'contracts/openapi.json', 'db/migrations/**', 'config/permissions.csv'],
};

/**
 * A PIPELINE_PROFILE.md holding only the settings block. The orchestrator options may still be written in the 1.0
 * seat shape (`seats`, `limits`, `secondaryConfigDir`, `credit`): the rig runs `accounts migrate` on them, so every
 * orchestrator test also proves the migration (REQ-106). `legacy: true` keeps the 1.0 keys as written.
 */
export function profileText({ orchestrator = {}, models = { strong: 'strong-model', mid: 'mid-model', orchestrator: null }, protectedGlobs = ['src/platform/**'], extraFeatures = {}, legacy = false } = {}) {
  let block = {
    schema: 2,
    commands: { tier: null, tiers: [], affected: null, typecheck: null },
    models,
    protected: protectedGlobs,
    features: { orchestrator: { state: 'on', target: 'dev', ...orchestrator }, ...extraFeatures },
  };
  if (!legacy) block = registry.migrate(block).settings;
  return `# profile\n\n\`\`\`json pipeline-settings\n${JSON.stringify(block, null, 2)}\n\`\`\`\n`;
}

/** A primary checkout on branch `dev` with a committed profile. */
export function scratchRepo({ profile = profileText(), files = {} } = {}) {
  const dir = tmp('repo');
  const repo = join(dir, 'primary');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'dev');
  git(repo, 'config', 'user.email', 'orch@test.local');
  git(repo, 'config', 'user.name', 'orch test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  git(repo, 'config', 'core.autocrlf', 'false');
  const all = { 'CHANGELOG.md': '# Changelog\n\n## next\n- base\n', 'a.txt': 'a\n', '.gitignore': '.pipeline/\nlogs/\n.claude/settings.local.json\n', 'PIPELINE_PROFILE.md': profile, ...files };
  for (const [rel, text] of Object.entries(all)) {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    writeFileSync(join(repo, rel), text);
  }
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');
  return { dir, repo, root: join(dir, 'orch') };
}

/** A lane worktree on `branch` (cut from dev) that commits one file. */
export function laneWorktree(dir, repo, branch, file, text) {
  const wt = join(dir, branch.replace(/\//g, '-'));
  git(repo, 'worktree', 'add', '-q', '-b', branch, wt, 'dev');
  writeFileSync(join(wt, file), text);
  git(wt, 'add', '.');
  git(wt, 'commit', '-q', '-m', `${branch} work`);
  return wt;
}

/** Run the CLI in `cwd` with the store at `root`. */
export function orch(cwd, root, args, env = {}) {
  const r = spawnSync(process.execPath, [ORCH, ...args], { cwd, encoding: 'utf8', timeout: 60000, env: { ...process.env, BUILDER_ORCH_DIR: root, BUILDER_NO_BASH_CAP: '1', ...env } });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', out: `${r.stdout || ''}${r.stderr || ''}` };
}

/** A split result with n plain lanes (no plan file needed). */
export function lanes(n, extra = {}) {
  return {
    maxLanes: 2,
    rows: [],
    lanes: Array.from({ length: n }, (_, i) => ({ name: `l${i + 1}`, rows: [`R${i + 1}`], level: 'Standard', track: 'ADDITIVE', dispatch: 'full', ownedFiles: [`f${i + 1}.ts`], hotFiles: [], ...extra })),
  };
}
