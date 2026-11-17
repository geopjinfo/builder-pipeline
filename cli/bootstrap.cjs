'use strict';
/*
 * `builder bootstrap [--tool <list>]` — the one mechanical step before the AI takes over: the `builder-init` skill,
 * for each AI tool the project uses, and — run via npx from outside the project — the kit itself as a devDependency
 * (ensureDependency below). No personas, no pointer, no ledgers — builder-init decides those with the human
 * (SETUP_PROMPT.md).
 *
 * Detection (no --tool): `.claude/` or CLAUDE.md → Claude Code; `.codex/` or AGENTS.md → Codex; `.agents/` →
 * Antigravity. Codex and Antigravity read the same `.agents/skills/`, so either writes that one copy. Nothing
 * detected → Claude Code.
 */

const fs = require('fs');
const path = require('path');

const BOOT_TOOLS = ['claude-code', 'codex', 'antigravity'];
const HOW = { 'claude-code': '/builder-init', codex: '$builder-init', antigravity: 'ask for the builder-init skill by name' };

/**
 * Detection reads the USER's files only. A folder counts when it holds a file the kit did not write (not in the lock
 * — builder.lock.json records what bootstrap and unpack wrote): run 1 writing `.agents/skills/builder-init/` for
 * Codex must not make run 2 detect Antigravity too.
 */
function detect(cwd, lock = {}) {
  const own = (rel) => {
    const abs = path.join(cwd, rel);
    if (!fs.existsSync(abs)) return false;
    if (!fs.statSync(abs).isDirectory()) return true;
    // An empty folder is the user's (the kit never leaves one); a folder holding only lock-recorded files is the kit's.
    const stack = [rel];
    let kitFiles = 0;
    while (stack.length) {
      const dir = stack.pop();
      for (const e of fs.readdirSync(path.join(cwd, dir), { withFileTypes: true })) {
        const r = `${dir}/${e.name}`;
        if (e.isDirectory()) stack.push(r);
        else if (!Object.prototype.hasOwnProperty.call(lock, r)) return true;
        else kitFiles++;
      }
    }
    return kitFiles === 0;
  };
  const has = (p) => own(p);
  const out = [];
  if (has('.claude') || has('CLAUDE.md')) out.push('claude-code');
  if (has('.codex') || has('AGENTS.md')) out.push('codex');
  if (has('.agents')) out.push('antigravity');
  return out.length ? out : ['claude-code'];
}

function cmdBootstrap(ctx, argv) {
  const i = argv.indexOf('--tool');
  let tools;
  if (i !== -1) {
    if (!argv[i + 1]) ctx.die('bootstrap --tool needs a list (claude-code, codex, antigravity)');
    tools = argv[i + 1].split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (tools.includes('all')) tools = BOOT_TOOLS;
    const unknown = tools.filter((t) => !BOOT_TOOLS.includes(t));
    if (unknown.length) ctx.die(`bootstrap: unknown tool(s): ${unknown.join(', ')} — bootstrap knows ${BOOT_TOOLS.join(', ')}; any other tool: ${ctx.RUN} unpack --tool <tool>`);
  } else {
    tools = detect(ctx.CWD, ctx.lockPrior());
    console.log(`detected: ${tools.join(', ')}`);
  }
  const content = fs.readFileSync(path.join(ctx.KIT, 'skills', 'builder-init.md'), 'utf8');
  for (const f of ctx.ADAPTERS.skillFiles(tools, [{ name: 'builder-init', content }])) {
    ctx.place(path.join(...f.path.split('/')), () => ctx.kitPaths(f.content), 'kit');
  }
  // The lock records only what bootstrap wrote, marked as a bootstrap lock (cli.js writeLock): not an install.
  ctx.writeLock({ bootstrap: true });
  if (!argv.includes('--no-dependency')) ensureDependency(ctx);
  console.log(`\n${ctx.DRY() ? 'Dry run — nothing written.' : 'Bootstrapped.'} Next: open your AI tool here and run the builder-init skill:`);
  for (const t of tools) console.log(`  ${t.padEnd(12)} ${HOW[t]}`);
}

/**
 * THE KIT RUN FROM OUTSIDE THE PROJECT. The setup prompt runs `npx github:<owner>/builder-pipeline#<tag> bootstrap`:
 * npx fetches the kit into its own cache and runs it there. Every later command builder-init runs is `npx builder-pipeline …`,
 * which resolves the PROJECT's bin — and with the kit not in the project, the bare name fetches the newest registry
 * release, not the tag the setup prompt named. So bootstrap, run from anywhere outside the project, adds the kit to the project as a
 * devDependency at the spec npx fetched (one source of truth for the version: package.json), and installs it with
 * npm when npm is on PATH; without npm the dependency is written and the human is told to run `npm install`.
 * Run from the project's own node_modules or builder/ folder, the kit is already the project's: nothing is added.
 * `--no-dependency` skips this step.
 */
