/**
 * The optional index refresh: `tooling/optional/autosync.py`, `sync.py --check` and `session-sync-hook.cjs`.
 *
 * WHY. Three triggers share one index. Without a lock, two of them embed the same backlog at once, which doubles the
 * spend and can corrupt the index. Without a limit, an unattended trigger spends an unbounded amount. And a sync
 * whose success exit covers "docs still pending" hides the backlog from every caller that branches on the exit. Each
 * of those is a property of a real process, so these tests spawn the real scripts against a throwaway index
 * directory instead of reading the source. graphify need not be installed: the paths that need it are either not
 * reached (no index) or replaced by an injected code-sync step.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const PACK = join(dirname(fileURLToPath(import.meta.url)), '..');
const OPTIONAL = join(PACK, 'tooling', 'optional');
const AUTOSYNC = join(OPTIONAL, 'autosync.py');
const SYNC = join(OPTIONAL, 'sync.py');
const HOOK = join(OPTIONAL, 'session-sync-hook.cjs');
const indexCheck = require('../scripts/lib/index-check.cjs');

function findPython() {
  for (const candidate of [process.env.INDEX_PYTHON, 'python3', 'python'].filter(Boolean)) {
    const r = spawnSync(candidate, ['-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim() === '3') return candidate;
  }
  return null;
}
const PY = findPython();
const NO_PYTHON = PY ? false : 'Python 3 is not on PATH (tried INDEX_PYTHON, python3, python) — the Python cases cannot run';

/** The caller's environment minus any INDEX_* variable, so a developer's own settings never leak into a case. */
function cleanEnv(extra = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('INDEX_') && k !== 'CLAUDE_PROJECT_DIR'));
  // No bytecode cache: the suite runs inside the pack, and a __pycache__ left in tooling/optional/ would ship.
  return { ...env, PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1', ...extra };
}

let base;
let n = 0;
/** A fresh repo root with an (empty) index directory inside it. */
function project({ outDir = true } = {}) {
  const root = join(base, `p${n++}`);
  const out = join(root, 'graphify-out');
  mkdirSync(outDir ? out : root, { recursive: true });
  return { root, out, env: (extra = {}) => cleanEnv({ INDEX_ROOT: root, INDEX_OUT_DIR: out, ...extra }) };
}

