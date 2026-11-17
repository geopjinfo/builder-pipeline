#!/usr/bin/env node
'use strict';
/**
 * Stub `ssh` for the remote-lane tests. It appends its argv to BUILDER_SSH_LOG (one JSON line per call) and plays
 * the first matching entry of BUILDER_SSH_SCRIPT, a JSON array of { match: <regex over the remote command>, code,
 * stdout, stderr }. No match: exit 0, no output. Stdin is read to the end and ignored.
 */
const fs = require('fs');
const argv = process.argv.slice(2);
const cmd = argv[argv.length - 1] || '';
if (process.env.BUILDER_SSH_LOG) fs.appendFileSync(process.env.BUILDER_SSH_LOG, JSON.stringify({ argv }) + '\n');
let script = [];
try {
  script = JSON.parse(fs.readFileSync(process.env.BUILDER_SSH_SCRIPT, 'utf8'));
} catch (_) {
  /* no script */
}
const hit = script.find((s) => new RegExp(s.match, 's').test(cmd)) || { code: 0 };
if (hit.stdout) process.stdout.write(hit.stdout);
if (hit.stderr) process.stderr.write(hit.stderr);
process.exit(hit.code || 0);