function ensureDependency(ctx) {
  const rel = path.relative(ctx.CWD, ctx.KIT);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return;
  const own = JSON.parse(fs.readFileSync(path.join(ctx.KIT, 'package.json'), 'utf8'));
  const spec = fetchedSpec(ctx.KIT, own);
  const pkgFile = path.join(ctx.CWD, 'package.json');
  let pkg = null;
  if (fs.existsSync(pkgFile)) {
    try {
      pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
    } catch (e) {
      console.log(`\nnote: package.json is not valid JSON (${e.message}) — add the kit yourself: npm install --save-dev ${spec}`);
      return;
    }
  }
  const listed = pkg && ['devDependencies', 'dependencies'].map((k) => pkg[k] && pkg[k][own.name]).find(Boolean);
  const present = fs.existsSync(path.join(ctx.CWD, 'node_modules', ...own.name.split('/'), 'package.json'));
  if (listed && present) return console.log(`\n${own.name} is already a dependency of this project (${listed}) — \`npx builder-pipeline\` runs it.`);
  if (ctx.DRY()) {
    return console.log(`\n${listed ? '' : `would add ${own.name}@${spec} to package.json devDependencies, then `}would run: npm install${listed ? '' : ` --save-dev ${spec}`}`);
  }
  if (!listed) {
    const next = pkg || { name: path.basename(ctx.CWD).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[._-]+/, '') || 'project', private: true };
    next.devDependencies = { ...(next.devDependencies || {}), [own.name]: spec };
    const eol = pkg && /\r\n/.test(fs.readFileSync(pkgFile, 'utf8')) ? '\r\n' : '\n';
    fs.writeFileSync(pkgFile, JSON.stringify(next, null, 2).replace(/\n/g, eol) + eol);
    console.log(`\n${pkg ? 'added' : 'created package.json with'} ${own.name} as a devDependency (${spec}) — later \`npx builder-pipeline\` commands run this kit at this tag, not the registry's newest release`);
  }
  const args = listed ? ['install'] : ['install', '--save-dev', spec];
  if (!npm(['--version'], ctx.CWD, 'pipe')) {
    return console.log(`npm is not on PATH: run \`npm install\` in this folder before the builder-init skill runs \`npx builder-pipeline\``);
  }
  console.log(`running: npm ${args.join(' ')}`);
  if (!npm(args, ctx.CWD, 'inherit')) console.log(`npm install failed — run \`npm ${args.join(' ')}\` here yourself before the builder-init skill runs \`npx builder-pipeline\``);
}

/**
 * The spec npx fetched: npx (npm 7+) runs a package from `<cache>/_npx/<hash>/node_modules/<name>`, beside a
 * package.json whose dependencies name the spec it was given. Anything else (a clone run by path) pins the release
 * tag of this kit's own version on its repository.
 */
function fetchedSpec(kit, own) {
  let dir = kit;
  while (path.basename(path.dirname(dir)) !== 'node_modules' && path.dirname(dir) !== dir) dir = path.dirname(dir);
  const root = path.dirname(path.dirname(dir));
  try {
    const p = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const s = (p.dependencies && p.dependencies[own.name]) || (p.devDependencies && p.devDependencies[own.name]);
    if (typeof s === 'string' && s.trim()) return s.trim();
  } catch (_) {
    // no npx root: fall through to the repository tag
  }
  const repo = /github\.com[/:]([^/]+\/[^/.]+?)(?:\.git)?$/.exec(String((own.repository && own.repository.url) || own.repository || ''));
  return repo ? `github:${repo[1]}#v${own.version}` : `${own.name}@${own.version}`;
}

/** Runs npm (npm.cmd through the shell on Windows); true when it exited 0. */
function npm(args, cwd, stdio) {
  const win = process.platform === 'win32';
  const r = require('child_process').spawnSync(win ? 'npm.cmd' : 'npm', win ? args.map((a) => `"${a}"`) : args, { cwd, stdio, shell: win, windowsHide: true });
  return !r.error && r.status === 0;
}

module.exports = { cmdBootstrap, detect, BOOT_TOOLS, fetchedSpec };
