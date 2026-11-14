/**
 * unpack gitignores what the kit's own tooling writes into the project: `.pipeline/` always, and `logs/bash/` (where
 * an armed bash-output-cap hook writes whole outputs) whenever that hook is installed — else the first capped
 * command dirties `git status`.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const PACK = join(dirname(fileURLToPath(import.meta.url)), '..');
const made = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

function project(kitAt) {
  const proj = mkdtempSync(join(tmpdir(), 'kit-gi-'));
  made.push(proj);
  const kit = join(proj, ...kitAt.split('/'));
  mkdirSync(kit, { recursive: true });
  cpSync(PACK, kit, { recursive: true, filter: (src) => !/[\\/](?:\.git|tests|node_modules)(?:[\\/]|$)/.test(`/${relative(PACK, src)}`) });
  return { proj, cli: join(kit, 'cli.js') };
}
const run = (cli, cwd, args) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });
const lines = (proj) => readFileSync(join(proj, '.gitignore'), 'utf8').split(/\r?\n/);

describe('unpack and .gitignore', () => {
  for (const kitAt of ['node_modules/@geopjinfo/builder-pipeline', 'builder']) {
    test(`red: with the Claude Code hooks installed, logs/bash/ is ignored once (${kitAt})`, () => {
      const { proj, cli } = project(kitAt);
      const first = run(cli, proj, ['unpack', '--tool', 'claude-code']);
      assert.equal(first.status, 0, first.stderr);
      assert.match(first.stdout, /appended: +\.gitignore \(logs\/bash\/\)/);
      assert.ok(lines(proj).includes('.pipeline/'));
      assert.ok(lines(proj).includes('logs/bash/'));
      const again = run(cli, proj, ['unpack', '--tool', 'claude-code']);
      assert.equal(again.status, 0, again.stderr);
      assert.match(again.stdout, /skip \(exists\): +\.gitignore \(logs\/bash\/\)/);
      assert.equal(lines(proj).filter((l) => l === 'logs/bash/').length, 1);
    });
  }

  test('no bash-cap hook installed (codex only): logs/bash/ is not added', () => {
    const { proj, cli } = project('node_modules/@geopjinfo/builder-pipeline');
    const r = run(cli, proj, ['unpack', '--tool', 'codex']);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(lines(proj).includes('.pipeline/'));
    assert.ok(!lines(proj).includes('logs/bash/'));
  });
});
