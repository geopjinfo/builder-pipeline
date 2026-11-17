#!/usr/bin/env node
'use strict';
/**
 * `account-key read <name>` — the `apiKeyHelper` of an api-key account (plan M10, REQ-1002; D2, D20).
 *
 * WHY. Claude Code reads an API key from `apiKeyHelper`, a command whose stdout is the key. `accounts key <name>`
 * points the account's settings.json at this file, so the key never sits in an environment variable (visible to every
 * child process and in `ps`) and never in settings.json itself. The harness calls this; a person has no reason to.
 *
 * It prints the key file's content to stdout and nothing else. On POSIX it refuses a key file wider than 0600 and a
 * key path that is a symlink: a key the group or the world can read is not a key the kit will hand out. Every
 * refusal goes to stderr, names the file and the reason, and never carries the value.
 *
 * The accounts home is `$BUILDER_ACCOUNTS_HOME`, else `~/.builder-pipeline` (scripts/lib/account-paths.cjs).
 */
const fs = require('fs');
const path = require('path');
const { home, paths, nameProblem } = require(path.join(__dirname, 'lib', 'account-paths.cjs'));

function fail(msg) {
  process.stderr.write(`account-key: ${msg}\n`);
  process.exit(2);
}

function main(argv, env = process.env, platform = process.platform) {
  const [cmd, name, ...rest] = argv;
  if (cmd !== 'read' || !name || rest.length) fail('usage: account-key read <name>  (the apiKeyHelper of an account; prints the key file to stdout)');
  const why = nameProblem(name);
  if (why) fail(why);
  const file = paths(home(env), name).keyFile;
  let st;
  try {
    st = fs.lstatSync(file);
  } catch (e) {
    fail(e.code === 'ENOENT' ? `no key for account "${name}" — enter one with: npx builder accounts key ${name}` : `${file}: ${e.message}`);
  }
  if (st.isSymbolicLink()) fail(`${file}: is a symlink — refusing to read through it`);
  if (!st.isFile()) fail(`${file}: not a regular file`);
  if (platform !== 'win32' && (st.mode & 0o077)) fail(`${file}: mode 0${(st.mode & 0o777).toString(8)} is wider than 0600 — run: chmod 600 on it, or enter the key again with npx builder accounts key ${name}`);
  const value = fs.readFileSync(file, 'utf8').replace(/\r?\n$/, '');
  if (!value) fail(`${file}: is empty — enter the key again with: npx builder accounts key ${name}`);
  process.stdout.write(value);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { main };
