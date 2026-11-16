'use strict';
/**
 * Every requirement id must have a test or a requirement-pack step.
 *
 * WHY THIS EXISTS. A requirement nobody traced is invisible debt: the module looks done, the suite is green, and
 * nothing in it ever asked whether the rule holds. The requirement-pack template (templates/requirement-pack.md) gives
 * each requirement one of four honest outcomes — `assert` (it holds), `by-design` (it diverges, with the citation that
 * says so), `gap` (knowingly unenforced) or `skipped` (could not run, with the reason). A requirement with none of
 * them, and no test either, has no outcome at all. That is what this check refuses at the readiness gate.
 *
 * WHAT IS A TRACE.
 *   - In a TEST file (under `tests`, matching `testPattern`): any whole-token mention of the id — a test name, a
 *     describe block, a comment beside the assertion. A pack tag written inside a test keeps its verb.
 *   - In a PACK file (under `packs`): a STEP only, in one of the template's two forms —
 *       `<verb>  REQ-…  text`            (the pack shape: the line starts with assert · by-design · gap · skipped)
 *       `REQ-…: text`                    (a step name; an assert)
 *       `REQ-… [by-design <cite>]: text` · `REQ-… [known-gap]: text` · `REQ-… [skipped]: text`
 *     A plain mention in a pack ("REQ-001 is covered elsewhere") is a note, not a step, and traces nothing.
 *   - A `by-design` step must carry its citation (`[by-design <cite>]`, or `by-design REQ-… [<cite>]`). One without
 *     it is UNCITED: it traces nothing and fails the check, because the template's whole point for that verb is that
 *     the divergence is documented.
 *
 * TWO CONTROLS. Requirement files that declare zero ids fail (a set of nothing is traced by nothing), and a run that
 * read no test or pack file fails (a trace that read nothing traced nothing).
 *
 * Pure over text; `scripts/spec-trace-check.mjs` reads the files.
 */

const KINDS = ['test', 'assert', 'by-design', 'gap', 'skipped'];
const VERB = /^\s*[-*]?\s*(assert|by-design|gap|known-gap|skipped)\s/;

/** The id pattern as a whole-token, global regex: `XREQ-001` and `REQ-001_x` are not `REQ-001`. */
function compileId(idPattern, flags = '') {
  return new RegExp(`(?<![A-Za-z0-9_-])(?:${idPattern})(?![A-Za-z0-9_])`, `g${flags.replace('g', '')}`);
}

const verbOf = (word) => (word === 'known-gap' ? 'gap' : word);

/** Every id declared in the requirement files, with its first site. Map preserves declared order. */
function declared(files, idRe) {
  const map = new Map();
  for (const { path, text } of files) {
    String(text)
      .split(/\r?\n/)
      .forEach((line, i) => {
        for (const m of line.matchAll(idRe)) if (!map.has(m[0])) map.set(m[0], { path, line: i + 1 });
      });
  }
  return map;
}

/**
 * The traces one file holds.
 * @param {'test'|'pack'} role
 * @returns {{ steps: { id, kind, path, line, cite? }[], uncited: { id, path, line }[] }}
 */
function scanFile(text, path, idRe, role) {
  const steps = [];
  const uncited = [];
  String(text)
    .split(/\r?\n/)
    .forEach((line, i) => {
      const lead = VERB.exec(line);
      for (const m of line.matchAll(idRe)) {
        const id = m[0];
        const rest = line.slice(m.index + id.length);
        const at = { id, path, line: i + 1 };
        const tag = /^\s*\[([^\]]*)\]/.exec(rest);
        const tagged = tag && /^\s*(by-design|known-gap|gap|skipped)\b\s*(.*)$/.exec(tag[1]);
        let kind = null;
        let cite = null;
        if (tagged) {
          kind = verbOf(tagged[1]);
          cite = tagged[2].replace(/^[:\s—-]+/, '').trim();
        } else if (lead) {
          kind = verbOf(lead[1]);
          cite = tag ? tag[1].trim() : '';
        } else if (role === 'test') {
          kind = 'test';
        } else if (/^\s*:/.test(rest)) {
          kind = 'assert';
        }
        if (!kind) continue;
        if (kind === 'by-design') {
          if (!cite) {
            uncited.push(at);
            continue;
          }
          steps.push({ ...at, kind, cite });
        } else {
          steps.push({ ...at, kind });
        }
      }
    });
  return { steps, uncited };
}

/**
 * Join declared ids to their traces.
 * @returns {{ results: { id, declaredAt, traces, verdict: 'traced'|'UNTRACED' }[], undeclared: object[], kinds: object }}
 */
function trace(declaredMap, steps) {
  const by = new Map();
  for (const s of steps) {
    if (!by.has(s.id)) by.set(s.id, []);
    by.get(s.id).push(s);
  }
  const results = [...declaredMap].map(([id, declaredAt]) => {
    const traces = (by.get(id) ?? []).map(({ kind, path, line, cite }) => (cite ? { kind, path, line, cite } : { kind, path, line }));
    return { id, declaredAt, traces, verdict: traces.length ? 'traced' : 'UNTRACED' };
  });
  const undeclared = steps.filter((s) => !declaredMap.has(s.id));
  const kinds = Object.fromEntries(KINDS.map((k) => [k, 0]));
  for (const s of steps) if (declaredMap.has(s.id)) kinds[s.kind] += 1;
  return { results, undeclared, kinds };
}

module.exports = { KINDS, compileId, declared, scanFile, trace };
