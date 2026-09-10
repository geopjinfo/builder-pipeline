'use strict';
// Test double for a mutation tool. Module name selects the behaviour:
//   broken     exits 1 and writes no report (the tool failed)
//   threshold  writes the report and exits 2 (a score under the tool's own break threshold)
//   noop       exits 0 and writes nothing (any report on disk is from an earlier run)
//   anything   writes report.json to reports-under-test/<module>/mutation.json and exits 0
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const mod = process.argv[2];
console.log(`fake mutation tool: ${mod}`);
if (mod === 'broken') process.exit(1);
if (mod === 'noop') process.exit(0);
const dir = join(process.cwd(), 'reports-under-test', mod);
mkdirSync(dir, { recursive: true });
// Written, not copied: a copy keeps the source's modification time on some platforms, and the step
// rightly treats an old report as one this run did not produce.
writeFileSync(join(dir, 'mutation.json'), readFileSync(join(__dirname, 'report.json')));
process.exit(mod === 'threshold' ? 2 : 0);
