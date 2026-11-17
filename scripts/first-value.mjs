/**
 * Measure time to first value from packing the kit to running its first check.
 *
 *   npx builder-pipeline run first-value [--json] [--keep]
 * (folder layout: node scripts/first-value.mjs in place of npx builder-pipeline run first-value)
 *
 * Exit 0 success · 1 a step failed · 2 bad arguments.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--json' && arg !== '--keep')) {
  console.error('first-value: unknown argument');
  process.exit(2);
}
const root = fileURLToPath(new URL('../', import.meta.url));
const keep = args.includes('--keep');
let temp;
const steps = {};

function run(name, command, argv) {
  const start = performance.now();
  const result = spawnSync(command, argv, {
    cwd: temp,
    stdio: 'pipe',
    encoding: 'utf8',
    shell: process.platform === 'win32' && (command === 'npm' || command === 'npx'),
  });
  if (name) steps[name] = (performance.now() - start) / 1000;
  if (result.error || result.status !== 0) {
    if (result.stderr) process.stderr.write(result.stderr);
    throw new Error(`${name || command} failed: ${result.error?.message || result.signal || result.status}`);
  }
}

try {
  temp = mkdtempSync(join(tmpdir(), 'builder-first-value-'));
  run(null, 'git', ['init', '-q']);
  writeFileSync(join(temp, 'package.json'), JSON.stringify({ name: 'first-value-probe', private: true }));
  writeFileSync(join(temp, 'README.md'), '# Probe\nA small example project.\n');
  const start = performance.now();
  run('pack', 'npm', ['pack', root, '--pack-destination', temp]);
  const tarball = readdirSync(temp).find((name) => name.endsWith('.tgz'));
  if (!tarball) throw new Error('pack produced no tarball');
  run('install', 'npm', ['install', '--no-audit', '--no-fund', '--prefer-offline', join(temp, tarball)]);
  run('inventory', 'npx', ['--no', 'builder-pipeline', 'inventory']);
  run('claimsCheck', 'npx', ['--no', 'builder-pipeline', 'run', 'claims-check', '--files', 'README.md']);
  const seconds = (performance.now() - start) / 1000;
  if (args.includes('--json')) {
    console.log(JSON.stringify({ seconds, steps, node: process.version }));
  } else {
    console.log(`first-value: ${seconds.toFixed(1)} s`);
    for (const [name, elapsed] of Object.entries(steps)) console.log(`${name}: ${elapsed.toFixed(1)} s`);
  }
} catch (error) {
  console.error(`first-value: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (temp) {
    if (keep) console.error(`first-value: kept ${temp}`);
    else rmSync(temp, { recursive: true, force: true });
  }
}
