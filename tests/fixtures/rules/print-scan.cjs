'use strict';
// Test double for a rules runner: prints the synthetic JSON stream in scan.jsonl, narrowed to a target path.
// Target "broken" behaves like a runner that failed to start its scan.
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const target = process.argv[2] ?? null;
if (target === 'broken') {
  process.stderr.write('scan: could not parse sgconfig.yml\n');
  process.exit(3);
}
const lines = readFileSync(join(__dirname, 'scan.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean);
for (const line of lines) {
  const file = JSON.parse(line).file.split('\\').join('/');
  if (!target || file.startsWith(target)) process.stdout.write(`${line}\n`);
}
