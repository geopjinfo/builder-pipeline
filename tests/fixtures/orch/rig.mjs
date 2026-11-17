/**
 * Shared rig for the orchestrator tests: scratch git repos, a profile with features.orchestrator on, and a runner
 * for the CLI. Not a test file itself (the runner picks up *.test.mjs only).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
export const PACK = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const ORCH = join(PACK, 'scripts', 'orch.mjs');
export const FIX = join(PACK, 'tests', 'fixtures', 'orch');
export const STUB = join(FIX, 'stub-worker.cjs');
export const registry = require(join(PACK, 'scripts', 'lib', 'accounts-registry.cjs'));
const accountPaths = require(join(PACK, 'scripts', 'lib', 'account-paths.cjs'));

export const tmp = (p) => mkdtempSync(join(tmpdir(), `orch-${p}-`));
const ACCOUNTS_HOME = tmp('accounts-home');
export const ACCOUNTS_HOME_OF = () => ACCOUNTS_HOME;
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
 * `caps` (default true) gives every migrated terminal account `maxTurns` and `timeoutMinutes`, which every launch needs
 * (REQ-305); `caps: false` leaves them out for the refusal test. `accounts` patches the migrated account rows by name.
 */
export function profileText({ orchestrator = {}, models = { strong: 'strong-model', mid: 'mid-model', orchestrator: null }, protectedGlobs = ['src/platform/**'], extraFeatures = {}, legacy = false, caps = true, accounts = {} } = {}) {
  let block = {
    schema: 2,
    commands: { tier: null, tiers: [], affected: null, typecheck: null },
    models,
    protected: protectedGlobs,
    features: { orchestrator: { state: 'on', target: 'dev', ...orchestrator }, ...extraFeatures },
  };
  if (!legacy) {
    // extra account rows need a registry: a profile with no seat keys gets the 1.0 default seat (the session) first
    if (Object.keys(accounts).length && block.features.orchestrator.seats === undefined) block.features.orchestrator.seats = ['primary'];
    block = registry.migrate(block).settings;
    const rows = (block.features.accounts && block.features.accounts.accounts) || {};
    for (const [name, a] of Object.entries(rows)) {
      if (caps && a.worker !== 'session') Object.assign(a, { maxTurns: a.maxTurns ?? 40, timeoutMinutes: a.timeoutMinutes ?? 90 });
      if (accounts[name]) Object.assign(a, accounts[name]);
    }
    for (const [name, a] of Object.entries(accounts)) if (!rows[name]) rows[name] = a;
    for (const a of Object.values(rows)) delete a.name; // a row's name is its key, never a field
    // every terminal account has its dir, as a signed-in account would: the pre-launch dir check (REQ-703) judges a missing one
    for (const [name, a] of Object.entries(rows)) if (a.worker !== 'session') mkdirSync(accountPaths.paths(ACCOUNTS_HOME, name, a).configDir, { recursive: true });
  }
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

/**
 * A bin dir with stub `claude` and `codex` executables that answer "signed in" (a `.js` plus a `.cmd` shim, so the
 * stubs run on win32 too): the readiness assessment inside every orch command probes them, never a real harness.
 * `claude` prints the `claude auth status` JSON (signed out when the config dir ends in `-down`); `codex` prints
 * `codex login status` to stderr.
 */
export function stubBin(dir = tmp('bin'), { claude = 'const d = process.env.CLAUDE_CONFIG_DIR || ""; const down = /-down$/.test(d); console.log(JSON.stringify({ loggedIn: !down, authMethod: down ? null : "oauth", configDirectory: d || null })); process.exit(down ? 1 : 0)', codex = 'console.error("Logged in using ChatGPT")' } = {}) {
  for (const [name, body] of [['claude', claude], ['codex', codex]]) {
    const js = join(dir, `${name}.js`);
    writeFileSync(js, `#!/usr/bin/env node\n${body}\n`);
    writeFileSync(join(dir, name), `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`);
    writeFileSync(join(dir, `${name}.cmd`), `@"${process.execPath}" "%~dp0${name}.js" %*\r\n`);
    try {
      chmodSync(join(dir, name), 0o755);
      chmodSync(js, 0o755);
    } catch {
      /* win32 */
    }
  }
  return dir;
}
const STUBS = stubBin();

/** Run the CLI in `cwd` with the store at `root`; the stub harnesses are first on PATH and the accounts home is scratch. */
export function orch(cwd, root, args, env = {}) {
  const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') || 'PATH';
  const r = spawnSync(process.execPath, [ORCH, ...args], { cwd, encoding: 'utf8', timeout: 60000, env: { ...process.env, [pathKey]: `${STUBS}${delimiter}${process.env[pathKey] || ''}`, BUILDER_ACCOUNTS_HOME: ACCOUNTS_HOME, BUILDER_ORCH_DIR: root, BUILDER_NO_BASH_CAP: '1', ...env } });
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
