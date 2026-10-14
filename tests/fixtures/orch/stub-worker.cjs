#!/usr/bin/env node
'use strict';
/**
 * Stub headless worker for the credit-lane tests (BUILDER_CREDIT_WORKER_BIN). It reads the prompt from stdin, records
 * what it was started with (argv, env NAMES only — never values — and its config dir) to BUILDER_STUB_ECHO, then
 * replays a fixture line by line. Fixture lines are stream-json events, or directives:
 *   {"_stub":"write","path":"<rel>","text":"…"}   write a file in cwd (a worker edit)
 *   {"_stub":"sleep","ms":N}                       pause
 *   {"_stub":"model_call"}                          touch BUILDER_STUB_MARK: a model call would have happened here
 *   {"_stub":"stderr","text":"…"}                  write to stderr (an API error the CLI prints)
 *   {"_stub":"exit","code":N}                       the exit code (default 0)
 * The account is read from the config dir it was given: none = primary, basename ".claude-secondary" = secondary,
 * anything else = credit. BUILDER_STUB_FIXTURE_secondary / _primary replace the fixture for those accounts; every
 * start appends { acct, hasKey, hasToken } to BUILDER_STUB_LOG. BUILDER_STUB_TAIL (JSON array) is replayed after.
 */
const fs = require('fs');
const path = require('path');

const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', async () => {
  const stdin = Buffer.concat(chunks).toString('utf8');
  const cfg = process.env.CLAUDE_CONFIG_DIR;
  const acct = !cfg ? 'primary' : path.basename(cfg) === '.claude-secondary' ? 'secondary' : 'credit';
  if (process.env.BUILDER_STUB_ECHO) {
    fs.writeFileSync(process.env.BUILDER_STUB_ECHO, JSON.stringify({ argv: process.argv.slice(2), envNames: Object.keys(process.env).sort(), configDir: cfg || null, stdinFirstLine: stdin.split(/\r?\n/)[0] }, null, 2));
  }
  if (process.env.BUILDER_STUB_LOG) fs.appendFileSync(process.env.BUILDER_STUB_LOG, JSON.stringify({ acct, hasKey: 'ANTHROPIC_API_KEY' in process.env, hasToken: 'ANTHROPIC_AUTH_TOKEN' in process.env }) + '\n');
  const fixture = (acct !== 'credit' && process.env[`BUILDER_STUB_FIXTURE_${acct}`]) || process.env.BUILDER_STUB_FIXTURE;
  const recorded = fs.readFileSync(fixture, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  const tail = process.env.BUILDER_STUB_TAIL ? JSON.parse(process.env.BUILDER_STUB_TAIL) : [];
  let code = 0;
  for (const ev of [...recorded, ...tail]) {
    if (ev._stub === 'write') {
      fs.mkdirSync(path.dirname(path.resolve(ev.path)), { recursive: true });
      fs.writeFileSync(ev.path, ev.text);
    } else if (ev._stub === 'sleep') await new Promise((r) => setTimeout(r, ev.ms));
    else if (ev._stub === 'model_call') {
      if (process.env.BUILDER_STUB_MARK) fs.writeFileSync(process.env.BUILDER_STUB_MARK, 'called\n');
    } else if (ev._stub === 'stderr') process.stderr.write(ev.text);
    else if (ev._stub === 'exit') code = ev.code;
    else process.stdout.write(JSON.stringify(ev) + '\n');
  }
  process.exit(code);
});
