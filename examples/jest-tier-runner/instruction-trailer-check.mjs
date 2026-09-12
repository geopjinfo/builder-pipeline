#!/usr/bin/env node
/**
 * EXAMPLE — the CI entry for `instruction-trailer.cjs`; that file says why the check exists.
 *
 *   node scripts/instruction-trailer-check.mjs [<base-ref>]      default base: origin/main
 *
 * Changed files     git diff --name-only <base>...HEAD   (three dots: what the branch changed since it forked)
 * Commit messages   git log --format=%B%x00 <base>..HEAD (two dots: every commit the branch adds)
 *
 * Helper lookup: `./lib/instruction-trailer.cjs` when installed the way the README's table says, otherwise
 * `./instruction-trailer.cjs` beside this file, so it also runs in place in the examples directory.
 *
 * Settings: none — the instruction paths live in the helper's INSTRUCTION_DIFF. Run it in CI on every pull request,
 * with enough history fetched for the base ref to resolve.
 *
 * Exit 0 PASS (no instruction file in the diff, or the change is declared) · 1 FAIL (undeclared instruction change)
 * · 2 git could not answer (not a repository, or the base ref does not resolve).
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const installed = fileURLToPath(new URL('./lib/instruction-trailer.cjs', import.meta.url));
const { verdict } = require(existsSync(installed) ? installed : './instruction-trailer.cjs');

const base = process.argv[2] ?? 'origin/main';
const git = (args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

let changedFiles;
let commitMessages;
try {
  changedFiles = git(['diff', '--name-only', `${base}...HEAD`]).split(/\r?\n/).filter(Boolean);
  commitMessages = git(['log', '--format=%B%x00', `${base}..HEAD`]).split('\x00').map((m) => m.trim()).filter(Boolean);
} catch (e) {
  console.error(`instruction-trailer-check: git could not compare against ${base} — ${String(e.stderr || e.message).trim().split(/\r?\n/)[0]}`);
  process.exit(2);
}

const result = verdict({ changedFiles, commitMessages });
console.log(`instruction-trailer-check: ${result.ok ? 'PASS' : 'FAIL'} — ${result.reason}`);
process.exit(result.ok ? 0 : 1);
