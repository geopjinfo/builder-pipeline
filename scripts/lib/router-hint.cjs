'use strict';
/**
 * routerHint — advisory account suggestion, risk flag and second-opinion advice for one lane
 * (plan M8b, D15; `features.routerHint`, experimental-off; EXPERIMENTS.md §16).
 *
 * WHY. A decisions-style API, or the local rule below, can say which account fits a lane and how risky the lane is.
 * A probability is not an exit code (D15): the kit prints the advice and places the lane by the rulebook as before.
 * Nothing here changes a placement, a seat or a lane; `suggest()` returns a new object and leaves its inputs alone.
 *
 * TWO DOORS, IN ORDER. A call that would send task text to an account is refused
 *   1. E_DATA_RECIPIENT — the account is a data recipient (pays free or gateway, or a baseUrl) and the decision log
 *      has no row that names it (the M4 policy, scripts/lib/account-policy.cjs). This is judged first.
 *   2. E_GUARD_OFF — `features.outboundGuard` is not on: nothing leaves without the guard.
 *   3. E_OUTBOUND — the outbound guard refuses the payload (a denied file, a secret shape, an env value, the size).
 * A refusal names the kind of match, never the text.
 *
 * OFF, NOTHING RUNS. `run()` with the feature not active returns the feature line and calls nothing. Pure over the
 * settings, the lane and the accounts; the only I/O is the injected `fsLike` of the guard.
 */
const guard = require('./outbound-guard.cjs');
const policy = require('./account-policy.cjs');
const family = require('./family-review.cjs');

const ACTIVE = new Set(['on', 'unmeasured', 'experimental-on']);
const PAYS_ORDER = ['subscription', 'gateway', 'free', 'api-key'];
const placeable = (a) => !Array.isArray(a.roles) || a.roles.length === 0 || a.roles.includes('module-builder');
const active = (state) => ACTIVE.has(state);

/** Why an account's content class does not fit the project's visibility, or null. */
function contentRisk(account, visibility) {
  const v = visibility === 'public' ? 'public' : 'private';
  if (account.content === 'scratch') return `content scratch vs visibility ${v} (a scratch account sees no project source)`;
  if (account.content === 'public' && v !== 'public') return `content public vs visibility ${v}`;
  return null;
}

/**
 * The advice for one lane. Advisory only: a new object, the inputs untouched, no placement field.
 * @param {{ lane: object, accounts: object[], visibility?: string, writer?: string|null }} input
 * @returns {{ advisory: true, account: string|null, risk: string[], secondOpinion: { advised: boolean, reason: string }, lines: string[] }}
 */
function suggest({ lane = {}, accounts = [], visibility = 'private', writer = null } = {}) {
  const risk = [];
  const ordered = accounts
    .map((a, i) => ({ a, i, pays: PAYS_ORDER.indexOf(a.pays) }))
    .sort((x, y) => (x.pays < 0 ? PAYS_ORDER.length : x.pays) - (y.pays < 0 ? PAYS_ORDER.length : y.pays) || x.i - y.i)
    .map((x) => x.a);
  let pick = null;
  for (const a of ordered) {
    if (!placeable(a)) continue;
    const why = contentRisk(a, visibility);
    if (why) {
      risk.push(`${a.name}: ${why}`);
      continue;
    }
    if (!pick) pick = a;
  }
  if (lane.level === 'Full') risk.push(`lane ${lane.name || '?'}: level Full (${lane.track || 'FULL'}) — a high-risk row`);
  const w = (writer && accounts.find((a) => a.name === writer)) || pick;
  let secondOpinion;
  if (lane.level !== 'Full') secondOpinion = { advised: false, reason: `level ${lane.level || 'unknown'}: a second opinion is advised for a Full lane only` };
  else if (!w) secondOpinion = { advised: false, reason: 'no writer account to compare against' };
  else {
    const second = family.secondReader(w, accounts);
    secondOpinion = second.account ? { advised: true, reason: second.reason.replace(/^familyReview: /, '') } : { advised: false, reason: second.reason.replace(/^familyReview: /, '') };
  }
  const lines = [];
  lines.push(pick ? `routerHint: suggest ${pick.name} (worker ${pick.worker || 'unknown'}, pays ${pick.pays || 'unknown'}) for lane ${lane.name || '?'}` : `routerHint: no account suggestion for lane ${lane.name || '?'} — no account may hold a lane under visibility ${visibility === 'public' ? 'public' : 'private'}`);
  lines.push(risk.length ? `routerHint: risk — ${risk.join('; ')}` : 'routerHint: risk — none flagged');
  lines.push(`routerHint: second opinion ${secondOpinion.advised ? 'advised' : 'not advised'} — ${secondOpinion.reason}`);
  lines.push('routerHint: advisory only — placement is unchanged');
  return { advisory: true, account: pick ? pick.name : null, risk, secondOpinion, lines };
}

