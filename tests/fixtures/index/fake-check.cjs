'use strict';
// Test double for an index tool's check command. INDEX_FACTS names a facts-*.json file to print as the
// one JSON facts line; INDEX_EXIT is the exit code (default 0). Neither set: prints prose, exits 0.
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

console.log('index check: comparing manifest');
if (process.env.INDEX_FACTS) console.log(JSON.stringify(JSON.parse(readFileSync(join(__dirname, process.env.INDEX_FACTS), 'utf8'))));
process.exit(Number(process.env.INDEX_EXIT ?? 0));
