'use strict';
/**
 * The claims checker — the record-class defects, found by a script before a seat has to find them.
 *
 * WHY. In one adopting project, record-class defects were the largest share of loop-back fixes: a count nobody
 * re-ran, a `file:line` that no longer says what the citation claims, a phrase a correction had already
 * retracted, a "NEEDS-RULING" or "owed" with nowhere it is actually owed to. About half of them were
 * deterministically catchable, and they drove most review re-loops: the reviewer found them by reading, and the
 * builder fixed them in another full dispatch. Four checks, each mechanical:
 *
 *   1. COUNT      every claim in `<runs>/<key>/claims.jsonl` ({ id, text, command, expect }) is re-run and its
 *                 output must match `expect` (a regex; a bare number must be a whole output line). A figure is
 *                 a claim about a command's output, so the command is kept beside it and run again — except
 *                 that, with `features.claims.jestBatch` set, a plain jest claim is run in one batch per config,
 *                 or answered from a PASSING result this checker logged at the same sha on a clean tree.
 *   2. CITATION   every `file:NN` (or `NN-MM`) under a citation root points at a file that exists and has that
 *                 line; a citation carrying an anchor — `file:NN «snippet»` — must find the snippet within two
 *                 lines of NN. Line numbers drift; an anchor says what the line was.
 *   3. RETRACTED  no phrase listed in the retracted-phrases file appears asserted in plain prose.
 *   4. OWED       every line saying `NEEDS-RULING` or `owed` names where it is owed: an existing file in the
 *                 decision workspace or the handoffs folder, a registry id present in the deferred registry, or
 *                 a `handoff §X`. Headings introduce such items and are exempt.
 *
 * Two more, OFF unless `ctx.extended` (`--extended` on the CLI). Both read only rows whose Status cell says
 * `DONE`, in the evidence cell — the columns are found from each table's header row (a `Status` column and
 * a column whose header contains `evidence`), so a board table without an evidence column is skipped:
 *
 *   5. UNANCHORED a count in the evidence (`16/16`, `12 cases`) with nothing in that cell that could have
 *                 produced it — no file named, no backticked command, no `script:name`, no `logs/` path.
 *   6. NAMED      a test name cited in the evidence (`describe 'X'`, `it "X"`, `test 'X'`, `title “X”`) must
 *                 occur in one of the files the same cell cites; an elided name (`…`) must match every
 *                 fragment. Compared without quotes/backticks, case-insensitive.
 *
 * In the adopting project both were measured over its whole board history before they were switched on:
 * a few dozen unanchored counts and a handful of cited names that occur nowhere. A first wording of 6 — the
 * cited test must name the row's requirement id — flagged a third of the correct rows, because test names
 * there followed board rows, not requirement ids; it was dropped.
 *
 * `check` is pure over (documents, fs probe, context); `scripts/claims-check.mjs` does the document I/O and reads
 * the settings. The runner the COUNT check calls is built here by `makeRunner`, with its spawn, lock and command
 * classifier injectable, so the lock behaviour is testable without a test runner or the machine-wide lock.
 */