/**
 * Send task text through the two doors. `call(payload)` is the experiment's own model call.
 * @param {{ text?: string, files?: Array<{ path: string, content?: string }> }} payload
 * @param {Function} call
 * @param {{ account: object, decisions?: string, decisionIdPattern?: string, decisionsPath?: string, guard?: { state?: string, [k: string]: any }, root?: string, fsLike?: object }} opts
 */
async function send(payload, call, opts = {}) {
  const account = opts.account || {};
  if (policy.isDataRecipient(account)) {
    const host = account.baseUrl ? policy.hostOf(account.baseUrl) : null;
    const pattern = opts.decisionIdPattern || 'D-\\d+';
    const name = account.name || '(unnamed)';
    if (!policy.hasDecision(opts.decisions || '', { name, host, pattern })) {
      return { sent: false, code: 'E_DATA_RECIPIENT', reasons: [`account ${name} is a data recipient (pays ${account.pays}${host ? `, baseUrl host ${host}` : ''}) with no decision-log entry — add a row to ${opts.decisionsPath || 'DECISIONS.md'} whose id matches ${pattern} and whose text names "${name}"${host ? ` or "${host}"` : ''}; nothing is sent`] };
    }
  }
  const g = opts.guard || {};
  if (!active(g.state)) return { sent: false, code: 'E_GUARD_OFF', reasons: ['features.outboundGuard is not on — routerHint sends nothing without the guard'] };
  const { state, ...config } = g;
  const r = await guard.send(payload, call, { root: opts.root, config, fsLike: opts.fsLike });
  return r.sent ? r : { ...r, code: 'E_OUTBOUND' };
}

/**
 * Run the experiment for one lane from the merged settings. Off: the feature line, nothing else.
 * @param {object} settings  merged profile settings
 * @param {{ lane: object, accounts: object[], writer?: string|null, call?: Function, payload?: object, decisions?: string, root?: string, fsLike?: object }} input
 */
async function run(settings, input = {}) {
  const f = settings && settings.features ? settings.features.routerHint : null;
  const state = f && f.state ? f.state : 'experimental-off';
  if (!active(state)) return { ran: false, line: `routerHint: experimental — ${state === 'off' ? 'not configured' : 'not enabled'}` };
  const advice = suggest({ lane: input.lane, accounts: input.accounts, visibility: settings.visibility, writer: input.writer });
  const out = { ran: true, ...advice };
  if (typeof input.call === 'function' && advice.account) {
    const account = (input.accounts || []).find((a) => a.name === advice.account);
    const handoff = (settings.features && settings.features.handoffPack) || {};
    const r = await send(input.payload || { text: advice.lines.join('\n') }, input.call, {
      account, decisions: input.decisions || '', decisionIdPattern: handoff.decisionIdPattern, decisionsPath: settings.paths && settings.paths.decisions,
      guard: settings.features && settings.features.outboundGuard, root: input.root, fsLike: input.fsLike,
    });
    Object.assign(out, { sent: r.sent, code: r.code, reasons: r.reasons, result: r.result, error: r.error });
    out.lines = [...out.lines, r.sent ? 'routerHint: advice requested through the outbound guard' : `routerHint: ${r.code} — ${(r.reasons || []).join('; ')}`];
  }
  return out;
}

module.exports = { suggest, send, run, contentRisk, active, PAYS_ORDER };