function py(args, env) {
  const r = spawnSync(PY, args, { encoding: 'utf8', env, timeout: 30_000 });
  return { status: r.status, stdout: r.stdout ?? '', out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** Runs a Python snippet with the optional folder importable. Written to a file: `-c` quoting differs per platform. */
function pySnippet(p, code, extra = {}) {
  const file = join(p.root, `snippet-${n++}.py`);
  writeFileSync(file, `import json, os, sys, time\nsys.path.insert(0, os.environ["PACK_OPTIONAL"])\n${code}\n`);
  return py([file], p.env({ PACK_OPTIONAL: OPTIONAL, ...extra }));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

before(() => {
  base = mkdtempSync(join(tmpdir(), 'pack-autosync-'));
});
after(() => rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

describe('autosync.py — pure pieces', { skip: NO_PYTHON }, () => {
  test('decide_embed: nothing pending, not requested, over the limit, no embedder, embed', () => {
    const p = project();
    const r = pySnippet(p, `
import autosync
d, L = autosync.decide_embed, 300 * 1024
print(json.dumps([
  d(0, L, True), d(68_611, L, True), d(L, L, True), d(L + 1, L, True),
  d(68_611, L, False), d(68_611, L, True, allowed=False), d(L + 1, L, False), d(0, L, False, allowed=False),
]))`);
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(JSON.parse(r.stdout.trim()), [
      'none',
      'embed',
      'embed', // the limit itself is within
      'over-limit',
      'no-embedder',
      'not-requested',
      'over-limit', // judged before the embedder: a person decides even where nothing could embed
      'none',
    ]);
  });

  test('the lock: taken, refused while held, a dead holder\'s lock reclaimed, released only by its owner', () => {
    const p = project();
    const r = pySnippet(p, `
import autosync
from pathlib import Path
lock = Path(os.environ["INDEX_OUT_DIR"]) / ".sync.lock"
now = time.time()
first = autosync.acquire_lock(lock, now)
held = json.loads(lock.read_text(encoding="utf-8"))
second = autosync.acquire_lock(lock, now, pid=424242)
foreign_release = autosync.release_lock(lock, pid=424242)
still_there = lock.exists()
own_release = autosync.release_lock(lock)
gone = not lock.exists()
lock.write_text(json.dumps({"pid": 1, "started": now - 3 * 3600}), encoding="utf-8")
reclaimed = autosync.acquire_lock(lock, now)
new_owner = json.loads(lock.read_text(encoding="utf-8"))["pid"] == os.getpid()
lock.unlink()
lock.write_text(json.dumps({"pid": 1, "started": now - 60}), encoding="utf-8")
young = autosync.acquire_lock(lock, now)
print(json.dumps(dict(first=first, heldPid=held["pid"] == os.getpid(), second=second, foreign=foreign_release,
  stillThere=still_there, own=own_release, gone=gone, reclaimed=reclaimed, newOwner=new_owner, young=young)))`);
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(JSON.parse(r.stdout.trim()), {
      first: true,
      heldPid: true,
      second: false,
      foreign: false,
      stillThere: true,
      own: true,
      gone: true,
      reclaimed: true,
      newOwner: true,
      young: false, // negative control: a live holder's lock is never taken over
    });
  });
});

describe('autosync.py — as a process', { skip: NO_PYTHON }, () => {
  test('contention: a second trigger exits 20 and does nothing while the first holds the lock', async (t) => {
    const p = project();
    const lock = join(p.out, '.sync.lock');
    // The holder keeps the lock until the test says so (--release-on), not for a fixed time: under load the second
    // trigger's interpreter could start after a 3 s hold had already ended, find no lock, and exit 3 (seen in full runs).
    const release = join(p.out, '..', 'release-now');
    t.after(() => { try { writeFileSync(release, ''); } catch { /* already released */ } }); // never leave the holder running
    const holder = spawn(PY, [AUTOSYNC, '--trigger', 'merge', '--hold-lock', '120', '--release-on', release], { env: p.env(), stdio: 'ignore' });
    let holderDone = false;
    const exited = new Promise((resolve) => holder.on('close', (code) => { holderDone = true; resolve(code); }));
    for (let i = 0; i < 600 && !existsSync(lock); i++) await sleep(50);
    assert.ok(existsSync(lock), 'the holder never took the lock');

    const second = py([AUTOSYNC, '--trigger', 'session'], p.env());
    assert.ok(!holderDone && existsSync(lock), 'the holder still holds the lock while the second trigger runs');
    assert.equal(second.status, 20, second.out);
    assert.match(second.out, /lock held/);
    assert.ok(existsSync(lock), 'the refused trigger removed a lock it did not own');
    assert.ok(!existsSync(join(p.out, '.autosync-status.json')), 'the refused trigger wrote a status');

    writeFileSync(release, '');
    assert.equal(await exited, 0);
    assert.ok(!existsSync(lock), 'the holder did not release its lock');
    assert.match(readFileSync(join(p.out, '.sync.log'), 'utf8'), /lock held by another trigger/);
  });

  test('a lock older than INDEX_STALE_LOCK_SECONDS is reclaimed; without the setting the same lock refuses', () => {
    const p = project();
    const lock = join(p.out, '.sync.lock');
    const stale = () => writeFileSync(lock, JSON.stringify({ pid: 1, started: Date.now() / 1000 - 30 }));
    stale();
    assert.equal(py([AUTOSYNC, '--trigger', 'p1', '--hold-lock', '0.1'], p.env()).status, 20);
    stale();
    const r = py([AUTOSYNC, '--trigger', 'p1', '--hold-lock', '0.1'], p.env({ INDEX_STALE_LOCK_SECONDS: '10' }));
    assert.equal(r.status, 0, r.out);
    assert.ok(!existsSync(lock));
  });

  test('INDEX_SYNC_SKIP exits 0 at once and touches nothing', () => {
    const p = project();
    const r = py([AUTOSYNC, '--trigger', 'session'], p.env({ INDEX_SYNC_SKIP: '1' }));
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(readdirSync(p.out), []);
  });

  test('no index: exit 3, and the lock is released', () => {
    const p = project();
    const r = py([AUTOSYNC, '--trigger', 'manual'], p.env());
    assert.equal(r.status, 3, r.out);
    assert.ok(!existsSync(join(p.out, '.sync.lock')));

    const bare = project({ outDir: false });
    assert.equal(py([AUTOSYNC, '--trigger', 'manual'], bare.env()).status, 3);
    assert.ok(!existsSync(bare.out), 'a run with no index created the index directory');
  });

  describe('the decision after a code sync (code sync injected, so graphify is not needed)', () => {
    const DRIVER = 'import autosync\nsys.exit(autosync.main(json.loads(os.environ["ARGV"]), code_sync=lambda: 0))';

    function withPending(p) {
      const doc = join(p.root, 'docs', 'design.md');
      mkdirSync(dirname(doc), { recursive: true });
      writeFileSync(doc, 'x'.repeat(2048));
      writeFileSync(join(p.out, '.needs_semantic_sync.json'), JSON.stringify({ files: [doc] }));
      const embed = join(p.root, 'embed.py');
      writeFileSync(
        embed,
        [
          'import os',
          'with open(os.path.join(os.environ["INDEX_OUT_DIR"], "embed-env.txt"), "w") as f:',
          '    f.write(os.environ.get("INDEX_SYNC_SKIP", ""))',
          'os.remove(os.environ["INDEX_PENDING_FILE"])',
        ].join('\n'),
      );
      const exe = PY.includes(' ') ? `"${PY}"` : PY;
      return { embedCommand: `${exe} "${embed}"` };
    }
    const status = (p) => JSON.parse(readFileSync(join(p.out, '.autosync-status.json'), 'utf8'));
    const run = (p, argv, extra) => pySnippet(p, DRIVER, { ARGV: JSON.stringify(argv), ...extra });

    test('within the limit with an embedder: the embed runs with INDEX_SYNC_SKIP set, and the run ends fresh', () => {
      const p = project();
      const { embedCommand } = withPending(p);
      const r = run(p, ['--trigger', 'p1'], { INDEX_EMBED_COMMAND: embedCommand });
      assert.equal(r.status, 0, r.out);
      assert.equal(readFileSync(join(p.out, 'embed-env.txt'), 'utf8'), '1', 'the embed could re-trigger the sync');
      assert.deepEqual({ ...status(p), at: undefined }, { at: undefined, trigger: 'p1', codeSyncExit: 0, decision: 'embed', embedExit: 0, pendingDocs: 0, pendingBytes: 0, limitBytes: 300 * 1024 });
    });

    test('above INDEX_AUTO_LIMIT_KB: no embed, exit 10, and the status says a person decides', () => {
      const p = project();
      const { embedCommand } = withPending(p);
      const r = run(p, ['--trigger', 'merge'], { INDEX_EMBED_COMMAND: embedCommand, INDEX_AUTO_LIMIT_KB: '1' });
      assert.equal(r.status, 10, r.out);
      assert.ok(!existsSync(join(p.out, 'embed-env.txt')), 'an over-limit backlog was embedded unattended');
      assert.equal(status(p).decision, 'over-limit');
      assert.equal(status(p).pendingBytes, 2048);
    });

    test('no INDEX_EMBED_COMMAND: decision no-embedder, exit 10 — pending is never reported as fresh', () => {
      const p = project();
      withPending(p);
      const r = run(p, ['--trigger', 'session']);
      assert.equal(r.status, 10, r.out);
      assert.equal(status(p).decision, 'no-embedder');
    });

    test('--no-embed: decision not-requested, exit 10', () => {
      const p = project();
      const { embedCommand } = withPending(p);
      const r = run(p, ['--trigger', 'p4', '--no-embed'], { INDEX_EMBED_COMMAND: embedCommand });
      assert.equal(r.status, 10, r.out);
      assert.equal(status(p).decision, 'not-requested');
      assert.ok(!existsSync(join(p.out, 'embed-env.txt')));
    });
  });
});

describe('sync.py', { skip: NO_PYTHON }, () => {
  test('--check with no index: exit 3, one facts line with "index": false, nothing written', () => {
    const p = project();
    const r = py([SYNC, '--check'], p.env());
    assert.equal(r.status, 3, r.out);
    const facts = indexCheck.factsFrom(r.stdout);
    assert.deepEqual(facts, { index: false });
    assert.equal(indexCheck.fromRun({ status: r.status, stdout: r.stdout }).code, indexCheck.EXIT.ABSENT);
    assert.deepEqual(readdirSync(p.out), []);
  });

  test('load_pending / write_pending: an empty list deletes the flag file', () => {
    const p = project();
    const r = pySnippet(p, `
import sync
from pathlib import Path
flag = Path(os.environ["INDEX_OUT_DIR"]) / "pending.json"
sync.write_pending(["b.md", "a.md", "a.md"], flag)
written = sync.load_pending(flag)
sync.write_pending([], flag)
print(json.dumps(dict(written=written, exists=flag.exists(), missing=sync.load_pending(flag))))`);
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(JSON.parse(r.stdout.trim()), { written: ['a.md', 'b.md'], exists: false, missing: [] });
  });
});

describe('session-sync-hook.cjs', () => {
  const node = (env) => {
    const started = Date.now();
    const r = spawnSync(process.execPath, [HOOK], { encoding: 'utf8', env, timeout: 15_000 });
    return { status: r.status, stdout: r.stdout ?? '', ms: Date.now() - started };
  };

  /** An index with a recorded previous status; the "interpreter" is node running an empty script, so no Python is spawned. */
  function indexed(previous) {
    const p = project();
    writeFileSync(join(p.out, 'graph.json'), '{"nodes":[],"edges":[]}');
    if (previous) writeFileSync(join(p.out, '.autosync-status.json'), JSON.stringify(previous));
    const noop = join(p.root, 'noop.js');
    writeFileSync(noop, '');
    return cleanEnv({ CLAUDE_PROJECT_DIR: p.root, INDEX_PYTHON: process.execPath, INDEX_AUTOSYNC_SCRIPT: noop });
  }

  test('red (I7): copied into a "type": "module" host it still runs — it is CommonJS by its own extension', () => {
    const p = project();
    const hooks = join(p.root, '.claude', 'hooks');
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(p.root, 'package.json'), '{ "type": "module" }\n');
    const copy = join(hooks, 'session-sync-hook.cjs');
    writeFileSync(copy, readFileSync(HOOK));
    const r = spawnSync(process.execPath, [copy], { encoding: 'utf8', env: cleanEnv({ CLAUDE_PROJECT_DIR: p.root }), timeout: 15_000 });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /require is not defined|ReferenceError/);
  });

  test('no index: exits 0 at once and says nothing', () => {
    const p = project();
    const r = node(cleanEnv({ CLAUDE_PROJECT_DIR: p.root }));
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.ok(r.ms < 5000, `took ${r.ms} ms`);
  });

  test('the previous run left docs above the limit: it says so, as SessionStart context', () => {
    const r = node(indexed({ decision: 'over-limit', pendingDocs: 7, pendingBytes: 512 * 1024, limitBytes: 300 * 1024 }));
    assert.equal(r.status, 0);
    const context = JSON.parse(r.stdout).hookSpecificOutput;
    assert.equal(context.hookEventName, 'SessionStart');
    assert.match(context.additionalContext, /7 doc\(s\), 512 KB.*above the 300 KB/);
  });

  test('silent otherwise: a within-limit previous run, no previous run, or INDEX_SYNC_SKIP', () => {
    assert.equal(node(indexed({ decision: 'no-embedder', pendingDocs: 3, pendingBytes: 2048, limitBytes: 300 * 1024 })).stdout, '');
    assert.equal(node(indexed(null)).stdout, '');
    const skipped = node({ ...indexed({ decision: 'over-limit', pendingDocs: 7, pendingBytes: 512 * 1024, limitBytes: 300 * 1024 }), INDEX_SYNC_SKIP: '1' });
    assert.equal(skipped.status, 0);
    assert.equal(skipped.stdout, '');
  });
});

describe('session-sync-hook.cjs starts committed code only', { skip: NO_PYTHON }, () => {
  const git = (cwd, ...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8' });
  const pyExe = () => spawnSync(PY, ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).stdout.trim();

  /** A repo with the hook + hook-trust installed, an index, and a committed autosync.py that leaves a marker when it runs. */
  function repo() {
    const p = project();
    writeFileSync(join(p.out, 'graph.json'), '{"nodes":[],"edges":[]}');
    writeFileSync(join(p.root, '.gitignore'), 'graphify-out/\nran-*.txt\n');
    const hooks = join(p.root, '.claude', 'hooks');
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, 'session-sync-hook.cjs'), readFileSync(HOOK));
    writeFileSync(join(hooks, 'hook-trust.cjs'), readFileSync(join(PACK, 'hooks', 'claude-code', 'hook-trust.cjs')));
    const dir = join(p.root, 'scripts', 'graphify');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'autosync.py'),
      'import sys\nfrom pathlib import Path\nPath.cwd().joinpath("ran-" + sys.argv[sys.argv.index("--trigger") + 1] + ".txt").write_text("ran")\n',
    );
    git(p.root, 'init', '-q');
    git(p.root, 'add', '-A');
    git(p.root, 'commit', '-qm', 'base');
    const run = (trigger = 'session') =>
      spawnSync(process.execPath, [join(hooks, 'session-sync-hook.cjs'), '--trigger', trigger], {
        encoding: 'utf8',
        env: cleanEnv({ CLAUDE_PROJECT_DIR: p.root, INDEX_PYTHON: pyExe() }),
        timeout: 15_000,
      });
    return { ...p, dir, run };
  }

  /** Wait for the detached child's marker; resolves false after `ms`. */
  async function ran(root, trigger, ms) {
    for (const until = Date.now() + ms; Date.now() < until; await sleep(100)) if (existsSync(join(root, `ran-${trigger}.txt`))) return true;
    return false;
  }

  test('committed scripts: the sync starts, for the session and the merge trigger', async () => {
    const r = repo();
    assert.equal(r.run('session').status, 0);
    assert.equal(await ran(r.root, 'session', 10_000), true, 'positive control: a trusted folder runs');
    assert.equal(r.run('merge').status, 0);
    assert.equal(await ran(r.root, 'merge', 10_000), true);
  });

  test('red: an untracked module beside autosync.py means no sync; removing it restores the sync', async () => {
    const r = repo();
    writeFileSync(join(r.dir, 'sync.py'), 'raise SystemExit("planted")\n');
    r.run();
    assert.equal(await ran(r.root, 'session', 2500), false, 'an extra file in the folder changes what import loads');
    rmSync(join(r.dir, 'sync.py'));
    r.run();
    assert.equal(await ran(r.root, 'session', 10_000), true);
  });

  test('red: a script changed in the working tree means no sync', async () => {
    const r = repo();
    writeFileSync(join(r.dir, 'autosync.py'), `${readFileSync(join(r.dir, 'autosync.py'), 'utf8')}# edited\n`);
    r.run();
    assert.equal(await ran(r.root, 'session', 2500), false);
  });

  test('red: an interpreter path recorded in the index directory is never used', async () => {
    const r = repo();
    writeFileSync(join(r.out, '.graphify_python'), pyExe()); // a working interpreter: the old hook would have run it
    const res = spawnSync(process.execPath, [join(r.root, '.claude', 'hooks', 'session-sync-hook.cjs')], {
      encoding: 'utf8',
      env: cleanEnv({ CLAUDE_PROJECT_DIR: r.root, INDEX_TOOL_VENV: 'no-such-venv-for-this-test' }),
      timeout: 15_000,
    });
    assert.equal(res.status, 0);
    assert.equal(await ran(r.root, 'session', 2500), false, 'no INDEX_PYTHON and no tool venv: nothing runs');
  });
});
