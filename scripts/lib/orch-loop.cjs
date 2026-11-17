'use strict';
/**
 * `orch loop <board>` — the loop runner placed on an account by the orchestrator (plan M9, REQ-908; D30, D37).
 *
 * PLACEMENT SEAM. M3 (account placement with caps, the content check and the settings scan) is built elsewhere, so
 * `placeLoop` is the seam it will fill: today it takes the first account whose readiness assessment reads `ready`
 * (accounts.cjs assess over account-probes.cjs collect). The body changes; the call does not. The loop job is recorded
 * in `<orch root>/loops.json` as kind `loop` with the account and the cap, and `orch status` prints the pass count and
 * the stop reason. The manual command and this one share one runner (board-loop.cjs), so the run-log rows are the same.
 */
const fs = require('fs');
const path = require('path');
const registry = require('./accounts-registry.cjs');

const loopsFile = (root) => path.join(root, 'loops.json');

/** The default assessment: probe every account and assess it (M2a). */
function defaultAssess(settings, env = process.env) {
  const accounts = require('./accounts.cjs');
  const probes = require('./account-probes.cjs');
  const accountPaths = require('./account-paths.cjs');
  const f = (settings.features && settings.features.accounts) || {};
  const home = accountPaths.home(env);
  const readings = {};
  for (const [name, raw] of Object.entries(f.accounts || {})) readings[name] = probes.collect({ ...registry.withDefaults(raw), name }, accountPaths.paths(home, name, raw), { env });
  return accounts.assessAll(settings, readings);
}

/**
 * Place the loop: the first placeable Claude Code account whose assessment reads ready.
 * TODO(M3): replace the body with the account placement (caps, content check, settings scan); keep the signature.
 * @returns {{ account: string|null, assessment: object|null, reason: string|null }}
 */
function placeLoop(settings, board, io = {}) {
  const f = (settings.features && settings.features.accounts) || {};
  const list = (io.assess || defaultAssess)(settings, io.env);
  const named = list.map((a) => ({ ...a, raw: registry.withDefaults((f.accounts || {})[a.name] || {}) }));
  const pick = named.find((a) => a.state === 'ready' && a.raw.worker === 'claude-code' && registry.placeable(a.raw));
  if (pick) return { account: pick.name, assessment: pick, reason: null };
  const why = named.map((a) => `${a.name}: ${a.state}${a.reason ? ` (${a.reason})` : ''}`).join('; ') || 'no account in features.accounts';
  return { account: null, assessment: null, reason: why };
}

function readLoops(root) {
  try {
    return JSON.parse(fs.readFileSync(loopsFile(root), 'utf8'));
  } catch (_) {
    return {};
  }
}

function recordLoop(root, key, patch) {
  const all = readLoops(root);
  all[key] = { kind: 'loop', ...(all[key] || {}), ...patch, updatedAt: new Date().toISOString() };
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(`${loopsFile(root)}.tmp`, JSON.stringify(all, null, 2) + '\n');
  fs.renameSync(`${loopsFile(root)}.tmp`, loopsFile(root));
  return all[key];
}

/** The status lines of every recorded loop. */
function statusLines(root) {
  return Object.entries(readLoops(root)).map(([key, j]) => `loop ${key} · account ${j.account} · cap ${j.cap} · ${j.passes ?? 0} pass(es) · ${j.stopReason ? `stopped: ${j.stopReason}` : j.status || 'running'}`);
}

module.exports = { loopsFile, defaultAssess, placeLoop, readLoops, recordLoop, statusLines };
