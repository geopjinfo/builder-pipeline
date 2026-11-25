/**
 * REQ-2028 to REQ-2030 — package pinning (specs/package-pinning.spec.md, D155). The shipped text gives the pinned form
 * `npx --no-install builder-pipeline …`; `pin-check` finds the bare form (UNPINNED, exit 1); the delivery gate row reads
 * it; `unpack` writes the pinned form; `builder-init` step 0 names the lock entry.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const PACK = join(dirname(fileURLToPath(import.meta.url)), '..');
const pin = require('../scripts/lib/pin-check.cjs');
const made = [];
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

const git = (cwd, ...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
const profile = (features) => `# Profile\n\n## 16\n\n\`\`\`json pipeline-settings\n${JSON.stringify({ schema: 2, features })}\n\`\`\`\n`;
const run = (cwd, script, args = []) => spawnSync(process.execPath, [join(PACK, 'scripts', script), ...args], { cwd, encoding: 'utf8', env: { ...process.env, BUILDER_CONFIG: '', BUILDER_ORCH_DIR: join(cwd, '.no-orch') } });

/** main: a README with one bare call, one --no-install call and one versioned call; a shell wrapper with a bare call. */
function rig(features) {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'pin-check-')));
  made.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'README.md'), '# x\n\nRun `npx builder-pipeline verify`.\nThen `npx --no-install builder-pipeline verify`.\nOr `npx builder-pipeline@2.1.0 verify`.\n');
  writeFileSync(join(dir, 'run.sh'), '#!/bin/sh\nnpm exec builder-pipeline features\n');
  writeFileSync(join(dir, 'tool.js'), "spawn('npx', ['builder-pipeline']); // code is not scanned by default\n");
  for (const f of ['README.md', 'run.sh', 'tool.js']) git(dir, 'add', f);
  git(dir, 'commit', '-q', '-m', 'init');
  if (features) writeFileSync(join(dir, 'PIPELINE_PROFILE.md'), profile(features));
  return dir;
}

describe('REQ-2030 — pin-check', () => {
  test('red: AC-2030a the bare npx form and npm exec are UNPINNED with path and line; --no-install and @version are not; exit 1', () => {
    const r = run(rig({ pinCheck: { state: 'on' } }), 'pin-check.mjs');
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /^UNPINNED\s+README\.md:3 — Run `npx builder-pipeline verify`\.$/m);
    assert.match(r.stdout, /^UNPINNED\s+run\.sh:2 — npm exec builder-pipeline features$/m);
    assert.doesNotMatch(r.stdout, /README\.md:[45]/);
    assert.doesNotMatch(r.stdout, /tool\.js/);
    assert.match(r.stdout, /^pin-check: FAIL — 2 unpinned kit call\(s\) in 2 file\(s\)/m);
  });

  test('red: AC-2030b allow suppresses by path → exit 0; --json gives the findings', () => {
    const dir = rig({ pinCheck: { state: 'on', allow: ['README.md', '*.sh'] } });
    const r = run(dir, 'pin-check.mjs');
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^pin-check: PASS — 0 unpinned/m);
    const j = JSON.parse(run(rig({ pinCheck: { state: 'on', files: ['*.md'] } }), 'pin-check.mjs', ['--json']).stdout);
    assert.equal(j.findings.length, 1);
    assert.deepEqual([j.findings[0].path, j.findings[0].line, j.scanned], ['README.md', 3, 1]);
  });

  test('red: AC-2030c off → not configured, exit 3; --defaults runs and says so; an unknown flag is usage (2)', () => {
    const dir = rig();
    const off = run(dir, 'pin-check.mjs');
    assert.equal(off.status, 3);
    assert.equal(off.stdout.trim(), 'pinCheck: not configured');
    const dflt = run(dir, 'pin-check.mjs', ['--defaults']);
    assert.equal(dflt.status, 1, dflt.stdout);
    assert.match(dflt.stdout, /^pinCheck: not configured — checking with defaults$/m);
    assert.equal(run(dir, 'pin-check.mjs', ['--nope']).status, 2);
  });

  test('red: AC-2030d the gate: pinCheck on, the rest off → delivery FAIL with the finding, six rows NOT CONFIGURED, exit 1', () => {
    const r = run(rig({ pinCheck: { state: 'on' } }), 'hygiene.mjs', ['--gate', '--json']);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    const g = JSON.parse(r.stdout);
    const row = Object.fromEntries(g.rows.map((x) => [x.gate, x]));
    assert.equal(g.rows.length, 7);
    assert.equal(row.delivery.result, 'FAIL');
    assert.match(row.delivery.findings.join('\n'), /README\.md:3/);
    assert.equal(g.rows.filter((x) => x.result === 'NOT CONFIGURED').length, 6);
  });

  test('scanText: the forms', () => {
    const hits = (t) => pin.scanText('x.md', t).length;
    assert.equal(hits('npx builder-pipeline verify'), 1);
    assert.equal(hits('npm exec -- builder-pipeline verify'), 1);
    assert.equal(hits('npx --no-install builder-pipeline verify'), 0);
    assert.equal(hits('npx --no builder-pipeline verify'), 0);
    assert.equal(hits('npx builder-pipeline@2.1.0 verify'), 0);
    assert.equal(hits('the builder-pipeline package'), 0);
  });
});

