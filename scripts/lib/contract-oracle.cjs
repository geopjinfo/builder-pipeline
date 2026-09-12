'use strict';
/**
 * Runtime contract oracle — what the RUNNING application served, judged against its written contract.
 *
 * WHY. A contract check that compares the document with a snapshot regenerated from the very routes it
 * describes proves the document agrees with itself, and nothing about what the server does. A route that
 * accepts a query parameter its document never lists, or answers 201 where the contract says 200, passes
 * that check forever. A behavioural test run already sends real requests; if it writes each request and
 * response to a transcript, this reads the transcript and judges every served answer.
 *
 * INPUT. JSONL records `{ seq, method, url, status, responseBody }` (responseBody a string or an object),
 * and operations compiled by an adapter (`oracles/<adapter>.cjs`, e.g. `openapi3`).
 *
 * CLASSES (failing):
 *   status-drift        the served status is not among the operation's declared responses
 *   query-drift         a success (< 400) to a request carrying a query parameter the operation does not declare
 *   code-drift          an error code other than the ones declared for that status
 *   undocumented-route  a success (< 400) on a method + path the contract does not describe
 * Informational (never failing):
 *   other-code          when `platformCodePattern` is set, an undeclared code that does not match it
 *                       (a module- or feature-specific code under a declared status)
 *
 * CONFIG (from `features.contractOracle`, no project codes built in):
 *   codeField            the error body's code field (default "code")
 *   statusFamilies       { "409": ["CONFLICT", "STALE"] } — codes a status may carry beyond the per-operation
 *                        examples. A document usually shows ONE example per status while the project's
 *                        error standard allows several; judging only the example flags correct answers.
 *   platformCodePattern  a regex; when set, only undeclared codes matching it are code-drift.
 */

const FAILING = new Set(['status-drift', 'query-drift', 'code-drift', 'undocumented-route']);

const DEFAULT_CONFIG = { codeField: 'code', statusFamilies: {}, platformCodePattern: null };

function configOf(config) {
  const c = { ...DEFAULT_CONFIG, ...(config ?? {}) };
  return {
    codeField: c.codeField || 'code',
    statusFamilies: c.statusFamilies && typeof c.statusFamilies === 'object' ? c.statusFamilies : {},
    platform: c.platformCodePattern ? new RegExp(c.platformCodePattern) : null,
  };
}

/** A status is declared exactly, by its range key (`4XX`), or by `default`. */
function statusDeclared(op, status) {
  const s = String(status);
  return op.statuses.has(s) || op.statuses.has(`${s[0]}XX`) || op.statuses.has('DEFAULT');
}

function bodyCode(responseBody, codeField) {
  let body = responseBody;
  if (typeof body === 'string') {
    if (!body.trim().startsWith('{')) return null;
    try {
      body = JSON.parse(body);
    } catch {
      return null;
    }
  }
  const code = body && typeof body === 'object' ? body[codeField] : null;
  return typeof code === 'string' || typeof code === 'number' ? String(code) : null;
}

