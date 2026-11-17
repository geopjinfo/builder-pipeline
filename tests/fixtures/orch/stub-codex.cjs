#!/usr/bin/env node
'use strict';
/**
 * Stub `codex exec --json` for the worker-adapter tests (BUILDER_CODEX_WORKER_BIN). It reads the prompt from stdin,
 * records argv, env NAMES only (never values) and CODEX_HOME to BUILDER_STUB_ECHO, then replays BUILDER_STUB_FIXTURE
 * line by line. Lines are codex JSONL events or directives:
 *   {"_stub":"sleep","ms":N}      pause (a stall when longer than the stall window)
 *   {"_stub":"hang"}              never exit (the pass timeout must stop it)
 *   {"_stub":"stderr","text":"…"} write to stderr
 *   {"_stub":"exit","code":N}     the exit code (default 0)
 *   {"_stub":"out","text":"…"}    write text to the file named by `-o` in argv (the last agent message)
 */
const fs = require('fs');
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', async () => {
  const argv = process.argv.slice(2);
  if (process.env.BUILDER_STUB_ECHO) {
    fs.writeFileSync(process.env.BUILDER_STUB_ECHO, JSON.stringify({ argv, envNames: Object.keys(process.env).sort(), codexHome: process.env.CODEX_HOME || null, stdin: Buffer.concat(chunks).toString('utf8') }, null, 2));
  }
  const lines = process.env.BUILDER_STUB_FIXTURE ? fs.readFileSync(process.env.BUILDER_STUB_FIXTURE, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : [];
  let code = 0;
  for (const ev of lines) {
    if (ev._stub === 'sleep') await new Promise((r) => setTimeout(r, ev.ms));
    else if (ev._stub === 'hang') await new Promise(() => setInterval(() => {}, 1000));
    else if (ev._stub === 'stderr') process.stderr.write(ev.text);
    else if (ev._stub === 'exit') code = ev.code;
    else if (ev._stub === 'out') {
      const i = argv.indexOf('-o');
      if (i !== -1) fs.writeFileSync(argv[i + 1], ev.text);
    } else process.stdout.write(JSON.stringify(ev) + '\n');
  }
  process.exit(code);
});
