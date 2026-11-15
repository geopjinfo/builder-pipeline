/**
 * The kit installs as an npm package from a git tag (`npm i -D github:<owner>/builder-pipeline#vX`), so its
 * package.json must describe a publishable package: not private, a `builder` command, the files the CLI reads, the
 * Node floor the CLI enforces, a licence field and the repository it comes from.
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const PACK = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(PACK, 'package.json'), 'utf8'));

describe('package.json — an installable package', () => {
  test('red: not private, and the bin "builder" runs cli.js, which starts with a node shebang', () => {
    assert.notEqual(pkg.private, true, 'a private package cannot be installed as a dependency by name');
    assert.equal(pkg.bin && pkg.bin.builder, 'cli.js');
    assert.match(readFileSync(join(PACK, 'cli.js'), 'utf8'), /^#!\/usr\/bin\/env node\r?\n/);
  });

  test('red: engines match the Node floor cli.js enforces; licence and repository are declared', () => {
    assert.equal(pkg.engines && pkg.engines.node, '>=18');
    assert.ok(typeof pkg.license === 'string' && pkg.license.length > 0, 'license missing');
    assert.match(String(pkg.repository && (pkg.repository.url || pkg.repository)), /builder-pipeline/);
  });

  test('red: `files` ships every top-level folder and document the kit carries, and not its own tests', () => {
    assert.ok(Array.isArray(pkg.files), 'files missing: npm would fall back to .npmignore / everything');
    const shipped = new Set(pkg.files.map((f) => f.replace(/\/$/, '')));
    const skip = new Set(['.git', 'node_modules', 'tests', 'package.json', '.gitignore', '.gitattributes', '.npmignore', '.claude', 'RELEASING.md', 'AGENTS.md', 'CLAUDE.md']);
    const missing = readdirSync(PACK).filter((n) => !skip.has(n) && !n.startsWith('.') && !shipped.has(n));
    assert.deepEqual(missing, [], `not in "files": ${missing.join(', ')}`);
    assert.ok(!shipped.has('tests'), 'the kit\'s own suite is not part of an install');
    assert.ok(!shipped.has('.github'), 'the kit repo\'s CI workflow is not part of an install');
    // The maintainer files speak to an agent working on the kit repo, not to a project that installs it.
    for (const f of ['AGENTS.md', 'CLAUDE.md', 'RELEASING.md']) assert.ok(!shipped.has(f), `${f} is for the kit repo only and must not ship`);
    // The doc map for agents ships, so an agent in a consuming project finds the kit's docs from node_modules.
    for (const f of ['llms.txt', 'FEATURES.md', 'GUIDE.md']) assert.ok(shipped.has(f), `${f} must ship`);
    for (const f of shipped) assert.ok(existsSync(join(PACK, f)), `"files" names ${f}, which does not exist`);
  });
});
