#!/usr/bin/env node
/**
 * EXPERIMENTAL (`features.livePage`) — write the read-only live page shell for one board.
 * CLAUDE CODE HOSTED-ARTIFACT PAGE RUNTIME ONLY; see EXPERIMENTS.md.
 *
 *   npx builder-pipeline run experimental/page-shell <key> [--out <file>]
 * (folder layout: node scripts/experimental/page-shell.mjs in place of npx builder-pipeline run experimental/page-shell)
 *
 * Installed by `npx builder-pipeline unpack --experimental` beside `page-shell.cjs` in `scripts/experimental/`.
 * Default output: `.pipeline/<key>/page-shell.html` (outside the `page/` directory the render rewrites).
 *
 * The shell holds no run data. Publish it once, with the capabilities this prints (viewers read, only
 * the owner writes), then load the section documents written by
 * `npx builder-pipeline run board-render <key> --json` into its `page` collection, one document per file. The
 * page has no write call and no click handler; the markdown board stays the truth and the rendered
 * board file the canonical copy. Cost cells are shown only as the render derived them, at its rate version.
 */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const { shellHtml, PAGE_CAPABILITIES, PAGE_COLLECTION } = require(join(here, 'page-shell.cjs'));
/** A pack lib: `scripts/lib/` beside an installed copy, or the pack's own `scripts/lib/` when run in the pack. */
const lib = (name) => [join(here, '..', 'lib', name), join(here, '..', '..', 'scripts', 'lib', name)].find((p) => existsSync(p));
const { runHint } = require(lib('run-hint.cjs'));

const USAGE = `usage: ${runHint('experimental/page-shell', '<key> [--out <file>]')}`;

const args = process.argv.slice(2);
const outAt = args.indexOf('--out');
if (outAt !== -1 && !args[outAt + 1]) {
  console.error(USAGE);
  process.exit(2);
}
const key = args.find((a, i) => !a.startsWith('--') && !(outAt !== -1 && i === outAt + 1));
if (!key || !/^[A-Za-z0-9_.-]+$/.test(key)) {
  console.error(USAGE);
  console.error('  <key> is one board key: letters, digits, "_", "." or "-".');
  process.exit(2);
}

const out = resolve(outAt !== -1 ? args[outAt + 1] : join('.pipeline', key, 'page-shell.html'));
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, shellHtml({ title: `${key} live run`, key }), 'utf8');
console.log(`page-shell: ${out}`);
console.log(`  publish with capabilities ${JSON.stringify(PAGE_CAPABILITIES)}`);
console.log(`  seed: ${runHint('board-render', `${key} --json`)}, then one document per file into collection "${PAGE_COLLECTION}"`);
