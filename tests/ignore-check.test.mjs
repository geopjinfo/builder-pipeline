/**
 * REQ-1811 — ignore-check (specs/repo-hygiene.spec.md, M19). The catalogue, TRACKED-JUNK, UNIGNORED-JUNK, `allow`,
 * the .gitignore lines to add, and the rule that the file is never written (D97). A soft check: exit 0 with findings.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const PACK = join(dirname(fileURLToPath(import.meta.url)), '..');
const lib = require('../scripts/lib/ignore-check.cjs');
const made = [];
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

const git = (cwd, ...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
const repo = () => {
  const dir = mkdtempSync(join(tmpdir(), 'ignore-check-'));
  made.push(dir);
  git(dir, 'init', '-q');
  return dir;
};
const write = (dir, rel, text) => {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
};
const profile = (features) => `# Profile\n\n## 16\n\n\`\`\`json pipeline-settings\n${JSON.stringify({ schema: 2, features })}\n\`\`\`\n`;
const run = (cwd, args = []) => spawnSync(process.execPath, [join(PACK, 'scripts', 'ignore-check.mjs'), ...args], { cwd, encoding: 'utf8', env: { ...process.env, BUILDER_CONFIG: '' } });

function junkRepo(features) {
  const dir = repo();
  write(dir, 'src/index.js', 'module.exports = 1;\n');
  write(dir, 'debug.log', 'noise\n');
  write(dir, '.gitignore', 'node_modules/\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  write(dir, '.env', 'SECRET_PLACEHOLDER=1\n');
  if (features) write(dir, 'PIPELINE_PROFILE.md', profile(features));
  return dir;
}

describe('REQ-1811 — the catalogue and the two verdicts', () => {
  test('red: AC-1811 a tracked debug.log is TRACKED-JUNK, an untracked .env is UNIGNORED-JUNK, the two lines print, exit 0, .gitignore unchanged', () => {
    const dir = junkRepo({ ignoreCheck: { state: 'on' } });
    const before = readFileSync(join(dir, '.gitignore'), 'utf8');
    const r = run(dir);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^TRACKED-JUNK\s+debug\.log — matches \*\.log$/m);
    assert.match(r.stdout, /^UNIGNORED-JUNK\s+\.env — matches \.env$/m);
    assert.match(r.stdout, /\.gitignore lines to add:\n\*\.log\n\.env\n/);
    assert.match(r.stdout, /^ignore-check: 2 finding\(s\) — 1 tracked, 1 unignored · \.gitignore is yours to edit \(D97\)$/m);
    assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8'), before);
  });

  test('red: AC-1811b debug.log in allow leaves one finding, and the allowed line is not proposed', () => {
    const dir = junkRepo({ ignoreCheck: { state: 'on', allow: ['debug.log'] } });
    const r = run(dir);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout, /TRACKED-JUNK/);
    assert.match(r.stdout, /^UNIGNORED-JUNK\s+\.env/m);
    assert.match(r.stdout, /ignore-check: 1 finding\(s\)/);
  });

  test('red: extra adds a pattern, the catalogue is never removed from, and an ignored match is no finding', () => {
    const dir = junkRepo({ ignoreCheck: { state: 'on', extra: ['*.tmp'] } });
    write(dir, 'scratch.tmp', 'x');
    write(dir, 'node_modules/left/index.js', 'x'); // ignored by the project's .gitignore: not a finding
    const r = run(dir);
    assert.match(r.stdout, /^UNIGNORED-JUNK\s+scratch\.tmp — matches \*\.tmp$/m);
    assert.doesNotMatch(r.stdout, /node_modules/);
    assert.ok(lib.CATALOGUE.includes('*.log') && lib.CATALOGUE.includes('.env.*') && lib.CATALOGUE.includes('node_modules/'));
  });

  test('red: off prints the not-configured line and exits 3; --defaults runs with the defaults and says so', () => {
    const dir = junkRepo();
    const off = run(dir);
    assert.equal(off.status, 3, off.stdout + off.stderr);
    assert.equal(off.stdout.trim(), 'ignoreCheck: not configured');
    const dflt = run(dir, ['--defaults']);
    assert.equal(dflt.status, 0, dflt.stdout + dflt.stderr);
    assert.match(dflt.stdout, /^ignoreCheck: not configured — checking with defaults$/m);
    assert.match(dflt.stdout, /TRACKED-JUNK\s+debug\.log/);
    assert.equal(run(dir, ['--nonsense']).status, 2);
  });

  test('judge: the catalogue matches a folder segment, a basename glob and a core dump; a path match is by file, never by substring', () => {
    const j = (rel) => lib.matchOf(rel, lib.CATALOGUE);
    assert.equal(j('web/dist/app.js'), 'dist/');
    assert.equal(j('distribution/notes.md'), null);
    assert.equal(j('docs/.env.production'), '.env.*');
    assert.equal(j('core'), 'core dumps');
    assert.equal(j('core.1234'), 'core dumps');
    assert.equal(j('src/core.js'), null);
    assert.equal(j('README.md.orig'), '*.orig');
    assert.equal(j('.pipeline/run1/run.jsonl'), '.pipeline/');
    assert.equal(existsSync(join(PACK, 'scripts', 'ignore-check.mjs')), true);
  });
});
