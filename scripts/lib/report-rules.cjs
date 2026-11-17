'use strict';
/**
 * report-rules.cjs — the constants and the profile rules of `features.reporter` (REQ-1601).
 *
 * Kept apart from report.cjs so the settings loader (profile.cjs, core) pulls in none of the reporter's closure
 * (orch-state, board-parse, notify): the reporter proper ships with the orchestrator group.
 */

const FEATURE = 'reporter';
const SECTIONS = Object.freeze(['RUNS AND LANES', 'SINCE LAST REPORT', 'NEEDS A PERSON', 'CAPACITY AND ACCOUNTS', 'COST', 'NEXT']);
const CHANNEL_KINDS = Object.freeze(['stdout', 'file', 'webhook', 'command']);
const WEBHOOK_FORMATS = Object.freeze(['slack', 'generic']);
const ALERTS = Object.freeze(['stall', 'failed', 'conflict', 'rate-limit', 'limit', 'run-complete']);
const DEFAULTS = Object.freeze({ state: 'off', channels: [], intervalMinutes: 30, onlyOnChange: true, heartbeatEvery: 4, alertOn: [], alertPollSeconds: 30, maxBytes: 3500, timeoutMs: 10000, reportsDir: '.pipeline/reports' });

/* ----------------------------------------------------------------- profile rules (REQ-1601) ---- */

/** The errors of `features.reporter`, never echoing a URL. */
function validateReporter(settings) {
  const f = settings && settings.features && settings.features.reporter;
  if (!f || typeof f !== 'object') return [];
  const errors = [];
  const at = (k) => `features.reporter.${k}`;
  const active = ['on', 'unmeasured', 'experimental-on'].includes(f.state);
  const channels = Array.isArray(f.channels) ? f.channels : [];
  if (f.channels !== undefined && !Array.isArray(f.channels)) errors.push(`${at('channels')}: a list of channels`);
  if (active && !channels.length) errors.push(`${at('channels')}: one or more channels are required while the reporter is on ({ kind: stdout | file | webhook | command })`);
  channels.forEach((c, i) => {
    const atC = (k) => `${at(`channels[${i}]`)}${k ? `.${k}` : ''}`;
    if (!c || typeof c !== 'object') return errors.push(`${atC()}: an object { kind, … }`);
    if (!CHANNEL_KINDS.includes(c.kind)) return errors.push(`${atC('kind')}: one of ${CHANNEL_KINDS.join(' | ')} (got ${JSON.stringify(c.kind)})`);
    if (c.kind === 'webhook') {
      if (!WEBHOOK_FORMATS.includes(c.format)) errors.push(`${atC('format')}: one of ${WEBHOOK_FORMATS.join(' | ')}`);
      if (c.url !== undefined) errors.push(`${atC('url')}: a webhook URL never lives in the profile — name it with urlEnv (an environment variable) or urlFile (a 0600 file)`);
      else if (!c.urlEnv && !c.urlFile) errors.push(`${atC()}: a webhook needs urlEnv or urlFile`);
    }
    if (c.kind === 'command' && (typeof c.command !== 'string' || !c.command.trim())) errors.push(`${atC('command')}: the command to run (use {file} for the report path)`);
  });
  if (f.alertOn !== undefined) {
    const bad = !Array.isArray(f.alertOn) ? ['(not a list)'] : f.alertOn.filter((a) => !ALERTS.includes(a));
    if (bad.length) errors.push(`${at('alertOn')}: ${bad.map((b) => JSON.stringify(b)).join(', ')} not in the closed set ${ALERTS.join(', ')}`);
  }
  for (const k of ['intervalMinutes', 'heartbeatEvery', 'alertPollSeconds', 'maxBytes', 'timeoutMs']) if (f[k] !== undefined && !(typeof f[k] === 'number' && f[k] > 0)) errors.push(`${at(k)}: a number > 0`);
  return errors;
}

module.exports = { FEATURE, SECTIONS, CHANNEL_KINDS, WEBHOOK_FORMATS, ALERTS, DEFAULTS, validateReporter };
