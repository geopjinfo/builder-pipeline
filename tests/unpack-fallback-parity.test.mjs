/**
 * The two no-Node fallbacks, scripts/unpack.sh and scripts/unpack.ps1, are twins: each says it is "kept
 * deliberately in step" with the other. Only the sh one is ever run by the suite (and only where `sh` exists),
 * so nothing held the PowerShell one to it. This test reads both statically — no shell, no pwsh — and asserts
 * they install the same files: per target (personas, skills), the profile-gated ledger block, the always-copied
 * files, and the copied trees with their exclusions. Every source either names must exist in the kit.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(KIT, rel), 'utf8').replace(/\r\n/g, '\n');
const SH = read('scripts/unpack.sh');
const PS = read('scripts/unpack.ps1');
const norm = (p) => p.replace(/\\/g, '/');
const sorted = (xs) => [...xs].map((x) => (Array.isArray(x) ? x.join(' -> ') : x)).sort();

/** The text between `start` and the first `end` after it; the test fails if either is missing. */
function between(text, start, end, what) {
  const i = text.indexOf(start);
  assert.notEqual(i, -1, `${what}: "${start}" not found`);
  const j = text.indexOf(end, i + start.length);
  assert.notEqual(j, -1, `${what}: "${end}" not found after "${start}"`);
  return text.slice(i + start.length, j);
}

