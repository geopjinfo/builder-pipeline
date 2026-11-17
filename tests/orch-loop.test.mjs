/**
 * M9 — `orch loop <board>` places the loop on a ready account through the placement seam and records the job
 * (REQ-908; D30, D37). A stub `claude` answers the probes; the stub loop worker runs the passes.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, join } from 'node:path';
import { describe, test } from 'node:test';
import { ORCH, PACK, git, profileText, scratchRepo, tmp } from './fixtures/orch/rig.mjs';

const require = createRequire(import.meta.url);
const orchLoop = require('../scripts/lib/orch-loop.cjs');
const STUB = join(PACK, 'tests', 'fixtures', 'loop', 'stub-loop-worker.cjs');
const GATE = join(PACK, 'tests', 'fixtures', 'loop', 'gate.cjs');
const q = (s) => JSON.stringify(s);

/** A stub `claude` whose `auth status` says signed in (or out) — the probe the placement seam reads. */
function claudeStub(loggedIn) {
  const bin = tmp('loop-bin');
  const script = `const a = process.argv.slice(2);\nif (a[0] === 'auth' && a[1] === 'status') { process.stdout.write(JSON.stringify({ loggedIn: ${loggedIn}, authMethod: 'claude.ai' })); process.exit(${loggedIn ? 0 : 1}); }\nif (a[0] === '--version') { process.stdout.write('1.2.3\\n'); process.exit(0); }\nprocess.exit(2);\n`;
  if (process.platform === 'win32') {
    writeFileSync(join(bin, 'claude.js'), script);
    writeFileSync(join(bin, 'claude.cmd'), `@"${process.execPath}" "%~dp0claude.js" %*\r\n`);
  } else {
    symlinkSync(process.execPath, join(bin, 'node'));
    writeFileSync(join(bin, 'claude'), `#!/usr/bin/env node\n${script}`);
    chmodSync(join(bin, 'claude'), 0o755);
  }
  return bin;
}
const BOARD = `# demo — build board\n\n## P2 — Code\n\n| # | Task | Cites | Status | Test-seed / evidence | Notes |\n|---|------|-------|--------|----------------------|-------|\n| T1 | solve r1 | REQ-1 | PLANNED | r1.txt | |\n`;

function rig({ loggedIn = true } = {}) {
  const extraFeatures = {
    accounts: { state: 'on', accounts: { alpha: { worker: 'claude-code', pays: 'subscription', command: 'claude {brief}' } } },
    boardLoop: { state: 'experimental-on', promptFile: 'LOOP_PROMPT.md', gate: `${q(process.execPath)} gate.cjs {row}`, maxPasses: 3, passTimeoutMinutes: 1, stallMinutes: 1 },
  };
  const { dir, repo } = scratchRepo({ profile: profileText({ extraFeatures }), files: { 'tasks/demo.md': BOARD, 'gate.cjs': readFileSync(GATE, 'utf8'), 'rows.txt': 'T1 r1\n', 'LOOP_PROMPT.md': 'solve\n' } });
  const bin = claudeStub(loggedIn);
  const script = join(dir, 'script.json');
  writeFileSync(script, JSON.stringify({ default: { writes: [{ path: 'r1.txt', text: 'ok\n' }] } }));
  mkdirSync(join(dir, 'home', 'accounts', 'alpha'), { recursive: true });
  const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, BUILDER_NO_BASH_CAP: '1', BUILDER_ACCOUNTS_HOME: join(dir, 'home'), BUILDER_ORCH_DIR: join(dir, 'orch'), BUILDER_LOOP_WORKER_BIN: STUB, BUILDER_LOOP_STUB_SCRIPT: script, BUILDER_LOOP_STUB_COUNTER: join(dir, 'counter') };
  const orch = (args) => {
    const r = spawnSync(process.execPath, [ORCH, ...args], { cwd: repo, encoding: 'utf8', env, timeout: 120000 });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', out: `${r.stdout || ''}${r.stderr || ''}` };
  };
  return { dir, repo, env, orch, root: join(dir, 'orch') };
}

describe('REQ-908 — orch loop', () => {
  test('red: the placement seam takes the first account whose assessment reads ready; none ready → null with the reasons', () => {
    const settings = { features: { accounts: { state: 'on', accounts: { a: { worker: 'claude-code', pays: 'subscription' }, b: { worker: 'claude-code', pays: 'api-key' } } } } };
    const io = { assess: () => [{ name: 'a', state: 'not ready', reason: 'signed out' }, { name: 'b', state: 'ready', reason: null }] };
    const p = orchLoop.placeLoop(settings, 'tasks/demo.md', io);
    assert.equal(p.account, 'b');
    const none = orchLoop.placeLoop(settings, 'tasks/demo.md', { assess: () => [{ name: 'a', state: 'not ready', reason: 'signed out' }, { name: 'b', state: 'unmeasured', reason: 'no probe' }] });
    assert.equal(none.account, null);
    assert.match(none.reason, /a: not ready \(signed out\); b: unmeasured/);
  });
  test('red: a board and a ready account → the state holds a loop job with the account and the cap; status prints the pass count and the stop reason', () => {
    const r = rig();
    const res = r.orch(['loop', 'tasks/demo.md']);
    assert.equal(res.status, 0, res.out);
    const jobs = JSON.parse(readFileSync(join(r.root, 'loops.json'), 'utf8'));
    assert.equal(jobs.demo.kind, 'loop');
    assert.equal(jobs.demo.account, 'alpha');
    assert.equal(jobs.demo.cap, 3);
    assert.equal(jobs.demo.stopReason, 'all-pass');
    assert.equal(jobs.demo.passes, 1);
    const st = r.orch(['status']);
    assert.match(st.stdout, /loop demo .*alpha.*1 pass.*all-pass/);
    assert.match(st.stdout, /^reporter: not configured$/m); // REQ-1613
    const rows = readFileSync(join(r.repo, '.pipeline', 'loop', 'demo.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.kind === 'pass');
    assert.equal(rows.length, 1);
    for (const k of ['pass', 'row', 'rowsPassing', 'retries', 'gateDigest', 'turns', 'cost', 'stopReason']) assert.ok(k in rows[0], k);
  });
  test('red: a not-ready account refuses before any pass', () => {
    const r = rig({ loggedIn: false });
    const res = r.orch(['loop', 'tasks/demo.md']);
    assert.equal(res.status, 3, res.out);
    assert.match(res.out, /REFUSED loop .*not ready/);
    assert.equal(existsSync(join(r.repo, '.pipeline', 'loop', 'demo.jsonl')), false);
    assert.equal(existsSync(join(r.repo, 'r1.txt')), false);
  });
});