describe('REQ-2028 — the shipped text is pinned', () => {
  test('red: AC-2028a 0 UNPINNED over the kit (history, the decision log, the specs and the suite excepted)', () => {
    const r = pin.scan({ root: PACK, allow: ['CHANGELOG.md', 'DECISIONS.md', 'specs/**', 'tests/**'] });
    assert.ok(r.scanned > 50, `scanned ${r.scanned}`);
    assert.deepEqual(r.findings.map((f) => `${f.path}:${f.line}: ${f.text}`), []);
  });

  test('red: AC-2028b unpack installed as a package rewrites a folder-layout script command to the pinned form', () => {
    const proj = realpathSync.native(mkdtempSync(join(tmpdir(), 'pin-unpack-')));
    made.push(proj);
    const kit = join(proj, 'node_modules', 'builder-pipeline');
    mkdirSync(kit, { recursive: true });
    cpSync(PACK, kit, { recursive: true, filter: (src) => !/[\\/](?:\.git|tests|node_modules)(?:[\\/]|$)/.test(`/${relative(PACK, src)}`) });
    const u = spawnSync(process.execPath, [join(kit, 'cli.js'), 'unpack', '--tool', 'claude-code'], { cwd: proj, encoding: 'utf8' });
    assert.equal(u.status, 0, `${u.stdout}${u.stderr}`);
    const r = pin.scan({ root: proj, tracked: walk(proj).filter((p) => !p.startsWith('node_modules/')) });
    assert.ok(r.scanned > 0);
    assert.deepEqual(r.findings.map((f) => `${f.path}:${f.line}: ${f.text}`), []);
  });

  test('red: AC-2029 builder-init step 0 names the lock entry as a stop and the --no-install check', () => {
    const text = readFileSync(join(PACK, 'skills', 'builder-init.md'), 'utf8');
    const step0 = text.slice(text.indexOf('## Step 0'), text.indexOf('## Step 1'));
    assert.match(step0, /lock file has an entry/);
    assert.match(step0, /node_modules\/builder-pipeline/);
    assert.match(step0, /no lock entry[^.]*stop/);
    assert.match(step0, /npx --no-install builder-pipeline --version/);
  });
});

/** Every file under `dir`, relative, posix. */
function walk(dir) {
  const out = [];
  const rec = (d) => {
    for (const e of require('node:fs').readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const abs = join(d, e.name);
      if (e.isDirectory()) rec(abs);
      else out.push(relative(dir, abs).split('\\').join('/'));
    }
  };
  rec(dir);
  return out;
}