// single-file copies: [kit source, project destination]
const shFiles = (t) => [...t.matchAll(/^\s*copy "\$KIT\/([^"$]+)"\s+"([^"]+)"/gm)].map((m) => [m[1], m[2]]);
const psFiles = (t) => [...t.matchAll(/Copy-KitFile \(Join-Path \$Kit '([^']+)'\)\s+'([^']+)'/g)].map((m) => [norm(m[1]), norm(m[2])]);
// per-file loops over a kit folder: [kit folder, destination folder]
const shLoops = (t) => [...t.matchAll(/for f in "\$KIT"\/(\w+)\/\*\.md; do copy "\$f" "([^"]+)\/\$\(basename/g)].map((m) => [m[1], m[2]]);
const psLoops = (t) =>
  [...t.matchAll(/Get-ChildItem \(Join-Path \$Kit '(\w+)\\\*\.md'\) \| ForEach-Object \{\s*Copy-KitFile \$_\.FullName \(Join-Path '([^']+)' \$_\.Name\)/g)].map((m) => [m[1], norm(m[2])]);
// named skill lists
const shSkills = (t) => (/for s in ([\w -]+); do\s*\n\s*copy "\$KIT\/skills\/\$s\.md" "\.claude\/skills\/\$s\/SKILL\.md"/.exec(t)?.[1] ?? '').trim().split(/\s+/).filter(Boolean);
const psSkills = (t) =>
  [...((/foreach \(\$s in ([^)]+)\) \{\s*\n\s*Copy-KitFile \(Join-Path \$Kit "skills\\\$s\.md"\) \(Join-Path "\.claude\\skills\\\$s" 'SKILL\.md'\)/.exec(t)?.[1] ?? '').matchAll(/'([\w-]+)'/g))].map((m) => m[1]);
// recursive tree copies: [kit folder, destination, excluded names]
const shTrees = (t) => [...t.matchAll(/^copy_tree "\$KIT\/(\w+)" "([^"]+)"([^\n]*)$/gm)].map((m) => [m[1], m[2], m[3].trim().split(/\s+/).filter(Boolean).sort().join(',')]);
const psTrees = (t) =>
  [...t.matchAll(/^Copy-KitTree \(Join-Path \$Kit '(\w+)'\) '([^']+)'([^\n]*)$/gm)].map((m) => [m[1], norm(m[2]), [...m[3].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort().join(',')]);

const SH_CLAUDE = between(SH, 'claude-code)', ';;', 'unpack.sh claude-code branch');
const SH_CODEX = between(SH, 'codex)', ';;', 'unpack.sh codex branch');
const PS_CLAUDE = between(PS, "if ($Target -eq 'claude-code') {", '\n}\nelse {', 'unpack.ps1 claude-code branch');
const PS_CODEX = between(PS, '\n}\nelse {', '\n}\n', 'unpack.ps1 codex branch');
const SH_LEDGERS = between(SH, 'if [ -e PIPELINE_PROFILE.md ]; then', '\nfi\n', 'unpack.sh ledger block');
const PS_LEDGERS = between(PS, "if (Test-Path 'PIPELINE_PROFILE.md') {", '\n}\n', 'unpack.ps1 ledger block');
const common = (text, what) => {
  const i = text.indexOf('# Common ledgers');
  assert.notEqual(i, -1, `${what}: "# Common ledgers" not found`);
  return text.slice(i);
};
const SH_COMMON = common(SH, 'unpack.sh');
const PS_COMMON = common(PS, 'unpack.ps1');

test('unpack fallbacks: both take the same two targets', () => {
  assert.match(SH, /usage: unpack\.sh <claude-code\|codex>/);
  assert.match(PS, /ValidateSet\('claude-code', 'codex'\)/);
});

test('unpack fallbacks: claude-code installs the same personas and skills', () => {
  const sh = shLoops(SH_CLAUDE);
  assert.deepEqual(sh, [['agents', '.claude/agents']], 'positive control: the sh persona loop was parsed');
  assert.deepEqual(psLoops(PS_CLAUDE), sh);
  const skills = shSkills(SH_CLAUDE);
  assert.ok(skills.includes('build-module-pipeline'), 'positive control: the sh skill list was parsed');
  assert.deepEqual(psSkills(PS_CLAUDE), skills);
  for (const s of skills) assert.ok(existsSync(join(KIT, 'skills', `${s}.md`)), `skills/${s}.md exists`);
});

test('unpack fallbacks: codex installs the same persona and playbook folders', () => {
  const sh = shLoops(SH_CODEX);
  assert.deepEqual(sorted(sh), sorted([['agents', '.builder/personas'], ['skills', '.builder/playbooks']]));
  assert.deepEqual(sorted(psLoops(PS_CODEX)), sorted(sh));
});

test('unpack fallbacks: the profile-gated ledger set is the same', () => {
  const sh = shFiles(SH_LEDGERS);
  assert.ok(sh.some(([, d]) => d === 'DEFERRED_TASKS.md'), 'positive control: the sh ledger block was parsed');
  assert.ok(sh.length >= 5);
  assert.deepEqual(sorted(psFiles(PS_LEDGERS)), sorted(sh));
  for (const [src] of sh) assert.ok(existsSync(join(KIT, src)), `${src} exists in the kit`);
});

test('unpack fallbacks: the always-copied files and the copied trees are the same', () => {
  const ungated = (files, block) => files.filter(([s, d]) => !block.some(([s2, d2]) => s === s2 && d === d2));
  const shAll = ungated(shFiles(SH_COMMON), shFiles(SH_LEDGERS));
  assert.ok(shAll.some(([, d]) => d === 'specs/module-brief.template.md'), 'positive control');
  assert.deepEqual(sorted(ungated(psFiles(PS_COMMON), psFiles(PS_LEDGERS))), sorted(shAll));
  const trees = shTrees(SH);
  assert.deepEqual(sorted(trees), sorted([['scripts', 'scripts', 'unpack.ps1,unpack.sh'], ['oracles', 'scripts/oracles', '']]));
  assert.deepEqual(sorted(psTrees(PS)), sorted(trees));
});

test('unpack fallbacks: both remind about .pipeline/ in .gitignore', () => {
  assert.match(SH, /note: add '\.pipeline\/' to \.gitignore/);
  assert.match(PS, /note: add '\.pipeline\/' to \.gitignore/);
});
