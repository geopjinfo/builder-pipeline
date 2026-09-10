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
 * Pure over (documents, fs probe, context); `scripts/claims-check.mjs` does the I/O and reads the settings.
 */

/**
 * Any id-shaped token — a decision-log id (`D-7`), a registry id (letters, a dash, a `D` and a number), a
 * sub-lettered reference (`REF-12b`). Used to decide whether a line names what retracted a phrase.
 */
const ID_SHAPE = /\b[A-Z][A-Z0-9]*-[A-Z]*\d+[a-z]?\b/g;
const OWED_LINE = /\bNEEDS-RULING\b|\bowed\b/i;
const HANDOFF_REF = /\bhandoff\s*§[A-F]\b/i;
const DEFAULT_REGISTRY_ID = '[A-Z][A-Z0-9]{1,8}-D\\d+[a-z]?';

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
 *   run?(cmd:string): {status:number|null, output:string},
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
    const result = ctx.run(claim.command);
    if (!pattern.test(result.output)) {
      const tail = result.output.trim().split(/\r?\n/).slice(-3).join(' ⏎ ').slice(0, 300);
      push('count', `claims.jsonl ${claim.id}`, `"${claim.text}" — \`${claim.command}\` (exit ${result.status}) no longer prints /${claim.expect}/; last lines: ${tail}`);
    }
  }

  for (const doc of documents) {
    const lines = doc.text.split(/\r?\n/);
    lines.forEach((line, i) => {
      const where = `${doc.name}:${i + 1}`;

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
    });
  }
  return problems;
}

module.exports = { check, citationPattern, referencePattern, ID_SHAPE, DEFAULT_REGISTRY_ID };