const { spawnSync } = require('node:child_process');
const { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { join, relative } = require('node:path');

/**
 * The machine-wide tier lock, if the project installed one beside this file (`examples/jest-tier-runner/
 * tier-lock.cjs` installs as `scripts/lib/tier-lock.cjs`). OPTIONAL: without it there is nothing to serialise
 * against, so claim commands run unlocked and the CLI says so — the same as before the lock existed. Only a
 * MISSING module is tolerated; a lock that is installed but fails to load is an error, not a silent downgrade.
 */
let installedLock = null;
try {
  installedLock = require('./tier-lock.cjs');
} catch (error) {
  if (!(error && error.code === 'MODULE_NOT_FOUND' && String(error.message).includes('tier-lock.cjs'))) throw error;
}

/**
 * Any id-shaped token — a decision-log id (`D-7`), a registry id (letters, a dash, a `D` and a number), a
 * sub-lettered reference (`REF-12b`). Used to decide whether a line names what retracted a phrase.
 */
const ID_SHAPE = /\b[A-Z][A-Z0-9]*-[A-Z]*\d+[a-z]?\b/g;
const OWED_LINE = /\bNEEDS-RULING\b|\bowed\b/i;
const HANDOFF_REF = /\bhandoff\s*§[A-F]\b/i;
const DEFAULT_REGISTRY_ID = '[A-Z][A-Z0-9]{1,8}-D\\d+[a-z]?';

// 5. UNANCHORED — `n/m` without spaces (so `404 / 409` is not a count) or `n <noun>`.
const COUNT_NOUN = String.raw`(?:tests?|cases?|suites?|specs?|assertions?|findings?|routes?|endpoints?|keys?|checks?|scenarios?|probes?|journeys?)`;
const COUNT = new RegExp(String.raw`\b(\d+\/\d+|\d+\s+${COUNT_NOUN})\b`, 'gi');
const COUNT_ANCHOR = new RegExp(
  [
    String.raw`\b[\w./@{},+-]+\.[A-Za-z]{1,6}\b(?!\.)`, // a file, by path or bare name
    String.raw`\`[^\`]*\s[^\`]*\``, // a backticked command
    String.raw`\b[a-z]+:[a-z-]+\b`, // a script name (test:unit, qa:run)
    String.raw`\blogs\/`,
  ].join('|'),
);
// 6. NAMED
const NAMED_TEST = /\b(?:describe|it|test|title|case)\s+[`"'“]([^`"'”]{3,160})[`"'”]/g;
const FILE_REF = /[\w./@+-]+\/[\w./@+-]+\.[A-Za-z]{1,6}\b/g;
const plain = (s) => s.replace(/[`'"“”]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
const cellsOf = (line) => line.split('|').map((s) => s.trim());

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The citation pattern for a set of roots. No roots → no pattern: a regex over an empty alternation would match
 * every absolute-looking path, which is a false alarm generator, not a check.
 */
function citationPattern(roots) {
  const clean = (roots ?? []).map((r) => String(r).replace(/\\/g, '/').replace(/\/+$/, '')).filter(Boolean);
  if (clean.length === 0) return null;
  return new RegExp(
    String.raw`(?:^|[\s\`(\[|])((?:${clean.map(escape).join('|')})\/[\w./@+-]+\.[A-Za-z]{1,6}):(\d+)(?:[-–](\d+))?(?:\`?\s*«([^»]+)»)?`,
    'g',
  );
}

/** A path reference under the decision workspace or the handoffs folder: the file itself, or a file beneath it. */
function referencePattern(refRoots) {
  const clean = (refRoots ?? []).map((r) => String(r).replace(/\\/g, '/').replace(/\/+$/, '')).filter(Boolean);
  if (clean.length === 0) return null;
  return new RegExp(String.raw`(?<![\w./-])(?:${clean.map(escape).join('|')})(?:\/[\w.@+-][\w./@+-]*)?`, 'g');
}

/**
 * @param {{ name: string, text: string }[]} documents
 * @param {{ exists(p:string):boolean, lines(p:string):string[]|null }} fsProbe
 * @param {{
 *   roots?: string[],                 citation roots (relative to the project root)
 *   refRoots?: string[],              the decision workspace path and the handoffs path
 *   registryText?: string,
 *   registryIdPattern?: string,
 *   retracted?: {phrase:string, retractedBy:string}[] | null,   null = not configured, the check is skipped
 *   claims?: {id:string,text:string,command:string,expect:string}[],
 *   run?(cmd:string, claim?:object): {status:number|null, output:string, refused?:boolean},
 * }} ctx
 * @returns {{ kind: 'count'|'citation'|'retracted'|'owed', where: string, detail: string }[]}
 */
function check(documents, fsProbe, ctx = {}) {
  const problems = [];
  const push = (kind, where, detail) => problems.push({ kind, where, detail });
  const citation = citationPattern(ctx.roots);
  const reference = referencePattern(ctx.refRoots);
  const idSource = ctx.registryIdPattern || DEFAULT_REGISTRY_ID;
  const registryRef = new RegExp(`\\b(?:${idSource})\\b`, 'g');
  const ownRow = new RegExp(`^\\|\\s*~?~?(?<own>${idSource})~?~?\\s*\\|`);
  const registryText = ctx.registryText ?? '';
  const inRegistry = (id) => new RegExp(`\\|\\s*~?~?${escape(id)}~?~?\\s*\\|`).test(registryText);

  // 1. COUNT
  // A batching runner sees every claim first, so each jest config runs once (see `makeRunner`).
  ctx.run?.prime?.(ctx.claims ?? []);
  for (const claim of ctx.claims ?? []) {
    let pattern;
    try {
      // A bare-number expect is a whole output line. Unanchored, "1" matched any digit — a date inside a
      // "No such file or directory" error for a vanished evidence log, or the "1" in "10".
      const bareNumber = /^\s*\d+\s*$/.test(String(claim.expect));
      pattern = bareNumber ? new RegExp(`^\\s*${String(claim.expect).trim()}\\s*$`, 'm') : new RegExp(claim.expect, 'm');
    } catch {
      push('count', `claims.jsonl ${claim.id}`, `unparseable expect /${claim.expect}/`);
      continue;
    }
    const result = ctx.run(claim.command, claim);
    if (result.refused) {
      // A claim that could not run (the tier lock was held) is never a silent pass, whatever its `expect` matches.
      push('count', `claims.jsonl ${claim.id}`, `"${claim.text}" — \`${claim.command}\` not run: ${result.output}`);
      continue;
    }
    if (!pattern.test(result.output)) {
      const tail = result.output.trim().split(/\r?\n/).slice(-3).join(' ⏎ ').slice(0, 300);
      push('count', `claims.jsonl ${claim.id}`, `"${claim.text}" — \`${claim.command}\` (exit ${result.status}) no longer prints /${claim.expect}/; last lines: ${tail}`);
    }
  }

  for (const doc of documents) {
    const lines = doc.text.split(/\r?\n/);
    let cols = null; // { status, evidence } from the current table's header row
    lines.forEach((line, i) => {
      const where = `${doc.name}:${i + 1}`;
      if (!/^\s*\|/.test(line)) cols = null;
      else if (!/^\s*\|?\s*[-:|\s]+\|?\s*$/.test(line)) {
        const cells = cellsOf(line);
        const status = cells.findIndex((c) => /^status$/i.test(c));
        if (status !== -1) {
          const evidence = cells.findIndex((c) => /evidence/i.test(c));
          cols = evidence === -1 ? null : { status, evidence };
        }
      }

      // 2. CITATION
      if (citation) {
        for (const m of line.matchAll(citation)) {
          const [, file, from, to, anchor] = m;
          if (/[<>*]|\.\.\./.test(file)) continue; // a template or an elided path is not a citation
          if (!fsProbe.exists(file)) {
            push('citation', where, `${file}:${from} — the file does not exist`);
            continue;
          }
          const body = fsProbe.lines(file);
          if (!body) continue;
          const last = Number(to ?? from);
          if (last > body.length) {
            push('citation', where, `${file}:${from}${to ? `-${to}` : ''} — the file has ${body.length} lines`);
            continue;
          }
          if (anchor) {
            const n = Number(from);
            const window = body.slice(Math.max(0, n - 3), Math.min(body.length, n + 2)).join('\n');
            if (!window.includes(anchor.trim())) push('citation', where, `${file}:${from} «${anchor.trim()}» — the anchor is not within two lines of ${from}`);
          }
        }
      }

      // 3. RETRACTED
      // The same mention rule as OWED: a phrase QUOTED is a report of the stale claim, and a line naming the id
      // that retracted it has read the retraction. Only the phrase asserted in plain prose fails.
      if (Array.isArray(ctx.retracted)) {
        const unquoted = line.replace(/"[^"]*"|“[^”]*”/g, '');
        for (const r of ctx.retracted) {
          if (!r?.phrase || !unquoted.toLowerCase().includes(String(r.phrase).toLowerCase())) continue;
          const ids = String(r.retractedBy ?? '').match(ID_SHAPE) ?? [];
          if (ids.some((id) => new RegExp(`\\b${escape(id)}\\b`).test(line))) continue;
          push('retracted', where, `"${r.phrase}" was retracted by ${r.retractedBy}`);
        }
      }

      // 4. OWED
      // The term QUOTED ("owed", `NEEDS-RULING`) is a mention, and a negation ("no deferral is owed") owes
      // nothing — both were false positives the first time this ran over a real registry.
      const spoken = line.replace(/"[^"]*"|`[^`]*`|“[^”]*”/g, '');
      const negated = /\b(no|nothing|not|none)\b[^.|]{0,40}\bowed\b/i.test(spoken);
      if (OWED_LINE.test(spoken) && !negated && !/^\s*#/.test(line) && !/^\s*\|?\s*[-:|\s]+\|?\s*$/.test(line)) {
        // A bare folder name ("owed to handoffs") names no file anyone can open, so a reference must carry an
        // extension to count.
        const refs = reference ? [...line.matchAll(reference)].map((x) => x[0]).filter((p) => /\.[A-Za-z]{1,6}$/.test(p)) : [];
        const ids = [...line.matchAll(registryRef)].map((x) => x[0]);
        const ownRowId = ownRow.exec(line)?.groups?.own;
        const resolved = refs.some((p) => fsProbe.exists(p)) || ids.some(inRegistry) || (ownRowId && inRegistry(ownRowId)) || HANDOFF_REF.test(line);
        if (!resolved) push('owed', where, `names no existing decision-workspace or handoff file, registry id or handoff § — "${line.trim().slice(0, 140)}"`);
      }

      if (!ctx.extended || !cols) return;
      const cells = cellsOf(line);
      if (!/^DONE\b/.test(cells[cols.status] ?? '')) return;
      const evidence = cells[cols.evidence] ?? '';

      // 5. UNANCHORED
      const counts = [...evidence.replace(/"[^"]*"|“[^”]*”/g, '').matchAll(COUNT)].map((x) => x[1]);
      if (counts.length && !COUNT_ANCHOR.test(evidence))
        push('unanchored', where, `${counts.join(', ')} — nothing in the evidence cell could have produced it (no file, command, script or logs/ path)`);

      // 6. NAMED
      const cited = [...evidence.matchAll(FILE_REF)].map((x) => x[0]).filter((p) => fsProbe.exists(p));
      if (!cited.length) return;
      const bodies = cited.map((p) => plain((fsProbe.lines(p) ?? []).join('\n')));
      for (const n of evidence.matchAll(NAMED_TEST)) {
        const frags = n[1].split(/…|\.\.\./).map(plain).filter((x) => x.length >= 4);
        if (frags.length && !bodies.some((b) => frags.every((f) => b.includes(f))))
          push('named', where, `"${n[1].trim()}" occurs in none of ${cited.join(', ')}`);
      }
    });
  }
  return problems;
}

/**
 * Which lock a claim command needs. The default matches the layout `examples/jest-tier-runner` installs; a project
 * with other script names passes its own `classify` to `makeRunner`.
 *
 *   'direct'  — runs a suite that shares the locked resource itself (`jest.integration.config`, `jest.e2e.config`,
 *               `test:integration`, `test:e2e` — not their sub-scripts such as `test:e2e:drift`). The claim takes
 *               the lock around the command.
 *   'wrapped' — goes through the tier wrapper (`run-tier.mjs`, `npm run tier`, `test:affected`,
 *               `test:integration:affected`), which takes the lock itself, so pre-locking would make it refuse
 *               itself; the claim is only refused up front while a live holder owns the lock. `npm run tier:<x>`
 *               is a different script and is not matched.
 *   'none'    — everything else.
 *
 * `direct` is tested FIRST, over the whole command: a compound command (`a && b`, `a ; b`) with a direct segment
 * is `direct` whatever else it contains, so a wrapped or unrelated segment can never hide an unlocked suite. Its
 * wrapped segment, if any, then finds the lock held and fails loudly — a failed claim, never an unlocked run.
 */
function lockClass(command) {
  if (/jest\.(?:integration|e2e)\.config|\btest:integration(?![:\w-])|\btest:e2e(?![:\w-])/.test(command)) return 'direct';
  if (/run-tier\.mjs|\bnpm run tier(?![:\w-])|\btest:affected\b|\btest:integration:affected\b/.test(command)) return 'wrapped';
  return 'none';
}

const MAX_BUFFER = 256 * 1024 * 1024;

/**
 * The default spawn — piped stdio, BOTH streams returned whatever the exit status. Jest prints its `Tests:` summary
 * to stderr, so a runner that kept only stdout on success made every test-count claim unverifiable. Claim commands
 * run with BUILDER_NO_BASH_CAP=1 so an output cap cannot truncate the figure being checked.
 */
function defaultExec(command) {
  const r = spawnSync(command, {
    shell: true,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15 * 60 * 1000,
    maxBuffer: MAX_BUFFER,
    env: { ...process.env, BUILDER_NO_BASH_CAP: '1' },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: `${r.stderr ?? ''}${r.error ? `\n${r.error.message}` : ''}` };
}

/** The live holder of the lock at `lockPath`, or null (absent, corrupt, dead or stale). */
function liveHolder(lock, lockPath) {
  if (!existsSync(lockPath)) return null;
  try {
    const holder = JSON.parse(readFileSync(lockPath, 'utf8'));
    return lock.holderStillRunning(holder) ? holder : null;
  } catch {
    return null;
  }
}

/**
 * A claim jest can batch: `npx jest [-c|--config <cfg>|--config=<cfg>] [--runInBand|-i] <pattern…> [2>&1]` and
 * nothing else (no `-t`, no other flag, no quoting, no compound). Returns `{ config, patterns, runInBand }` or null.
 * No config is `DEFAULT_CONFIG`: the batch then passes no `-c`, and jest picks its own config as it would have.
 */
const DEFAULT_CONFIG = '(default)';
function plainJest(command) {
  const text = String(command).trim().replace(/\s+2>&1$/, '');
  // POSIX and cmd.exe (% ^) shell syntax; `#` would comment out every later pattern of the rebuilt batch command;
  // a backslash is a regex escape as often as a path separator, so it is never rewritten — the claim runs alone.
  if (/["'`;&|<>$()%^#\\]/.test(text)) return null;
  const tokens = text.split(/\s+/);
  if (tokens[0] !== 'npx' || tokens[1] !== 'jest') return null;
  let config = DEFAULT_CONFIG;
  let runInBand = false;
  const patterns = [];
  for (let i = 2; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t === '-c' || t === '--config') {
      config = tokens[(i += 1)];
      if (!config || config.startsWith('-')) return null;
    } else if (t.startsWith('--config=')) {
      config = t.slice('--config='.length);
      if (!config || config.startsWith('-')) return null; // the same guard as the spaced form
    } else if (t === '--runInBand' || t === '-i') runInBand = true;
    else if (t.startsWith('-')) return null;
    else patterns.push(t);
  }
  return patterns.length ? { config: config.replace(/^\.\//, ''), patterns, runInBand } : null;
}

/** Jest's own selection rule: a pattern is a case-insensitive regex over the test file's absolute path. */
function selects(pattern, file) {
  try {
    return new RegExp(pattern, 'i').test(file);
  } catch {
    return false;
  }
}

/** Per-file results from jest's `--json` output: `{ [absolute path, '/'-separated]: { status, message, counts } }`. */
function resultsOf(json) {
  const results = {};
  for (const t of json.testResults ?? []) {
    const counts = { failed: 0, skipped: 0, todo: 0, passed: 0 };
    for (const a of t.assertionResults ?? []) {
      if (a.status === 'passed' || a.status === 'failed' || a.status === 'todo') counts[a.status] += 1;
      else counts.skipped += 1; // pending / skipped / disabled — jest's summary says "skipped"
    }
    results[String(t.name).replace(/\\/g, '/')] = { status: t.status === 'failed' ? 'failed' : 'passed', message: t.message ?? '', counts };
  }
  return results;
}

/** The output a claim's own jest run would have ended with: FAIL/PASS lines, failure text, and jest's summary lines. */
function render(picked, header) {
  const sum = { failed: 0, skipped: 0, todo: 0, passed: 0 };
  const suites = { failed: 0, skipped: 0, passed: 0 };
  const lines = [header];
  for (const [file, r] of picked) {
    for (const k of Object.keys(sum)) sum[k] += r.counts[k];
    const failed = r.status === 'failed' || r.counts.failed > 0;
    const skipped = !failed && r.counts.passed === 0 && r.counts.skipped + r.counts.todo > 0;
    suites[failed ? 'failed' : skipped ? 'skipped' : 'passed'] += 1;
    lines.push(`${failed ? 'FAIL' : 'PASS'} ${relative(process.cwd(), file).replace(/\\/g, '/')}`);
    if (failed && r.message) lines.push(r.message);
  }
  const list = (parts, total) => [...parts.filter(([n]) => n > 0).map(([n, w]) => `${n} ${w}`), `${total} total`].join(', ');
  lines.push(`Test Suites: ${list([[suites.failed, 'failed'], [suites.skipped, 'skipped'], [suites.passed, 'passed']], picked.length)}`);
  const total = sum.failed + sum.skipped + sum.todo + sum.passed;
  lines.push(`Tests:       ${list([[sum.failed, 'failed'], [sum.skipped, 'skipped'], [sum.todo, 'todo'], [sum.passed, 'passed']], total)}`);
  return { status: suites.failed > 0 ? 1 : 0, output: `${lines.join('\n')}\n` };
}

/** The real sha/clean predicate over the checkout at `cwd`. */
const makeGit = (cwd = process.cwd()) => ({
  head() {
    const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' });
    return r.status === 0 ? r.stdout.trim() : null;
  },
  /**
   * Clean = nothing tracked or untracked-unignored changed: specs may read the boards and the registry, so any
   * change can move a count. Ignored state (dependencies, env files, a generated client, a database) is NOT seen.
   */
  clean() {
    const r = spawnSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' });
    return r.status === 0 && r.stdout.trim() === '';
  },
});

/**
 * Build the COUNT runner: `run(command, claim) → { status, output, refused? }`. `output` is stdout + stderr on every
 * exit. With no lock (none installed, or `lock: null`) every command runs unlocked.
 *
 * `batch` (`features.claims.jestBatch`; off when null): `run.prime(claims)` — called by `check` before the first
 * claim — groups every `plainJest` claim by config and runs each config ONCE (`--json`), over the union of the
 * group's patterns; each claim's output is rebuilt from the files its own patterns select. The PASSING per-file
 * result is kept in one flat file per config, `<cacheDir>/<config with each run of characters outside [\w.-] as
 * _>.json`, with the sha it ran at and the patterns it ran, and a later check reuses it only when that sha is HEAD
 * and the tree is clean — a log from another sha is refused, and only patterns not yet run are spawned. A failure
 * is never logged, so it is re-run next time. Whatever cannot be batched (no JSON, a claim selecting no file, a
 * busy lock) runs its own command as before.
 *
 * @param {{
 *   exec?: (cmd:string) => { status:number|null, stdout:string, stderr:string },
 *   lock?: { acquire: Function, holderStillRunning: Function, TierBusyError: Function, DEFAULT_LOCK: string } | null,
 *   lockPath?: string,
 *   classify?: (cmd:string) => 'direct'|'wrapped'|'none',
 *   batch?: { cacheDir: string, git?: { head(): string|null, clean(): boolean } } | null,
 * }} [deps]
 */
function makeRunner({ exec = defaultExec, lock = installedLock, lockPath, classify = lockClass, batch = null } = {}) {
  const path = lockPath ?? lock?.DEFAULT_LOCK;
  const refuse = (message) => ({ status: 75, output: `BUSY — ${message}`, refused: true });
  const outputOf = (r) => `${r.stdout ?? ''}${r.stderr ?? ''}`;
  // One check never re-spawns an identical command: claim commands only read, and one check reads one
  // tree, so the first result stands for every later claim that names it. Several counts drawn from the
  // same test run otherwise re-ran that run once each. A refusal (busy lock) is never cached — retried.
  const seen = new Map();
  /** Results `prime` produced for whole claim commands (batched, or from a same-sha log). */
  const primed = new Map();

  function run(command, claim = {}) {
    if (primed.has(command)) return primed.get(command);
    if (seen.has(command)) return seen.get(command);
    const result = runOnce(command, claim);
    if (!result.refused) seen.set(command, result);
    return result;
  }
  // One runner serves one check: the first prime decides, a second call (the CLI primes to print its line) is a no-op.
  let primedStats;
  run.prime = (claims) => (primedStats ??= batch ? prime(claims) : null);
  return run;

  function prime(claims) {
    const stats = { claims: 0, runs: 0, fromLog: 0 };
    const groups = new Map();
    for (const c of claims) {
      const p = plainJest(c.command);
      if (!p) continue;
      const g = groups.get(p.config) ?? { patterns: new Set(), runInBand: false, commands: new Map() };
      p.patterns.forEach((x) => g.patterns.add(x));
      g.runInBand ||= p.runInBand;
      g.commands.set(c.command, p);
      groups.set(p.config, g);
    }
    if (!groups.size) return stats;
    const git = batch.git ?? makeGit();
    const sha = git.head();
    const useLog = Boolean(sha) && git.clean();
    for (const [config, g] of groups) {
      const logPath = join(batch.cacheDir, `${config.replace(/[^\w.-]+/g, '_')}.json`);
      // Asked again per group: an earlier group's long run may have outlived the sha.
      const logged = useLog && git.head() === sha && git.clean() ? readLog(logPath, config, sha) : null;
      const results = { ...(logged?.results ?? {}) };
      const done = new Set(logged?.patterns ?? []);
      const todo = [...g.patterns].filter((p) => !done.has(p));
      let fresh = false;
      if (todo.length) {
        const r = runBatch(config, todo, g.runInBand, logPath);
        // A busy lock is not kept for the group: each claim then asks for itself, refused while the holder lives
        // (a loud COUNT problem) and run once it has gone, as the unbatched path does.
        if (r.refused) continue;
        stats.runs += 1;
        if (r.results) {
          Object.assign(results, r.results);
          todo.forEach((p) => done.add(p));
          fresh = true;
          // Re-checked after the run: a commit or an edit while jest ran makes the result no sha's.
          if (useLog && git.head() === sha && git.clean()) writeLog(logPath, { sha, config, ...passingOnly([...done], results) });
        }
      }
      const header = `claims-check batch — ${config} @ ${sha ?? 'no sha'} (${logged && !fresh ? 'same-sha log' : logged ? 'same-sha log + one run' : 'one run'})`;
      for (const [command, p] of g.commands) {
        if (!p.patterns.every((x) => done.has(x))) continue;
        const picked = Object.entries(results).filter(([file]) => p.patterns.some((x) => selects(x, file)));
        if (!picked.length) continue; // jest would print "No tests found": let the claim's own command say so
        primed.set(command, render(picked, header));
        stats.claims += 1;
        if (logged && p.patterns.every((x) => logged.patterns.includes(x))) stats.fromLog += 1;
      }
    }
    return stats;
  }

  function runBatch(config, patterns, runInBand, logPath) {
    mkdirSync(batch.cacheDir, { recursive: true });
    const outFile = `${logPath.replace(/\.json$/, '')}.${process.pid}.out.json`;
    const configArg = config === DEFAULT_CONFIG ? '' : ` -c ${config}`;
    const command = `npx jest${configArg}${runInBand ? ' --runInBand' : ''} --json --outputFile=${outFile} ${patterns.join(' ')}`;
    try {
      const r = runOnce(command, { id: `batch ${config}` });
      if (r.refused) return r;
      try {
        return { results: resultsOf(JSON.parse(readFileSync(outFile, 'utf8'))) };
      } catch {
        return { results: null }; // jest wrote no JSON: every claim of the group runs its own command
      }
    } finally {
      rmSync(outFile, { force: true });
    }
  }

  function runOnce(command, claim) {
    const cls = lock ? classify(command) : 'none';
    if (cls === 'wrapped') {
      const holder = liveHolder(lock, path);
      if (holder) return refuse(`tier "${holder.tier}" holds the machine-wide lock (pid ${holder.pid}, since ${holder.startedAt}); re-run the claims check when it finishes`);
    }
    let held;
    if (cls === 'direct') {
      try {
        held = lock.acquire(`claims:${claim.id ?? '?'}`, { lockPath: path });
      } catch (error) {
        if (!(error instanceof lock.TierBusyError)) throw error;
        return refuse(error.message);
      }
    }
    try {
      const r = exec(command);
      return { status: r.status, output: outputOf(r) };
    } finally {
      held?.release();
    }
  }
}

/**
 * Only a pattern whose every selected file PASSED is logged, with those files — and a pattern that selected no file
 * is not a pass. A failure (a real defect, or a flaky or unreachable dependency) is never replayed: the next check
 * at the same sha runs it again.
 */
function passingOnly(patterns, results) {
  const passed = (r) => r.status === 'passed' && r.counts.failed === 0;
  const kept = patterns.filter((p) => {
    const mine = Object.entries(results).filter(([file]) => selects(p, file));
    return mine.length > 0 && mine.every(([, r]) => passed(r));
  });
  const files = Object.entries(results).filter(([file]) => kept.some((p) => selects(p, file)));
  return { patterns: kept, results: Object.fromEntries(files) };
}

/** A per-config result log, or null unless it was written at `sha` for `config` with well-formed entries. */
function readLog(logPath, config, sha) {
  try {
    const body = JSON.parse(readFileSync(logPath, 'utf8'));
    if (!(body && body.sha === sha && body.config === config && Array.isArray(body.patterns) && body.results)) return null;
    // Every entry must have the shape render() reads, or the log is refused — never thrown on.
    const counted = (c) => c && ['failed', 'skipped', 'todo', 'passed'].every((k) => Number.isInteger(c[k]));
    return Object.values(body.results).every((r) => r && typeof r.status === 'string' && counted(r.counts)) ? body : null;
  } catch {
    return null;
  }
}

function writeLog(logPath, body) {
  writeFileSync(logPath, JSON.stringify({ ...body, writtenAt: new Date().toISOString() }));
}

module.exports = { check, citationPattern, referencePattern, ID_SHAPE, DEFAULT_REGISTRY_ID, makeRunner, lockClass, plainJest, makeGit, lockInstalled: installedLock !== null };
