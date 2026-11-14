/**
 * `builder doctor` — which kit features each tool supports, partly supports or cannot support, with the reason.
 *
 * WHY. A seat limit Codex cannot hold per agent, or a guard Antigravity never runs, reads as protection unless
 * something says otherwise. doctor says it per tool, from each adapter's own `unconfirmed` list plus the known
 * limits, and is a report: exit 0 whatever it finds.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const PACK = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const lib = require('../adapters/lib/index.cjs');
const made = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

function project() {
  const proj = mkdtempSync(join(tmpdir(), 'kit-doctor-'));
  made.push(proj);
  cpSync(PACK, join(proj, 'builder'), { recursive: true, filter: (src) => !/[\\/](?:\.git|tests|node_modules)(?:[\\/]|$)/.test(`/${relative(PACK, src)}`) });
  return proj;
}
const run = (cwd, args) => {
  const r = spawnSync(process.execPath, ['builder/cli.js', ...args], { cwd, encoding: 'utf8', env: { ...process.env, BUILDER_NO_BASH_CAP: '1' } });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, stdout: r.stdout ?? '' };
};

describe('builder doctor', () => {
  const root = project();

  test('red: codex — the sandbox, apply_patch and hook-agent limits are named, and it exits 0', () => {
    const r = run(root, ['doctor', '--tool', 'codex']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /^\[codex\]/m);
    assert.match(r.out, /partial .*sandbox/i);
    assert.match(r.out, /apply_patch/);
    assert.match(r.out, /unsupported .*reviewer-write-guard/);
    for (const u of lib.codex.unconfirmed) assert.ok(r.out.includes(u), u);
  });

  test('red: antigravity — hooks not written, whole-tool grants, no effort', () => {
    const r = run(root, ['doctor', '--tool', 'antigravity']);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /unsupported .*hooks/i);
    assert.match(r.out, /partial .*whole-tool/i);
    assert.match(r.out, /unsupported .*effort/i);
    for (const u of lib.antigravity.unconfirmed) assert.ok(r.out.includes(u), u);
  });

  test('--json gives every feature a status of supported, partial or unsupported', () => {
    const j = JSON.parse(run(root, ['doctor', '--tool', 'claude-code,codex,antigravity,opencode', '--json']).stdout);
    assert.deepEqual(j.map((t) => t.tool), ['claude-code', 'codex', 'antigravity', 'opencode']);
    for (const t of j) for (const f of t.features) assert.ok(['supported', 'partial', 'unsupported'].includes(f.status), `${t.tool} ${f.feature}`);
    assert.ok(j[0].features.every((f) => f.status !== 'unsupported'), 'claude-code supports every kit feature');
  });

  test('without --tool it reports the installed tools, or says nothing is installed', () => {
    const fresh = project();
    const none = run(fresh, ['doctor']);
    assert.equal(none.status, 0);
    assert.match(none.out, /no kit install detected/);
    assert.equal(run(fresh, ['unpack', '--tool', 'codex', '--no-extras']).status, 0);
    const r = run(fresh, ['doctor']);
    assert.match(r.out, /^\[codex\]/m);
    assert.doesNotMatch(r.out, /^\[claude-code\]/m);
  });
});
