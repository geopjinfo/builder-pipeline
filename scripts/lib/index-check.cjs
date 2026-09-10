'use strict';
/**
 * Knowledge-index freshness — the EXIT-CODE CONTRACT, as a pure verdict. Facts in, exit code and digest out.
 *
 * WHY THIS EXISTS. An index sync worker once exited 0 — "nothing changed" — with over a hundred documents
 * still waiting to be embedded. Exit 0 read as "fresh" to every caller, so the planning step meant to catch
 * a rotten index passed over one. A check whose success code covers two different states is not a check.
 *
 * So every state gets its own code, and a caller branches on the number, never on prose:
 *
 *   0   fresh — code and docs both current
 *   1   error — the check itself failed
 *   3   absent — no index on this machine (indexes are usually untracked; a fresh clone has none)
 *   4   unmeasurable — an index is present but its tooling is unreachable
 *   10  docs pending — code current, documents awaiting (re-)embedding (usually spends tokens)
 *   11  code behind — code changed since the index was built, docs current (usually free to sync)
 *   12  both
 *
 * Any index tool maps onto it: its check command either exits with these codes, or prints one JSON facts
 * line (`{ "index": true, "tooling": true, "changedCode": 0, "deleted": 0, "pendingDocs": [...] }`) that
 * `verdict()` turns into the code. When both are present the facts win — a success exit over pending
 * documents is exactly the failure this contract exists to catch.
 *
 * CODE-BEHIND IS MEASURED BY CONTENT, NOT BY COMMIT. A "built at commit" stamp only moves when a sync
 * writes the index, so after any commit that touches nothing indexed HEAD moves and the stamp does not;
 * a commit comparison would report "behind" forever over an index that is byte-current. The stamp is
 * reported beside the verdict as information only.
 *
 * THE AUTO-EMBED LIMIT (`features.graph.autoLimitKb`): above it, a person decides whether to spend the
 * tokens; at or below it, the pipeline may embed automatically.
 */

const EXIT = Object.freeze({ FRESH: 0, ERROR: 1, ABSENT: 3, UNMEASURABLE: 4, DOCS: 10, CODE: 11, BOTH: 12 });
const DEFAULT_AUTO_LIMIT_KB = 300;

const STATE = Object.freeze({
  [EXIT.FRESH]: 'fresh',
  [EXIT.ERROR]: 'error',
  [EXIT.ABSENT]: 'absent',
  [EXIT.UNMEASURABLE]: 'unmeasurable',
  [EXIT.DOCS]: 'docs-pending',
  [EXIT.CODE]: 'code-behind',
  [EXIT.BOTH]: 'code-behind+docs-pending',
});

const kb = (bytes) => `${Math.round(bytes / 1024)} KB`;

/**
 * @param {object} facts
 * @param {boolean} facts.index              an index exists on this machine
 * @param {boolean} [facts.tooling]          the index tooling answered
 * @param {number}  [facts.changedCode]      code files whose content differs from the index manifest
 * @param {number}  [facts.deleted]          manifest entries whose file is gone or now ignored
 * @param {{path:string,bytes:number}[]} [facts.pendingDocs]  documents awaiting embedding
 * @param {number}  [facts.pruned]           pending entries dropped because they are ignored or missing
 * @param {string}  [facts.builtAtCommit]
 * @param {string}  [facts.head]
 * @param {{ autoLimitKb?: number }} [options]
 */
