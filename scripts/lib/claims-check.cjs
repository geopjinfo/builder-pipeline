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
 *                 output must match `expect` (a regex). A figure is a claim about a command's output, so the
 *                 command is kept beside it and run again.
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
const { existsSync, readFileSync } = require('node:fs');

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
  for (const claim of ctx.claims ?? []) {
    let pattern;
    try {
      pattern = new RegExp(claim.expect, 'm');
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
 * Build the COUNT runner: `run(command, claim) → { status, output, refused? }`. `output` is stdout + stderr on every
 * exit. With no lock (none installed, or `lock: null`) every command runs unlocked.
 *
 * @param {{
 *   exec?: (cmd:string) => { status:number|null, stdout:string, stderr:string },
 *   lock?: { acquire: Function, holderStillRunning: Function, TierBusyError: Function, DEFAULT_LOCK: string } | null,
 *   lockPath?: string,
 *   classify?: (cmd:string) => 'direct'|'wrapped'|'none',
 * }} [deps]
 */
function makeRunner({ exec = defaultExec, lock = installedLock, lockPath, classify = lockClass } = {}) {
  const path = lockPath ?? lock?.DEFAULT_LOCK;
  const refuse = (message) => ({ status: 75, output: `BUSY — ${message}`, refused: true });
  const outputOf = (r) => `${r.stdout ?? ''}${r.stderr ?? ''}`;
  // One check never re-spawns an identical command: claim commands only read, and one check reads one
  // tree, so the first result stands for every later claim that names it. Several counts drawn from the
  // same test run otherwise re-ran that run once each. A refusal (busy lock) is never cached — retried.
  const seen = new Map();

  return function run(command, claim = {}) {
    if (seen.has(command)) return seen.get(command);
    const result = runOnce(command, claim);
    if (!result.refused) seen.set(command, result);
    return result;
  };

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

module.exports = { check, citationPattern, referencePattern, ID_SHAPE, DEFAULT_REGISTRY_ID, makeRunner, lockClass, lockInstalled: installedLock !== null };
