'use strict';
/**
 * OmniRoute adapter (plan M11, REQ-1104, REQ-1105; D8, D43). Endpoints are pinned per version and each pinned version
 * has a golden request-plan fixture (tests/fixtures/gateway/omniroute-<version>/). A version that is not pinned is
 * refused: the kit never guesses an API.
 *
 * The plan is pure: given the policy and the gateway's current objects it lists the requests that make the gateway
 * match the policy (combos, the CLI key's access scope, the bridge key's scope when that key exists, budgets, pricing
 * rows). Ids come from the current objects only, never from the policy; a key the plan creates is referred to as
 * `{created:<name>}` and resolved when apply runs. Key secrets returned by the API are never copied into the plan.
 */
const name = 'omniroute';
const capabilities = Object.freeze({ combos: true, budgets: true, usage: true });
const VERSIONS = Object.freeze({
  '3.8': Object.freeze({ keys: '/api/keys', keyAccess: (id) => `/api/keys/${id}/access`, combos: '/api/combos', budget: '/api/usage/budget', pricing: '/api/pricing', version: '/api/version' }),
});
const SAFE_ID = /^[A-Za-z0-9_.:-]+$/;

function endpoints(version) {
  const e = VERSIONS[String(version)];
  if (!e) throw new Error(`omniroute ${version} is not pinned — pinned: ${Object.keys(VERSIONS).join(', ')} (a new version needs its endpoint table and a golden fixture)`);
  return e;
}

/** The list inside a GET answer: a list, or the first list of named objects in an object. */
function rows(doc) {
  if (Array.isArray(doc)) return doc.filter((x) => x && typeof x === 'object');
  if (doc && typeof doc === 'object') for (const v of Object.values(doc)) if (Array.isArray(v) && v.every((x) => x && typeof x === 'object')) return v;
  return [];
}
const byName = (doc, n) => rows(doc).find((r) => r.name === n) || null;
const safeId = (id) => {
  if (!SAFE_ID.test(String(id))) throw new Error('unexpected object id from the gateway — refused to put it in a URL');
  return id;
};

