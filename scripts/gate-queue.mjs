#!/usr/bin/env node
/**
 * `npx builder run gate-queue <command>` — the lite-split gate queue, `<boards>/_gate-queue.md`
 * (feature `liteSplit`). Logic and rationale: scripts/lib/gate-queue.cjs.
 * (folder layout: node scripts/gate-queue.mjs in place of npx builder run gate-queue)
 *
 *   add <key> --base <sha> [--tip <sha>] [--branch <b>] [--board <path>] [--dir <module dir>] [--batch <id>]
 *       → queues a lite-built module; files = `git diff --name-only base..tip`. Exit 3 at the cap.
 *   retip <key> --tip <sha>   → re-records the tip and base..tip files after a FIX moved the code; the new tip
 *       must descend from the base and from the recorded tip (lanes merge, never rebase). GATED keys are refused.
 *   mark <key|batch> <phase> --evidence "<command → result line>" [--sha <sha>]   (sha defaults to HEAD)
 *   status   → OWED and still-valid DONE lines at HEAD (stale DONEs re-opened). Exit 0 nothing owed · 10 owed.
 *   close <key>  → BUILT-UNGATED → GATED; exit 2 while anything is owed.
 *   board        → writes <boards>/gate-batch-<batch-id>.md from the queue (refuses to overwrite one).
 *   reset        → every module GATED → empty queue for the next batch; exit 2 while one is open.
 *
 * Phases: module 1 2 3 3a (lite) · 4 5 6 7 (gate batch) — batch checks 3b gates integration e2e 6.5.
 * The batch id comes from the first `add` (`--batch <id>`, else the branch name minus `lite/`).
 * Feature not enabled → prints the feature line and exits 2 without touching anything.
 *
 * Call it with `node`, not through a package-manager script: some shells hand `--run`-style flags to the
 * package manager instead of the script.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { delimiter, isAbsolute, join } from 'node:path';

const require = createRequire(import.meta.url);
const q = require('./lib/gate-queue.cjs');
const profile = require('./lib/profile.cjs');

const { settings } = profile.load(process.cwd());
const lite = profile.feature(settings, 'liteSplit');
if (!lite.enabled) {
  console.error(`gate-queue: ${lite.line} — set features.liteSplit.state in PIPELINE_PROFILE.md §16 to use the lite split.`);
  process.exit(2);
}
const cfg = q.config(settings);
const FILE = join(cfg.boards, '_gate-queue.md');

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name) => {
  const i = rest.indexOf(`--${name}`);
  return i === -1 ? undefined : rest[i + 1];
};
const positional = rest.filter((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1].startsWith('--')));

// git from an ABSOLUTE PATH entry: on Windows a bare spawn tries the cwd first, and retip/add run inside lane
// checkouts a worker could have written a `git` into (the rule `whichAbs` in scripts/lib/orch-credit.cjs states).
function whichAbs(name) {
  const exts = process.platform === 'win32' ? ['.exe', '.com'] : [''];
  for (const d of String(process.env.PATH || process.env.Path || '').split(delimiter).filter((p) => p && isAbsolute(p))) {
    for (const x of exts) {
      const f = join(d, name + x);
      if (existsSync(f)) return f;
    }
  }
  return null;
}
const GIT = whichAbs('git');
const gitExe = () => GIT || fail('refused: no git executable on an absolute PATH entry');
const git = (...args) => execFileSync(gitExe(), args, { encoding: 'utf8' }).trim();
// A ref from argv or from the ledger that starts with '-' would be read by git as an option.
const safeRef = (ref) => {
  if (!ref || /^-/.test(String(ref))) throw new Error(`refused: bad ref ${JSON.stringify(ref)}`);
  return String(ref);
};
const resolve = (ref) => git('rev-parse', '--verify', '--end-of-options', `${safeRef(ref)}^{commit}`);
const diff = (from, to) => git('diff', '--name-only', `${safeRef(from)}..${safeRef(to)}`).split(/\r?\n/).filter(Boolean);
const descends = (ancestor, tip) => {
  try {
    execFileSync(gitExe(), ['merge-base', '--is-ancestor', safeRef(ancestor), tip], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

const load = () => (existsSync(FILE) ? q.parse(readFileSync(FILE, 'utf8')) : q.empty(cfg.cap));
const save = (s) => writeFileSync(FILE, q.serialize(s, { trigger: cfg.trigger }));

function fail(msg, code = 1) {
  console.error(`gate-queue: ${msg}`);
  process.exit(code);
}

try {
  switch (cmd) {
    case 'add': {
      const [key] = positional;
      const base = flag('base') ? resolve(flag('base')) : fail('add needs --base <sha>');
      const tip = resolve(flag('tip') ?? 'HEAD');
      const branch = flag('branch') ?? git('rev-parse', '--abbrev-ref', 'HEAD');
      const s = q.add(load(), {
        key,
        base,
        tip,
        files: diff(base, tip),
        moduleDir: flag('dir') ?? null,
        branch,
        board: flag('board') ?? join(cfg.boards, `${key}.md`),
        built: new Date().toISOString().slice(0, 10),
        batchId: flag('batch') ?? branch.replace(/^lite\//, ''),
      });
      save(s);
      console.log(`gate-queue: ${key} queued BUILT-UNGATED (${base.slice(0, 8)}..${tip.slice(0, 8)}, ${s.modules.at(-1).files.length} files)`);
      break;
    }
    case 'retip': {
      // A FIX moved the code after `add`; re-record the range the credit auditors and the gate batch read.
      const [key] = positional;
      const tip = flag('tip') ? resolve(flag('tip')) : fail('retip needs --tip <sha>');
      const s0 = load();
      const m = s0.modules.find((x) => x.key === key);
      const s = q.retip(s0, key, { tip, files: m ? diff(m.base, tip) : [], ancestry: m ? { fromBase: descends(m.base, tip), fromTip: descends(m.tip, tip) } : undefined });
      save(s);
      const n = s.modules.find((x) => x.key === key);
      console.log(`gate-queue: ${key} retipped ${String(m.tip).slice(0, 8)} → ${tip.slice(0, 8)} (${n.files.length} files)`);
      break;
    }
    case 'mark': {
      const [key, phase] = positional;
      save(q.mark(load(), key, phase, { sha: resolve(flag('sha') ?? 'HEAD'), evidence: flag('evidence') }));
      console.log(`gate-queue: ${key} ${phase} DONE`);
      break;
    }
    case 'status': {
      const s = load();
      const o = q.owed(s, diff, resolve('HEAD'), cfg);
      const open = Object.keys(o.modules);
      if (!open.length) {
        console.log('gate-queue: no open module');
        process.exit(0);
      }
      const d = q.done(s);
      const names = (list) => list.map((p) => q.PHASE_NAMES[p]).join(' · ') || 'nothing';
      const stamps = (list, owedNow) =>
        list.filter((x) => !owedNow.includes(x.phase)).map((x) => `${q.PHASE_NAMES[x.phase]} @${String(x.sha).slice(0, 8)}`).join(' · ') || 'nothing';
      for (const k of open) {
        console.log(`${k.padEnd(24)} OWED ${names(o.modules[k])}`);
        console.log(`${''.padEnd(24)} DONE ${stamps(d.modules[k], o.modules[k])}`);
      }
      console.log(`${'batch'.padEnd(24)} OWED ${names(o.batch)}`);
      console.log(`${''.padEnd(24)} DONE ${stamps(d.batch, o.batch)}`);
      console.log(`verdict: ${open.length} open of cap ${s.cap}${open.length >= cfg.trigger ? ' — READY FOR GATE BATCH' : ''}`);
      process.exit(open.some((k) => o.modules[k].length) || o.batch.length ? 10 : 0);
    }
    // eslint-disable-next-line no-fallthrough
    case 'close': {
      const [key] = positional;
      try {
        save(q.close(load(), key, diff, resolve('HEAD'), cfg));
      } catch (e) {
        fail(e.message, 2);
      }
      console.log(`gate-queue: ${key} GATED`);
      break;
    }
    case 'board': {
      const s = load();
      if (!s.modules.some((m) => m.status === 'BUILT-UNGATED')) fail('board: no open module in the queue', 2);
      const out = join(cfg.boards, `gate-batch-${s.batch.id}.md`);
      if (existsSync(out)) fail(`board: ${out} already exists — the board is the run's truth once written; append FIX-n rows to it`, 2);
      writeFileSync(out, q.board(s, { boards: cfg.boards }));
      // The sibling script beside this one — a package install has no scripts/ folder in the project.
      execFileSync(process.execPath, [require('node:url').fileURLToPath(new URL('./board-progress.mjs', import.meta.url)), out], { stdio: 'ignore' });
      console.log(`gate-queue: wrote ${out}`);
      break;
    }
    case 'reset': {
      try {
        save(q.reset(load()));
      } catch (e) {
        fail(e.message, 2);
      }
      console.log('gate-queue: queue emptied — every module was GATED');
      break;
    }
    default:
      fail('usage: gate-queue <add|retip|mark|status|close|board|reset> … (see the header of scripts/gate-queue.mjs)');
  }
} catch (e) {
  fail(e.message, /cap/.test(e.message) ? 3 : 1);
}
