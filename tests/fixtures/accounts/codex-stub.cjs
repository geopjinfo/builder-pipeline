#!/usr/bin/env node
'use strict';
/*
 * A stand-in for the Codex CLI used by the accounts tests (REQ-1003). `login --with-api-key` reads stdin to EOF and
 * writes it to $CODEX_HOME/auth.json at 0600, as the real CLI does with cli_auth_credentials_store = "file";
 * `logout` removes that file. Every call records its argv and the NAMES of its environment variables (never a value)
 * in $CODEX_HOME/stub-calls.json, so a test can see what the kit sent.
 */
const fs = require('fs');
const path = require('path');
const home = process.env.CODEX_HOME;
if (!home) { process.stderr.write('codex-stub: CODEX_HOME is not set\n'); process.exit(3); }
fs.mkdirSync(home, { recursive: true });
const log = path.join(home, 'stub-calls.json');
const calls = fs.existsSync(log) ? JSON.parse(fs.readFileSync(log, 'utf8')) : [];
calls.push({ argv: process.argv.slice(2), envNames: Object.keys(process.env).sort(), cwd: process.cwd() });
fs.writeFileSync(log, JSON.stringify(calls, null, 2));
const [cmd, flag] = process.argv.slice(2);
if (cmd === 'login' && flag === '--with-api-key') {
  const value = fs.readFileSync(0, 'utf8').replace(/\r?\n$/, '');
  if (!value) { process.stderr.write('codex-stub: no key on stdin\n'); process.exit(4); }
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: value }), { mode: 0o600 });
  process.stdout.write('Successfully logged in\n');
  process.exit(0);
}
if (cmd === 'logout') {
  try { fs.unlinkSync(path.join(home, 'auth.json')); } catch { /* already gone */ }
  process.stdout.write('Successfully logged out\n');
  process.exit(0);
}
process.stderr.write(`codex-stub: unexpected argv ${process.argv.slice(2).join(' ')}\n`);
process.exit(5);
