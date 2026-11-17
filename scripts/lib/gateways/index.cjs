'use strict';
/** The gateway adapters the kit knows (REQ-1104). Each declares `capabilities: { combos, budgets, usage }`. */
const KNOWN = Object.freeze({
  omniroute: require('./omniroute.cjs'),
  bifrost: require('./bifrost.cjs'),
});
function adapter(kind) {
  const a = KNOWN[String(kind)];
  if (!a) throw new Error(`unknown gateway ${JSON.stringify(kind)} — known: ${Object.keys(KNOWN).sort().join(', ')}`);
  return a;
}
module.exports = { KNOWN, adapter };