/** The combos a profile gets (the devbox shape): three auto combos over the pool, manual ones per paid model family. */
function combosOf(policy) {
  const p = policy.profile;
  const prof = policy.profiles[p];
  const pool = [...(prof.claudeApiAllowed ? policy.pool.paid : []), ...(prof.freeAllowed ? policy.pool.free : [])].filter((m, i, a) => a.indexOf(m) === i);
  const auto = (stem, pack) => ({ name: `claude-${stem}-${p}`, strategy: 'auto', models: [...pool], config: { explorationRate: 0, routerStrategy: 'rules', modePack: pack, auto: { explorationRate: 0, routerStrategy: 'rules', modePack: pack } } });
  const out = [auto('auto-balanced', 'quality-first'), auto('auto-coding', 'quality-first'), auto('auto-cheap', 'cost-saver')];
  const sonnet = pool.find((m) => /sonnet/i.test(m));
  const opus = pool.find((m) => /opus/i.test(m));
  if (sonnet) out.push({ name: `claude-manual-sonnet-${p}`, strategy: 'priority', models: [sonnet], config: {} });
  if (opus) out.push({ name: `claude-manual-opus-${p}`, strategy: 'priority', models: [opus], config: {} });
  const gem = pool.filter((m) => /^gemini\//.test(m));
  if (gem.length) out.push({ name: `claude-manual-gemini-${p}`, strategy: 'priority', models: gem, config: {} });
  return out;
}

/** The requests that make the gateway match the policy. */
function plan(policy, current, version = '3.8') {
  const e = endpoints(version);
  const p = policy.profile;
  const prof = policy.profiles[p];
  const combos = combosOf(policy);
  const names = combos.map((c) => c.name);
  const def = `claude-${prof.default}-${p}`;
  if (!names.includes(def)) throw new Error(`profile "${p}": default combo ${def} has no combo (its model is not in the pool)`);
  const allowed = [def, ...names.filter((n) => n !== def)];
  const out = [];
  for (const c of combos) {
    const cur = byName(current[e.combos], c.name);
    if (cur) out.push({ method: 'PUT', path: `${e.combos}/${safeId(cur.id)}`, body: c, why: `combo ${c.name} updated` });
    else out.push({ method: 'POST', path: e.combos, body: c, why: `combo ${c.name} created` });
  }
  const keys = policy.keys || {};
  const scope = (allowedModels) => ({ allowAutoCombos: false, allowedCombos: allowed, catalogScope: 'combos', modelAccessMode: 'restricted', allowedModels });
  const anthropicPaid = policy.pool.paid.filter((m) => /^anthropic\//.test(m));
  const keyIds = [];
  if (keys.cli) {
    const cur = byName(current[e.keys], keys.cli);
    const id = cur ? safeId(cur.id) : `{created:${keys.cli}}`;
    if (!cur) out.push({ method: 'POST', path: e.keys, body: { name: keys.cli, noLog: true }, why: `key ${keys.cli} created`, creates: keys.cli });
    out.push({ method: 'PATCH', path: e.keyAccess(id), body: { noLog: true, ...scope(anthropicPaid) }, why: `key ${keys.cli} scoped to its combos` });
    keyIds.push(id);
  }
  if (keys.bridge) {
    const cur = byName(current[e.keys], keys.bridge);
    if (cur) {
      out.push({ method: 'PATCH', path: e.keyAccess(safeId(cur.id)), body: { noLog: true, ...scope([]), allowedCombos: [`claude-auto-cheap-${p}`] }, why: `key ${keys.bridge} scoped to the cheap combo only` });
      keyIds.push(safeId(cur.id));
    }
  }
  for (const id of keyIds) out.push({ method: 'POST', path: e.budget, body: { apiKeyId: id, monthlyLimitUsd: policy.budget.monthlyLimitUsd, warningThreshold: policy.budget.warningThreshold, resetInterval: 'monthly', resetTime: policy.budget.resetTime }, why: `budget on key ${id}` });
  const curPricing = (current[e.pricing] && (current[e.pricing].pricing || current[e.pricing])) || {};
  const patch = {};
  for (const [m, row] of Object.entries(policy.pricing || {})) if (JSON.stringify(curPricing[m] || null) !== JSON.stringify(row)) patch[m] = row;
  for (const m of policy.pool.free || []) if (!curPricing[m] && !patch[m]) patch[m] = { input: 0, output: 0, cached: 0, cache_creation: 0 };
  if (Object.keys(patch).length) out.push({ method: 'PATCH', path: e.pricing, body: patch, why: `pricing rows: ${Object.keys(patch).join(', ')}` });
  return out;
}

/** Read the current objects the plan compares against (GETs only). */
async function readCurrent(client, version = '3.8') {
  const e = endpoints(version);
  const out = {};
  for (const p of [e.combos, e.keys, e.pricing]) out[p] = await client.get(p);
  return out;
}

async function gatewayVersion(client, version = '3.8') {
  try {
    const v = await client.get(endpoints(version).version);
    return v && typeof v.version === 'string' ? v.version : 'unknown';
  } catch (_) {
    return 'unknown';
  }
}

/** The public rows for `show`: names only, never a key value. */
function summary(current, version = '3.8') {
  const e = endpoints(version);
  return { combos: rows(current[e.combos]).map((c) => ({ name: c.name, strategy: c.strategy, models: c.models })), keys: rows(current[e.keys]).map((k) => ({ name: k.name, id: k.id })) };
}

const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
/** Per-key spend and budget as the assessment reads it (REQ-1105). */
async function usage(client, version = '3.8') {
  const e = endpoints(version);
  const keys = {};
  for (const k of rows(await client.get(e.keys))) {
    if (typeof k.id !== 'string' || typeof k.name !== 'string') continue;
    let b = {};
    try {
      b = await client.get(`${e.budget}?apiKeyId=${encodeURIComponent(k.id)}`);
    } catch (_) {
      b = {};
    }
    const reset = num(b.nextResetAt);
    keys[k.name] = { spend: num(b.totalCostPeriod) ?? num(b.monthlyTotal), maxBudget: num(b.activeLimitUsd) ?? num(b.monthlyLimitUsd), budgetResetAt: reset ? new Date(reset).toISOString() : null, todayUsd: num(b.totalCostToday), entries: num(b.totalEntries) };
  }
  return keys;
}

module.exports = { name, capabilities, VERSIONS, endpoints, rows, byName, combosOf, plan, readCurrent, gatewayVersion, summary, usage };