function verdict(facts, { autoLimitKb = DEFAULT_AUTO_LIMIT_KB } = {}) {
  const limitBytes = (Number(autoLimitKb) > 0 ? Number(autoLimitKb) : DEFAULT_AUTO_LIMIT_KB) * 1024;
  if (!facts || !facts.index) {
    return { code: EXIT.ABSENT, state: STATE[EXIT.ABSENT], lines: ['graph: absent — build the index once to measure it', `verdict: absent (exit ${EXIT.ABSENT})`] };
  }
  if (!facts.tooling) {
    return {
      code: EXIT.UNMEASURABLE,
      state: STATE[EXIT.UNMEASURABLE],
      lines: ['graph: present, but its tooling is unreachable — freshness cannot be measured', `verdict: unmeasurable (exit ${EXIT.UNMEASURABLE})`],
    };
  }
  const pending = Array.isArray(facts.pendingDocs) ? facts.pendingDocs : [];
  const pendingBytes = pending.reduce((sum, doc) => sum + (Number(doc.bytes) || 0), 0);
  const codeBehind = (facts.changedCode ?? 0) + (facts.deleted ?? 0) > 0;
  const docsPending = pending.length > 0;
  const code = codeBehind && docsPending ? EXIT.BOTH : codeBehind ? EXIT.CODE : docsPending ? EXIT.DOCS : EXIT.FRESH;
  const overLimit = pendingBytes > limitBytes;

  const lines = [
    `code:  ${codeBehind ? `BEHIND — ${facts.changedCode ?? 0} changed, ${facts.deleted ?? 0} to prune` : 'current'}`,
    `docs:  ${docsPending ? `${pending.length} pending, ${kb(pendingBytes)} (${overLimit ? 'ABOVE' : 'within'} the ${kb(limitBytes)} auto-embed limit${overLimit ? ' — a person decides' : ''})` : 'current'}`,
  ];
  if (facts.pruned) lines.push(`prune: ${facts.pruned} pending entr${facts.pruned === 1 ? 'y is' : 'ies are'} ignored or missing — the next sync drops them`);
  if (facts.builtAtCommit && facts.head) {
    const same = facts.head.startsWith(facts.builtAtCommit.slice(0, 7)) || facts.builtAtCommit.startsWith(facts.head.slice(0, 7));
    lines.push(`stamp: built at ${facts.builtAtCommit.slice(0, 8)} ${same ? '=' : '≠'} HEAD ${facts.head.slice(0, 8)} (information — freshness is by content)`);
  }
  lines.push(`verdict: ${STATE[code]} (exit ${code})`);
  return { code, state: STATE[code], pendingBytes, overLimit, lines };
}

/** The verdict line for a bare exit code from a check command that printed no facts. */
function lineForCode(code) {
  if (!Object.prototype.hasOwnProperty.call(STATE, code)) return null;
  const meaning = {
    [EXIT.FRESH]: 'code and docs current',
    [EXIT.ERROR]: 'the check failed',
    [EXIT.ABSENT]: 'no index on this machine — record it and proceed',
    [EXIT.UNMEASURABLE]: 'index present, tooling unreachable',
    [EXIT.DOCS]: 'docs pending embed',
    [EXIT.CODE]: 'code behind the index',
    [EXIT.BOTH]: 'code behind and docs pending',
  }[code];
  return `verdict: ${STATE[code]} (exit ${code}) — ${meaning}`;
}

/** The first line of a check's stdout that parses as a JSON object, or null. */
function factsFrom(stdout) {
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const v = JSON.parse(t);
      if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    } catch {
      /* not the facts line */
    }
  }
  return null;
}

/**
 * The CLI's decision over one run of the check command. Pure.
 * @param {{ spawnError?: boolean, status: number|null, stdout?: string }} run
 * @param {{ autoLimitKb?: number }} [options]
 * @returns {{ code: number, lines: string[] }}
 */
function fromRun(run, options = {}) {
  if (run.spawnError || run.status === null) {
    return { code: EXIT.UNMEASURABLE, lines: ['graph: the check command could not be started — freshness cannot be measured', lineForCode(EXIT.UNMEASURABLE)] };
  }
  const facts = factsFrom(run.stdout);
  if (facts) {
    const v = verdict(facts, options);
    const note = run.status !== v.code && lineForCode(run.status) ? [`note: the check exited ${run.status}; its facts say exit ${v.code} — the facts win`] : [];
    return { code: v.code, lines: [...v.lines, ...note] };
  }
  const line = lineForCode(run.status);
  if (!line) return { code: EXIT.ERROR, lines: [`graph: the check exited ${run.status}, which is not in the exit-code contract`, lineForCode(EXIT.ERROR)] };
  return { code: run.status, lines: [line] };
}

module.exports = { EXIT, STATE, DEFAULT_AUTO_LIMIT_KB, verdict, lineForCode, factsFrom, fromRun };
