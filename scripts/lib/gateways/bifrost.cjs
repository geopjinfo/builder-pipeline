'use strict';
/**
 * Bifrost adapter (plan M11, REQ-1104): declared, not yet pinned. It names its capabilities so `accounts policy` can
 * list it and refuse honestly: no endpoint table and no golden fixture exist for a Bifrost version yet, so every plan
 * is refused with that reason rather than guessed.
 */
const name = 'bifrost';
const capabilities = Object.freeze({ combos: false, budgets: true, usage: true });
const VERSIONS = Object.freeze({});
const refuse = () => {
  throw new Error('bifrost is not pinned — no endpoint table and no golden fixture for any Bifrost version yet; add both before the first apply');
};
module.exports = { name, capabilities, VERSIONS, endpoints: refuse, plan: refuse, readCurrent: refuse, gatewayVersion: async () => 'unknown', summary: refuse, usage: refuse };
