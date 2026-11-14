'use strict';
/*
 * `builder bootstrap [--tool <list>]` — the one mechanical step before the AI takes over: the `builder-init` skill,
 * and nothing else, for each AI tool the project uses. No personas, no pointer, no ledgers — builder-init decides
 * those with the human (SETUP_PROMPT.md).
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
  console.log(`\n${ctx.DRY() ? 'Dry run — nothing written.' : 'Bootstrapped.'} Next: open your AI tool here and run the builder-init skill:`);
  for (const t of tools) console.log(`  ${t.padEnd(12)} ${HOW[t]}`);
}

module.exports = { cmdBootstrap, detect, BOOT_TOOLS };
