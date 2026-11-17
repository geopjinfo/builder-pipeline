'use strict';
/**
 * Validate a sandbox-runtime settings file before a wrapper launches (REQ-1109). Exit 0 valid · 1 invalid, naming the
 * file and every fault on stderr · 2 unreadable. Called by the account wrappers with the kit's own Node.
 */
const fs = require('fs');
const { srtFaults } = require('./account-wrappers.cjs');

function check(file) {
  let obj;
  try {
    obj = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return { code: 2, lines: [`${file}: cannot read as JSON (${e.code || e.name})`] };
  }
  const faults = srtFaults(obj);
  return faults.length ? { code: 1, lines: faults.map((f) => `${file}: ${f}`) } : { code: 0, lines: [] };
}

if (require.main === module) {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: srt-check.cjs <srt-settings.json>');
    process.exit(2);
  }
  const r = check(file);
  for (const l of r.lines) console.error(l);
  process.exit(r.code);
}

module.exports = { check };