function queryDeclared(op, name) {
  if (op.openQuery || op.query.has(name)) return true;
  const bracket = /^([^[]+)\[/.exec(name);
  return Boolean(bracket && op.deepQuery?.has(bracket[1]));
}

/**
 * @param {{ seq?: number, method: string, url: string, status: number, responseBody?: string|object }} record
 * @param {object[]} ops  compiled operations, most specific first
 * @param {object} [config]
 * @returns {{ op: object|null, problems: { class: string, detail: string }[] }}
 */
function judge(record, ops, config) {
  const { codeField, statusFamilies, platform } = configOf(config);
  const url = new URL(String(record.url ?? ''), 'http://oracle.local');
  const method = String(record.method ?? '').toUpperCase();
  const status = Number(record.status);
  const op = ops.find((o) => o.method === method && o.re.test(url.pathname)) ?? null;
  const problems = [];
  if (!op) {
    if (status < 400) problems.push({ class: 'undocumented-route', detail: `${method} ${url.pathname} answered ${status}` });
    return { op, problems };
  }
  if (!statusDeclared(op, status)) {
    problems.push({ class: 'status-drift', detail: `answered ${status}; declared ${[...op.statuses].join('/')}` });
  }
  if (status < 400) {
    for (const name of new Set(url.searchParams.keys())) {
      if (!queryDeclared(op, name)) problems.push({ class: 'query-drift', detail: `accepted undeclared query parameter "${name}"` });
    }
  }
  if (status >= 400) {
    const code = bodyCode(record.responseBody, codeField);
    const key = String(status);
    const perOp = op.codes.get(key) ?? op.codes.get(`${key[0]}XX`) ?? null;
    // A family widens a status the operation declares; it never declares a status the operation does not.
    const declared = new Set([...(perOp ?? []), ...(perOp ? statusFamilies[key] ?? [] : [])]);
    if (code && declared.size > 0 && !declared.has(code)) {
      const cls = platform && !platform.test(code) ? 'other-code' : 'code-drift';
      problems.push({ class: cls, detail: `${status} carried ${code}; declared ${[...declared].join('/')}` });
    }
  }
  return { op, problems };
}

/**
 * Distinct findings, keyed so a baseline survives re-runs: class · METHOD template · status · detail
 * (the served status is dropped from the detail — it is already in the key).
 */
function findings(records, ops, config) {
  const byKey = new Map();
  let matched = 0;
  for (const record of records) {
    const { op, problems } = judge(record, ops, config);
    if (op) matched += 1;
    const where = op?.template ?? new URL(String(record.url ?? ''), 'http://oracle.local').pathname;
    for (const p of problems) {
      const method = String(record.method ?? '').toUpperCase();
      const key = `${p.class} ${method} ${where} ${record.status} ${p.detail.replace(/^answered \d+; /, '')}`;
      const hit = byKey.get(key) ?? { key, class: p.class, count: 0, example: `#${record.seq ?? '?'} ${method} ${record.url}` };
      hit.count += 1;
      byKey.set(key, hit);
    }
  }
  return { matched, total: records.length, findings: [...byKey.values()] };
}

/**
 * Split the failing findings against a baseline: `fresh` fail the run, `known` are reported, `resolved`
 * are baseline entries the transcript no longer produces (prune with a re-baseline).
 * @param {{ findings: object[] }} result
 * @param {{ findings?: { key: string }[] } | null} baseline
 */
function compare(result, baseline) {
  const knownKeys = new Set((baseline?.findings ?? []).map((f) => f.key));
  const current = new Set(result.findings.map((f) => f.key));
  const failing = result.findings.filter((f) => FAILING.has(f.class));
  return {
    failing,
    fresh: failing.filter((f) => !knownKeys.has(f.key)),
    known: failing.filter((f) => knownKeys.has(f.key)),
    resolved: (baseline?.findings ?? []).filter((f) => !current.has(f.key)),
  };
}

const entryOf = ({ key, class: c, count, example }) => ({ key, class: c, count, example });

function baselineDocument(failing, transcript) {
  return {
    _doc: 'contract-oracle baseline — known drift that does not fail the run. Each entry needs a registry row or a written reason; it shrinks by itself and grows only by a named --accept.',
    transcript,
    findings: failing.map(entryOf),
  };
}

/**
 * The next baseline — SHRINK-ONLY.
 *
 * WHY. A write that re-records "whatever fails now" absorbs every new drift finding in one motion, and the
 * baseline's whole value is that it holds only drift somebody CHOSE to carry. So a plain write may only
 * prune entries the run no longer produces. A new finding enters one of two ways: named, one key at a time
 * (`accept`), or — on adoption, when there is no baseline yet to protect — all at once (`initial`).
 *
 * Entries already carried are left exactly as they were (their count and example are not refreshed): a
 * refresh would rewrite the file on every run, and a baseline that changes when nothing was decided is noise
 * on the one artefact that must only move deliberately.
 *
 * @param {{ key: string }[]} current   the run's FAILING findings (`compare().failing`)
 * @param {object|null} baseline        the parsed baseline document, or null when no file exists
 * @param {{ accept?: string[], initial?: boolean, transcript?: string|null }} [options]
 * @returns {{ document: object|null, added: object[], pruned: object[], refused: object[], noop: string[],
 *             unknown: string[], invalid: string[], changed: boolean }}
 *   invalid / unknown → a usage error (nothing may be written) · refused → unnamed fresh findings (nothing may
 *   be written) · otherwise `document` is what to write when `changed`.
 */
function nextBaseline(current, baseline, options = {}) {
  const accept = [...new Set(options.accept ?? [])];
  const initial = Boolean(options.initial);
  const out = { document: null, added: [], pruned: [], refused: [], noop: [], unknown: [], invalid: [], changed: false };
  if (initial && baseline) out.invalid.push('--initial records every failing finding and is only for adoption — a baseline already exists; prune with --write-baseline, add with --accept');
  if (initial && accept.length) out.invalid.push('--initial and --accept are exclusive — --initial already records every failing finding');
  if (out.invalid.length) return out;

  if (initial) {
    out.added = current.map(entryOf);
    out.document = baselineDocument(current, options.transcript ?? null);
    out.changed = true;
    return out;
  }

  const carried = baseline?.findings ?? [];
  const carriedKeys = new Set(carried.map((f) => f.key));
  const byKey = new Map(current.map((f) => [f.key, f]));
  for (const key of accept) {
    if (carriedKeys.has(key)) out.noop.push(key);
    else if (!byKey.has(key)) out.unknown.push(key);
  }
  if (out.unknown.length) return out;

  const named = new Set(accept);
  const fresh = current.filter((f) => !carriedKeys.has(f.key));
  out.refused = fresh.filter((f) => !named.has(f.key));
  if (out.refused.length) return out;

  out.added = fresh.map(entryOf);
  out.pruned = carried.filter((f) => !byKey.has(f.key));
  out.changed = out.added.length > 0 || out.pruned.length > 0;
  const kept = carried.filter((f) => byKey.has(f.key));
  const base = baseline ?? baselineDocument([], options.transcript ?? null);
  out.document = { ...base, findings: [...kept, ...out.added] };
  return out;
}

/** JSONL text → records; a blank line is skipped, a malformed one throws with its line number. */
function parseTranscript(text) {
  const out = [];
  String(text)
    .split(/\r?\n/)
    .forEach((line, i) => {
      if (!line.trim()) return;
      try {
        out.push(JSON.parse(line));
      } catch (e) {
        throw new Error(`transcript line ${i + 1}: ${e.message}`);
      }
    });
  return out;
}

module.exports = { FAILING, judge, findings, compare, baselineDocument, nextBaseline, parseTranscript };
